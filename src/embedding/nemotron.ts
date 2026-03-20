/**
 * embedding/nemotron.ts — Nemotron Embed 1B v2 via TEI (HuggingFace Text Embeddings Inference)
 *
 * Supports query/passage prefixes per Nemotron requirements.
 * Backward compatible: if QWEN_EMBED_URL is set, falls back to Qwen behavior.
 */

// ============================================================================
// Configuration — env overrides with sensible defaults
// ============================================================================
const QWEN_EMBED_URL_ENV = process.env.QWEN_EMBED_URL;
const QWEN_MODEL = "qwen3-embedding:8b";

export const EMBED_URL = process.env.EMBED_URL ?? "http://localhost:8080/v1/embeddings";
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "nvidia/llama-nemotron-embed-1b-v2";
export const EMBED_DIM = parseInt(process.env.EMBED_DIM ?? "2048", 10);

// Nemotron requires prefixes for asymmetric retrieval
export const QUERY_PREFIX = "query: ";
export const PASSAGE_PREFIX = "passage: ";

// Detect legacy mode
const USE_QWEN_LEGACY = !!QWEN_EMBED_URL_ENV;

/**
 * Embed text using Nemotron (or legacy Qwen if QWEN_EMBED_URL is set).
 * @param text - text to embed
 * @param type - 'query' for search queries, 'passage' for documents/facts
 */
export async function embed(text: string, type: "query" | "passage" = "passage"): Promise<number[] | null> {
  try {
    const url = USE_QWEN_LEGACY ? QWEN_EMBED_URL_ENV! : EMBED_URL;
    const model = USE_QWEN_LEGACY ? QWEN_MODEL : EMBED_MODEL;

    // Apply prefix only for Nemotron (not legacy Qwen)
    const input = USE_QWEN_LEGACY
      ? text.slice(0, 2000)
      : (type === "query" ? QUERY_PREFIX : PASSAGE_PREFIX) + text.slice(0, 7500);

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as any;
    const emb = data?.data?.[0]?.embedding;
    return Array.isArray(emb) && emb.length > 0 ? emb : null;
  } catch {
    return null; // endpoint unreachable — graceful fallback
  }
}

/**
 * Cosine similarity between two embedding vectors.
 */
export function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Convert a float[] embedding to a Buffer for sqlite-vec storage.
 * sqlite-vec expects little-endian float32 blobs.
 */
export function embeddingToBuffer(embedding: number[]): Buffer {
  const buf = Buffer.alloc(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buf.writeFloatLE(embedding[i], i * 4);
  }
  return buf;
}

/**
 * Convert a sqlite-vec blob back to a float[] embedding.
 */
export function bufferToEmbedding(buf: Buffer): number[] {
  const result: number[] = [];
  for (let i = 0; i < buf.length; i += 4) {
    result.push(buf.readFloatLE(i));
  }
  return result;
}

/**
 * Batch embed multiple texts in a single TEI request.
 * TEI supports batch: {"input": ["text1", "text2", ...]} → response has data: [{embedding: [...]}, ...]
 * Returns null for any text that failed to embed.
 */
export async function embedBatch(texts: string[], type: "query" | "passage" = "passage"): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  // Fall back to sequential if only 1 text
  if (texts.length === 1) {
    const result = await embed(texts[0], type);
    return [result];
  }

  try {
    const url = USE_QWEN_LEGACY ? QWEN_EMBED_URL_ENV! : EMBED_URL;
    const model = USE_QWEN_LEGACY ? QWEN_MODEL : EMBED_MODEL;

    const inputs = texts.map(t =>
      USE_QWEN_LEGACY
        ? t.slice(0, 2000)
        : (type === "query" ? QUERY_PREFIX : PASSAGE_PREFIX) + t.slice(0, 7500)
    );

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: inputs }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      // Fallback to sequential on batch failure
      return Promise.all(texts.map(t => embed(t, type)));
    }

    const data = (await resp.json()) as any;
    const embeddings: (number[] | null)[] = new Array(texts.length).fill(null);

    if (Array.isArray(data?.data)) {
      for (const item of data.data) {
        const idx = item.index ?? 0;
        if (idx < texts.length && Array.isArray(item.embedding) && item.embedding.length > 0) {
          embeddings[idx] = item.embedding;
        }
      }
    }

    return embeddings;
  } catch {
    // Fallback to sequential on error
    return Promise.all(texts.map(t => embed(t, type)));
  }
}

// Re-export qwenEmbed alias for backward compatibility with existing imports
export { embed as qwenEmbed };

// ============================================================================
// Skill semantic search (migrated from ollama.ts to use Nemotron embeddings)
// ============================================================================

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
    const snippet = s.content.slice(0, 500);
    const emb = await embed(snippet, "passage");
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
  logger.info?.(`memory-unified: Nemotron embedding cache loaded (${results.length} skills, ${EMBED_DIM}-dim)`);
  return results;
}

export async function qwenSemanticSearch(
  query: string,
  db: any,
  logger: any,
  topK = 3
): Promise<Array<{ name: string; content: string; similarity: number }>> {
  const queryEmb = await embed(query, "query");
  if (!queryEmb) return [];

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
