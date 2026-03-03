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
import { unifiedConfigSchema, type UnifiedMemoryConfig, ENTRY_TYPES, type EntryType } from "./config";
import { HierarchicalNSW } from "hnswlib-node";

// ============================================================================
// Minimal OpenClaw Plugin API types (matches runtime contract)
// ============================================================================
interface PluginApi {
  pluginConfig?: Record<string, unknown>;
  resolvePath(input: string): string;
  logger: {
    info?(...args: unknown[]): void;
    warn?(...args: unknown[]): void;
    error?(...args: unknown[]): void;
  };
  registerTool(tool: ToolDef, opts?: { name?: string }): void;
  registerCli(handler: (ctx: { program: any }) => void, opts?: { commands: string[] }): void;
  registerService(svc: { id: string; start: () => void; stop: () => void }): void;
  on(hookName: string, handler: (event: Record<string, unknown>) => unknown, opts?: { priority?: number }): void;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
}

// ============================================================================
// Ruflo HNSW bridge — calls MCP tools at runtime
// ============================================================================

/**
 * We don't import Ruflo directly — we call the MCP tools that are already
 * registered in the OpenClaw runtime. This module provides a thin async
 * wrapper that the plugin hooks will use.
 *
 * In practice the plugin hooks get executed inside the OpenClaw agent loop
 * where these MCP tools are available. For the plugin build we define
 * the interface and at runtime the host injects the actual tool executor.
 */
interface RufloHNSW {
  store(key: string, value: string | object, opts?: { tags?: string[]; namespace?: string }): Promise<void>;
  search(query: string, opts?: { limit?: number; threshold?: number; namespace?: string }): Promise<Array<{ key: string; value: any; similarity: number }>>;
  trajectoryStart(task: string, agent?: string): Promise<string>;
  trajectoryStep(trajectoryId: string, action: string, result: string, quality?: number): Promise<void>;
  trajectoryEnd(trajectoryId: string, success: boolean, feedback?: string): Promise<void>;
}

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
class UnifiedDB {
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
    entry_type TEXT CHECK(entry_type IN ('skill','protocol','config','history','tool','result')) NOT NULL,
    tags TEXT, content TEXT NOT NULL, summary TEXT, source_path TEXT,
    hnsw_key TEXT, skill_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_unified_type ON unified_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_unified_hnsw ON unified_entries(hnsw_key);
      `;
    }
    this.db.exec(sql);

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
// Chunking utility for CLI ingest
// ============================================================================
function chunkText(text: string, maxTokens = 500): string[] {
  // Approximate: 1 token ≈ 4 chars
  const maxChars = maxTokens * 4;
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function autoTag(text: string): string[] {
  const tags: string[] = [];
  if (/\bfunction\b|\bclass\b|\bimport\b|\bexport\b/i.test(text)) tags.push("code");
  if (/\bstep\s+\d/i.test(text) || /procedure|workflow/i.test(text)) tags.push("procedure");
  if (/\bconfig|\.env|settings|parameter/i.test(text)) tags.push("config");
  if (/\btest|assert|expect|jest|vitest/i.test(text)) tags.push("testing");
  if (/\bdocker|deploy|ci\/cd|kubernetes/i.test(text)) tags.push("devops");
  if (/\bapi|endpoint|route|http/i.test(text)) tags.push("api");
  if (/\bsecurity|auth|token|encrypt/i.test(text)) tags.push("security");
  if (tags.length === 0) tags.push("general");
  return tags;
}

function summarize(text: string, maxTokens = 25): string {
  // Ultra-slim: first sentence or first N chars
  const firstSentence = text.match(/^[^\n.!?]*[.!?]/);
  const raw = firstSentence ? firstSentence[0] : text.slice(0, maxTokens * 4);
  return raw.slice(0, maxTokens * 4).trim();
}


// ============================================================================
// Pattern Learning — Phase 1 (keyword extraction + temporal decay)
// Added 2026-03-02 by Wiki — extracted from Ruflo's pattern schema concept
// ============================================================================

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one',
  'our', 'out', 'day', 'had', 'has', 'his', 'how', 'its', 'may', 'new', 'now', 'old',
  'see', 'way', 'who', 'did', 'get', 'let', 'say', 'she', 'too', 'use', 'from', 'this',
  'that', 'with', 'have', 'will', 'been', 'what', 'when', 'where', 'which', 'there',
  'their', 'them', 'then', 'than', 'these', 'those', 'some', 'other', 'about', 'into',
  'your', 'just', 'also', 'more', 'would', 'could', 'should', 'each', 'make', 'like',
  'nie', 'tak', 'jest', 'ale', 'czy', 'jak', 'ten', 'tam', 'dla', 'pod', 'nad',
  'bez', 'przez', 'przy', 'przed', 'tylko', 'jeszcze', 'tego', 'jako', 'jego',
  'system', 'utc', 'whatsapp', 'gateway', 'connected', 'please', 'thanks', 'hello',
  'agent', 'tool', 'result', 'content', 'text', 'data', 'file', 'name', 'type',
]);

function extractKeywords(text: string): string[] {
  if (!text) return [];
  return [...new Set(
    (text.toLowerCase().match(/[a-ząćęłńóśźż]{3,}/g) || [])
      .filter(w => !STOP_WORDS.has(w))
      .slice(0, 10)
  )];
}

/**
 * Daily decay — reduces confidence of all patterns by decay_rate.
 * Can be called from cron or manually.
 * Patterns below 0.05 are effectively dormant.
 */
function decayPatterns(db: any): number {
  const patterns = db.prepare(
    "SELECT id, confidence, decay_rate FROM patterns WHERE confidence > 0.1"
  ).all() as Array<{ id: number; confidence: number; decay_rate: number }>;

  for (const p of patterns) {
    const newConf = Math.max(0.05, p.confidence * p.decay_rate);
    if (Math.abs(newConf - p.confidence) > 0.001) {
      db.prepare(
        "UPDATE patterns SET confidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(newConf, p.id);
      db.prepare(
        "INSERT INTO pattern_history (pattern_id, event_type, old_confidence, new_confidence) VALUES (?, 'decay', ?, ?)"
      ).run(p.id, p.confidence, newConf);
    }
  }
  return patterns.length;
}

// ============================================================================
// Conversation Tracking Helpers - Phase 5
// Added 2026-03-03 by Wiki - conversation thread tracking with 3-layer arch
// ============================================================================

function generateThreadId(topic: string): string {
  const date = new Date().toISOString().split('T')[0];
  const slug = topic.toLowerCase()
    .replace(/[^a-z\u0105\u0107\u0119\u0142\u0144\u00f3\u015b\u017a\u017c0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${date}:${slug}`;
}

