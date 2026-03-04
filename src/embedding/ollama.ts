/**
 * embedding/ollama.ts — Qwen3 Embedding via Ollama (Spark)
 *
 * 4096-dim semantic embeddings. Falls back gracefully if Spark unreachable.
 * Added 2026-03-02 by Wiki.
 */

// ============================================================================
// Qwen3 Embedding via Ollama (Spark) — 4096-dim semantic search
// ============================================================================
export const QWEN_EMBED_URL = process.env.QWEN_EMBED_URL ?? "http://192.168.1.80:11434/v1/embeddings";
export const QWEN_MODEL = "qwen3-embedding:8b";

export async function qwenEmbed(text: string): Promise<number[] | null> {
  try {
    const resp = await fetch(QWEN_EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: QWEN_MODEL, input: text.slice(0, 2000) }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json() as any;
    const emb = data?.data?.[0]?.embedding;
    return Array.isArray(emb) && emb.length > 0 ? emb : null;
  } catch {
    return null; // Spark unreachable — graceful fallback
  }
}

export function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Skill embedding cache — loaded lazily on first semantic query
export interface SkillEmb { key: string; name: string; embedding: number[]; content: string }
let skillEmbCache: SkillEmb[] | null = null;
let skillEmbLoading = false;

export async function loadSkillEmbeddings(db: any, logger: any): Promise<SkillEmb[]> {
  if (skillEmbCache) return skillEmbCache;
  if (skillEmbLoading) return []; // prevent double-load
  skillEmbLoading = true;

  const skills = db.prepare(
    "SELECT hnsw_key, content FROM unified_entries WHERE entry_type='skill' AND hnsw_key LIKE 'skill-full:%' AND length(content) > 500"
  ).all() as any[];

  const results: SkillEmb[] = [];
  for (const s of skills) {
    // Embed summary (first 500 chars + tags) not full content — faster
    const snippet = s.content.slice(0, 500);
    const emb = await qwenEmbed(snippet);
    if (emb) {
      results.push({
        key: s.hnsw_key,
        name: (s.hnsw_key as string).replace("skill-full:", ""),
        embedding: emb,
        content: s.content,
      });
    }
  }

  skillEmbCache = results;
  skillEmbLoading = false;
  logger.info?.(`memory-unified: Qwen embedding cache loaded (${results.length} skills, 4096-dim)`);
  return results;
}

export async function qwenSemanticSearch(
  query: string,
  db: any,
  logger: any,
  topK = 3
): Promise<Array<{ name: string; content: string; similarity: number }>> {
  const queryEmb = await qwenEmbed(query);
  if (!queryEmb) return []; // Spark unreachable

  const skills = await loadSkillEmbeddings(db, logger);
  if (skills.length === 0) return [];

  const scored = skills.map(s => ({
    name: s.name,
    content: s.content,
    similarity: cosineSim(queryEmb, s.embedding),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK).filter(s => s.similarity > 0.35);
}
