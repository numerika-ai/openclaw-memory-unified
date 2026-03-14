import type { PluginApi, UnifiedDB, RufloHNSW } from "../types";
import type { UnifiedMemoryConfig } from "../config";
import type { MemoryBankConfig } from "../memory-bank/types";
import { embed, embeddingToBuffer } from "../embedding/nemotron";
import { rerankResults, type RerankCandidate } from "../reranking/nemotron-rerank";
import { extractAgentFromSessionKey } from "../utils/helpers";

// State variables that need to be shared across hooks
interface MemoryState {
  activeTrajectoryId: string | null;
  matchedSkillName: string | null;
  matchedSkillId: number | null;
  turnPrompt: string | null;
  agentId: string | null;
}

interface NativeLanceManager {
  isReady(): boolean;
  search(query: string, topK?: number): Promise<Array<{ entryId: number; distance: number }>>;
}

interface QwenSearchFunction {
  (query: string, db: any, logger: any, topK?: number): Promise<Array<{ name: string; content: string; similarity: number }>>;
}

interface ExtractKeywordsFunction {
  (text: string): string[];
}

interface FactVecSearch {
  searchFactsByVector(queryEmbeddingBuf: Buffer, topK: number, scope?: string): Array<{ factId: number; distance: number; topic: string; fact: string; confidence: number }>;
}

interface HookDependencies {
  udb: UnifiedDB;
  ruflo: RufloHNSW | null;
  lanceManager: NativeLanceManager | null;
  cfg: UnifiedMemoryConfig;
  memoryState: MemoryState;
  qwenSemanticSearch: QwenSearchFunction;
  extractKeywords: ExtractKeywordsFunction;
  memoryBankConfig?: MemoryBankConfig;
  factVecSearch?: FactVecSearch | null;
}

/**
 * Creates the RAG injection hook for before_agent_start
 * This hook performs multi-layer memory search and injects context
 */
