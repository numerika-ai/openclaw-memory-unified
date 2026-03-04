/**
 * memory-unified — OpenClaw Plugin
 *
 * Merges USMD SQLite skill memory with Ruflo HNSW vector search.
 * Hooks: before_agent_start (RAG slim), on_tool_call (log to HNSW),
 *        agent_end (trajectory end with success/failure label).
 * CLI:   openclaw ingest <path> — chunk, auto-tag, embed, store.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import Database from "better-sqlite3";
import { unifiedConfigSchema, type UnifiedMemoryConfig, ENTRY_TYPES, type EntryType } from "./src/config";
import { HierarchicalNSW } from "hnswlib-node";

// Import extracted components
import type { PluginApi, ToolResult, ToolDef, RufloHNSW, UnifiedDB } from "./src/types";
import { createUnifiedSearchTool } from "./src/tools/unified-search";
import { createUnifiedStoreTool } from "./src/tools/unified-store";
import { createUnifiedConversationsTool } from "./src/tools/unified-conversations";
import { createRagInjectionHook } from "./src/hooks/rag-injection";
import { createToolCallLogHook, createAgentEndHook } from "./src/hooks/on-turn-end";
import { 
  chunkText, 
  autoTag, 
  summarize, 
  extractKeywords,
  generateThreadId,
  extractTopic,
  extractConversationTags,
  isActionRequest,
  isDecision,
  isResolution
} from "./src/utils/helpers";

// ============================================================================
// Ruflo HNSW bridge — calls MCP tools at runtime
// ============================================================================

/**
 * We don't import Ruflo directly — we call the MCP tools that are already
 * registered in the OpenClaw runtime. This module provides a thin async
 * wrapper that the plugin hooks will use.
 */

// Stub that will be replaced by the runtime tool executor
let ruflo: RufloHNSW | null = null;

/**
 * Direct HTTP bridge to Ruflo MCP server (port 3002).
 * Replaces the file-queue stub with real synchronous calls.
 * Fixed 2026-03-01 by Wiki — original Hermes code used file queue (always returned []).
 */
function createRufloFromApi(api: PluginApi): RufloHNSW {
  const RUFLO_URL = process.env.RUFLO_MCP_URL ?? "http://127.0.0.1:3002/mcp";
  let sessionId: string | null = null;
  let reqId = 0;

  async function mcpCall(toolName: string, args: Record<string, unknown>): Promise<any> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      id: ++reqId,
      params: { name: toolName, arguments: args },
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;

    const resp = await fetch(RUFLO_URL, { method: "POST", headers, body, signal: AbortSignal.timeout(8000) });
    const sid = resp.headers.get("Mcp-Session-Id");
    if (sid) sessionId = sid;

    const text = await resp.text();
    const lines = text.split("\n").filter((l: string) => l.startsWith("data: "));
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.result) return parsed.result;
        if (parsed.error) throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
    try { const p = JSON.parse(text); return p.result ?? p; } catch { /* ignore */ }
    return null;
  }

  return {
    async store(key, value, opts) {
      try {
        const valStr = typeof value === "string" ? value : JSON.stringify(value);
        await mcpCall("memory_store", {
          key, value: valStr,
          namespace: opts?.namespace ?? "unified",
          tags: JSON.stringify(opts?.tags ?? []),
          upsert: true,
        });
      } catch (err) {
        api.logger.warn?.("memory-unified: HNSW store failed:", err);
      }
    },

    async search(query, opts) {
      try {
        const result = await mcpCall("memory_search", {
          query, namespace: opts?.namespace ?? "unified",
          limit: opts?.limit ?? 5, threshold: opts?.threshold ?? 0.3,
        });
        if (result?.content?.[0]?.text) {
          const parsed = JSON.parse(result.content[0].text);
          if (parsed.results && Array.isArray(parsed.results)) {
            return parsed.results.map((r: any) => ({
              key: r.key, value: r.value,
              similarity: r.similarity ?? r.score ?? 0.5,
            }));
          }
        }
        return [];
      } catch (err) {
        api.logger.warn?.("memory-unified: HNSW search failed:", err);
        return [];
      }
    },

    async trajectoryStart(task, agent) {
      const fallbackId = `traj-${Date.now()}-${randomUUID().slice(0, 6)}`;
      try {
        const result = await mcpCall("hooks_intelligence_trajectory-start", {
          task: task.slice(0, 200), agent: agent ?? "memory-unified",
        });
        // Extract real Ruflo trajectory ID from response
        const text = result?.content?.[0]?.text;
        if (text) {
          const parsed = typeof text === "string" ? JSON.parse(text) : text;
          if (parsed.trajectoryId) return parsed.trajectoryId;
        }
        return fallbackId;
      } catch { return fallbackId; }
    },

    async trajectoryStep(trajectoryId, action, result, quality) {
      try {
        await mcpCall("hooks_intelligence_trajectory-step", {
          trajectoryId, action, result: result.slice(0, 200), quality: quality ?? 0.5,
        });
      } catch { /* non-critical */ }
    },

    async trajectoryEnd(trajectoryId, success, feedback) {
      try {
        await mcpCall("hooks_intelligence_trajectory-end", {
          trajectoryId, success, feedback: feedback ?? "",
        });
      } catch { /* non-critical */ }
    },
  };
}

