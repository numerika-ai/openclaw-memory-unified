import type { PluginApi } from "../types";
import type { DatabasePort } from "../db/port";
import type { UnifiedMemoryConfig } from "../config";
import type { MemoryBankConfig } from "../memory-bank/types";
import { embed } from "../embedding/nemotron";
import { rerankResults, type RerankCandidate } from "../reranking/nemotron-rerank";
import { extractAgentFromSessionKey } from "../utils/helpers";
import { strengthenFact } from "../memory-bank/maintenance";

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

// ============================================================================
// Multi-strategy retrieval candidate
// ============================================================================
interface RetrievalCandidate {
  id: string;
  type: "skill" | "entry" | "fact" | "entity";
  score: number;
  strategy: "semantic" | "keyword" | "graph" | "temporal";
  text: string;
  content?: string;
  meta?: Record<string, unknown>;
}

/**
 * v2.0 RAG injection hook — 4 parallel retrieval strategies + score fusion + reranking.
 */
export function createRagInjectionHook(deps: HookDependencies) {
  const { port, lanceManager, cfg, memoryState, extractKeywords } = deps;

  return async function(api: PluginApi, event: Record<string, unknown>) {
    const prompt = event.prompt as string | undefined;
    if (!prompt || prompt.length < 5) return;

    // Skip RAG for internal extraction calls
    if (prompt.startsWith("You are a memory extraction system")) return;

    const agentId = (event.agentId ?? event.agent_id ?? extractAgentFromSessionKey(event.sessionKey as string | undefined) ?? "main") as string;
    memoryState.agentId = agentId;
    (globalThis as any).__openclawAgentId = agentId;
    (globalThis as any).__openclawSessionKey = event.sessionKey as string | undefined;

    try {
      const slimLines: string[] = [];
      const guardrailLines: string[] = [];
      let matchedProcedure: string | null = null;

      // Clean prompt — strip metadata
      let cleanPrompt = prompt;
      cleanPrompt = cleanPrompt.replace(/<unified-memory>[\s\S]*?<\/unified-memory>\s*/gi, "");
      cleanPrompt = cleanPrompt.replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, "");
      cleanPrompt = cleanPrompt.replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, "");
      cleanPrompt = cleanPrompt.replace(/Replied message \(untrusted[^)]*\):\s*```json[\s\S]*?```\s*/gi, "");
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

      const expandedPrompt = await port.expandQuery(cleanPrompt);
      const currentScope = agentId ?? "main";

      // ============================================================
      // MULTI-STRATEGY RETRIEVAL (4 strategies in parallel)
      // ============================================================
      const [keywordResults, semanticResults, graphResults, temporalResults] = await Promise.all([
        keywordStrategy(port, expandedPrompt, cleanPrompt),
        semanticStrategy(port, lanceManager, prompt),
        graphStrategy(port, cleanPrompt),
        temporalStrategy(port, currentScope),
      ]);

      // ============================================================
      // SCORE FUSION
      // ============================================================
      const allCandidates = [...keywordResults, ...semanticResults, ...graphResults, ...temporalResults];
      const WEIGHTS = { semantic: 0.40, keyword: 0.25, graph: 0.20, temporal: 0.15 };
      const fusedMap = new Map<string, { candidate: RetrievalCandidate; fusedScore: number }>();

      for (const c of allCandidates) {
        const entry = fusedMap.get(c.id) ?? { candidate: c, fusedScore: 0 };
        entry.fusedScore += c.score * WEIGHTS[c.strategy];
        if (c.score > (entry.candidate.score ?? 0)) entry.candidate = c;
        fusedMap.set(c.id, entry);
      }

      const sorted = [...fusedMap.values()]
        .sort((a, b) => b.fusedScore - a.fusedScore)
        .slice(0, 20);

      // ============================================================
      // BUILD SLIM LINES FROM FUSED RESULTS
      // ============================================================
      for (const { candidate: c, fusedScore } of sorted) {
        if (c.type === "skill" && c.content && c.content.length > 500 && !matchedProcedure && fusedScore >= 0.15) {
          matchedProcedure = c.content.slice(0, 4000);
          const skillName = (c.meta?.name as string) ?? c.id.replace("skill:", "");
          memoryState.matchedSkillName = skillName;
          memoryState.turnPrompt = prompt.slice(0, 500);
          try {
            const skill = await port.getSkillByName(skillName);
            if (skill) memoryState.matchedSkillId = skill.id;
          } catch {}
          slimLines.push(`[SKILL MATCH] ${skillName} (score=${fusedScore.toFixed(3)}, ${c.strategy})`);
        } else if (c.type === "entity") {
          slimLines.push(`[entity] ${c.text}`);
        } else {
          slimLines.push(`[${c.strategy}] ${c.text.slice(0, 120)} (${(fusedScore * 100).toFixed(0)}%)`);
        }
      }

      // Skill history + feedback
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
        try {
          const fb = await port.getFeedback({ skillName: memoryState.matchedSkillName, limit: 5 });
          if (fb.length >= 3) {
            const avg = fb.reduce((s, e) => s + e.rating, 0) / fb.length;
            if (avg < 0) slimLines.push(`[feedback] Skill "${memoryState.matchedSkillName}" has negative feedback`);
            else if (avg > 0.5) slimLines.push(`[feedback] Skill "${memoryState.matchedSkillName}" performing well`);
          }
        } catch {}
      }

      // Recent executions
      try {
        const recent = await port.getRecentExecutions(3);
        for (const s of recent) slimLines.push(`[recent] ${s.skill_name}: ${s.status}`);
      } catch {}

      // ============================================================
      // RERANKING
      // ============================================================
      if (cfg.rerankEnabled && sorted.length > 2) {
        try {
          const rerankCands: RerankCandidate[] = sorted
            .filter(({ candidate: c }) => c.type !== "skill" || !matchedProcedure)
            .map(({ candidate: c }, i) => ({ id: i, text: c.text, score: 0 }));
          if (rerankCands.length > 2) {
            const reranked = await rerankResults(prompt, rerankCands, 5);
            if (reranked.length > 0) {
              const keep = slimLines.filter(l => l.startsWith("[SKILL") || l.startsWith("[history]") || l.startsWith("[feedback]") || l.startsWith("[recent]") || l.startsWith("[entity]"));
              const rerankedLines = reranked.map(r => `[reranked] ${r.text.slice(0, 120)} (rerank=${r.score.toFixed(3)})`);
              slimLines.length = 0;
              slimLines.push(...keep, ...rerankedLines);
              api.logger.info?.(`memory-unified: reranked ${rerankCands.length} → ${reranked.length}`);
            }
          }
        } catch {}
      }

      // ============================================================
      // PATTERN BOOSTING
      // ============================================================
      try {
        const promptKw = extractKeywords(prompt);
        if (promptKw.length >= 2) {
          const patterns = await port.queryPatterns({ minConfidence: 0.05, limit: 30 });
          for (const p of patterns) {
            const pkw: string[] = JSON.parse(p.keywords);
            const overlap = pkw.filter((k: string) => promptKw.includes(k)).length;
            const ratio = overlap / pkw.length;
            if (ratio > 0.5) {
              if (p.confidence < 0.2) guardrailLines.push(`Pattern "${p.skill_name}" has failed repeatedly (${(p.confidence * 100).toFixed(0)}%)`);
              else if (p.confidence > 0.4 && memoryState.matchedSkillName !== p.skill_name)
                slimLines.push(`[pattern] ${p.skill_name} (${(p.confidence * 100).toFixed(0)}% conf)`);
            }
          }
        }
      } catch {}

      // Conversations + trends
      try {
        const convs = await port.queryConversations({ status: 'active', recentHours: 24, minConfidence: 0.3, limit: 5 });
        if (convs.length > 0) {
          slimLines.push('[active threads]');
          for (const c of convs) slimLines.push(`  ${c.topic.slice(0,60)} (${JSON.parse(c.tags||'[]').join(',')}) — ${c.summary?.slice(0,80) ?? ""}`);
        }
      } catch {}
      try {
        const trends = await port.getTopicTrends(5);
        if (trends.length > 0) {
          slimLines.push("[trending topics]");
          for (const t of trends) slimLines.push(`  ${t.label} (${t.recent_events} events last 7d, score: ${t.trend_score})`);
        }
      } catch {}

      // ============================================================
      // HOT TIER FACTS (always injected)
      // ============================================================
      if (deps.memoryBankConfig?.enabled) {
        try {
          const hotFacts = await port.getHotFacts(currentScope);
          if (hotFacts.length > 0) {
            slimLines.push("[hot memory — always active]");
            for (const f of hotFacts) {
              slimLines.push(`  [${f.topic}] ${f.fact} (${(f.confidence * 100).toFixed(0)}%)`);
              try { await port.updateFactAccessCount(f.id); strengthenFact(port, f.id).catch(() => {}); } catch {}
            }
          }
        } catch {}
      }

      // ============================================================
      // WARM TIER FACTS (vector search)
      // ============================================================
      if (deps.memoryBankConfig?.enabled) {
        try {
          const mbConfig = deps.memoryBankConfig;
          const queryEmb = await embed(prompt, "query");
          if (queryEmb) {
            const vecResults = await port.searchFactsByVector(queryEmb, mbConfig.ragTopK * 2, currentScope);
            const topFacts = vecResults.map(r => ({ ...r, similarity: 1 - r.distance }))
              .filter(r => r.similarity > 0.35)
              .slice(0, mbConfig.ragTopK);
            if (topFacts.length > 0) {
              slimLines.push("[memory bank]");
              for (const f of topFacts) {
                slimLines.push(`  [${f.topic}] ${f.fact} (${(f.confidence * 100).toFixed(0)}%)`);
                try { await port.updateFactAccessCount(f.factId); strengthenFact(port, f.factId).catch(() => {}); } catch {}
              }
            }
          }
        } catch {}
      }

      // ============================================================
      // GUARDRAILS — lessons_learned
      // ============================================================
      if (deps.memoryBankConfig?.enabled) {
        try {
          const lessons = await port.queryFacts({ topic: "lessons_learned", status: "active", scope: currentScope, minConfidence: 0.3, limit: 10 });
          let globalLessons: any[] = [];
          if (currentScope !== "global") {
            globalLessons = await port.queryFacts({ topic: "lessons_learned", status: "active", scope: "global", minConfidence: 0.3, limit: 10 });
          }
          const all = [...lessons, ...globalLessons].sort((a, b) => b.confidence - a.confidence).slice(0, 5);
          for (const f of all) {
            const prefix = (f.repeated_count ?? 0) > 1 ? "⚠️ REPEATED: " : "";
            guardrailLines.push(`${prefix}${f.fact} (confidence: ${(f.confidence * 100).toFixed(0)}%)`);
            try { await port.updateFactAccessCount(f.id); strengthenFact(port, f.id).catch(() => {}); } catch {}
          }
        } catch {}
      }

      if (slimLines.length === 0 && !matchedProcedure && guardrailLines.length === 0) return;

      // Build context
      const guardrailBlock = guardrailLines.length > 0
        ? `## ⚠️ GUARDRAILS — Lessons Learned (DO NOT repeat these mistakes):\n${guardrailLines.map(l => `- ${l}`).join("\n")}\n\n` : "";

      let contextBlock: string;
      if (matchedProcedure) {
        contextBlock = `<unified-memory>\n${guardrailBlock}## Matched Skill Procedure (USE THIS):\n${matchedProcedure}\n\n## Other context:\n${slimLines.join("\n")}\n</unified-memory>`;
        api.logger.info?.("memory-unified: ENFORCING skill procedure in context");
      } else {
        contextBlock = `<unified-memory>\n${guardrailBlock}Slim RAG context:\n${slimLines.join("\n")}\n</unified-memory>`;
      }

      if (guardrailLines.length > 0) api.logger.info?.(`memory-unified: injected ${guardrailLines.length} guardrail lessons`);

      // Dynamic tool routing
      if (memoryState.matchedSkillName) {
        try {
          const skill = await port.getSkillByName(memoryState.matchedSkillName);
          if (skill?.required_tools) {
            const tools: string[] = JSON.parse(skill.required_tools);
            if (tools.length > 0) {
              (globalThis as any).__openclawDynamicToolPolicy = { allow: tools };
              api.logger.info?.(`memory-unified: TOOL ROUTING — skill "${memoryState.matchedSkillName}" → ${tools.length} tools`);
            }
          }
        } catch { (globalThis as any).__openclawDynamicToolPolicy = undefined; }
      } else {
        (globalThis as any).__openclawDynamicToolPolicy = undefined;
      }

      return { prependContext: contextBlock };
    } catch (err) {
      api.logger.warn?.("memory-unified: RAG failed:", err);
    }
  };
}

