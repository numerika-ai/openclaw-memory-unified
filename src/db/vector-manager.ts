/**
 * db/vector-manager.ts — Vector index manager (sqlite-vec only)
 *
 * Wraps SqliteVecStore with SQLite hnsw_meta tracking,
 * Qwen3 embedding, and bulk indexing.
 */

import Database from "better-sqlite3";
import { qwenEmbed, EMBED_DIM } from "../embedding/nemotron";
import type { SqliteVecStore } from "./sqlite-vec";

export class VectorManager {
  private sqliteVecStore: SqliteVecStore;
  private insertsSinceSave = 0;
  private db: ReturnType<typeof Database>;
  private logger: { info?(...a: unknown[]): void; warn?(...a: unknown[]): void; error?(...a: unknown[]): void };

  constructor(db: ReturnType<typeof Database>, sqliteVecStore: SqliteVecStore, logger: any) {
    this.db = db;
    this.sqliteVecStore = sqliteVecStore;
    this.logger = logger;

    // Create tracking table for which entries have been embedded
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hnsw_meta (
        entry_id INTEGER PRIMARY KEY,
        embedded_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  isReady(): boolean {
    return !!this.sqliteVecStore;
  }

  getCount(): number {
    try {
      const result = this.db.prepare('SELECT COUNT(*) as count FROM hnsw_meta').get() as { count: number };
      return result.count;
    } catch {
      return 0;
    }
  }

  /** Embed text and add to sqlite-vec index with the given unified_entries.id as label */
  async addEntry(entryId: number, text: string): Promise<boolean> {
    try {
      // Skip if already embedded
      const existing = this.db.prepare('SELECT 1 FROM hnsw_meta WHERE entry_id = ?').get(entryId);
      if (existing) return true;

      // Skip tool entries — they are 96% noise and degrade vector search quality
      const entry = this.db.prepare('SELECT entry_type, tags FROM unified_entries WHERE id = ?').get(entryId) as any;
      const entryType = entry?.entry_type || '';
      if (entryType === 'tool') return false;

      const embedding = await qwenEmbed(text);
      if (!embedding || embedding.length !== EMBED_DIM) return false;

      // Store in sqlite-vec
      this.sqliteVecStore.store(entryId, text, embedding, entryType);
      this.db.prepare('INSERT OR IGNORE INTO hnsw_meta (entry_id) VALUES (?)').run(entryId);
      this.insertsSinceSave++;

      return true;
    } catch (err) {
      this.logger.warn?.('memory-unified: vector add failed:', String(err));
      return false;
    }
  }

  /** Search for entries most similar to query text via sqlite-vec */
  async search(query: string, topK = 5, excludeTypes: string[] = ['tool']): Promise<Array<{ entryId: number; distance: number }>> {
    try {
      const embedding = await qwenEmbed(query);
      if (!embedding || embedding.length !== EMBED_DIM) return [];

      // Fetch extra to allow post-filtering by excluded types
      const fetchK = excludeTypes.length > 0 ? topK + 10 : topK;
      const results = this.sqliteVecStore.search(embedding, fetchK);

      if (excludeTypes.length > 0) {
        const excludeSet = new Set(excludeTypes);
        // Enrich with entry_type from unified_entries and filter
        const filtered: Array<{ entryId: number; distance: number }> = [];
        for (const r of results) {
          const entry = this.db.prepare('SELECT entry_type FROM unified_entries WHERE id = ?').get(r.entryId) as any;
          if (entry && !excludeSet.has(entry.entry_type)) {
            filtered.push(r);
            if (filtered.length >= topK) break;
          }
        }
        return filtered;
      }

      return results.slice(0, topK);
    } catch (err) {
      this.logger.warn?.('memory-unified: vector search failed:', String(err));
      return [];
    }
  }

  /** No-op — sqlite-vec auto-persists via SQLite WAL */
  save(): void {
    this.insertsSinceSave = 0;
  }

  /** Bulk-index entries missing from sqlite-vec (incremental — only embeds what's missing) */
  async bulkIndex(): Promise<void> {
    try {
      const unembedded = this.db.prepare(`
        SELECT ue.id, ue.summary, ue.content, ue.entry_type
        FROM unified_entries ue
        LEFT JOIN hnsw_meta hm ON hm.entry_id = ue.id
        WHERE hm.entry_id IS NULL
        AND ue.entry_type != 'tool'
        ORDER BY ue.id DESC LIMIT 2000
      `).all() as any[];

      if (unembedded.length === 0) {
        this.logger.info?.('memory-unified: bulk — all entries already embedded');
        return;
      }

      this.logger.info?.(`memory-unified: bulk indexing ${unembedded.length} entries...`);

      let indexed = 0;
      const BATCH = 10;
      for (let i = 0; i < unembedded.length; i += BATCH) {
        const batch = unembedded.slice(i, i + BATCH);
        const results = await Promise.all(
          batch.map((e: any) => {
            const text = e.summary || (e.content || '').slice(0, 500);
            return text.length >= 10 ? this.addEntry(e.id, text) : Promise.resolve(false);
          })
        );
        indexed += results.filter(Boolean).length;
        // Throttle: 200ms between batches to not overwhelm Spark
        if (i + BATCH < unembedded.length) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      this.logger.info?.(`memory-unified: bulk complete — ${indexed}/${unembedded.length} embedded`);
    } catch (err) {
      this.logger.warn?.('memory-unified: bulk indexing failed:', String(err));
    }
  }
}

// Re-export for backward compatibility with imports that reference NativeLanceManager
export { VectorManager as NativeLanceManager };
