/**
 * reranking/nemotron-rerank.ts — Nemotron Rerank 1B v2 via TEI
 *
 * Cross-encoder reranking for improved RAG accuracy.
 * Falls back gracefully if rerank endpoint is unavailable.
 */

export const RERANK_URL = process.env.RERANK_URL ?? "http://localhost:8081/rerank";

export interface RerankCandidate {
  id: number;
  text: string;
  score: number;
}

interface TeiRerankResponse {
  index: number;
  score: number;
}

/**
 * Rerank candidates using Nemotron Rerank 1B v2 cross-encoder.
 * Returns top-K results sorted by rerank score.
 * Falls back to original order if rerank endpoint is unavailable.
 */
export async function rerankResults(
  query: string,
  candidates: RerankCandidate[],
  topK: number = 5,
): Promise<RerankCandidate[]> {
  if (candidates.length === 0) return [];
  if (candidates.length <= topK) {
    // Not enough candidates to justify reranking, but still try if available
  }

  try {
    const resp = await fetch(RERANK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        texts: candidates.map((c) => c.text),
        truncate: true,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      // Endpoint error — fall back to original scoring
      return candidates.slice(0, topK);
    }

    const data = (await resp.json()) as TeiRerankResponse[];

    // TEI returns [{index, score}, ...] sorted by score desc
    const reranked: RerankCandidate[] = data
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((r) => ({
        ...candidates[r.index],
        score: r.score,
      }));

    return reranked;
  } catch {
    // Endpoint unreachable — graceful fallback to original order
    return candidates.slice(0, topK);
  }
}