// ============================================================================
// Strategy 1: Keyword/BM25
// ============================================================================
async function keywordStrategy(port: DatabasePort, expandedPrompt: string, cleanPrompt: string): Promise<RetrievalCandidate[]> {
  const results: RetrievalCandidate[] = [];
  try {
    const keywords = (expandedPrompt.match(/[a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ]{3,}/g) || []).slice(0, 10).join(" OR ");
    if (!keywords) return results;

    const ftsResults = await port.ftsSearchSkills(keywords, 3);
    const skillWords = (cleanPrompt.match(/[a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ]{3,}/g) || []).slice(0, 10);
    const seen = new Set(ftsResults.map((r: any) => (r.hnsw_key || "").replace("skill-full:", "").replace("skill:", "")));
    try {
      const rows = await port.searchSkillsByKeywords(skillWords, 3);
      for (const s of rows) {
        if (!seen.has(s.name)) ftsResults.push({ hnsw_key: `skill-full:${s.name}`, content: s.procedure, source_path: null, summary: s.description, content_len: s.proc_len || (s.procedure?.length ?? 0) });
      }
    } catch {}

    for (const r of ftsResults) {
      const name = (r.hnsw_key || "").replace("skill-full:", "").replace("skill:", "");
      results.push({ id: `skill:${name}`, type: "skill", score: r.rank ? Math.min(1, Number(r.rank)) : 0.5, strategy: "keyword", text: `${name}: ${(r.summary || "").slice(0, 80)}`, content: r.content, meta: { name, contentLen: r.content_len || 0 } });
    }

    // Entry search — exclude tool (P10)
    const entries = await port.ftsSearch(cleanPrompt, undefined, 5);
    for (const e of entries) {
      if (e.entry_type === "tool") continue;
      results.push({ id: `entry:${e.id}`, type: "entry", score: e.rank ? Math.min(1, Number(e.rank) * 0.8) : 0.3, strategy: "keyword", text: `${e.entry_type}:${e.id} ${(e.summary || "").slice(0, 100)}` });
    }
  } catch {}
  return results;
}

