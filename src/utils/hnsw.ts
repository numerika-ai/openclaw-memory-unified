/**
 * utils/hnsw.ts — Native HNSW Index Manager
 *
 * hnswlib-node with Qwen3 4096-dim embeddings.
 * Added 2026-03-02 by Wiki — Phase 0: replaces Ruflo MCP HNSW dependency.
 */

import * as fs from "node:fs";
import { HierarchicalNSW } from "hnswlib-node";
import Database from "better-sqlite3";
import { qwenEmbed } from "../embedding/ollama";

// ============================================================================
// Native HNSW Index Manager — hnswlib-node with Qwen3 4096-dim embeddings
// ============================================================================
export const HNSW_DIMS = 4096;
export const HNSW_MAX_ELEMENTS = 50000;
export const HNSW_M = 16;
export const HNSW_EF_CONSTRUCTION = 200;
export const HNSW_EF_SEARCH = 100;
export const HNSW_SAVE_EVERY = 10; // auto-save every N inserts

export class NativeHnswManager {
  private index: HierarchicalNSW;
  private indexPath: string;
  private insertsSinceSave = 0;
  private db: ReturnType<typeof Database>;
  private logger: { info?(...a: unknown[]): void; warn?(...a: unknown[]): void; error?(...a: unknown[]): void };
  private ready = false;

  constructor(indexPath: string, db: ReturnType<typeof Database>, logger: any) {
    this.indexPath = indexPath;
    this.db = db;
    this.logger = logger;

    // Create tracking table for which entries have been embedded
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hnsw_meta (
        entry_id INTEGER PRIMARY KEY,
        embedded_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create or load HNSW index
    this.index = new HierarchicalNSW('cosine', HNSW_DIMS);

    try {
      if (fs.existsSync(indexPath)) {
        this.index.readIndexSync(indexPath);
        this.index.setEf(HNSW_EF_SEARCH);
        this.ready = true;
        logger.info?.(`memory-unified: HNSW loaded (${this.index.getCurrentCount()} vectors, ${HNSW_DIMS}d)`);
      } else {
        this.index.initIndex(HNSW_MAX_ELEMENTS, HNSW_M, HNSW_EF_CONSTRUCTION);
        this.index.setEf(HNSW_EF_SEARCH);
        this.ready = true;
        logger.info?.(`memory-unified: HNSW created new index (max ${HNSW_MAX_ELEMENTS}, ${HNSW_DIMS}d)`);
      }
    } catch (err) {
      // Corrupted index file — recreate from scratch
      logger.warn?.('memory-unified: HNSW load failed, recreating:', String(err));
      try {
        this.index.initIndex(HNSW_MAX_ELEMENTS, HNSW_M, HNSW_EF_CONSTRUCTION);
        this.index.setEf(HNSW_EF_SEARCH);
        this.db.exec('DELETE FROM hnsw_meta'); // clear stale tracking
        this.ready = true;
        logger.info?.('memory-unified: HNSW recreated (old index was corrupted)');
      } catch (err2) {
        logger.error?.('memory-unified: HNSW init completely failed:', String(err2));
        this.ready = false;
      }
    }
  }

  isReady(): boolean { return this.ready; }
  getCount(): number { return this.ready ? this.index.getCurrentCount() : 0; }

  /** Embed text and add to HNSW index with the given unified_entries.id as label */
  async addEntry(entryId: number, text: string): Promise<boolean> {
    if (!this.ready) return false;
    try {
      // Skip if already embedded
      const existing = this.db.prepare('SELECT 1 FROM hnsw_meta WHERE entry_id = ?').get(entryId);
      if (existing) return true;

      const embedding = await qwenEmbed(text);
      if (!embedding || embedding.length !== HNSW_DIMS) return false;

      // Auto-resize if nearing capacity
      if (this.index.getCurrentCount() >= this.index.getMaxElements() - 1) {
        const newMax = this.index.getMaxElements() + 10000;
        this.index.resizeIndex(newMax);
        this.logger.info?.(`memory-unified: HNSW resized to ${newMax}`);
      }

      this.index.addPoint(embedding, entryId);
      this.db.prepare('INSERT OR IGNORE INTO hnsw_meta (entry_id) VALUES (?)').run(entryId);

      this.insertsSinceSave++;
      if (this.insertsSinceSave >= HNSW_SAVE_EVERY) {
        this.save();
      }
      return true;
    } catch (err) {
      this.logger.warn?.('memory-unified: HNSW add failed:', String(err));
      return false;
    }
  }

  /** Search HNSW for entries most similar to query text */
  async search(query: string, topK = 5): Promise<Array<{ entryId: number; distance: number }>> {
    if (!this.ready || this.index.getCurrentCount() === 0) return [];
    try {
      const embedding = await qwenEmbed(query);
      if (!embedding || embedding.length !== HNSW_DIMS) return [];

      const k = Math.min(topK, this.index.getCurrentCount());
      const result = this.index.searchKnn(embedding, k);

      return result.neighbors.map((label, i) => ({
        entryId: label,
        distance: result.distances[i],
      }));
    } catch (err) {
      this.logger.warn?.('memory-unified: HNSW search failed:', String(err));
      return [];
    }
  }

  /** Persist HNSW index to disk */
  save(): void {
    if (!this.ready) return;
    try {
      this.index.writeIndexSync(this.indexPath);
      this.insertsSinceSave = 0;
      this.logger.info?.(`memory-unified: HNSW saved (${this.index.getCurrentCount()} vectors)`);
    } catch (err) {
      this.logger.warn?.('memory-unified: HNSW save failed:', String(err));
    }
  }

  /** Bulk-index existing entries that don't have embeddings yet (background) */
  async bulkIndex(): Promise<void> {
    if (!this.ready) return;
    try {
      const unembedded = this.db.prepare(`
        SELECT ue.id, ue.summary, ue.content
        FROM unified_entries ue
        LEFT JOIN hnsw_meta hm ON hm.entry_id = ue.id
        WHERE hm.entry_id IS NULL
        ORDER BY ue.id DESC LIMIT 500
      `).all() as any[];

      if (unembedded.length === 0) {
        this.logger.info?.('memory-unified: HNSW bulk — all entries already embedded');
        return;
      }

      this.logger.info?.(`memory-unified: HNSW bulk indexing ${unembedded.length} entries...`);

      let indexed = 0;
      const BATCH = 10;
      for (let i = 0; i < unembedded.length; i += BATCH) {
        const batch = unembedded.slice(i, i + BATCH);
        const results = await Promise.all(
          batch.map((e: any) => {
            const text = e.summary || (e.content || '').slice(0, 2000);
            return text.length >= 10 ? this.addEntry(e.id, text) : Promise.resolve(false);
          })
        );
        indexed += results.filter(Boolean).length;
        // Throttle: 200ms between batches to not overwhelm Spark
        if (i + BATCH < unembedded.length) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      this.save();
      this.logger.info?.(`memory-unified: HNSW bulk complete — ${indexed}/${unembedded.length} embedded`);
    } catch (err) {
      this.logger.warn?.('memory-unified: HNSW bulk indexing failed:', String(err));
    }
  }
}