export function createRagInjectionHook(deps: HookDependencies) {
  const { udb, ruflo, lanceManager, cfg, memoryState, qwenSemanticSearch, extractKeywords } = deps;

  return async function(api: PluginApi, event: Record<string, unknown>) {
    const prompt = event.prompt as string | undefined;
    if (!prompt || prompt.length < 5) return;

    // Capture agent_id from event context and expose globally for tools
    const agentId = (event.agentId ?? event.agent_id ?? extractAgentFromSessionKey(event.sessionKey as string | undefined) ?? "main") as string;
    memoryState.agentId = agentId;
    (globalThis as any).__openclawAgentId = agentId;
    (globalThis as any).__openclawSessionKey = event.sessionKey as string | undefined;

    try {
      const slimLines: string[] = [];
      let matchedProcedure: string | null = null;

      // ============================================================
      // STEP 1: FTS5 full-text search for matching SKILLS (priority)
      // ============================================================
      try {
        // Strip audio/WhatsApp metadata — extract only user actual text
        let cleanPrompt = prompt;
        const transcriptMatch = prompt.match(/Transcript:\s*\n?([\s\S]+?)$/i);
        if (transcriptMatch) {
          cleanPrompt = transcriptMatch[1].trim();
        } else {
          cleanPrompt = prompt.replace(/\[Audio\][\s\S]*?Transcript:\s*/i, "")
                              .replace(/\[WhatsApp[^\]]*\]\s*<media:[^>]+>\s*/gi, "")
                              .replace(/User text:\s*/gi, "")
                              .trim() || prompt;
        }

        const keywords = (cleanPrompt.match(/[a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ]{3,}/g) || [])
          .slice(0, 10)
          .join(" OR ");

        if (keywords.length > 0) {
          const ftsResults = udb.db.prepare(`
            SELECT ue.hnsw_key, ue.content, ue.source_path, ue.summary,
                   length(ue.content) as content_len
            FROM unified_fts fts
            JOIN unified_entries ue ON ue.id = fts.rowid
            WHERE unified_fts MATCH ?
            AND ue.entry_type = 'skill'
            ORDER BY rank
            LIMIT 3
          `).all(keywords);

          // LAYER 2: Direct search in skills table (fast fallback, ~30 rows)
          const skillWords = (cleanPrompt.match(/[a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ]{3,}/g) || []).slice(0, 10);
          const seenFtsSkills = new Set<string>();
          for (const r of ftsResults as any[]) {
            const n = (r.hnsw_key || "").replace("skill-full:", "").replace("skill:", "");
            seenFtsSkills.add(n);
          }
          try {
            const likeOr = skillWords.map((w: string) => `(s.description LIKE '%${w.replace(/'/g, "")}%' OR s.keywords LIKE '%${w.replace(/'/g, "")}%')`).join(" OR ");
            if (likeOr) {
              const skillRows = udb.db.prepare(`SELECT s.name, s.description, s.procedure, length(s.procedure) as proc_len FROM skills s WHERE ${likeOr} ORDER BY s.last_used DESC NULLS LAST LIMIT 3`).all() as any[];
              for (const s of skillRows) {
                if (!seenFtsSkills.has(s.name)) {
                  (ftsResults as any[]).push({ hnsw_key: `skill-full:${s.name}`, content: s.procedure, source_path: null, summary: s.description, content_len: s.proc_len || 0 });
                }
              }
            }
          } catch {}

          for (const r of ftsResults as any[]) {
            const name = (r.hnsw_key || "").replace("skill-full:", "").replace("skill:", "");
            const contentLen = r.content_len || 0;

            if (contentLen > 500) {
              slimLines.push(`[SKILL MATCH] ${name} (${contentLen}B full procedure available)`);
              if (!matchedProcedure && r.content) {
                matchedProcedure = r.content.slice(0, 4000);
                memoryState.matchedSkillName = name;
                memoryState.turnPrompt = prompt.slice(0, 500);
                try {
                  const skill = udb.getSkillByName(name);
                  if (skill) memoryState.matchedSkillId = skill.id;
                } catch {}
              }
            } else {
              slimLines.push(`[skill] ${name}: ${(r.summary || "").slice(0, 80)}`);
            }
          }

          if (ftsResults.length > 0) {
            api.logger.info?.(`memory-unified: FTS5 found ${ftsResults.length} skills for: ${keywords.slice(0, 50)}`);
          }
        }
      } catch (ftsErr) {
        api.logger.warn?.("memory-unified: FTS5 search failed:", ftsErr);
      }

      // ============================================================
      // STEP 2: History for matched skill
      // ============================================================
      if (memoryState.matchedSkillName) {
        try {
          const skillObj = udb.getSkillByName(memoryState.matchedSkillName);
          if (skillObj) {
            const history = udb.db.prepare(`
              SELECT summary, status, timestamp FROM skill_executions
              WHERE skill_id = ? ORDER BY timestamp DESC LIMIT 3
            `).all(skillObj.id) as any[];
            for (const h of history) {
              slimLines.push(`[history] ${memoryState.matchedSkillName} (${h.timestamp}): ${h.status} — ${(h.summary || "").slice(0, 120)}`);
            }
          }
        } catch {}
      }

      // Recent executions across all skills
      const recentSkills = udb.getRecentExecutions(3);
      for (const s of recentSkills) {
        slimLines.push(`[recent] ${s.skill_name}: ${s.status}`);
      }

      // ============================================================
      // STEP 2.5: Native HNSW vector search
      // ============================================================
      if (lanceManager?.isReady()) {
        try {
          const hnswResults = await lanceManager.search(prompt, 5);
          if (hnswResults.length > 0) {
            const hnswEntryIds = hnswResults.map(r => r.entryId);
            const placeholders = hnswEntryIds.map(() => '?').join(',');
            const hnswEntries = udb.db.prepare(
              `SELECT id, entry_type, content, summary, hnsw_key FROM unified_entries WHERE id IN (${placeholders})`
            ).all(...hnswEntryIds) as any[];

            const entryMap = new Map(hnswEntries.map((e: any) => [e.id, e]));

            for (const hr of hnswResults) {
              const entry = entryMap.get(hr.entryId);
              if (!entry) continue;
              const sim = 1 - hr.distance;
              if (sim < 0.50) continue; // raised from 0.35 — reduce false positives

              const name = (entry.hnsw_key || '').replace(/^(skill-full|skill|tool|history|config):/, '');

              if (entry.entry_type === 'skill' && (entry.content || '').length > 500 && !matchedProcedure && sim >= 0.60) { // require 60% for full procedure injection
                matchedProcedure = (entry.content as string).slice(0, 4000);
                memoryState.matchedSkillName = name;
                memoryState.turnPrompt = prompt.slice(0, 500);
                try {
                  const skill = udb.getSkillByName(name);
                  if (skill) memoryState.matchedSkillId = skill.id;
                } catch {}
                slimLines.push(`[VEC MATCH] ${name} (${(sim * 100).toFixed(0)}% semantic, ${entry.entry_type})`);
              } else {
                slimLines.push(`[vec] ${name || entry.entry_type}:${entry.id} (${(sim * 100).toFixed(0)}%): ${(entry.summary || '').slice(0, 80)}`);
              }
            }
          }
        } catch (hnswErr) {
          api.logger.warn?.('memory-unified: vector search failed:', hnswErr);
        }
      }

      // ============================================================
      // STEP 2.6: Rerank vector search results (Nemotron Rerank 1B)
      // ============================================================
      if (cfg.rerankEnabled && slimLines.length > 10) {
        try {
          // Collect all vec/qwen candidates for reranking
          const rerankCandidates: RerankCandidate[] = slimLines
            .filter((l) => l.startsWith("[vec]") || l.startsWith("[qwen]"))
            .map((l, i) => ({ id: i, text: l, score: 0 }));

          if (rerankCandidates.length > 5) {
            const reranked = await rerankResults(prompt, rerankCandidates, 5);
            if (reranked.length > 0) {
              // Replace vec/qwen lines with reranked subset
              const nonVecLines = slimLines.filter((l) => !l.startsWith("[vec]") && !l.startsWith("[qwen]"));
              const rerankedLines = reranked.map((r) => `[reranked] ${r.text.replace(/^\[(vec|qwen)\]\s*/, "")} (rerank=${r.score.toFixed(3)})`);
              slimLines.length = 0;
              slimLines.push(...nonVecLines, ...rerankedLines);
              api.logger.info?.(`memory-unified: reranked ${rerankCandidates.length} → ${reranked.length} results`);
            }
          }
        } catch (rerankErr) {
          api.logger.warn?.("memory-unified: rerank failed:", rerankErr);
        }
      }

      // ============================================================
      // STEP 3: Qwen3 semantic search
      // ============================================================
      if (!matchedProcedure) {
        try {
          const qwenResults = await qwenSemanticSearch(prompt, udb.db, api.logger, 2);
          for (const r of qwenResults) {
            if (r.content.length > 500 && !matchedProcedure && r.similarity >= 0.60) { // require 60% for full procedure
              matchedProcedure = r.content.slice(0, 4000);
              memoryState.matchedSkillName = r.name;
              memoryState.turnPrompt = prompt.slice(0, 500);
              try {
                const skill = udb.getSkillByName(r.name);
                if (skill) memoryState.matchedSkillId = skill.id;
              } catch {}
              slimLines.push(`[QWEN MATCH] ${r.name} (${(r.similarity * 100).toFixed(0)}% semantic)`);
            } else {
              slimLines.push(`[qwen] ${r.name} (${(r.similarity * 100).toFixed(0)}%)`);
            }
          }
        } catch (qErr) {
          api.logger.warn?.("memory-unified: Qwen search failed:", qErr);
        }
      }

      // ============================================================
      // STEP 4: Pattern-based boosting
      // ============================================================
      try {
        const promptKeywords = extractKeywords(prompt);
        if (promptKeywords.length >= 2) {
          const allPatterns = udb.db.prepare(
            "SELECT skill_name, keywords, confidence FROM patterns WHERE confidence > 0.3 ORDER BY confidence DESC LIMIT 20"
          ).all() as Array<{ skill_name: string; keywords: string; confidence: number }>;

          for (const pattern of allPatterns) {
            const patternKw: string[] = JSON.parse(pattern.keywords);
            const overlap = patternKw.filter(kw => promptKeywords.includes(kw)).length;
            const overlapRatio = overlap / patternKw.length;

            if (overlapRatio > 0.5 && pattern.confidence > 0.4) {
              if (!memoryState.matchedSkillName || memoryState.matchedSkillName !== pattern.skill_name) {
                slimLines.push(`[pattern] ${pattern.skill_name} (${(pattern.confidence * 100).toFixed(0)}% confidence, ${(overlapRatio * 100).toFixed(0)}% keyword overlap)`);
              }
            }
          }
        }
      } catch (patternErr) {
        api.logger.warn?.("memory-unified: pattern boost failed:", patternErr);
      }

      // ============================================================
      // STEP 5: Conversation context
      // ============================================================
      try {
        const activeConversations = udb.db.prepare(`
          SELECT topic, tags, summary, status, message_count, updated_at
          FROM conversations
          WHERE status = 'active'
          AND updated_at > datetime('now', '-24 hours')
          AND confidence > 0.3
          ORDER BY updated_at DESC
          LIMIT 5
        `).all() as any[];

        if (activeConversations.length > 0) {
          slimLines.push('[active threads]');
          for (const conv of activeConversations) {
            const convTags = JSON.parse(conv.tags || '[]').join(', ');
            slimLines.push(`  ${conv.topic.slice(0,60)} (${convTags}) — ${conv.summary.slice(0,80)}`);
          }
        }
      } catch (convCtxErr) {
        api.logger.warn?.('memory-unified: conversation context error:', String(convCtxErr));
      }

      // ============================================================
      // STEP 6: Memory Bank facts (pre-embedded sqlite-vec search)
      // ============================================================
      if (deps.memoryBankConfig?.enabled) {
        try {
          const mbConfig = deps.memoryBankConfig;
          const queryEmb = await embed(prompt, "query");
          if (queryEmb && deps.factVecSearch) {
            const currentScope = memoryState.agentId ?? "main";
            const vecResults = deps.factVecSearch.searchFactsByVector(
              embeddingToBuffer(queryEmb),
              mbConfig.ragTopK * 2, // fetch extra for filtering
              currentScope,
            );

            // Convert distance to similarity (cosine distance: sim = 1 - dist)
            const topFacts = vecResults
              .map((r) => ({ ...r, similarity: 1 - r.distance }))
              .filter((r) => r.similarity > 0.35)
              .slice(0, mbConfig.ragTopK);

            if (topFacts.length > 0) {
              slimLines.push("[memory bank]");
              for (const f of topFacts) {
                slimLines.push(`  [${f.topic}] ${f.fact} (${(f.confidence * 100).toFixed(0)}%)`);
                try {
                  udb.db.prepare(
                    "UPDATE memory_facts SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?"
                  ).run(f.factId);
                } catch {}
              }
              api.logger.info?.(`memory-bank: injected ${topFacts.length} facts via sqlite-vec`);
            }
          } else if (queryEmb) {
            // Fallback: no vec table yet, use old per-fact embedding (slow)
            const currentScope = memoryState.agentId ?? "main";
            const activeFacts = udb.db.prepare(
              "SELECT id, topic, fact, confidence FROM memory_facts WHERE status = 'active' AND confidence > 0.3 AND (scope = 'global' OR scope = ?) ORDER BY confidence DESC LIMIT 50"
            ).all(currentScope) as Array<{ id: number; topic: string; fact: string; confidence: number }>;

            const scored: Array<{ id: number; topic: string; fact: string; confidence: number; similarity: number }> = [];
            for (const f of activeFacts) {
              const fEmb = await embed(f.fact, "passage");
              if (!fEmb) continue;
              const { cosineSim } = await import("../embedding/nemotron");
              const sim = cosineSim(queryEmb, fEmb);
              if (sim > 0.35) scored.push({ ...f, similarity: sim });
            }

            scored.sort((a, b) => b.similarity - a.similarity);
            const topFacts = scored.slice(0, mbConfig.ragTopK);
            if (topFacts.length > 0) {
              slimLines.push("[memory bank]");
              for (const f of topFacts) {
                slimLines.push(`  [${f.topic}] ${f.fact} (${(f.confidence * 100).toFixed(0)}%)`);
                try {
                  udb.db.prepare(
                    "UPDATE memory_facts SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?"
                  ).run(f.id);
                } catch {}
              }
              api.logger.info?.(`memory-bank: injected ${topFacts.length} facts (fallback mode)`);
            }
          }
        } catch (mbErr) {
          api.logger.warn?.("memory-bank: RAG injection error:", String(mbErr).slice(0, 100));
        }
      }

      if (slimLines.length === 0 && !matchedProcedure) return;

      // ============================================================
      // BUILD CONTEXT
      // ============================================================
      let contextBlock: string;
      if (matchedProcedure) {
        contextBlock = `<unified-memory>\n## Matched Skill Procedure (USE THIS):\n${matchedProcedure}\n\n## Other context:\n${slimLines.join("\n")}\n</unified-memory>`;
        api.logger.info?.("memory-unified: ENFORCING skill procedure in context");
      } else {
        contextBlock = `<unified-memory>\nSlim RAG context:\n${slimLines.join("\n")}\n</unified-memory>`;
      }

      // ============================================================
      // DYNAMIC TOOL ROUTING
      // ============================================================
      if (memoryState.matchedSkillName) {
        try {
          const skill = udb.getSkillByName(memoryState.matchedSkillName);
          if (skill && (skill as any).required_tools) {
            const requiredTools: string[] = JSON.parse((skill as any).required_tools);
            if (requiredTools.length > 0) {
              (globalThis as any).__openclawDynamicToolPolicy = {
                allow: requiredTools
              };
              api.logger.info?.(
                `memory-unified: TOOL ROUTING — skill "${memoryState.matchedSkillName}" → ${requiredTools.length} tools`
              );
            }
          }
        } catch (toolRouteErr) {
          api.logger.warn?.("memory-unified: tool routing failed:", String(toolRouteErr));
          (globalThis as any).__openclawDynamicToolPolicy = undefined;
        }
      } else {
        (globalThis as any).__openclawDynamicToolPolicy = undefined;
      }

      // Start trajectory if enabled
      if (cfg.trajectoryTracking && ruflo) {
        try {
          memoryState.activeTrajectoryId = await ruflo.trajectoryStart(
            prompt.slice(0, 200),
            "memory-unified"
          );
        } catch {}
      }

      return { prependContext: contextBlock };
    } catch (err) {
      api.logger.warn?.("memory-unified: RAG failed:", err);
    }
  };
}