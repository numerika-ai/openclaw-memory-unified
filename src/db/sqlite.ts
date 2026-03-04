/**
 * db/sqlite.ts — SQLite wrapper implementing UnifiedDB interface
 *
 * Manages: unified_entries, patterns, pattern_history, conversations, conversation_messages.
 * Schema from schema.sql (USMD tables) + inline migrations for new tables.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import type { UnifiedDB } from "../types";
import type { EntryType } from "../config";

export class UnifiedDBImpl implements UnifiedDB {
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


  // Get single entry by ID (for enriching vector results)
  getEntryById(id: number): any | undefined {
    return this.db.prepare("SELECT * FROM unified_entries WHERE id = ?").get(id);
  }

  // FTS5 full-text search
  ftsSearch(query: string, entryType?: EntryType, limit = 10): any[] {
    const ftsQuery = query.split(/\s+/).map(w => w.replace(/[^\w]/g, "")).filter(Boolean).join(" OR ");
    if (!ftsQuery) return this.searchEntries(entryType, limit);
    try {
      if (entryType) {
        return this.db.prepare("SELECT e.* FROM unified_entries e JOIN unified_fts f ON e.id = f.rowid WHERE unified_fts MATCH ? AND e.entry_type = ? ORDER BY rank LIMIT ?").all(ftsQuery, entryType, limit);
      }
      return this.db.prepare("SELECT e.* FROM unified_entries e JOIN unified_fts f ON e.id = f.rowid WHERE unified_fts MATCH ? ORDER BY rank LIMIT ?").all(ftsQuery, limit);
    } catch {
      return this.searchEntries(entryType, limit);
    }
  }
  close(): void { this.db.close(); }
}
