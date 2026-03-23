import type { PluginApi } from "../types";
import type { DatabasePort } from "../db/port";
import type { UnifiedMemoryConfig } from "../config";
import type { MemoryBankConfig } from "../memory-bank/types";
import { embed } from "../embedding/nemotron";
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

interface HookDependencies {
  port: DatabasePort;
  lanceManager: NativeLanceManager | null;
  cfg: UnifiedMemoryConfig;
  memoryState: MemoryState;
  qwenSemanticSearch: QwenSearchFunction;
  extractKeywords: ExtractKeywordsFunction;
  memoryBankConfig?: MemoryBankConfig;
}

/**
 * Creates the RAG injection hook for before_agent_start
 * This hook performs multi-layer memory search and injects context
 */
export function createRagInjectionHook(deps: HookDependencies) {
  const { port, lanceManager, cfg, memoryState, qwenSemanticSearch, extractKeywords } = deps;

  return async function(api: PluginApi, event: Record<string, unknown>) {
    const prompt = event.prompt as string | undefined;
    if (!prompt || prompt.length < 5) return;

    // Skip RAG pipeline for internal Memory Bank extraction calls
    if (prompt.startsWith("You are a memory extraction system")) {
      return; // extraction doesn't need skill matching or vector search
    }

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
        // Strip audio/WhatsApp metadata AND unified-memory injection — extract only user actual text
        let cleanPrompt = prompt;
        // Remove unified-memory block (injected by gateway, not user text)
        cleanPrompt = cleanPrompt.replace(/<unified-memory>[\s\S]*?<\/unified-memory>\s*/gi, "");
        // Remove conversation info metadata blocks
        cleanPrompt = cleanPrompt.replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, "");
        cleanPrompt = cleanPrompt.replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, "");
        cleanPrompt = cleanPrompt.replace(/Replied message \(untrusted[^)]*\):\s*```json[\s\S]*?```\s*/gi, "");
        // Remove pre-compaction flush instructions
        cleanPrompt = cleanPrompt.replace(/Pre-compaction memory flush\.[\s\S]*?Current time:.*$/gim, "");
        const transcriptMatch = cleanPrompt.match(/Transcript:\s*\n?([\s\S]+?)$/i);
        if (transcriptMatch) {
          cleanPrompt = transcriptMatch[1].trim();
        } else {
          cleanPrompt = cleanPrompt.replace(/\[Audio\][\s\S]*?Transcript:\s*/i, "")
                              .replace(/\[WhatsApp[^\]]*\]\s*<media:[^>]+>\s*/gi, "")
                              .replace(/User text:\s*/gi, "")
                              .trim() || prompt;
        }

        // Expand query using search aliases (PAI → Personal AI, MC → Mission Control, etc.)
        const expandedPrompt = await port.expandQuery(cleanPrompt);

        const keywords = (expandedPrompt.match(/[a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ]{3,}/g) || [])
          .slice(0, 10)
          .join(" OR ");

        if (keywords.length > 0) {
          const ftsResults = await port.ftsSearchSkills(keywords, 3);

          // LAYER 2: Direct search in skills table (fast fallback, ~30 rows)
          const skillWords = (cleanPrompt.match(/[a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ]{3,}/g) || []).slice(0, 10);
          const seenFtsSkills = new Set<string>();
          for (const r of ftsResults) {
            const n = (r.hnsw_key || "").replace("skill-full:", "").replace("skill:", "");
            seenFtsSkills.add(n);
          }
          try {
            const skillRows = await port.searchSkillsByKeywords(skillWords, 3);
            for (const s of skillRows) {
              if (!seenFtsSkills.has(s.name)) {
                ftsResults.push({
                  hnsw_key: `skill-full:${s.name}`,
                  content: s.procedure,
                  source_path: null,
                  summary: s.description,
                  content_len: s.proc_len || (s.procedure ? s.procedure.length : 0),
                });
              }
            }
          } catch {}

          for (const r of ftsResults) {
            const name = (r.hnsw_key || "").replace("skill-full:", "").replace("skill:", "");
            const contentLen = r.content_len || 0;

            if (contentLen > 500) {
              slimLines.push(`[SKILL MATCH] ${name} (${contentLen}B full procedure available)`);
              if (!matchedProcedure && r.content) {
                matchedProcedure = r.content.slice(0, 4000);
                memoryState.matchedSkillName = name;
                memoryState.turnPrompt = prompt.slice(0, 500);
                try {
                  const skill = await port.getSkillByName(name);
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
          const skillObj = await port.getSkillByName(memoryState.matchedSkillName);
          if (skillObj) {
            const history = await port.getSkillExecutionHistory(skillObj.id, 3);
            for (const h of history) {
              slimLines.push(`[history] ${memoryState.matchedSkillName} (${h.timestamp}): ${h.status} — ${(h.summary || "").slice(0, 120)}`);
            }
          }
        } catch {}
      }

      // Feedback context for matched skill
      if (memoryState.matchedSkillName) {
        try {
          const fbEntries = await port.getFeedback({ skillName: memoryState.matchedSkillName, limit: 5 });
          if (fbEntries.length >= 3) {
            const avg = fbEntries.reduce((sum, e) => sum + e.rating, 0) / fbEntries.length;
            if (avg < 0) {
              slimLines.push(`[feedback] Skill "${memoryState.matchedSkillName}" has negative feedback — review approach`);
            } else if (avg > 0.5) {
              slimLines.push(`[feedback] Skill "${memoryState.matchedSkillName}" performing well (avg ${avg.toFixed(1)})`);
            }
          }
        } catch {}
      }

      // Recent executions across all skills
      const recentSkills = await port.getRecentExecutions(3);
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
            const hnswEntries = await port.queryEntries({ ids: hnswEntryIds });

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
                  const skill = await port.getSkillByName(name);
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
      if (cfg.rerankEnabled && slimLines.length > 3) {
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
          const rawDb = (port as any).rawDb;
          if (rawDb) {
            const qwenResults = await qwenSemanticSearch(prompt, rawDb, api.logger, 2);
            for (const r of qwenResults) {
              if (r.content.length > 500 && !matchedProcedure && r.similarity >= 0.60) { // require 60% for full procedure
                matchedProcedure = r.content.slice(0, 4000);
                memoryState.matchedSkillName = r.name;
                memoryState.turnPrompt = prompt.slice(0, 500);
                try {
                  const skill = await port.getSkillByName(r.name);
                  if (skill) memoryState.matchedSkillId = skill.id;
                } catch {}
                slimLines.push(`[QWEN MATCH] ${r.name} (${(r.similarity * 100).toFixed(0)}% semantic)`);
              } else {
                slimLines.push(`[qwen] ${r.name} (${(r.similarity * 100).toFixed(0)}%)`);
              }
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
          const allPatterns = await port.queryPatterns({ minConfidence: 0.3, limit: 20 });

          for (const pattern of allPatterns) {
            const patternKw: string[] = JSON.parse(pattern.keywords);
            const overlap = patternKw.filter((kw: string) => promptKeywords.includes(kw)).length;
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
        const activeConversations = await port.queryConversations({
          status: 'active',
          recentHours: 24,
          minConfidence: 0.3,
          limit: 5,
        });

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
          if (queryEmb) {
            const currentScope = memoryState.agentId ?? "main";
            const vecResults = await port.searchFactsByVector(
              queryEmb,
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
                  await port.updateFactAccessCount(f.factId);
                } catch {}
              }
              api.logger.info?.(`memory-bank: injected ${topFacts.length} facts via vector search`);
            } else {
              // Fallback: no vec results, use query-based fact search
              const activeFacts = await port.queryFacts({
                status: 'active',
                scope: currentScope,
                minConfidence: 0.3,
                limit: 50,
              });

              const scored: Array<{ id: number; topic: string; fact: string; confidence: number; similarity: number }> = [];
              for (const f of activeFacts) {
                const fEmb = await embed(f.fact, "passage");
                if (!fEmb) continue;
                const { cosineSim } = await import("../embedding/nemotron");
                const sim = cosineSim(queryEmb, fEmb);
                if (sim > 0.35) scored.push({ ...f, similarity: sim });
              }

              scored.sort((a, b) => b.similarity - a.similarity);
              const fallbackFacts = scored.slice(0, mbConfig.ragTopK);
              if (fallbackFacts.length > 0) {
                slimLines.push("[memory bank]");
                for (const f of fallbackFacts) {
                  slimLines.push(`  [${f.topic}] ${f.fact} (${(f.confidence * 100).toFixed(0)}%)`);
                  try {
                    await port.updateFactAccessCount(f.id);
                  } catch {}
                }
                api.logger.info?.(`memory-bank: injected ${fallbackFacts.length} facts (fallback mode)`);
              }
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
          const skill = await port.getSkillByName(memoryState.matchedSkillName);
          if (skill && skill.required_tools) {
            const requiredTools: string[] = JSON.parse(skill.required_tools);
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

      return { prependContext: contextBlock };
    } catch (err) {
      api.logger.warn?.("memory-unified: RAG failed:", err);
    }
  };
}