// ============================================================================
// Qwen3 Embedding via Ollama (Spark) — 4096-dim semantic search
// Added 2026-03-02 by Wiki. Falls back gracefully if Spark unreachable.
// ============================================================================
const QWEN_EMBED_URL = process.env.QWEN_EMBED_URL ?? "http://192.168.1.80:11434/v1/embeddings";
const QWEN_MODEL = "qwen3-embedding:8b";

async function qwenEmbed(text: string): Promise<number[] | null> {
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

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Skill embedding cache — loaded lazily on first semantic query
interface SkillEmb { key: string; name: string; embedding: number[]; content: string }
let skillEmbCache: SkillEmb[] | null = null;
let skillEmbLoading = false;

async function loadSkillEmbeddings(db: any, logger: any): Promise<SkillEmb[]> {
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

async function qwenSemanticSearch(query: string, db: any, logger: any, topK = 3): Promise<Array<{ name: string; content: string; similarity: number }>> {
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

// ============================================================================
// Native HNSW Index Manager — hnswlib-node with Qwen3 4096-dim embeddings
// Added 2026-03-02 by Wiki — Phase 0: replaces Ruflo MCP HNSW dependency
// ============================================================================
const HNSW_DIMS = 4096;
const HNSW_MAX_ELEMENTS = 50000;
const HNSW_M = 16;
const HNSW_EF_CONSTRUCTION = 200;
const HNSW_EF_SEARCH = 100;
const HNSW_SAVE_EVERY = 10; // auto-save every N inserts

class NativeHnswManager {
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

// ============================================================================
// DB helper
// ============================================================================
class UnifiedDBImpl implements UnifiedDB {
  public db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initTables();
  }

  private initTables(): void {
    const schemaPath = path.join(__dirname, "..", "schema.sql");
    let sql: string;
    if (fs.existsSync(schemaPath)) {
      sql = fs.readFileSync(schemaPath, "utf-8");
    } else {
      // Inline fallback (unified_entries only — other tables should already exist)
      sql = `
CREATE TABLE IF NOT EXISTS unified_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_type TEXT CHECK(entry_type IN ('skill','protocol','config','history','tool','result','task','file')) NOT NULL,
    tags TEXT, content TEXT NOT NULL, summary TEXT, source_path TEXT,
    hnsw_key TEXT, skill_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_unified_type ON unified_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_unified_hnsw ON unified_entries(hnsw_key);
      `;
    }
    this.db.exec(sql);

    // Migration: allow 'file' entry_type for existing databases
    try {
      this.db.exec("INSERT INTO unified_entries (entry_type, content) VALUES ('file', 'test')");
      this.db.exec("DELETE FROM unified_entries WHERE content = 'test' AND entry_type = 'file'");
    } catch (error) {
      // Need to recreate table with new constraint
      this.db.exec(`
        CREATE TABLE unified_entries_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entry_type TEXT CHECK(entry_type IN ('skill','protocol','config','history','tool','result','task','file')) NOT NULL,
          tags TEXT, content TEXT NOT NULL, summary TEXT, source_path TEXT,
          hnsw_key TEXT, skill_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          memory_type TEXT DEFAULT 'episodic', access_count INTEGER DEFAULT 0,
          last_accessed_at TIMESTAMP, namespace TEXT DEFAULT 'general'
        );
        INSERT INTO unified_entries_v2 SELECT * FROM unified_entries;
        DROP TABLE unified_entries;
        ALTER TABLE unified_entries_v2 RENAME TO unified_entries;
        CREATE INDEX IF NOT EXISTS idx_unified_type ON unified_entries(entry_type);
        CREATE INDEX IF NOT EXISTS idx_unified_hnsw ON unified_entries(hnsw_key);
      `);
    }

    // Pattern learning tables (Phase 1)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name TEXT NOT NULL,
        keywords TEXT NOT NULL,
        confidence REAL DEFAULT 0.5,
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0,
        decay_rate REAL DEFAULT 0.95,
        half_life_days REAL DEFAULT 14,
        parent_id INTEGER,
        version INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_matched_at TIMESTAMP,
        UNIQUE(skill_name, keywords)
      );
      CREATE TABLE IF NOT EXISTS pattern_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_id INTEGER NOT NULL REFERENCES patterns(id),
        event_type TEXT NOT NULL,
        old_confidence REAL,
        new_confidence REAL,
        context TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_patterns_skill ON patterns(skill_name);
      CREATE INDEX IF NOT EXISTS idx_patterns_confidence ON patterns(confidence DESC);
    `);

    // Conversation tracking tables (Phase 5)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT UNIQUE NOT NULL,
        topic TEXT NOT NULL,
        tags TEXT,
        channel TEXT,
        participants TEXT,
        status TEXT DEFAULT 'active',
        priority TEXT DEFAULT 'normal',
        summary TEXT NOT NULL,
        decisions TEXT,
        details TEXT,
        key_facts TEXT,
        related_entries TEXT,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        resolved_at TIMESTAMP,
        message_count INTEGER DEFAULT 0,
        memory_type TEXT DEFAULT 'episodic',
        confidence REAL DEFAULT 0.8,
        decay_rate REAL DEFAULT 0.98,
        last_accessed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER REFERENCES conversations(id),
        role TEXT NOT NULL,
        content_summary TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        has_decision BOOLEAN DEFAULT 0,
        has_action BOOLEAN DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status);
      CREATE INDEX IF NOT EXISTS idx_conv_tags ON conversations(tags);
      CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_conv_thread ON conversations(thread_id);
    `);
  }

  // --- Unified entries ---
  storeEntry(params: {
    entryType: EntryType;
    tags?: string;
    content: string;
    summary?: string;
    sourcePath?: string;
    hnswKey?: string;
    skillId?: number;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO unified_entries (entry_type, tags, content, summary, source_path, hnsw_key, skill_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(
      params.entryType, params.tags ?? null, params.content,
      params.summary ?? null, params.sourcePath ?? null,
      params.hnswKey ?? null, params.skillId ?? null
    );
    return r.lastInsertRowid as number;
  }

  searchEntries(entryType?: EntryType, limit = 20): any[] {
    if (entryType) {
      return this.db.prepare("SELECT * FROM unified_entries WHERE entry_type = ? ORDER BY created_at DESC LIMIT ?").all(entryType, limit);
    }
    return this.db.prepare("SELECT * FROM unified_entries ORDER BY created_at DESC LIMIT ?").all(limit);
  }

  // --- Skills (USMD compat) ---
  getSkillByName(name: string): any | undefined {
    return this.db.prepare("SELECT * FROM skills WHERE name = ?").get(name);
  }

  listSkills(category?: string): any[] {
    if (category) return this.db.prepare("SELECT * FROM skills WHERE category = ? ORDER BY name").all(category);
    return this.db.prepare("SELECT * FROM skills ORDER BY category, name").all();
  }

  getRecentExecutions(limit = 5): any[] {
    return this.db.prepare(`
      SELECT s.name AS skill_name, se.summary, se.status, se.timestamp
      FROM skill_executions se JOIN skills s ON s.id = se.skill_id
      ORDER BY se.timestamp DESC LIMIT ?
    `).all(limit);
  }

  close(): void { this.db.close(); }
}

// ============================================================================
// Plugin Definition
// ============================================================================
const memoryUnifiedPlugin = {
  id: "memory-unified",
  name: "Memory Unified (USMD + HNSW)",
  description: "Unified memory: USMD SQLite for structured skills + Ruflo HNSW for semantic search. RAG slim, tool logging, trajectory tracking.",
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

    ruflo = createRufloFromApi(api);

    // Shared state across hooks
    const memoryState = {
      activeTrajectoryId: null as string | null,
      matchedSkillName: null as string | null,
      matchedSkillId: null as number | null,
      turnPrompt: null as string | null,
    };

    // ========================================================================
    // HNSW Native Index — Phase 0 (replaces Ruflo MCP HNSW)
    // ========================================================================
    const hnswIndexPath = path.join(path.dirname(resolvedDbPath), "skill-memory.hnsw");
    let hnswManager: NativeHnswManager | null = null;
    try {
      hnswManager = new NativeHnswManager(hnswIndexPath, udb.db, api.logger);
      api.logger.info?.(`memory-unified: HNSW manager ready (${hnswManager.getCount()} vectors)`);
    } catch (hnswErr) {
      api.logger.warn?.('memory-unified: HNSW manager init failed, continuing without:', String(hnswErr));
    }

    api.logger.info?.(`memory-unified: initialized (db: ${resolvedDbPath})`);

    // ========================================================================
    // Hook 1: before_agent_start → RAG slim
    // ========================================================================
    if (cfg.ragSlim) {
      const ragHook = createRagInjectionHook({
        udb,
        ruflo,
        hnswManager,
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
    // Hook 2: on_tool_call → log to HNSW with skill tag
    // ========================================================================
    if (cfg.logToolCalls) {
      const toolCallHook = createToolCallLogHook({
        udb,
        ruflo,
        hnswManager,
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
        ruflo,
        hnswManager,
        cfg,
        memoryState,
      });

      api.on("agent_end", async (event) => {
        return await agentEndHook(api, event);
      });
    }

    // ========================================================================
    // File indexing tool
    // ========================================================================
    function createUnifiedIndexFilesTool(udb: UnifiedDB): ToolDef {
      return {
        name: "unified_index_files",
        label: "Index Files",
        description: "Scan a directory and index files into unified memory",
        parameters: Type.Object({
          directory: Type.Optional(Type.String({ 
            description: "Directory to scan (default: workspace)", 
            default: "/home/tank/.openclaw/workspace" 
          })),
          limit: Type.Optional(Type.Number({ 
            description: "Maximum number of files to process (default: 100)", 
            default: 100 
          })),
        }),
        async execute(_id, params): Promise<ToolResult> {
          const directory = params.directory as string || "/home/tank/.openclaw/workspace";
          const limit = params.limit as number || 100;
          
          let processed = 0;
          let skipped = 0;
          const extensions = ['.md', '.txt', '.json', '.ts', '.py', '.sh'];
          
          try {
            const entries = fs.readdirSync(directory, { withFileTypes: true });
            
            for (const entry of entries) {
              if (processed >= limit) break;
              
              if (entry.isFile()) {
                const filePath = path.join(directory, entry.name);
                const ext = path.extname(entry.name).toLowerCase();
                
                if (extensions.includes(ext)) {
                  // Check if already indexed
                  const existing = udb.searchEntries("file").find(
                    (e: any) => e.source_path === filePath
                  );
                  
                  if (existing) {
                    skipped++;
                    continue;
                  }
                  
                  // Read and index file
                  try {
                    const content = fs.readFileSync(filePath, 'utf-8').slice(0, 2000);
                    const relativePath = path.relative("/home/tank/.openclaw/workspace", filePath);
                    
                    // Generate tags from path
                    const pathParts = relativePath.split('/').filter(p => p.length > 0);
                    const tags = pathParts.map(part => 
                      part.replace(/\.(md|txt|json|ts|py|sh)$/, '')
                           .replace(/[^a-zA-Z0-9]/g, '-')
                           .toLowerCase()
                    ).join(',');
                    
                    udb.storeEntry({
                      entryType: "file",
                      content,
                      tags,
                      sourcePath: filePath,
                      summary: `File: ${entry.name} (${content.length} chars)`
                    });
                    
                    processed++;
                  } catch (readError) {
                    // Skip files that can't be read
                    skipped++;
                  }
                }
              }
            }
            
            return {
              content: [{ type: "text", text: `Indexed ${processed} files, skipped ${skipped} files from ${directory}` }],
              details: { processed, skipped, directory }
            };
            
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to scan directory ${directory}: ${error}` }],
            };
          }
        },
      };
    }

    // ========================================================================
    // Tools: Register all four tools
    // ========================================================================
    api.registerTool(createUnifiedSearchTool(udb, ruflo), { name: "unified_search" });
    api.registerTool(createUnifiedStoreTool(udb, ruflo, hnswManager), { name: "unified_store" });
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

              if (ruflo) {
                await ruflo.store(hnswKey, { chunk: chunk.slice(0, 2000), summary: sum, source: file, tags }, { tags: [path.basename(file), ...tags], namespace: "unified" });
              }

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
        // Kick off HNSW bulk indexing in background (fire and forget)
        if (hnswManager?.isReady()) {
          hnswManager.bulkIndex().catch(err => api.logger.warn?.("memory-unified: HNSW bulk failed:", String(err)));
        }
      },
      stop: () => {
        // Save HNSW index before shutdown
        if (hnswManager?.isReady()) {
          hnswManager.save();
          api.logger.info?.("memory-unified: HNSW saved on shutdown");
        }
        udb.close();
        api.logger.info?.("memory-unified: service stopped");
      },
    });
  },
};

export default memoryUnifiedPlugin;