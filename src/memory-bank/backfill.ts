/**
 * memory-bank/backfill.ts — Re-embed existing facts that lack vector embeddings
 *
 * Called on startup to ensure all active facts are searchable via sqlite-vec.
 */

import { embed, embeddingToBuffer } from "../embedding/nemotron";

interface BackfillDB {
  getFactsWithoutEmbeddings(): Array<{ id: number; fact: string }>;
  storeFactEmbedding(factId: number, embeddingBuf: Buffer): void;
}

/**
 * Backfill embeddings for all active facts missing from memory_facts_vec.
 * Runs in the background — does not block startup.
 */
export async function backfillFactEmbeddings(
  db: BackfillDB,
  logger: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void },
): Promise<number> {
  const missing = db.getFactsWithoutEmbeddings();
  if (missing.length === 0) return 0;

  logger.info?.(`memory-bank: backfilling ${missing.length} facts without embeddings...`);

  let count = 0;
  for (const fact of missing) {
    try {
      const emb = await embed(fact.fact, "passage");
      if (emb) {
        db.storeFactEmbedding(fact.id, embeddingToBuffer(emb));
        count++;
      }
    } catch {
      // Skip individual failures — non-critical
    }

    // Yield between batches to avoid blocking
    if (count % 50 === 0 && count > 0) {
      logger.info?.(`memory-bank: backfill progress ${count}/${missing.length}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  logger.info?.(`memory-bank: backfill complete — ${count}/${missing.length} facts embedded`);
  return count;
}
