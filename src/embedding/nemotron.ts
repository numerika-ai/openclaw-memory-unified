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

// Re-export qwenEmbed alias for backward compatibility with existing imports
export { embed as qwenEmbed };
