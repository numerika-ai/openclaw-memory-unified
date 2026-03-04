/**
 * memory-unified — OpenClaw Plugin
 *
 * Merges USMD SQLite skill memory with LanceDB vector search.
 * Hooks: before_agent_start (RAG slim), on_tool_call (log to LanceDB),
 *        agent_end (trajectory end with success/failure label).
 * CLI:   openclaw ingest <path> — chunk, auto-tag, embed, store.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Config & types
import { unifiedConfigSchema, type UnifiedMemoryConfig, type EntryType } from "./config";
import type { PluginApi } from "./types";

// Database
import { UnifiedDBImpl } from "./db/sqlite";
import { NativeLanceManager } from "./db/lance-manager";

// Embedding
import { qwenSemanticSearch } from "./embedding/ollama";

// Hooks
import { createRagInjectionHook } from "./hooks/rag-injection";
import { createToolCallLogHook, createAgentEndHook } from "./hooks/on-turn-end";

// Tools
import { createUnifiedSearchTool } from "./tools/unified-search";
import { createUnifiedStoreTool } from "./tools/unified-store";
import { createUnifiedConversationsTool } from "./tools/unified-conversations";
import { createUnifiedIndexFilesTool } from "./tools/file-indexer";

// Utils
import { chunkText, autoTag, summarize, extractKeywords } from "./utils/helpers";

// ============================================================================
// Plugin Definition
// ============================================================================
const memoryUnifiedPlugin = {
  id: "memory-unified",
  name: "Memory Unified (USMD + LanceDB)",
  description: "Unified memory: USMD SQLite for structured skills + LanceDB for semantic search. RAG slim, tool logging, trajectory tracking.",
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

    let udb: UnifiedDBImpl;
    try {
      udb = new UnifiedDBImpl(resolvedDbPath);
    } catch (err) {
      api.logger.error?.("memory-unified: DB init failed:", err);
      throw err;
    }

    // Shared state across hooks
    const memoryState = {
      activeTrajectoryId: null as string | null,
      matchedSkillName: null as string | null,
      matchedSkillId: null as number | null,
      turnPrompt: null as string | null,
    };

    // ========================================================================
    // LanceDB Vector Index
    // ========================================================================
    let lanceManager: NativeLanceManager | null = null;
    try {
      lanceManager = new NativeLanceManager(resolvedDbPath, udb.db, api.logger);
      api.logger.info?.(`memory-unified: LanceDB manager ready (${lanceManager.getCount()} vectors)`);
    } catch (hnswErr) {
      api.logger.warn?.('memory-unified: LanceDB manager init failed, continuing without:', String(hnswErr));
    }

    api.logger.info?.(`memory-unified: initialized (db: ${resolvedDbPath})`);

    // ========================================================================
    // Hook 1: before_agent_start → RAG slim
    // ========================================================================
    if (cfg.ragSlim) {
      const ragHook = createRagInjectionHook({
        udb,
        ruflo: null,
        lanceManager,
        cfg,
        memoryState,
        qwenSemanticSearch,
        extractKeywords,
      });

      api.on("before_agent_start", async (event) => {
        return await ragHook(api, event);
      });
    }

    // ========================================================================
    // Hook 2: on_tool_call → log to LanceDB with skill tag
    // ========================================================================
    if (cfg.logToolCalls) {
      const toolCallHook = createToolCallLogHook({
        udb,
        ruflo: null,
        lanceManager,
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
        udb,
        ruflo: null,
        lanceManager,
        cfg,
        memoryState,
      });

      api.on("agent_end", async (event) => {
        return await agentEndHook(api, event);
      });
    }

    // ========================================================================
    // Tools: Register all four tools
    // ========================================================================
    api.registerTool(createUnifiedSearchTool(udb, lanceManager), { name: "unified_search" });
    api.registerTool(createUnifiedStoreTool(udb, null, lanceManager), { name: "unified_store" });
    api.registerTool(createUnifiedConversationsTool(udb), { name: "unified_conversations" });
    api.registerTool(createUnifiedIndexFilesTool(udb), { name: "unified_index_files" });

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

            // Auto-detect entry type
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

              udb.storeEntry({
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
        api.logger.info?.(`memory-unified: service started (db: ${resolvedDbPath})`);
        // Kick off LanceDB bulk indexing in background (fire and forget)
        if (lanceManager?.isReady()) {
          lanceManager.bulkIndex().catch(err => api.logger.warn?.("memory-unified: LanceDB bulk failed:", String(err)));
        }
      },
      stop: () => {
        // Save LanceDB state before shutdown
        if (lanceManager?.isReady()) {
          lanceManager.save();
          api.logger.info?.("memory-unified: LanceDB saved on shutdown");
        }
        udb.close();
        api.logger.info?.("memory-unified: service stopped");
      },
    });
  },
};

export default memoryUnifiedPlugin;
