/**
 * Memory Bank consolidator — deduplicates, merges, and detects contradictions
 * using semantic similarity + LLM verification
 */

import type { Database } from "better-sqlite3";
import { qwenEmbed, cosineSim } from "../embedding/ollama";
import type { ExtractedFact, ConsolidationResult, MemoryBankConfig, MemoryFact } from "./types";

interface NativeLanceManager {
  isReady(): boolean;
  addEntry(entryId: number, text: string): Promise<boolean>;
}

/**
 * Ask the extraction LLM whether two facts contradict each other.
 * Returns true if they contradict, false otherwise.
 */
async function checkContradiction(
  factA: string,
  factB: string,
  config: MemoryBankConfig,
): Promise<{ contradicts: boolean; reason: string }> {
  try {
    const prompt = `Do these two facts contradict each other? Answer YES or NO with a brief reason.

Fact A: ${factA}
Fact B: ${factB}

Answer:`;

    const isAnthropic = config.extractionUrl.includes("anthropic.com");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.extractionApiKey) {
      if (isAnthropic) {
        headers["x-api-key"] = config.extractionApiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["Authorization"] = `Bearer ${config.extractionApiKey}`;
      }
    }

    const resp = await fetch(config.extractionUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.extractionModel,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) return { contradicts: false, reason: "LLM unavailable" };

    const data = (await resp.json()) as any;
    const content = isAnthropic
      ? (data?.content?.[0]?.text ?? "")
      : (data?.choices?.[0]?.message?.content ?? "");

    const answer = content.trim().toUpperCase();
    const contradicts = answer.startsWith("YES");
    return { contradicts, reason: content.trim().slice(0, 200) };
  } catch {
    return { contradicts: false, reason: "contradiction check failed" };
  }
}

export async function consolidateFact(
  newFact: ExtractedFact,
  db: Database,
  config: MemoryBankConfig,
  lanceManager: NativeLanceManager | null,
  logger: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void },
  scope?: string,
): Promise<ConsolidationResult> {
  // Embed the new fact
  const newEmb = await qwenEmbed(newFact.fact);

  // If embedding fails, just create a new fact without vector dedup
  if (!newEmb) {
    const factId = insertFact(db, newFact, scope);
    logRevision(db, factId, "created", null, newFact.fact, "embedding unavailable");
    return { action: "created", factId, similarity: 0 };
  }

  // Find existing facts in same topic that are active
  const existing = db.prepare(
    "SELECT id, fact, confidence, hnsw_key FROM memory_facts WHERE topic = ? AND status = 'active' ORDER BY confidence DESC LIMIT 50"
  ).all(newFact.topic) as Array<Pick<MemoryFact, "id" | "fact" | "confidence" | "hnsw_key">>;

  let bestSim = 0;
  let bestMatch: (typeof existing)[0] | null = null;

  for (const ex of existing) {
    const exEmb = await qwenEmbed(ex.fact);
    if (!exEmb) continue;
    const sim = cosineSim(newEmb, exEmb);
    if (sim > bestSim) {
      bestSim = sim;
      bestMatch = ex;
    }
  }

  // Consolidation logic
  if (bestMatch && bestSim > 0.95) {
    // Near-duplicate: boost confidence
    const newConf = Math.min(1.0, bestMatch.confidence + 0.05);
    db.prepare("UPDATE memory_facts SET confidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(newConf, bestMatch.id);
    logRevision(db, bestMatch.id, "merged", bestMatch.fact, bestMatch.fact, `confidence boost ${bestMatch.confidence.toFixed(2)} -> ${newConf.toFixed(2)} (sim=${bestSim.toFixed(3)})`);
    logger.info?.(`memory-bank: BOOST fact #${bestMatch.id} (sim=${bestSim.toFixed(3)}, conf=${newConf.toFixed(2)})`);
    return { action: "boosted", factId: bestMatch.id, similarity: bestSim };
  }

  if (bestMatch && bestSim >= 0.90) {
    // Similar: update content
    const oldContent = bestMatch.fact;
    db.prepare("UPDATE memory_facts SET fact = ?, confidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(newFact.fact, Math.max(bestMatch.confidence, newFact.confidence), bestMatch.id);
    logRevision(db, bestMatch.id, "updated", oldContent, newFact.fact, `content update (sim=${bestSim.toFixed(3)})`);
    logger.info?.(`memory-bank: UPDATE fact #${bestMatch.id} (sim=${bestSim.toFixed(3)})`);
    return { action: "updated", factId: bestMatch.id, similarity: bestSim };
  }

  // Contradiction detection zone: 0.70 - 0.90 similarity
  if (bestMatch && bestSim >= 0.70 && bestSim < 0.90) {
    const { contradicts, reason } = await checkContradiction(bestMatch.fact, newFact.fact, config);

    if (contradicts) {
      // Mark old fact as contradicted
      db.prepare("UPDATE memory_facts SET status = 'contradicted', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(bestMatch.id);
      logRevision(db, bestMatch.id, "contradicted", bestMatch.fact, newFact.fact, `contradicted by new fact (sim=${bestSim.toFixed(3)}): ${reason}`);

      // Create the new (corrected) fact
      const factId = insertFact(db, newFact, scope);
      logRevision(db, factId, "created", null, newFact.fact, `replaces contradicted fact #${bestMatch.id} (sim=${bestSim.toFixed(3)})`);

      logger.info?.(`memory-bank: CONTRADICTED fact #${bestMatch.id} → new fact #${factId} (sim=${bestSim.toFixed(3)})`);
      return { action: "contradicted", factId, similarity: bestSim };
    }
    // Not a contradiction — fall through to create new fact
  }

  // Below threshold or no contradiction: create new fact
  const factId = insertFact(db, newFact, scope);
  logRevision(db, factId, "created", null, newFact.fact, bestSim > 0 ? `new (best sim=${bestSim.toFixed(3)})` : "new (no similar facts)");

  // Embed in LanceDB (fire and forget)
  if (lanceManager?.isReady()) {
    lanceManager.addEntry(factId, newFact.fact).catch(() => {});
  }

  logger.info?.(`memory-bank: CREATE fact #${factId} topic=${newFact.topic} conf=${newFact.confidence.toFixed(2)}`);
  return { action: "created", factId, similarity: bestSim };
}

function insertFact(db: Database, fact: ExtractedFact, scope?: string): number {
  const hnswKey = `memfact:${fact.topic}:${Date.now()}`;
  const result = db.prepare(`
    INSERT INTO memory_facts (topic, fact, confidence, source_type, temporal_type, scope, hnsw_key)
    VALUES (?, ?, ?, 'conversation', ?, ?, ?)
  `).run(fact.topic, fact.fact, fact.confidence, fact.temporal_type ?? "current_state", scope ?? "global", hnswKey);
  return result.lastInsertRowid as number;
}

function logRevision(
  db: Database,
  factId: number,
  revisionType: string,
  oldContent: string | null,
  newContent: string | null,
  reason: string,
): void {
  try {
    db.prepare(`
      INSERT INTO memory_revisions (fact_id, revision_type, old_content, new_content, reason)
      VALUES (?, ?, ?, ?, ?)
    `).run(factId, revisionType, oldContent, newContent, reason);
  } catch {
    // Non-critical — don't break consolidation
  }
}
