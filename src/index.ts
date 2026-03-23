/**
 * memory-unified — OpenClaw Plugin
 *
 * Merges USMD SQLite skill memory with vector search (sqlite-vec or pgvector).
 * Supports two backends: SQLite (local) and Postgres (remote).
 * Hooks: before_agent_start (RAG slim), on_tool_call (log vectors),
 *        agent_end (trajectory end with success/failure label).
 * CLI:   openclaw ingest <path> — chunk, auto-tag, embed, store.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Config & types
import { unifiedConfigSchema, type UnifiedMemoryConfig, type EntryType } from "./config";
import type { PluginApi } from "./types";
import type { DatabasePort } from "./db/port";

// Database backends
import { UnifiedDBImpl } from "./db/sqlite";
import { SqlitePort } from "./db/sqlite-port";
import { PostgresPort } from "./db/postgres";
import { SqliteVecStore } from "./db/sqlite-vec";

// Embedding
import { qwenSemanticSearch } from "./embedding/nemotron";

// Memory Bank
import { DEFAULT_TOPICS } from "./memory-bank/topics";
import { backfillFactEmbeddings } from "./memory-bank/backfill";
import type { MemoryBankConfig } from "./memory-bank/types";

// Hooks
import { createRagInjectionHook } from "./hooks/rag-injection";
import { createToolCallLogHook, createAgentEndHook } from "./hooks/on-turn-end";

// Tools
import { createUnifiedSearchTool } from "./tools/unified-search";
import { createUnifiedStoreTool } from "./tools/unified-store";
import { createUnifiedConversationsTool } from "./tools/unified-conversations";
import { createUnifiedIndexFilesTool } from "./tools/file-indexer";
import { createMemoryBankManageTool } from "./tools/memory-bank-manage";
import { createFeedbackTool } from "./tools/feedback";

// Utils
import { chunkText, autoTag, summarize, extractKeywords } from "./utils/helpers";

// ============================================================================
// VectorManager adapter for DatabasePort
// ============================================================================
class PortVectorManager {
  constructor(private port: DatabasePort, private logger: any) {}

  isReady(): boolean { return true; }

  async getCount(): Promise<number> {
    return this.port.getEntryEmbeddingCount();
  }

  async addEntry(entryId: number, text: string): Promise<boolean> {
    try {
      const isEmbedded = await this.port.isEntryEmbedded(entryId);
      if (isEmbedded) return true;

      const entries = await this.port.queryEntries({ ids: [entryId] });
      const entry = entries[0];
      if (entry?.entry_type === 'tool') return false;

      const { qwenEmbed, EMBED_DIM } = await import("./embedding/nemotron");
      const embedding = await qwenEmbed(text);
      if (!embedding || embedding.length !== EMBED_DIM) return false;

      await this.port.storeEntryEmbedding(entryId, embedding, entry?.entry_type || '', text.slice(0, 500));
      await this.port.markEntryAsEmbedded(entryId);
      return true;
    } catch (err) {
      this.logger.warn?.('memory-unified: vector add failed:', String(err));
      return false;
    }
  }

  async search(query: string, topK = 5, excludeTypes: string[] = ['tool']): Promise<Array<{ entryId: number; distance: number }>> {
    try {
      const { qwenEmbed, EMBED_DIM } = await import("./embedding/nemotron");
      const embedding = await qwenEmbed(query);
      if (!embedding || embedding.length !== EMBED_DIM) return [];

      const fetchK = excludeTypes.length > 0 ? topK + 10 : topK;
      const results = await this.port.searchEntryEmbeddings(embedding, fetchK);

      if (excludeTypes.length > 0) {
        const excludeSet = new Set(excludeTypes);
        const filtered: Array<{ entryId: number; distance: number }> = [];
        for (const r of results) {
          const entries = await this.port.queryEntries({ ids: [r.entryId] });
          const entry = entries[0];
          if (entry && !excludeSet.has(entry.entry_type)) {
            filtered.push({ entryId: r.entryId, distance: r.distance });
            if (filtered.length >= topK) break;
          }
        }
        return filtered;
      }

      return results.slice(0, topK).map(r => ({ entryId: r.entryId, distance: r.distance }));
    } catch (err) {
      this.logger.warn?.('memory-unified: vector search failed:', String(err));
      return [];
    }
  }

  save(): void { /* no-op */ }

  async bulkIndex(): Promise<void> {
    try {
      const unembedded = await this.port.getUnembeddedEntries(2000);
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

// ============================================================================
// Plugin Definition
// ============================================================================
const memoryUnifiedPlugin = {
  id: "memory-unified",
  name: "Memory Unified (USMD + vector search)",
  description: "Unified memory: USMD + vector search (sqlite-vec or pgvector). RAG slim, tool logging, trajectory tracking.",
  kind: "memory" as const,
  configSchema: unifiedConfigSchema,

  register(api: PluginApi): void {
    let cfg: UnifiedMemoryConfig;
    try {
      cfg = unifiedConfigSchema.parse(api.pluginConfig);
    } catch (err) {
      api.logger.error?.("memory-unified: config error:", err);
      throw err;
    }

    const resolvedDbPath = api.resolvePath(cfg.dbPath);
    (api as any)._resolvedDbPath = resolvedDbPath;

    // ========================================================================
    // Backend initialization (async, deferred to service start)
    // ========================================================================
    let port: DatabasePort;
    let vectorManager: PortVectorManager;

    // Shared state across hooks
    const memoryState = {
      activeTrajectoryId: null as string | null,
      matchedSkillName: null as string | null,
      matchedSkillId: null as number | null,
      turnPrompt: null as string | null,
      agentId: null as string | null,
    };

    const memoryBankConfig: MemoryBankConfig | undefined = cfg.memoryBank;

    if (cfg.backend === "postgres") {
      // === POSTGRES BACKEND ===
      const pgPort = new PostgresPort(cfg.postgresUrl, cfg.embeddingDim);
      port = pgPort;
      vectorManager = new PortVectorManager(port, api.logger);

      // Async init — runs table creation, column migration, agent map loading
      pgPort.init()
        .then(async () => {
          api.logger.info?.(`memory-unified: Postgres backend initialized (${cfg.postgresUrl.replace(/:[^:@]+@/, ':***@')})`);

          // Seed topics
          if (memoryBankConfig?.enabled) {
            try {
              await port.seedTopics(DEFAULT_TOPICS);
              api.logger.info?.("memory-unified: memory bank topics seeded");
            } catch (e) { api.logger.warn?.("memory-unified: topic seed failed:", String(e)); }
          }

          // Archive phantom conversations
          try {
            const archived = await port.archiveConversations({ phantom: true });
            if (archived > 0) api.logger.info?.(`memory-unified: archived ${archived} phantom conversations`);
          } catch (e) { api.logger.warn?.("memory-unified: phantom cleanup failed:", String(e)); }

          // Data cleanup
          try {
            const stats = await port.runDataCleanup();
            if (stats.toolEntriesDeleted > 0 || stats.conversationsArchived > 0) {
              api.logger.info?.(`memory-unified: cleanup — tools=${stats.toolEntriesDeleted}, convs=${stats.conversationsArchived}`);
            }
          } catch (e) { api.logger.warn?.("memory-unified: cleanup failed:", String(e)); }
        })
        .catch(err => api.logger.error?.("memory-unified: Postgres init failed:", String(err)));
    } else {
      // === SQLITE BACKEND (fallback) ===
      let udb: UnifiedDBImpl;
      try {
        udb = new UnifiedDBImpl(resolvedDbPath, cfg.embeddingDim);
      } catch (err) {
        api.logger.error?.("memory-unified: DB init failed:", err);
        throw err;
      }

      let sqliteVecStore: SqliteVecStore | null = null;
      try {
        sqliteVecStore = new SqliteVecStore(udb.db, api.logger);
      } catch (e) {
        api.logger.warn?.("memory-unified: sqlite-vec init failed:", String(e));
      }

      port = new SqlitePort(udb, sqliteVecStore);
      vectorManager = new PortVectorManager(port, api.logger);

      // Sync initialization for SQLite
      if (memoryBankConfig?.enabled) {
        try { udb.seedTopics(DEFAULT_TOPICS); } catch (e) { api.logger.warn?.("memory-unified: topic seed failed:", String(e)); }
        try {
          const { runMaintenance } = require("./memory-bank/maintenance");
          const mResult = runMaintenance(udb.db, api.logger);
          if (mResult.expired > 0 || mResult.decayed > 0) {
            api.logger.info?.(`memory-unified: startup maintenance — expired=${mResult.expired}, decayed=${mResult.decayed}`);
          }
        } catch (e) { api.logger.warn?.("memory-unified: startup maintenance failed:", String(e)); }
      }

      // Clean up phantom conversations (sync)
      try {
        const cleanupResult = udb.db.prepare(`
          UPDATE conversations SET status = 'archived'
          WHERE status = 'active'
            AND (topic LIKE 'You are a memory extraction system%'
                 OR topic LIKE 'Extract facts:%')
        `).run();
        if (cleanupResult.changes > 0) {
          api.logger.info?.(`memory-unified: archived ${cleanupResult.changes} phantom extraction conversations`);
        }
      } catch (e) { api.logger.warn?.("memory-unified: phantom cleanup failed:", String(e)); }

      // Data cleanup (sync)
      try {
        const { runDataCleanup } = require("./memory-bank/maintenance");
        const cleanupStats = runDataCleanup(udb.db, api.logger);
        if (cleanupStats.toolEntriesDeleted > 0 || cleanupStats.stagingCleared > 0) {
          api.logger.info?.(`memory-unified: cleanup — tool entries=${cleanupStats.toolEntriesDeleted}, staging=${cleanupStats.stagingCleared}`);
        }
      } catch (e) { api.logger.warn?.("memory-unified: cleanup failed:", String(e)); }

      // Periodic maintenance (sync)
      try {
        const { runPeriodicMaintenance } = require("./memory-bank/maintenance");
        runPeriodicMaintenance(udb.db, api.logger, resolvedDbPath);
      } catch (e) { api.logger.warn?.("memory-unified: periodic maintenance failed:", String(e)); }

      api.logger.info?.(`memory-unified: SQLite backend initialized (db: ${resolvedDbPath})`);
    }

    api.logger.info?.(`memory-unified: initialized (backend: ${cfg.backend})`);

    // ========================================================================
    // Hook 1: before_agent_start → RAG slim
    // ========================================================================
    if (cfg.ragSlim) {
      const ragHook = createRagInjectionHook({
        port,
        lanceManager: vectorManager,
        cfg,
        memoryState,
        qwenSemanticSearch,
        extractKeywords,
        memoryBankConfig,
      });

      api.on("before_agent_start", async (event) => {
        return await ragHook(api, event);
      });
    }

    // ========================================================================
    // Hook 2: on_tool_call → log to vector store with skill tag
    // ========================================================================
    if (cfg.logToolCalls) {
      const toolCallHook = createToolCallLogHook({
        port,
        lanceManager: vectorManager,
        cfg,
        memoryState,
      });

      api.on("after_tool_call", async (event) => {
        return await toolCallHook(api, event);
      });
    }

    // ========================================================================
    // Hook 3: agent_end → trajectory end + tool policy cleanup
    // ========================================================================
    if (cfg.trajectoryTracking) {
      const agentEndHook = createAgentEndHook({
        port,
        lanceManager: vectorManager,
        cfg,
        memoryState,
        memoryBankConfig,
      });

      api.on("agent_end", async (event) => {
        return await agentEndHook(api, event);
      });
    }

    // ========================================================================
    // Tools: Register all tools
    // ========================================================================
    api.registerTool(createUnifiedSearchTool(port, vectorManager), { name: "unified_search" });
    api.registerTool(createUnifiedStoreTool(port, vectorManager), { name: "unified_store" });
    api.registerTool(createUnifiedConversationsTool(port), { name: "unified_conversations" });
    api.registerTool(createUnifiedIndexFilesTool(port), { name: "unified_index_files" });
    api.registerTool(createMemoryBankManageTool(port), { name: "memory_bank_manage" });
    api.registerTool(createFeedbackTool(port), { name: "feedback" });

    // ========================================================================
    // CLI: openclaw ingest <path>
    // ========================================================================
    api.registerCli(({ program }) => {
      program
        .command("ingest")
        .description("Ingest file(s) into unified memory: chunk 500 tok → auto-tag → embed → store")
        .argument("<filepath>", "File or directory to ingest")
        .option("--chunk-size <n>", "Chunk size in tokens", "500")
        .option("--type <t>", "Entry type (default: auto-detect)")
        .action(async (filepath: string, opts: any) => {
          const chunkSize = parseInt(opts.chunkSize) || 500;
          const resolvedPath = path.resolve(filepath);

          if (!fs.existsSync(resolvedPath)) {
            console.error(`File not found: ${resolvedPath}`);
            process.exit(1);
          }

          const stat = fs.statSync(resolvedPath);
          const files = stat.isDirectory()
            ? fs.readdirSync(resolvedPath)
                .filter(f => /\.(md|txt|ts|js|json|sql|py|sh|yaml|yml)$/.test(f))
                .map(f => path.join(resolvedPath, f))
            : [resolvedPath];

          let totalChunks = 0;

          for (const file of files) {
            const text = fs.readFileSync(file, "utf-8");
            const ext = path.extname(file).slice(1);
            const chunks = chunkText(text, chunkSize);

            let entryType: EntryType = (opts.type as EntryType) ?? "history";
            if (!opts.type) {
              if (/skill/i.test(file) || ext === "md") entryType = "skill";
              else if (/config/i.test(file) || ["json", "yaml", "yml", "env"].includes(ext)) entryType = "config";
              else if (["ts", "js", "py", "sh"].includes(ext)) entryType = "protocol";
            }

            for (const chunk of chunks) {
              const tags = autoTag(chunk);
              const sum = summarize(chunk);
              const hnswKey = `ingest:${path.basename(file)}:${totalChunks}`;

              await port.storeEntry({
                entryType,
                tags: tags.join(","),
                content: chunk,
                summary: sum,
                sourcePath: file,
                hnswKey,
              });

              totalChunks++;
            }

            console.log(`  ✓ ${path.basename(file)}: ${chunks.length} chunks [${entryType}]`);
          }

          console.log(`\nIngested ${totalChunks} chunks from ${files.length} file(s)`);
        });
    }, { commands: ["ingest"] });

    // ========================================================================
    // Service
    // ========================================================================
    api.registerService({
      id: "memory-unified",
      start: () => {
        api.logger.info?.(`memory-unified: service started (backend: ${cfg.backend})`);
        // Kick off bulk indexing in background
        vectorManager.bulkIndex().catch(err => api.logger.warn?.("memory-unified: bulk index failed:", String(err)));
        // Backfill memory_facts_vec for existing facts missing embeddings
        if (memoryBankConfig?.enabled) {
          backfillFactEmbeddings(port, api.logger).catch(err =>
            api.logger.warn?.("memory-unified: fact backfill failed:", String(err))
          );
        }
      },
      stop: () => {
        vectorManager.save();
        port.close().catch(() => {});
        api.logger.info?.("memory-unified: service stopped");
      },
    });
  },
};

export default memoryUnifiedPlugin;