function extractTopic(prompt: string): string {
  let clean = prompt;
  // Strip WhatsApp/audio metadata
  clean = clean.replace(/\[Audio\]\s*/gi, '');
  clean = clean.replace(/User text:\s*/gi, '');
  clean = clean.replace(/\[WhatsApp\s+[^\]]*\]\s*(<media:\w+>)?\s*/gi, '');
  clean = clean.replace(/Transcript:\s*/gi, '');
  // Strip system/cron/subagent prefixes
  clean = clean.replace(/^System:\s*\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/i, '');
  clean = clean.replace(/^\s*\[?cron:[a-f0-9-]+\s+[\w-]+\]?\s*/i, '');
  clean = clean.replace(/^\s*\[Subagent Context\][^.]*\.\s*/i, '');
  // Strip remaining bracket metadata
  clean = clean.replace(/\[.*?\]/g, '');
  clean = clean.trim();
  if (clean.length < 5) return 'misc';
  if (clean.length <= 60) return clean;
  const firstSentence = clean.match(/^[^.!?\n]+[.!?]?/)?.[0];
  return (firstSentence || clean.slice(0, 60)).trim();
}

function extractConversationTags(prompt: string, matchedSkill?: string): string[] {
  const tags: string[] = [];
  if (matchedSkill) tags.push(matchedSkill);

  const domains: [string, RegExp][] = [
    ['memory', /memo|pami\u0119\u0107|hnsw|embed|vector|baz[aey] dan/i],
    ['trading', /trad|bot|hyperliquid|binance|pnl|spread|arbitr/i],
    ['infrastructure', /docker|systemd|ram|cpu|spark|tank|server|nginx/i],
    ['openclaw', /openclaw|gateway|plugin|config|restart|kompak/i],
    ['tts', /g\u0142os\u00f3w|voice|piper|radio|audycj|tts/i],
    ['coding', /kod|code|claude|script|html|typescript|python/i],
    ['task', /task|focalboard|kanban|sprint|priory/i],
  ];
  for (const [tag, re] of domains) {
    if (re.test(prompt)) tags.push(tag);
  }
  return [...new Set(tags)].slice(0, 5);
}

function isActionRequest(text: string): boolean {
  return /zr\u00f3b|stw\u00f3rz|sprawdź|wyłącz|włącz|zapisz|dodaj|usuń|napraw|wdro\u017c|odpal|uruchom|zatrzymaj|wy\u015blij/i.test(text);
}

function isDecision(text: string): boolean {
  return /zdecydowa\u0142|decyzja|robimy|wybieramy|plan:|zatwierdzam|ok ruszaj|tak prosz\u0119|lecimy/i.test(text);
}

