/**
 * db/lance-manager.ts — LanceDB vector index manager
 *
 * Wraps LanceVectorStore with SQLite hnsw_meta tracking,
 * Qwen3 embedding via Ollama, and bulk indexing.
 */

import * as path from "node:path";
import Database from "better-sqlite3";
import { LanceVectorStore } from "./lancedb";
import { qwenEmbed } from "../embedding/ollama";
import type { SqliteVecStore } from "./sqlite-vec";

export type VectorBackend = "lancedb" | "sqlite-vec" | "dual";

export class NativeLanceManager {
  private lanceStore: LanceVectorStore;
  private sqliteVecStore: SqliteVecStore | null = null;
  private vectorBackend: VectorBackend = "lancedb";
  private insertsSinceSave = 0;
  private db: ReturnType<typeof Database>;
  private logger: { info?(...a: unknown[]): void; warn?(...a: unknown[]): void; error?(...a: unknown[]): void };
  private ready = false;

  constructor(dbPath: string, db: ReturnType<typeof Database>, logger: any) {
    this.db = db;
    this.logger = logger;

    // Create tracking table for which entries have been embedded
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hnsw_meta (
        entry_id INTEGER PRIMARY KEY,
        embedded_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create LanceDB vector store
    const lanceDbPath = path.join(path.dirname(dbPath), "memory-vectors.lance");
    this.lanceStore = new LanceVectorStore(lanceDbPath, logger);

    // Initialize LanceDB
    this.lanceStore.init()
      .then(() => {
        this.ready = true;
        logger.info?.(`memory-unified: LanceDB initialized (path: ${lanceDbPath})`);
      })
      .catch((err) => {
        logger.error?.('memory-unified: LanceDB init failed:', String(err));
        this.ready = false;
      });
  }

  /** Attach a SqliteVecStore for dual-write and optional search routing */
  setSqliteVecStore(store: SqliteVecStore): void {
    this.sqliteVecStore = store;
    const envBackend = process.env.MEMORY_VECTOR_BACKEND;
    if (envBackend === "sqlite-vec" || envBackend === "dual" || envBackend === "lancedb") {
      this.setVectorBackend(envBackend);
    }
  }

  /** Set the vector search backend: "lancedb" (default), "sqlite-vec", or "dual" */
  setVectorBackend(backend: VectorBackend): void {
    this.vectorBackend = backend;
    this.logger.info?.(`memory-unified: vector search backend set to "${backend}"`);
  }

  getVectorBackend(): VectorBackend {
    return this.vectorBackend;
  }

  isReady(): boolean {
    // sqlite-vec mode doesn't require LanceDB to be initialized
    if (this.vectorBackend === "sqlite-vec" && this.sqliteVecStore) return true;
    return this.ready;
  }

  getCount(): number {
    if (!this.ready) return 0;
    try {
      const result = this.db.prepare('SELECT COUNT(*) as count FROM hnsw_meta').get() as { count: number };
      return result.count;
    } catch {
      return 0;
    }
  }

  /** Embed text and add to LanceDB index with the given unified_entries.id as label */
  async addEntry(entryId: number, text: string): Promise<boolean> {
    if (!this.ready) return false;

    try {
      // Skip if already embedded
      const existing = this.db.prepare('SELECT 1 FROM hnsw_meta WHERE entry_id = ?').get(entryId);
      if (existing) return true;

      const embedding = await qwenEmbed(text);
      if (!embedding || embedding.length !== 4096) return false;

      // Get entry metadata for filtering
      const entry = this.db.prepare('SELECT entry_type, tags FROM unified_entries WHERE id = ?').get(entryId) as any;
      const metadata = {
        entry_type: entry?.entry_type || '',
        tags: entry?.tags || '',
        created_at: new Date().toISOString()
      };

      // Store in LanceDB
      const success = await this.lanceStore.store(entryId, text, embedding, metadata);
      if (success) {
        this.db.prepare('INSERT OR IGNORE INTO hnsw_meta (entry_id) VALUES (?)').run(entryId);
        this.insertsSinceSave++;

        // Phase 1 dual-write: also store in sqlite-vec
        if (this.sqliteVecStore) {
          this.sqliteVecStore.store(entryId, text, embedding, metadata.entry_type);
        }
      }

      return success;
    } catch (err) {
      this.logger.warn?.('memory-unified: LanceDB add failed:', String(err));
      return false;
    }
  }

  /** Search for entries most similar to query text, routed by vectorBackend setting */
  async search(query: string, topK = 5): Promise<Array<{ entryId: number; distance: number }>> {
    try {
      const embedding = await qwenEmbed(query);
      if (!embedding || embedding.length !== 4096) return [];

      // sqlite-vec only: no LanceDB needed
      if (this.vectorBackend === "sqlite-vec" && this.sqliteVecStore) {
        return this.sqliteVecStore.search(embedding, topK);
      }

      if (!this.ready) return [];

      // dual: merge both backends
      if (this.vectorBackend === "dual" && this.sqliteVecStore) {
        const [lanceResults, vecResults] = await Promise.all([
          this.lanceStore.search(embedding, topK),
          Promise.resolve(this.sqliteVecStore.search(embedding, topK)),
        ]);
        return this.mergeResults(lanceResults, vecResults, topK);
      }

      // Default: lancedb
      return await this.lanceStore.search(embedding, topK);
    } catch (err) {
      this.logger.warn?.('memory-unified: vector search failed:', String(err));
      return [];
    }
  }

  /** Merge results from two backends, deduplicate by entryId, keep best distance */
  private mergeResults(
    a: Array<{ entryId: number; distance: number }>,
    b: Array<{ entryId: number; distance: number }>,
    topK: number,
  ): Array<{ entryId: number; distance: number }> {
    const map = new Map<number, number>();
    for (const r of a) {
      map.set(r.entryId, r.distance);
    }
    for (const r of b) {
      const existing = map.get(r.entryId);
      if (existing === undefined || r.distance < existing) {
        map.set(r.entryId, r.distance);
      }
    }
    return Array.from(map.entries())
      .map(([entryId, distance]) => ({ entryId, distance }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, topK);
  }

  /** LanceDB auto-saves, so this is a no-op but maintained for interface compatibility */
  save(): void {
    this.insertsSinceSave = 0;
    if (this.ready) {
      this.logger.info?.(`memory-unified: LanceDB state consistent (auto-persisted)`);
    }
  }

  /** Bulk-index ALL entries into unified_vectors (resets hnsw_meta to re-embed everything) */
  async bulkIndex(): Promise<void> {
    if (!this.ready) return;

    try {
      // Reset tracking so all entries get re-embedded into the new unified_vectors table
      this.db.exec('DELETE FROM hnsw_meta');

      const unembedded = this.db.prepare(`
        SELECT ue.id, ue.summary, ue.content
        FROM unified_entries ue
        LEFT JOIN hnsw_meta hm ON hm.entry_id = ue.id
        WHERE hm.entry_id IS NULL
        ORDER BY ue.id DESC LIMIT 500
      `).all() as any[];

      if (unembedded.length === 0) {
        this.logger.info?.('memory-unified: LanceDB bulk — all entries already embedded');
        return;
      }

      this.logger.info?.(`memory-unified: LanceDB bulk indexing ${unembedded.length} entries...`);

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

      this.logger.info?.(`memory-unified: LanceDB bulk complete — ${indexed}/${unembedded.length} embedded`);
    } catch (err) {
      this.logger.warn?.('memory-unified: LanceDB bulk indexing failed:', String(err));
    }
  }
}