// ============================================================================
// Strategy 2: Semantic vector search
// ============================================================================
async function semanticStrategy(port: DatabasePort, lanceManager: NativeLanceManager | null, prompt: string): Promise<RetrievalCandidate[]> {
  const results: RetrievalCandidate[] = [];
  if (!lanceManager?.isReady()) return results;
  try {
    const hrs = await lanceManager.search(prompt, 8);
    if (!hrs.length) return results;
    const entries = await port.queryEntries({ ids: hrs.map(r => r.entryId) });
    const map = new Map(entries.map((e: any) => [e.id, e]));

    for (const hr of hrs) {
      const entry = map.get(hr.entryId);
      if (!entry || entry.entry_type === "tool") continue;
      const sim = 1 - hr.distance;
      if (sim < 0.50) continue;
      const name = (entry.hnsw_key || '').replace(/^(skill-full|skill|tool|history|config):/, '');
      if (entry.entry_type === 'skill' && (entry.content || '').length > 500 && sim >= 0.60) {
        results.push({ id: `skill:${name}`, type: "skill", score: sim, strategy: "semantic", text: `${name} (${(sim * 100).toFixed(0)}% semantic)`, content: entry.content, meta: { name } });
      } else {
        results.push({ id: `entry:${entry.id}`, type: "entry", score: sim * 0.8, strategy: "semantic", text: `${name || entry.entry_type}:${entry.id} (${(sim * 100).toFixed(0)}%): ${(entry.summary || '').slice(0, 80)}` });
      }
    }
  } catch {}
  return results;
}

