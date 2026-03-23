/**
 * db/sqlite.ts — SQLite wrapper implementing UnifiedDB interface
 *
 * Manages: unified_entries, patterns, pattern_history, conversations, conversation_messages.
 * Schema from schema.sql (USMD tables) + inline migrations for new tables.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { UnifiedDB } from "../types";
import type { EntryType } from "../config";

export class UnifiedDBImpl implements UnifiedDB {
  public db: Database.Database;
  public embeddingDim: number;

  constructor(dbPath: string, embeddingDim: number = 4096) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.embeddingDim = embeddingDim;
    sqliteVec.load(this.db);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initTables();
  }

  private initTables(): void {
    // dist/db/sqlite.js → ../../schema.sql
    const schemaPath = path.join(__dirname, "..", "..", "schema.sql");
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
    hnsw_key TEXT, skill_id INTEGER, agent_id TEXT DEFAULT 'unknown',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_unified_type ON unified_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_unified_hnsw ON unified_entries(hnsw_key);
CREATE INDEX IF NOT EXISTS idx_unified_agent ON unified_entries(agent_id);
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
          hnsw_key TEXT, skill_id INTEGER, agent_id TEXT DEFAULT 'unknown',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          memory_type TEXT DEFAULT 'episodic', access_count INTEGER DEFAULT 0,
          last_accessed_at TIMESTAMP, namespace TEXT DEFAULT 'general'
        );
        INSERT INTO unified_entries_v2 (id, entry_type, tags, content, summary, source_path, hnsw_key, skill_id, created_at, updated_at) SELECT * FROM unified_entries;
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

    // FTS5 full-text index on unified_entries
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS unified_fts USING fts5(
        content, summary, tags, hnsw_key,
        content='unified_entries', content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS unified_entries_ai AFTER INSERT ON unified_entries BEGIN
        INSERT INTO unified_fts(rowid, content, summary, tags, hnsw_key)
        VALUES (new.id, new.content, new.summary, new.tags, new.hnsw_key);
      END;

      CREATE TRIGGER IF NOT EXISTS unified_entries_ad AFTER DELETE ON unified_entries BEGIN
        INSERT INTO unified_fts(unified_fts, rowid, content, summary, tags, hnsw_key)
        VALUES ('delete', old.id, old.content, old.summary, old.tags, old.hnsw_key);
      END;

      CREATE TRIGGER IF NOT EXISTS unified_entries_au AFTER UPDATE ON unified_entries BEGIN
        INSERT INTO unified_fts(unified_fts, rowid, content, summary, tags, hnsw_key)
        VALUES ('delete', old.id, old.content, old.summary, old.tags, old.hnsw_key);
        INSERT INTO unified_fts(rowid, content, summary, tags, hnsw_key)
        VALUES (new.id, new.content, new.summary, new.tags, new.hnsw_key);
      END;
    `);

    // Migration: add agent_id column to unified_entries (safe for existing DBs)
    try {
      this.db.exec("ALTER TABLE unified_entries ADD COLUMN agent_id TEXT DEFAULT 'unknown'");
    } catch {
      // Column already exists — expected on subsequent runs
    }
    try {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_unified_agent ON unified_entries(agent_id)");
    } catch {}

    // Rebuild FTS index if unified_entries has rows but FTS is empty (existing DB upgrade)
    try {
      const entryCount = (this.db.prepare("SELECT COUNT(*) as c FROM unified_entries").get() as any)?.c ?? 0;
      const ftsCount = (this.db.prepare("SELECT COUNT(*) as c FROM unified_fts").get() as any)?.c ?? 0;
      if (entryCount > 0 && ftsCount === 0) {
        this.db.exec("INSERT INTO unified_fts(unified_fts) VALUES('rebuild')");
      }
    } catch {}

    // Memory Bank tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        fact TEXT NOT NULL,
        confidence REAL DEFAULT 0.8,
        status TEXT DEFAULT 'active',
        scope TEXT DEFAULT 'global',
        source_type TEXT DEFAULT 'conversation',
        temporal_type TEXT DEFAULT 'current_state',
        source_session TEXT,
        source_summary TEXT,
        agent_id TEXT DEFAULT 'main',
        ttl_days INTEGER DEFAULT NULL,
        access_count INTEGER DEFAULT 0,
        last_accessed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expired_at TIMESTAMP DEFAULT NULL,
        hnsw_key TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_facts_topic ON memory_facts(topic);
      CREATE INDEX IF NOT EXISTS idx_facts_agent ON memory_facts(agent_id);
      CREATE INDEX IF NOT EXISTS idx_facts_confidence ON memory_facts(confidence);
      CREATE INDEX IF NOT EXISTS idx_facts_status ON memory_facts(status);
      CREATE INDEX IF NOT EXISTS idx_facts_scope ON memory_facts(scope);

      CREATE TABLE IF NOT EXISTS memory_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fact_id INTEGER NOT NULL REFERENCES memory_facts(id),
        revision_type TEXT CHECK(revision_type IN ('created','updated','merged','expired','manual_edit','contradicted','decay','deleted')) NOT NULL,
        old_content TEXT,
        new_content TEXT,
        reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS memory_topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        extraction_prompt TEXT,
        ttl_days INTEGER DEFAULT NULL,
        priority INTEGER DEFAULT 5,
        enabled INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Memory Bank vector table for pre-embedded facts (sqlite-vec)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_vec USING vec0(
        fact_id INTEGER PRIMARY KEY,
        embedding float[${this.embeddingDim}]
      );
    `);

    // Feedback table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT DEFAULT 'main',
        session_key TEXT,
        task_description TEXT NOT NULL,
        rating INTEGER CHECK (rating BETWEEN -1 AND 1),
        comment TEXT,
        skill_name TEXT,
        trajectory_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_agent ON feedback(agent_id);
      CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating);
      CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
    `);

    // Migrations for existing databases: add new columns
    const addColumnSafe = (table: string, col: string, def: string) => {
      try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* already exists */ }
    };
    addColumnSafe("memory_facts", "status", "TEXT DEFAULT 'active'");
    addColumnSafe("memory_facts", "scope", "TEXT DEFAULT 'global'");
    addColumnSafe("memory_facts", "temporal_type", "TEXT DEFAULT 'current_state'");

    // Expand revision_type constraint for existing DBs (SQLite can't ALTER CHECK constraints,
    // but new values will work since CHECK is only enforced on the original DDL if table already existed
    // with the old constraint — new inserts with new values will succeed on existing tables because
    // SQLite only enforces CHECK constraints defined at CREATE TABLE time for that specific table creation)

    // Indexes for new columns
    try { this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_status ON memory_facts(status)"); } catch {}
    try { this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_scope ON memory_facts(scope)"); } catch {}
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
    agentId?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO unified_entries (entry_type, tags, content, summary, source_path, hnsw_key, skill_id, agent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(
      params.entryType, params.tags ?? null, params.content,
      params.summary ?? null, params.sourcePath ?? null,
      params.hnswKey ?? null, params.skillId ?? null,
      params.agentId ?? "unknown"
    );
    return r.lastInsertRowid as number;
  }

  searchEntries(entryType?: EntryType, limit = 20, agentId?: string): any[] {
    if (entryType && agentId) {
      return this.db.prepare("SELECT * FROM unified_entries WHERE entry_type = ? AND agent_id = ? ORDER BY created_at DESC LIMIT ?").all(entryType, agentId, limit);
    }
    if (entryType) {
      return this.db.prepare("SELECT * FROM unified_entries WHERE entry_type = ? ORDER BY created_at DESC LIMIT ?").all(entryType, limit);
    }
    if (agentId) {
      return this.db.prepare("SELECT * FROM unified_entries WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?").all(agentId, limit);
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


  // Get single entry by ID (for enriching vector results)
  getEntryById(id: number): any | undefined {
    return this.db.prepare("SELECT * FROM unified_entries WHERE id = ?").get(id);
  }

  // FTS5 full-text search
  ftsSearch(query: string, entryType?: EntryType, limit = 10, agentId?: string): any[] {
    const ftsQuery = query.split(/\s+/).map(w => w.replace(/[^\w]/g, "")).filter(Boolean).join(" OR ");
    if (!ftsQuery) return this.searchEntries(entryType, limit, agentId);
    try {
      if (entryType && agentId) {
        return this.db.prepare("SELECT e.* FROM unified_entries e JOIN unified_fts f ON e.id = f.rowid WHERE unified_fts MATCH ? AND e.entry_type = ? AND e.agent_id = ? ORDER BY rank LIMIT ?").all(ftsQuery, entryType, agentId, limit);
      }
      if (entryType) {
        return this.db.prepare("SELECT e.* FROM unified_entries e JOIN unified_fts f ON e.id = f.rowid WHERE unified_fts MATCH ? AND e.entry_type = ? ORDER BY rank LIMIT ?").all(ftsQuery, entryType, limit);
      }
      if (agentId) {
        return this.db.prepare("SELECT e.* FROM unified_entries e JOIN unified_fts f ON e.id = f.rowid WHERE unified_fts MATCH ? AND e.agent_id = ? ORDER BY rank LIMIT ?").all(ftsQuery, agentId, limit);
      }
      return this.db.prepare("SELECT e.* FROM unified_entries e JOIN unified_fts f ON e.id = f.rowid WHERE unified_fts MATCH ? ORDER BY rank LIMIT ?").all(ftsQuery, limit);
    } catch {
      return this.searchEntries(entryType, limit, agentId);
    }
  }
  // --- Memory Bank ---
  seedTopics(topics: Array<{ name: string; description: string; ttl_days: number | null; priority: number }>): void {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO memory_topics (name, description, ttl_days, priority) VALUES (?, ?, ?, ?)"
    );
    for (const t of topics) {
      stmt.run(t.name, t.description, t.ttl_days, t.priority);
    }
  }

  getTopics(): any[] {
    return this.db.prepare("SELECT * FROM memory_topics WHERE enabled = 1 ORDER BY priority DESC").all();
  }

  storeFact(params: {
    topic: string;
    fact: string;
    confidence?: number;
    sourceType?: string;
    sourceSession?: string;
    sourceSummary?: string;
    agentId?: string;
    hnswKey?: string;
  }): number {
    const r = this.db.prepare(`
      INSERT INTO memory_facts (topic, fact, confidence, source_type, source_session, source_summary, agent_id, hnsw_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.topic, params.fact, params.confidence ?? 0.8,
      params.sourceType ?? "conversation", params.sourceSession ?? null,
      params.sourceSummary ?? null, params.agentId ?? "main", params.hnswKey ?? null
    );
    return r.lastInsertRowid as number;
  }

  updateFact(id: number, fact: string, confidence?: number): void {
    if (confidence !== undefined) {
      this.db.prepare("UPDATE memory_facts SET fact = ?, confidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(fact, confidence, id);
    } else {
      this.db.prepare("UPDATE memory_facts SET fact = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(fact, id);
    }
  }

  searchFacts(topic?: string, limit = 20): any[] {
    if (topic) {
      return this.db.prepare("SELECT * FROM memory_facts WHERE topic = ? AND expired_at IS NULL ORDER BY confidence DESC, updated_at DESC LIMIT ?").all(topic, limit);
    }
    return this.db.prepare("SELECT * FROM memory_facts WHERE expired_at IS NULL ORDER BY confidence DESC, updated_at DESC LIMIT ?").all(limit);
  }

  getFactsByTopic(topic: string): any[] {
    return this.db.prepare("SELECT * FROM memory_facts WHERE topic = ? AND expired_at IS NULL ORDER BY confidence DESC").all(topic);
  }

  expireFacts(): number {
    const result = this.db.prepare(`
      UPDATE memory_facts SET expired_at = CURRENT_TIMESTAMP
      WHERE expired_at IS NULL AND ttl_days IS NOT NULL
      AND julianday('now') - julianday(created_at) > ttl_days
    `).run();
    return result.changes;
  }

  // --- Memory Bank vector operations ---
  storeFactEmbedding(factId: number, embeddingBuf: Buffer): void {
    // Upsert: delete existing then insert (sqlite-vec doesn't support ON CONFLICT)
    // CAST required: sqlite-vec vec0 rejects JS numbers as primary keys — needs SQLite INTEGER type
    this.db.prepare("DELETE FROM memory_facts_vec WHERE fact_id = ?").run(factId);
    this.db.prepare("INSERT INTO memory_facts_vec (fact_id, embedding) VALUES (CAST(? AS INTEGER), ?)").run(factId, embeddingBuf);
  }

  searchFactsByVector(queryEmbeddingBuf: Buffer, topK: number = 5, scope?: string): Array<{ factId: number; distance: number; topic: string; fact: string; confidence: number }> {
    // sqlite-vec KNN search joined with memory_facts for metadata
    const scopeFilter = scope
      ? "AND mf.status = 'active' AND mf.confidence > 0.3 AND (mf.scope = 'global' OR mf.scope = ?)"
      : "AND mf.status = 'active' AND mf.confidence > 0.3";

    const query = `
      SELECT v.fact_id, v.distance, mf.topic, mf.fact, mf.confidence
      FROM memory_facts_vec v
      JOIN memory_facts mf ON mf.id = v.fact_id
      WHERE v.embedding MATCH ?
      AND k = ?
      ${scopeFilter}
      ORDER BY v.distance ASC
    `;

    const params: any[] = [queryEmbeddingBuf, topK];
    if (scope) params.push(scope);

    return this.db.prepare(query).all(...params) as any[];
  }

  getFactsWithoutEmbeddings(): Array<{ id: number; fact: string }> {
    return this.db.prepare(`
      SELECT mf.id, mf.fact FROM memory_facts mf
      LEFT JOIN memory_facts_vec v ON v.fact_id = mf.id
      WHERE v.fact_id IS NULL AND mf.status = 'active'
    `).all() as any[];
  }

  close(): void { this.db.close(); }
}