function isResolution(text: string): boolean {
  return /\u2705|done|gotowe|zrobione|zako\u0144czon|wdro\u017con|naprawion/i.test(text);
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

    let udb: UnifiedDB;
    try {
      udb = new UnifiedDB(resolvedDbPath);
    } catch (err) {
      api.logger.error?.("memory-unified: DB init failed:", err);
      throw err;
    }

    ruflo = createRufloFromApi(api);
    let activeTrajectoryId: string | null = null;
    let matchedSkillName: string | null = null;
    let matchedSkillId: number | null = null;
    let turnPrompt: string | null = null;


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
      api.on("before_agent_start", async (event) => {
        const prompt = event.prompt as string | undefined;
        if (!prompt || prompt.length < 5) return;

        try {
          const slimLines: string[] = [];
          let matchedProcedure: string | null = null;

          // ============================================================
          // STEP 1: FTS5 full-text search for matching SKILLS (priority)
          // Searches full SKILL.md content, not just descriptions.
          // Fixed 2026-03-02 by Wiki — replaces broken HNSW-only search.
          // ============================================================
          try {
            // Extract keywords from prompt (simple: split on spaces, take 3+ char words)
            const keywords = (prompt.match(/[a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ]{3,}/g) || [])
              .slice(0, 10)
              .join(" OR ");

            if (keywords.length > 0) {
              const ftsResults = udb.db.prepare(`
                SELECT ue.hnsw_key, ue.content, ue.source_path, ue.summary,
                       length(ue.content) as content_len
                FROM unified_fts fts
                JOIN unified_entries ue ON ue.id = fts.rowid
                WHERE unified_fts MATCH ?
                AND ue.entry_type = 'skill'
                ORDER BY rank
                LIMIT 3
              `).all(keywords);

              for (const r of ftsResults as any[]) {
                const name = (r.hnsw_key || "").replace("skill-full:", "").replace("skill:", "");
                const contentLen = r.content_len || 0;

                if (contentLen > 500) {
                  // Full skill found — inject PROCEDURE, not just name
                  slimLines.push(`[SKILL MATCH] ${name} (${contentLen}B full procedure available)`);
                  // Take the BEST match as the enforced procedure
                  if (!matchedProcedure && r.content) {
                    matchedProcedure = r.content.slice(0, 4000);
                    // Remember which skill matched for agent_end logging
                    matchedSkillName = name;
                    turnPrompt = prompt.slice(0, 500);
                    // Look up skill ID for execution logging
                    try {
                      const skill = udb.getSkillByName(name);
                      if (skill) matchedSkillId = skill.id;
                    } catch {}
                  }
                } else {
                  slimLines.push(`[skill] ${name}: ${(r.summary || "").slice(0, 80)}`);
                }
              }

              if (ftsResults.length > 0) {
                api.logger.info?.(`memory-unified: FTS5 found ${ftsResults.length} skills for: ${keywords.slice(0, 50)}`);
              }
            }
          } catch (ftsErr) {
            // FTS5 table might not exist yet — fallback gracefully
            api.logger.warn?.("memory-unified: FTS5 search failed (table may need rebuild):", ftsErr);
          }

          // ============================================================
          // STEP 2: History for matched skill (past conversations)
          // ============================================================
          if (matchedSkillName) {
            try {
              const skillObj = udb.getSkillByName(matchedSkillName);
              if (skillObj) {
                const history = udb.db.prepare(`
                  SELECT summary, status, timestamp FROM skill_executions
                  WHERE skill_id = ? ORDER BY timestamp DESC LIMIT 3
                `).all(skillObj.id) as any[];
                for (const h of history) {
                  slimLines.push(`[history] ${matchedSkillName} (${h.timestamp}): ${h.status} — ${(h.summary || "").slice(0, 120)}`);
                }
                if (history.length > 0) {
                  api.logger.info?.(`memory-unified: injecting ${history.length} past executions for ${matchedSkillName}`);
                }
              }
            } catch {}
          }

          // Recent executions across all skills
          const recentSkills = udb.getRecentExecutions(3);
          for (const s of recentSkills) {
            slimLines.push(`[recent] ${s.skill_name}: ${s.status}`);
          }


          // ============================================================
          // STEP 2.5: Native HNSW vector search (4096-dim Qwen3)
          // Searches ALL entry types via real semantic similarity.
          // Added 2026-03-02 by Wiki — Phase 0 native HNSW.
          // ============================================================
          if (hnswManager?.isReady()) {
            try {
              const hnswResults = await hnswManager.search(prompt, 5);
              if (hnswResults.length > 0) {
                // Fetch matched entries from SQLite
                const hnswEntryIds = hnswResults.map(r => r.entryId);
                const placeholders = hnswEntryIds.map(() => '?').join(',');
                const hnswEntries = udb.db.prepare(
                  `SELECT id, entry_type, content, summary, hnsw_key FROM unified_entries WHERE id IN (${placeholders})`
                ).all(...hnswEntryIds) as any[];

                const entryMap = new Map(hnswEntries.map((e: any) => [e.id, e]));

                for (const hr of hnswResults) {
                  const entry = entryMap.get(hr.entryId);
                  if (!entry) continue;
                  const sim = 1 - hr.distance; // cosine distance → similarity
                  if (sim < 0.35) continue; // threshold

                  const name = (entry.hnsw_key || '').replace(/^(skill-full|skill|tool|history|config):/, '');

                  if (entry.entry_type === 'skill' && (entry.content || '').length > 500 && !matchedProcedure) {
                    // Full skill found via HNSW — inject as procedure
                    matchedProcedure = (entry.content as string).slice(0, 4000);
                    matchedSkillName = name;
                    turnPrompt = prompt.slice(0, 500);
                    try {
                      const skill = udb.getSkillByName(name);
                      if (skill) matchedSkillId = skill.id;
                    } catch {}
                    slimLines.push(`[HNSW MATCH] ${name} (${(sim * 100).toFixed(0)}% semantic, ${entry.entry_type})`);
                    api.logger.info?.(`memory-unified: HNSW matched skill: ${name} (${(sim * 100).toFixed(0)}%)`);
                  } else {
                    slimLines.push(`[hnsw] ${name || entry.entry_type}:${entry.id} (${(sim * 100).toFixed(0)}%): ${(entry.summary || '').slice(0, 80)}`);
                  }
                }

                if (hnswResults.length > 0) {
                  api.logger.info?.(`memory-unified: HNSW found ${hnswResults.length} entries for prompt`);
                }
              }
            } catch (hnswErr) {
              // HNSW search failed — FTS5 is primary, this is supplementary
              api.logger.warn?.('memory-unified: HNSW search in RAG failed:', hnswErr);
            }
          }
          // ============================================================
          // STEP 3: Qwen3 4096-dim semantic search (Spark Ollama)
          // Catches fuzzy/semantic queries that FTS5 keywords miss.
          // Added 2026-03-02 by Wiki — replaces broken HNSW 128-dim.
          // ============================================================
          if (!matchedProcedure) {
            try {
              const qwenResults = await qwenSemanticSearch(prompt, udb.db, api.logger, 2);
              for (const r of qwenResults) {
                if (r.content.length > 500 && !matchedProcedure) {
                  matchedProcedure = r.content.slice(0, 4000);
                  matchedSkillName = r.name;
                  turnPrompt = prompt.slice(0, 500);
                  try {
                    const skill = udb.getSkillByName(r.name);
                    if (skill) matchedSkillId = skill.id;
                  } catch {}
                  slimLines.push(`[QWEN MATCH] ${r.name} (${(r.similarity * 100).toFixed(0)}% semantic)`);
                  api.logger.info?.(`memory-unified: Qwen semantic match: ${r.name} (${(r.similarity * 100).toFixed(0)}%)`);
                } else {
                  slimLines.push(`[qwen] ${r.name} (${(r.similarity * 100).toFixed(0)}%)`);
                }
              }
            } catch (qErr) {
              // Qwen/Spark unreachable — FTS5 is primary, this is supplementary
              api.logger.warn?.("memory-unified: Qwen search failed (Spark may be down):", qErr);
            }
          }


          // ============================================================
          // STEP 2.7: Pattern-based boosting (Phase 1)
          // Checks learned patterns for keyword overlap with prompt.
          // Added 2026-03-02 by Wiki — Phase 1 pattern learning.
          // ============================================================
          try {
            const promptKeywords = extractKeywords(prompt);
            if (promptKeywords.length >= 2) {
              const allPatterns = udb.db.prepare(
                "SELECT skill_name, keywords, confidence FROM patterns WHERE confidence > 0.3 ORDER BY confidence DESC LIMIT 20"
              ).all() as Array<{ skill_name: string; keywords: string; confidence: number }>;

              for (const pattern of allPatterns) {
                const patternKw: string[] = JSON.parse(pattern.keywords);
                const overlap = patternKw.filter(kw => promptKeywords.includes(kw)).length;
                const overlapRatio = overlap / patternKw.length;

                // If >50% keyword overlap and good confidence, boost this skill
                if (overlapRatio > 0.5 && pattern.confidence > 0.4) {
                  if (!matchedSkillName || matchedSkillName !== pattern.skill_name) {
                    slimLines.push(`[pattern] ${pattern.skill_name} (${(pattern.confidence * 100).toFixed(0)}% confidence, ${(overlapRatio * 100).toFixed(0)}% keyword overlap)`);
                  }
                }
              }

              if (allPatterns.length > 0) {
                api.logger.info?.(`memory-unified: Pattern boost checked ${allPatterns.length} patterns against ${promptKeywords.length} keywords`);
              }
            }
          } catch (patternErr) {
            // Pattern matching should never block the agent
            api.logger.warn?.("memory-unified: pattern boost failed:", patternErr);
          }

          // ============================================================
          // STEP 2.8: CONVERSATION CONTEXT (Phase 5)
          // Injects active conversation threads for continuity.
          // Added 2026-03-03 by Wiki.
          // ============================================================
          try {
            const activeConversations = udb.db.prepare(`
              SELECT topic, tags, summary, status, message_count, updated_at
              FROM conversations
              WHERE status = 'active'
              AND updated_at > datetime('now', '-24 hours')
              AND confidence > 0.3
              ORDER BY updated_at DESC
              LIMIT 5
            `).all() as any[];

            if (activeConversations.length > 0) {
              slimLines.push('[active threads]');
              for (const conv of activeConversations) {
                const convTags = JSON.parse(conv.tags || '[]').join(', ');
                slimLines.push(`  ${conv.topic.slice(0,60)} (${convTags}) \u2014 ${conv.summary.slice(0,80)}`);
              }
            }
          } catch (convCtxErr) {
            api.logger.warn?.('memory-unified: conversation context error:', String(convCtxErr));
          }

          if (slimLines.length === 0 && !matchedProcedure) return;

          // ============================================================
          // BUILD CONTEXT: If we matched a full skill, inject the procedure
          // ============================================================
          let contextBlock: string;
          if (matchedProcedure) {
            contextBlock = `<unified-memory>\n## Matched Skill Procedure (USE THIS):\n${matchedProcedure}\n\n## Other context:\n${slimLines.join("\n")}\n</unified-memory>`;
            api.logger.info?.("memory-unified: ENFORCING skill procedure in context");
          } else {
            contextBlock = `<unified-memory>\nSlim RAG context:\n${slimLines.join("\n")}\n</unified-memory>`;
          }

          api.logger.info?.(`memory-unified: RAG injecting ${slimLines.length} entries (procedure: ${!!matchedProcedure})`);

          // ============================================================
          // DYNAMIC TOOL ROUTING — reduce tools sent to LLM
          // If a skill was matched AND has required_tools, set dynamic
          // tool policy via globalThis. OpenClaw's patched pipeline
          // reads this and filters tools accordingly.
          // Added 2026-03-02 by Wiki — tool-router feature.
          // ============================================================
          if (matchedSkillName) {
            try {
              const skill = udb.getSkillByName(matchedSkillName);
              if (skill && (skill as any).required_tools) {
                const requiredTools: string[] = JSON.parse((skill as any).required_tools);
                if (requiredTools.length > 0) {
                  // Set dynamic tool policy — OpenClaw's patched pipeline reads this
                  (globalThis as any).__openclawDynamicToolPolicy = {
                    allow: requiredTools
                  };
                  api.logger.info?.(
                    `memory-unified: TOOL ROUTING — skill "${matchedSkillName}" → ${requiredTools.length} tools: [${requiredTools.join(", ")}]`
                  );
                }
              }
            } catch (toolRouteErr) {
              api.logger.warn?.("memory-unified: tool routing failed:", String(toolRouteErr));
              // Clear on error — fallback to full tool list
              (globalThis as any).__openclawDynamicToolPolicy = undefined;
            }
          } else {
            // No skill matched — clear any stale policy, allow all tools
            (globalThis as any).__openclawDynamicToolPolicy = undefined;
          }

          // Start trajectory if enabled
          if (cfg.trajectoryTracking && ruflo) {
            try {
              activeTrajectoryId = await ruflo.trajectoryStart(
                prompt.slice(0, 200),
                "memory-unified"
              );
            } catch {}
          }

          return { prependContext: contextBlock };
        } catch (err) {
          api.logger.warn?.("memory-unified: RAG failed:", err);
        }
      });
    }

    // ========================================================================
    // Hook 2: on_tool_call → log to HNSW with skill tag
    // ========================================================================
    if (cfg.logToolCalls) {
      api.on("after_tool_call", async (event) => {
        try {
          // OpenClaw may pass tool info in different field names
          const toolName = (event.toolName ?? event.name ?? event.tool ?? "unknown") as string;
          const params = (event.params ?? event.arguments ?? event.input) as Record<string, unknown> | undefined;
          const result = (event.result ?? event.output ?? "") as string;
          const error = (event.error ?? event.err) as string | undefined;

          // Skip our own tools and internal tools
          if (toolName.startsWith("skill_") || toolName.startsWith("unified_") || toolName === "artifact_register") return;
          if (toolName === "unknown") return;

          const paramsPreview = params ? JSON.stringify(params).slice(0, 500) : "";
          const resultStr = typeof result === "string" ? result : JSON.stringify(result ?? "");
          const resultPreview = error ? `ERROR: ${error}`.slice(0, 300) : resultStr.slice(0, 300);
          const status = error ? "error" : "success";

          // Store in SQLite unified_entries
          const tags = autoTag(`${toolName} ${paramsPreview}`);
          const summary = `${toolName}(${status}): ${paramsPreview.slice(0, 80)}`;
          const hnswKey = `tool:${toolName}:${Date.now()}`;

          const toolEntryId = udb.storeEntry({
            entryType: "tool",
            tags: tags.join(","),
            content: JSON.stringify({ tool: toolName, params: paramsPreview, result: resultPreview, status }),
            summary,
            hnswKey,
          });

          // Store in HNSW (fire and forget, don't block agent)
          if (ruflo) {
            ruflo.store(hnswKey, { tool: toolName, summary, status, tags }, { tags: [toolName, ...tags], namespace: "unified" }).catch(() => {});

          // Native HNSW indexing (fire and forget, don't block agent)
          if (hnswManager?.isReady()) {
            hnswManager.addEntry(toolEntryId, summary).catch(() => {});
          }
          }

          // ============================================================
          // MoE Auto-Routing: when sessions_spawn is called, log the
          // model routing decision to Ruflo for learning.
          // Added 2026-03-02 by Wiki — enforces MoE at plugin level.
          // ============================================================
          if (toolName === "sessions_spawn" && ruflo && params) {
            try {
              const task = (params.task ?? params.message ?? "") as string;
              const modelUsed = (params.model ?? "unknown") as string;

              // Log routing decision as pattern
              const routingPattern = `moe-route: task="${task.slice(0, 100)}" → model=${modelUsed}`;
              await ruflo.store(`moe:${Date.now()}`, routingPattern, {
                tags: ["moe", "model-routing", modelUsed],
                namespace: "pattern",
              });

              api.logger.info?.(`memory-unified: MoE logged: ${modelUsed} for "${task.slice(0, 50)}"`);
            } catch {} // non-critical
          }

          // Trajectory step (fire and forget)
          if (activeTrajectoryId && ruflo) {
            ruflo.trajectoryStep(activeTrajectoryId, `tool:${toolName}`, status, status === "success" ? 0.8 : 0.2).catch(() => {});
          }
        } catch (err) {
          // Silently skip — tool logging should never break the agent
          api.logger.warn?.("memory-unified: tool log failed:", String(err).slice(0, 100));
        }
      });
    }

    // ========================================================================
    // Hook 3: agent_end → trajectory end + tool policy cleanup
    // ========================================================================
    if (cfg.trajectoryTracking) {
      api.on("agent_end", async (event) => {
        // Always clear dynamic tool policy — prevent stale policies across turns
        (globalThis as any).__openclawDynamicToolPolicy = undefined;

        try {
          const success = event.success !== false;
          const response = (event.response ?? event.output ?? event.reply ?? "") as string;
          const responsePreview = typeof response === "string" ? response.slice(0, 500) : JSON.stringify(response).slice(0, 500);

          // ============================================================
          // SKILL EXECUTION LOGGING — closes the learning loop
          // If a skill was matched in before_agent_start, log what happened.
          // Next time this skill is triggered, history is injected.
          // Added 2026-03-02 by Wiki.
          // ============================================================
          if (matchedSkillName && matchedSkillId) {
            try {
              const summary = `${turnPrompt?.slice(0, 100) ?? "?"} → ${responsePreview.slice(0, 200)}`;
              udb.db.prepare(`
                INSERT INTO skill_executions (skill_id, summary, status, output_summary, session_key)
                VALUES (?, ?, ?, ?, ?)
              `).run(
                matchedSkillId,
                summary,
                success ? "success" : "error",
                responsePreview.slice(0, 1000),
                event.sessionKey ?? "unknown"
              );

              // Update skill use_count and success_rate
              udb.db.prepare(`
                UPDATE skills SET 
                  use_count = use_count + 1,
                  last_used = CURRENT_TIMESTAMP,
                  success_rate = (success_rate * use_count + ?) / (use_count + 1)
                WHERE id = ?
              `).run(success ? 1.0 : 0.0, matchedSkillId);

              api.logger.info?.(`memory-unified: logged execution for skill "${matchedSkillName}" (${success ? "success" : "error"})`);

              // Feed Ruflo Intelligence — store pattern from successful executions
              if (success && ruflo) {
                try {
                  const patternKey = `pattern:skill:${matchedSkillName}:${Date.now()}`;
                  const patternVal = `skill:${matchedSkillName} | query: ${turnPrompt?.slice(0, 100)} | result: success | ts: ${new Date().toISOString()}`;
                  await ruflo.store(patternKey, patternVal, {
                    tags: ["pattern", "skill-execution", matchedSkillName],
                    namespace: "pattern",
                  });
                } catch {} // non-critical
              }

              // ============================================================
              // PATTERN EXTRACTION (Phase 1)
              // Extract keywords from prompt and upsert pattern with confidence.
              // Added 2026-03-02 by Wiki — Phase 1 pattern learning.
              // ============================================================
              try {
                const keywords = extractKeywords(turnPrompt || "");
                if (keywords.length >= 3) {
                  const keywordsJson = JSON.stringify(keywords.sort());

                  const existing = udb.db.prepare(
                    "SELECT id, confidence, success_count FROM patterns WHERE skill_name = ? AND keywords = ?"
                  ).get(matchedSkillName, keywordsJson) as { id: number; confidence: number; success_count: number } | undefined;

                  if (existing) {
                    // Boost confidence: +0.03 per success, cap at 0.95
                    const newConf = Math.min(0.95, existing.confidence + 0.03);
                    udb.db.prepare(
                      "UPDATE patterns SET confidence = ?, success_count = success_count + 1, updated_at = CURRENT_TIMESTAMP, last_matched_at = CURRENT_TIMESTAMP WHERE id = ?"
                    ).run(newConf, existing.id);
                    udb.db.prepare(
                      "INSERT INTO pattern_history (pattern_id, event_type, old_confidence, new_confidence, context) VALUES (?, 'success', ?, ?, ?)"
                    ).run(existing.id, existing.confidence, newConf, (turnPrompt || "").slice(0, 200));
                    api.logger.info?.(`memory-unified: pattern boosted for "${matchedSkillName}" (${existing.confidence.toFixed(2)} -> ${newConf.toFixed(2)})`);
                  } else {
                    // New pattern starts at 0.5
                    const info = udb.db.prepare(
                      "INSERT INTO patterns (skill_name, keywords, confidence) VALUES (?, ?, 0.5)"
                    ).run(matchedSkillName, keywordsJson);
                    // Log creation in history
                    if (info.lastInsertRowid) {
                      udb.db.prepare(
                        "INSERT INTO pattern_history (pattern_id, event_type, old_confidence, new_confidence, context) VALUES (?, 'created', 0, 0.5, ?)"
                      ).run(info.lastInsertRowid, (turnPrompt || "").slice(0, 200));
                    }
                    api.logger.info?.(`memory-unified: new pattern created for "${matchedSkillName}" with ${keywords.length} keywords`);
                  }
                }
              } catch (patErr) {
                api.logger.warn?.("memory-unified: pattern extraction failed:", patErr);
              }

            } catch (logErr) {
              api.logger.warn?.("memory-unified: skill execution log failed:", logErr);
            }
          }


          // ============================================================
          // PATTERN FAILURE (Phase 1)
          // If a skill was matched but the turn failed, reduce confidence
          // of all patterns for that skill.
          // Added 2026-03-02 by Wiki — Phase 1 pattern learning.
          // ============================================================
          if (matchedSkillName && !success) {
            try {
              const failPatterns = udb.db.prepare(
                "SELECT id, confidence FROM patterns WHERE skill_name = ?"
              ).all(matchedSkillName) as Array<{ id: number; confidence: number }>;

              for (const p of failPatterns) {
                const newConf = Math.max(0.05, p.confidence - 0.05);
                udb.db.prepare(
                  "UPDATE patterns SET confidence = ?, failure_count = failure_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
                ).run(newConf, p.id);
                udb.db.prepare(
                  "INSERT INTO pattern_history (pattern_id, event_type, old_confidence, new_confidence) VALUES (?, 'failure', ?, ?)"
                ).run(p.id, p.confidence, newConf);
              }

              if (failPatterns.length > 0) {
                api.logger.info?.(`memory-unified: reduced confidence for ${failPatterns.length} patterns of "${matchedSkillName}" (failure)`);
              }
            } catch (failPatErr) {
              api.logger.warn?.("memory-unified: pattern failure update failed:", failPatErr);
            }
          }

          // ============================================================
          // CONVERSATION TRACKING (Phase 5)
          // Track conversation threads with 3-layer architecture.
          // Added 2026-03-03 by Wiki.
          // ============================================================
          try {
            const convPrompt = turnPrompt || "";
            const convResponse = responsePreview || "";

            if (convPrompt.length > 20) {
              // Skip cron heartbeats, subagent contexts, and system reconnects
              const skipConv = /^\s*\[?cron:|HEARTBEAT_OK|\[Subagent Context\]|Auto-handoff check|WhatsApp gateway (dis)?connected/i.test(convPrompt);
              if (skipConv) {
                api.logger.info?.('memory-unified: CONV SKIP (system/cron message)');
                throw new Error('skip');  // caught by outer try/catch, no-op
              }
              const topic = extractTopic(convPrompt);
              const convTags = extractConversationTags(convPrompt, matchedSkillName || undefined);
              const channel = convPrompt.match(/\[WhatsApp|Mattermost|Discord/i)?.[0]?.replace('[','') || 'unknown';

              // Find existing active conversation with similar tags
              const recentConversations = udb.db.prepare(
                "SELECT id, thread_id, topic, tags, summary, message_count, details FROM conversations WHERE status = 'active' AND updated_at > datetime('now', '-2 hours') ORDER BY updated_at DESC LIMIT 5"
              ).all() as any[];

              let conversationId: number | null = null;
              let isNewConversation = true;

              for (const conv of recentConversations) {
                const existingTags: string[] = JSON.parse(conv.tags || '[]');
                const overlap = convTags.filter(t => existingTags.includes(t)).length;
                if (overlap >= 1 || conv.topic.toLowerCase().includes(topic.toLowerCase().slice(0, 20))) {
                  conversationId = conv.id;
                  isNewConversation = false;

                  const newSummary = convResponse.length > 50
                    ? convResponse.slice(0, 150).replace(/\n/g, ' ').trim()
                    : conv.summary;

                  udb.db.prepare(`
                    UPDATE conversations
                    SET summary = ?,
                        message_count = message_count + 1,
                        updated_at = CURRENT_TIMESTAMP,
                        last_accessed_at = CURRENT_TIMESTAMP,
                        tags = ?,
                        details = CASE WHEN length(details || '') < 2000
                          THEN (COALESCE(details, '') || char(10) || ?)
                          ELSE details END
                    WHERE id = ?
                  `).run(
                    newSummary,
                    JSON.stringify([...new Set([...existingTags, ...convTags])]),
                    `[${new Date().toISOString().slice(11,16)}] ${topic.slice(0, 80)}`,
                    conversationId
                  );
                  break;
                }
              }

              if (isNewConversation) {
                const threadId = generateThreadId(topic);
                const summary = convResponse.length > 50
                  ? convResponse.slice(0, 150).replace(/\n/g, ' ').trim()
                  : topic;

                const result = udb.db.prepare(`
                  INSERT OR IGNORE INTO conversations (thread_id, topic, tags, channel, participants, summary, details, key_facts)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                  threadId,
                  topic.slice(0, 200),
                  JSON.stringify(convTags),
                  channel,
                  JSON.stringify(['bartosz', 'wiki']),
                  summary,
                  `[${new Date().toISOString().slice(11,16)}] ${topic.slice(0, 200)}`,
                  JSON.stringify([])
                );
                conversationId = result.lastInsertRowid as number;
              }

              if (conversationId) {
                const userSummary = convPrompt.slice(0, 200).replace(/\n/g, ' ').trim();
                const assistantSummary = convResponse.slice(0, 200).replace(/\n/g, ' ').trim();

                if (userSummary.length > 10) {
                  udb.db.prepare(`
                    INSERT INTO conversation_messages (conversation_id, role, content_summary, has_decision, has_action)
                    VALUES (?, 'user', ?, ?, ?)
                  `).run(conversationId, userSummary, isDecision(convPrompt) ? 1 : 0, isActionRequest(convPrompt) ? 1 : 0);
                }

                if (assistantSummary.length > 10) {
                  udb.db.prepare(`
                    INSERT INTO conversation_messages (conversation_id, role, content_summary, has_decision, has_action)
                    VALUES (?, 'assistant', ?, ?, ?)
                  `).run(conversationId, assistantSummary, isResolution(convResponse) ? 1 : 0, 0);
                }

                if (isResolution(convResponse) && isNewConversation) {
                  udb.db.prepare("UPDATE conversations SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?")
                    .run(conversationId);
                }
              }

              api.logger.info?.(`memory-unified: CONV ${isNewConversation ? 'NEW' : 'UPDATE'} thread=${conversationId} topic="${topic.slice(0,40)}" tags=${convTags.join(',')}`);
            }
          } catch (convErr) {
            api.logger.warn?.('memory-unified: conversation tracking error:', String(convErr));
          }

          // Trajectory end (Ruflo SONA)
          if (activeTrajectoryId && ruflo) {
            try {
              await ruflo.trajectoryEnd(
                activeTrajectoryId,
                success,
                matchedSkillName ? `Skill: ${matchedSkillName}` : "No skill matched"
              );
            } catch {}
          }

          api.logger.info?.(`memory-unified: turn ended (skill: ${matchedSkillName ?? "none"}, success: ${success})`);
        } catch (err) {
          api.logger.warn?.("memory-unified: agent_end failed:", err);
        } finally {
          activeTrajectoryId = null;
          matchedSkillName = null;
          matchedSkillId = null;
          turnPrompt = null;
        }
      });
    }

    // ========================================================================
    // Tool: unified_search — search across USMD + HNSW
    // ========================================================================
    api.registerTool({
      name: "unified_search",
      label: "Unified Memory Search",
      description: "Search across USMD skills and HNSW vector memory. Combines structured SQL + semantic search.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        type: Type.Optional(Type.String({ description: "Filter by entry type: skill/protocol/config/history/tool/result" })),
        limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
      }),
      async execute(_id, params) {
        const query = params.query as string;
        const entryType = params.type as EntryType | undefined;
        const limit = (params.limit as number) ?? 10;

        const sqlResults = udb.searchEntries(entryType, limit);
        let hnswResults: any[] = [];
        if (ruflo) {
          try {
            hnswResults = await ruflo.search(query, { limit, namespace: "unified" });
          } catch {}
        }

        const lines = [
          `## SQL results (${sqlResults.length}):`,
          ...sqlResults.map((e: any) => `- [${e.entry_type}] ${e.summary || e.content?.slice(0, 100)}`),
          `\n## HNSW results (${hnswResults.length}):`,
          ...hnswResults.map((r: any) => `- [${(r.similarity * 100).toFixed(0)}%] ${r.key}: ${typeof r.value === "string" ? r.value.slice(0, 100) : JSON.stringify(r.value).slice(0, 100)}`),
        ];

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { sqlCount: sqlResults.length, hnswCount: hnswResults.length },
        };
      },
    }, { name: "unified_search" });

    // ========================================================================
    // Tool: unified_store — store entry to both backends
    // ========================================================================
    api.registerTool({
      name: "unified_store",
      label: "Unified Memory Store",
      description: "Store an entry in both USMD SQLite and Ruflo HNSW. Auto-tags and summarizes.",
      parameters: Type.Object({
        content: Type.String({ description: "Content to store" }),
        type: Type.Optional(Type.String({ description: "Entry type: skill/protocol/config/history/tool/result (default: history)" })),
        tags: Type.Optional(Type.String({ description: "Comma-separated tags" })),
        source_path: Type.Optional(Type.String({ description: "Source file path" })),
      }),
      async execute(_id, params) {
        const content = params.content as string;
        const entryType = (params.type as EntryType) ?? "history";
        const userTags = params.tags as string | undefined;
        const sourcePath = params.source_path as string | undefined;

        const tags = userTags ? userTags.split(",").map(t => t.trim()) : autoTag(content);
        const summary = summarize(content);
        const hnswKey = `${entryType}:${Date.now()}:${randomUUID().slice(0, 6)}`;

        const entryId = udb.storeEntry({
          entryType,
          tags: tags.join(","),
          content,
          summary,
          sourcePath,
          hnswKey,
        });

        if (ruflo) {
          await ruflo.store(hnswKey, { content: content.slice(0, 2000), summary, tags, entryType }, { tags, namespace: "unified" });
        }

        // Index in native HNSW (fire and forget)
        if (hnswManager?.isReady()) {
          hnswManager.addEntry(entryId, summary || content.slice(0, 2000)).catch(() => {});
        }

        return {
          content: [{ type: "text", text: `Stored unified entry #${entryId} [${entryType}] (hnsw: ${hnswKey})` }],
          details: { entryId, hnswKey, tags },
        };
      },
    }, { name: "unified_store" });

    // ========================================================================
    // Tool: unified_conversations - query conversation threads (Phase 5)
    // Added 2026-03-03 by Wiki.
    // ========================================================================
    api.registerTool({
      name: "unified_conversations",
      label: "Conversation Threads",
      description: "List or search conversation threads. Use to recall what was discussed.",
      parameters: Type.Object({
        status: Type.Optional(Type.String({ description: "Filter by status: active/resolved/blocked/archived/all (default: active)" })),
        query: Type.Optional(Type.String({ description: "Search topic/tags/summary" })),
        limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
        details: Type.Optional(Type.Boolean({ description: "Include full details and messages (default: false)" })),
      }),
      async execute(_id, params) {
        const status = (params.status as string) || 'active';
        const limit = Math.min((params.limit as number) || 10, 50);
        const query = (params.query as string) || '';
        const includeDetails = (params.details as boolean) || false;

        let sql = 'SELECT * FROM conversations WHERE 1=1';
        const sqlParams: any[] = [];

        if (status !== 'all') {
          sql += ' AND status = ?';
          sqlParams.push(status);
        }
        if (query) {
          sql += ' AND (topic LIKE ? OR tags LIKE ? OR summary LIKE ?)';
          const q = `%${query}%`;
          sqlParams.push(q, q, q);
        }
        sql += ' ORDER BY updated_at DESC LIMIT ?';
        sqlParams.push(limit);

        const conversations = udb.db.prepare(sql).all(...sqlParams) as any[];

        if (includeDetails) {
          for (const conv of conversations) {
            conv.messages = udb.db.prepare(
              'SELECT role, content_summary, has_decision, has_action, timestamp FROM conversation_messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT 20'
            ).all(conv.id);
          }
        }

        const text = JSON.stringify(conversations, null, 2);
        return {
          content: [{ type: "text" as const, text }],
          details: { count: conversations.length, status, query: query || undefined },
        };
      },
    }, { name: "unified_conversations" });

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