// ============================================================================
// Strategy 3: Graph traversal (entity-based)
// ============================================================================
async function graphStrategy(port: DatabasePort, cleanPrompt: string): Promise<RetrievalCandidate[]> {
  const results: RetrievalCandidate[] = [];
  try {
    const words = cleanPrompt.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*|[a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ]{4,}/g) || [];
    const terms = [...new Set(words)].slice(0, 5);
    for (const term of terms) {
      const entities = await port.searchEntities(term, 2);
      for (const e of entities) {
        const rels = await port.getEntityRelations(e.id);
        if (rels.length > 0) {
          const relText = rels.slice(0, 3).map((r: any) => `${r.source_name} →[${r.relation_type}]→ ${r.target_name}`);
          results.push({ id: `entity:${e.id}`, type: "entity", score: (e.sim ?? 0.5) * 0.8, strategy: "graph", text: `${e.name} (${e.entity_type}): ${relText.join("; ")}`, meta: { entityId: e.id } });
        }
      }
    }
  } catch {}
  return results;
}

// ============================================================================
// Strategy 4: Temporal filtering (recency-boosted)
// ============================================================================
async function temporalStrategy(port: DatabasePort, scope: string): Promise<RetrievalCandidate[]> {
  const results: RetrievalCandidate[] = [];
  try {
    const facts = await port.queryFacts({ status: "active", scope, minConfidence: 0.5, limit: 10 });
    const now = Date.now();
    const DAY_MS = 86400000;
    for (const f of facts) {
      const lastAccess = f.last_accessed_at ? new Date(f.last_accessed_at).getTime() : new Date(f.created_at).getTime();
      const daysAgo = (now - lastAccess) / DAY_MS;
      const score = (1 / (1 + daysAgo / 7)) * f.confidence;
      if (score > 0.1) {
        results.push({ id: `fact:${f.id}`, type: "fact", score, strategy: "temporal", text: `[${f.topic}] ${f.fact} (${(f.confidence * 100).toFixed(0)}%, ${daysAgo.toFixed(0)}d ago)` });
      }
    }
  } catch {}
  return results;
}
