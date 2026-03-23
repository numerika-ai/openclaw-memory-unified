/**
 * db/sqlite-port.ts — SqlitePort adapter
 *
 * Wraps UnifiedDBImpl (sync better-sqlite3) and SqliteVecStore to implement
 * the async DatabasePort interface. All sync calls are wrapped in Promise.resolve().
 */

import type {
  DatabasePort,
  StoreEntryParams,
  StoreFactParams,
  QueryEntriesOptions,
  QueryFactsOptions,
  QueryPatternsOptions,
  QueryConversationsOptions,
  CreateConversationData,
  UpdateConversationData,
  ArchiveConversationsOptions,
  VecSearchResult,
  EntryVecSearchResult,
  FactStats,
  CleanupResult,
} from "./port";
import type { UnifiedDBImpl } from "./sqlite";
import type { SqliteVecStore } from "./sqlite-vec";
import type { EntryType } from "../config";
import type Database from "better-sqlite3";
import { embeddingToBuffer } from "../embedding/nemotron";

export class SqlitePort implements DatabasePort {
  public readonly embeddingDim: number;
  private udb: UnifiedDBImpl;
  private vecStore: SqliteVecStore | null;

  constructor(udb: UnifiedDBImpl, vecStore: SqliteVecStore | null = null) {
    this.udb = udb;
    this.embeddingDim = udb.embeddingDim;
    this.vecStore = vecStore;
  }

  /** Expose raw db for legacy compat (used during transition) */
  get rawDb(): Database.Database {
    return this.udb.db;
  }

  // =========================================================================
  // Entries
  // =========================================================================

  async storeEntry(params: StoreEntryParams): Promise<number> {
    return Promise.resolve(this.udb.storeEntry(params));
  }

  async queryEntries(options: QueryEntriesOptions): Promise<any[]> {
    if (options.ids && options.ids.length > 0) {
      const placeholders = options.ids.map(() => "?").join(",");
      return Promise.resolve(
        this.udb.db
          .prepare(`SELECT * FROM unified_entries WHERE id IN (${placeholders})`)
          .all(...options.ids)
      );
    }
    return Promise.resolve(
      this.udb.searchEntries(options.entryType, options.limit ?? 20, options.agentId)
    );
  }

  async ftsSearch(query: string, entryType?: EntryType, limit?: number, agentId?: string): Promise<any[]> {
    return Promise.resolve(this.udb.ftsSearch(query, entryType, limit, agentId));
  }

  async ftsSearchSkills(keywords: string, limit: number = 10): Promise<any[]> {
    try {
      const ftsQuery = keywords
        .split(/\s+/)
        .map((w) => w.replace(/[^\w]/g, ""))
        .filter(Boolean)
        .join(" OR ");
      if (!ftsQuery) return [];
      return this.udb.db
        .prepare(
          `SELECT ue.hnsw_key, ue.content, ue.source_path, ue.summary, length(ue.content) as content_len
           FROM unified_fts fts
           JOIN unified_entries ue ON ue.id = fts.rowid
           WHERE unified_fts MATCH ?
             AND ue.entry_type = 'skill'
           ORDER BY rank
           LIMIT ?`
        )
        .all(ftsQuery, limit);
    } catch {
      return [];
    }
  }

  async updateEntryAccessCount(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.udb.db
      .prepare(
        `UPDATE unified_entries SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`
      )
      .run(...ids);
  }

  async deleteEntries(options: { entryType?: EntryType; olderThanDays?: number }): Promise<number> {
    if (!options.entryType) return 0;
    if (options.olderThanDays != null) {
      const result = this.udb.db
        .prepare(
          "DELETE FROM unified_entries WHERE entry_type = ? AND created_at < datetime('now', '-' || ? || ' days')"
        )
        .run(options.entryType, options.olderThanDays);
      return result.changes;
    }
    const result = this.udb.db
      .prepare("DELETE FROM unified_entries WHERE entry_type = ?")
      .run(options.entryType);
    return result.changes;
  }

  // =========================================================================
  // Skills
  // =========================================================================

  async getSkillByName(name: string): Promise<any | undefined> {
    return Promise.resolve(this.udb.getSkillByName(name));
  }

  async listSkills(category?: string): Promise<any[]> {
    return Promise.resolve(this.udb.listSkills(category));
  }

  async searchSkillsByKeywords(words: string[], limit: number = 10): Promise<any[]> {
    if (words.length === 0) return [];
    const conditions = words.map(() => "(s.description LIKE '%' || ? || '%' OR s.keywords LIKE '%' || ? || '%')").join(" OR ");
    const params: any[] = [];
    for (const w of words) {
      params.push(w, w);
    }
    params.push(limit);
    try {
      return this.udb.db
        .prepare(
          `SELECT s.name, s.description, s.procedure, length(s.procedure) as proc_len
           FROM skills s
           WHERE ${conditions}
           ORDER BY s.last_used DESC NULLS LAST
           LIMIT ?`
        )
        .all(...params);
    } catch {
      return [];
    }
  }

  async getRecentExecutions(limit?: number): Promise<any[]> {
    return Promise.resolve(this.udb.getRecentExecutions(limit));
  }

  async getSkillExecutionHistory(skillId: number, limit: number = 10): Promise<any[]> {
    try {
      return this.udb.db
        .prepare(
          "SELECT summary, status, timestamp FROM skill_executions WHERE skill_id = ? ORDER BY timestamp DESC LIMIT ?"
        )
        .all(skillId, limit);
    } catch {
      return [];
    }
  }

  async logSkillExecution(
    skillId: number,
    summary: string,
    status: string,
    outputSummary: string,
    sessionKey: string
  ): Promise<void> {
    this.udb.db
      .prepare(
        "INSERT INTO skill_executions (skill_id, summary, status, output_summary, session_key) VALUES (?, ?, ?, ?, ?)"
      )
      .run(skillId, summary, status, outputSummary, sessionKey);
  }

  async updateSkillStats(skillId: number, success: boolean): Promise<void> {
    const successVal = success ? 1.0 : 0.0;
    this.udb.db
      .prepare(
        "UPDATE skills SET use_count = use_count + 1, last_used = CURRENT_TIMESTAMP, success_rate = (success_rate * use_count + ?) / (use_count + 1) WHERE id = ?"
      )
      .run(successVal, skillId);
  }

  // =========================================================================
  // Facts (Memory Bank)
  // =========================================================================

  async seedTopics(
    topics: Array<{ name: string; description: string; ttl_days: number | null; priority: number }>
  ): Promise<void> {
    return Promise.resolve(this.udb.seedTopics(topics));
  }

  async getTopics(): Promise<any[]> {
    return Promise.resolve(this.udb.getTopics());
  }

  async storeFact(params: StoreFactParams): Promise<number> {
    const r = this.udb.db
      .prepare(
        `INSERT INTO memory_facts (topic, fact, confidence, source_type, temporal_type, source_session, source_summary, agent_id, hnsw_key, scope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.topic,
        params.fact,
        params.confidence ?? 0.8,
        params.sourceType ?? "conversation",
        params.temporalType ?? "current_state",
        params.sourceSession ?? null,
        params.sourceSummary ?? null,
        params.agentId ?? "main",
        params.hnswKey ?? null,
        params.scope ?? "global"
      );
    return r.lastInsertRowid as number;
  }

  async queryFacts(options: QueryFactsOptions): Promise<any[]> {
    const clauses: string[] = ["1=1"];
    const params: any[] = [];

    if (options.id != null) {
      clauses.push("id = ?");
      params.push(options.id);
    }
    if (options.topic != null) {
      clauses.push("topic = ?");
      params.push(options.topic);
    }
    if (options.status != null) {
      clauses.push("status = ?");
      params.push(options.status);
    } else {
      clauses.push("expired_at IS NULL");
    }
    if (options.scope != null) {
      clauses.push("(scope = 'global' OR scope = ?)");
      params.push(options.scope);
    }
    if (options.textSearch != null) {
      clauses.push("fact LIKE '%' || ? || '%'");
      params.push(options.textSearch);
    }
    if (options.minConfidence != null) {
      clauses.push("confidence > ?");
      params.push(options.minConfidence);
    }

    const limit = options.limit ?? 50;
    params.push(limit);

    return this.udb.db
      .prepare(
        `SELECT * FROM memory_facts WHERE ${clauses.join(" AND ")} ORDER BY confidence DESC, updated_at DESC LIMIT ?`
      )
      .all(...params);
  }

  async updateFact(
    id: number,
    updates: { fact?: string; confidence?: number; status?: string; expired?: boolean }
  ): Promise<void> {
    const setClauses: string[] = ["updated_at = CURRENT_TIMESTAMP"];
    const params: any[] = [];

    if (updates.fact != null) {
      setClauses.push("fact = ?");
      params.push(updates.fact);
    }
    if (updates.confidence != null) {
      setClauses.push("confidence = ?");
      params.push(updates.confidence);
    }
    if (updates.status != null) {
      setClauses.push("status = ?");
      params.push(updates.status);
    }
    if (updates.expired === true) {
      setClauses.push("expired_at = CURRENT_TIMESTAMP");
    }

    params.push(id);

    this.udb.db
      .prepare(`UPDATE memory_facts SET ${setClauses.join(", ")} WHERE id = ?`)
      .run(...params);
  }

  async expireFactsByTTL(): Promise<number> {
    return Promise.resolve(this.udb.expireFacts());
  }

  async getFactStats(): Promise<FactStats> {
    const total = (this.udb.db.prepare("SELECT COUNT(*) as c FROM memory_facts").get() as any)?.c ?? 0;
    const active = (this.udb.db.prepare("SELECT COUNT(*) as c FROM memory_facts WHERE status = 'active'").get() as any)?.c ?? 0;
    const contradicted = (this.udb.db.prepare("SELECT COUNT(*) as c FROM memory_facts WHERE status = 'contradicted'").get() as any)?.c ?? 0;
    const archived = (this.udb.db.prepare("SELECT COUNT(*) as c FROM memory_facts WHERE status = 'archived'").get() as any)?.c ?? 0;
    const stale = (this.udb.db.prepare("SELECT COUNT(*) as c FROM memory_facts WHERE status = 'stale'").get() as any)?.c ?? 0;

    const byTopic = this.udb.db
      .prepare(
        "SELECT topic, COUNT(*) as count, AVG(confidence) as avg_conf FROM memory_facts WHERE status = 'active' GROUP BY topic ORDER BY count DESC"
      )
      .all() as Array<{ topic: string; count: number; avg_conf: number }>;

    let lastExtraction: string | null = null;
    try {
      const row = this.udb.db
        .prepare(
          "SELECT created_at FROM memory_revisions WHERE revision_type = 'created' ORDER BY created_at DESC LIMIT 1"
        )
        .get() as any;
      lastExtraction = row?.created_at ?? null;
    } catch {
      // table may not exist yet
    }

    let revisionCount = 0;
    try {
      revisionCount = (this.udb.db.prepare("SELECT COUNT(*) as c FROM memory_revisions").get() as any)?.c ?? 0;
    } catch {
      // table may not exist yet
    }

    return { total, active, contradicted, archived, stale, byTopic, lastExtraction, revisionCount };
  }

  async updateFactAccessCount(factId: number): Promise<void> {
    this.udb.db
      .prepare(
        "UPDATE memory_facts SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?"
      )
      .run(factId);
  }

  async getFactsForDecay(): Promise<any[]> {
    return this.udb.db
      .prepare(
        `SELECT f.id, f.confidence, f.last_accessed_at, f.created_at, f.ttl_days, t.ttl_days AS topic_ttl_days
         FROM memory_facts f
         LEFT JOIN memory_topics t ON f.topic = t.name
         WHERE f.status = 'active' AND f.confidence > 0.3`
      )
      .all();
  }

  // =========================================================================
  // Fact Vectors
  // =========================================================================

  async storeFactEmbedding(factId: number, embedding: number[]): Promise<void> {
    this.udb.storeFactEmbedding(factId, embeddingToBuffer(embedding));
  }

  async searchFactsByVector(
    queryEmbedding: number[],
    topK: number = 5,
    scope?: string
  ): Promise<VecSearchResult[]> {
    return this.udb.searchFactsByVector(embeddingToBuffer(queryEmbedding), topK, scope);
  }

  async getFactsWithoutEmbeddings(): Promise<Array<{ id: number; fact: string }>> {
    return Promise.resolve(this.udb.getFactsWithoutEmbeddings());
  }

  // =========================================================================
  // Revisions
  // =========================================================================

  async storeRevision(
    factId: number,
    revisionType: string,
    oldContent: string | null,
    newContent: string | null,
    reason: string
  ): Promise<void> {
    this.udb.db
      .prepare(
        "INSERT INTO memory_revisions (fact_id, revision_type, old_content, new_content, reason) VALUES (?, ?, ?, ?, ?)"
      )
      .run(factId, revisionType, oldContent, newContent, reason);
  }

  // =========================================================================
  // Patterns
  // =========================================================================

  async queryPatterns(options: QueryPatternsOptions): Promise<any[]> {
    const clauses: string[] = ["1=1"];
    const params: any[] = [];

    if (options.skillName != null) {
      clauses.push("skill_name = ?");
      params.push(options.skillName);
    }
    if (options.keywords != null) {
      clauses.push("keywords = ?");
      params.push(options.keywords);
    }
    if (options.minConfidence != null) {
      clauses.push("confidence > ?");
      params.push(options.minConfidence);
    }

    const limit = options.limit ?? 20;
    params.push(limit);

    return this.udb.db
      .prepare(
        `SELECT * FROM patterns WHERE ${clauses.join(" AND ")} ORDER BY confidence DESC LIMIT ?`
      )
      .all(...params);
  }

  async createPattern(skillName: string, keywordsJson: string, confidence: number = 0.5): Promise<number> {
    const r = this.udb.db
      .prepare("INSERT INTO patterns (skill_name, keywords, confidence) VALUES (?, ?, ?)")
      .run(skillName, keywordsJson, confidence);
    return r.lastInsertRowid as number;
  }

  async updatePatternSuccess(id: number, newConf: number): Promise<void> {
    this.udb.db
      .prepare(
        "UPDATE patterns SET confidence = ?, success_count = success_count + 1, updated_at = CURRENT_TIMESTAMP, last_matched_at = CURRENT_TIMESTAMP WHERE id = ?"
      )
      .run(newConf, id);
  }

  async updatePatternFailure(id: number, newConf: number): Promise<void> {
    this.udb.db
      .prepare(
        "UPDATE patterns SET confidence = ?, failure_count = failure_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      )
      .run(newConf, id);
  }

  async logPatternHistory(
    patternId: number | bigint,
    eventType: string,
    oldConf: number,
    newConf: number,
    context?: string
  ): Promise<void> {
    this.udb.db
      .prepare(
        "INSERT INTO pattern_history (pattern_id, event_type, old_confidence, new_confidence, context) VALUES (?, ?, ?, ?, ?)"
      )
      .run(patternId, eventType, oldConf, newConf, context ?? null);
  }

  async cleanupStalePatterns(): Promise<number> {
    const result = this.udb.db
      .prepare("DELETE FROM patterns WHERE confidence < 0.1 AND updated_at < datetime('now', '-30 days')")
      .run();
    return result.changes;
  }

  // =========================================================================
  // Conversations
  // =========================================================================

  async queryConversations(options: QueryConversationsOptions): Promise<any[]> {
    const clauses: string[] = ["1=1"];
    const params: any[] = [];

    if (options.status != null && options.status !== "all") {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.query != null) {
      clauses.push("(topic LIKE ? OR tags LIKE ? OR summary LIKE ?)");
      const q = `%${options.query}%`;
      params.push(q, q, q);
    }
    if (options.recentHours != null) {
      clauses.push("updated_at > datetime('now', '-' || ? || ' hours')");
      params.push(options.recentHours);
    }
    if (options.minConfidence != null) {
      clauses.push("confidence > ?");
      params.push(options.minConfidence);
    }

    const limit = options.limit ?? 20;
    params.push(limit);

    const conversations = this.udb.db
      .prepare(
        `SELECT * FROM conversations WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`
      )
      .all(...params) as any[];

    if (options.includeMessages) {
      for (const conv of conversations) {
        conv.messages = this.udb.db
          .prepare(
            "SELECT role, content_summary, has_decision, has_action, timestamp FROM conversation_messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT 20"
          )
          .all(conv.id);
      }
    }

    return conversations;
  }

  async createConversation(data: CreateConversationData): Promise<number> {
    const r = this.udb.db
      .prepare(
        "INSERT OR IGNORE INTO conversations (thread_id, topic, tags, channel, participants, summary, details, key_facts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        data.threadId,
        data.topic,
        data.tags,
        data.channel,
        data.participants,
        data.summary,
        data.details,
        data.keyFacts
      );
    return r.lastInsertRowid as number;
  }

  async updateConversation(id: number, updates: UpdateConversationData): Promise<void> {
    const setClauses: string[] = [
      "updated_at = CURRENT_TIMESTAMP",
      "last_accessed_at = CURRENT_TIMESTAMP",
    ];
    const params: any[] = [];

    if (updates.summary != null) {
      setClauses.push("summary = ?");
      params.push(updates.summary);
    }
    if (updates.tags != null) {
      setClauses.push("tags = ?");
      params.push(updates.tags);
    }
    if (updates.incrementMessageCount) {
      setClauses.push("message_count = message_count + 1");
    }
    if (updates.details != null) {
      setClauses.push(
        "details = CASE WHEN length(details || '') < 2000 THEN (COALESCE(details, '') || char(10) || ?) ELSE details END"
      );
      params.push(updates.details);
    }

    params.push(id);

    this.udb.db
      .prepare(`UPDATE conversations SET ${setClauses.join(", ")} WHERE id = ?`)
      .run(...params);
  }

  async addConversationMessage(
    conversationId: number,
    role: string,
    contentSummary: string,
    hasDecision: boolean,
    hasAction: boolean
  ): Promise<void> {
    this.udb.db
      .prepare(
        "INSERT INTO conversation_messages (conversation_id, role, content_summary, has_decision, has_action) VALUES (?, ?, ?, ?, ?)"
      )
      .run(conversationId, role, contentSummary, hasDecision ? 1 : 0, hasAction ? 1 : 0);
  }

  async resolveConversation(id: number): Promise<void> {
    this.udb.db
      .prepare("UPDATE conversations SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(id);
  }

  async archiveConversations(options: ArchiveConversationsOptions): Promise<number> {
    let totalChanges = 0;

    if (options.phantom) {
      const r = this.udb.db
        .prepare(
          "UPDATE conversations SET status = 'archived' WHERE status = 'active' AND (topic LIKE 'You are a memory extraction system%' OR topic LIKE 'Extract facts:%')"
        )
        .run();
      totalChanges += r.changes;
    }

    if (options.staleOlderThanDays != null) {
      const r = this.udb.db
        .prepare(
          "UPDATE conversations SET status = 'archived' WHERE status = 'active' AND updated_at < datetime('now', '-' || ? || ' days')"
        )
        .run(options.staleOlderThanDays);
      totalChanges += r.changes;
    }

    if (options.resolvedOlderThanDays != null) {
      const r = this.udb.db
        .prepare(
          "UPDATE conversations SET status = 'archived' WHERE status = 'resolved' AND resolved_at < datetime('now', '-' || ? || ' days')"
        )
        .run(options.resolvedOlderThanDays);
      totalChanges += r.changes;
    }

    return totalChanges;
  }

  // =========================================================================
  // Entry Vectors (HNSW meta + sqlite-vec)
  // =========================================================================

  async storeEntryEmbedding(
    entryId: number,
    embedding: number[],
    entryType: string,
    text: string
  ): Promise<void> {
    if (!this.vecStore) return;
    this.vecStore.store(entryId, text, embedding, entryType);
  }

  async searchEntryEmbeddings(
    queryEmbedding: number[],
    topK: number,
    entryType?: string
  ): Promise<EntryVecSearchResult[]> {
    if (!this.vecStore) return [];
    return this.vecStore.search(queryEmbedding, topK, entryType);
  }

  async deleteEntryEmbedding(entryId: number): Promise<void> {
    if (!this.vecStore) return;
    this.vecStore.delete(entryId);
  }

  async getEntryEmbeddingCount(): Promise<number> {
    try {
      const r = this.udb.db.prepare("SELECT COUNT(*) as count FROM hnsw_meta").get() as any;
      return r?.count ?? 0;
    } catch {
      return 0;
    }
  }

  async isEntryEmbedded(entryId: number): Promise<boolean> {
    try {
      const r = this.udb.db.prepare("SELECT 1 FROM hnsw_meta WHERE entry_id = ?").get(entryId);
      return r != null;
    } catch {
      return false;
    }
  }

  async markEntryAsEmbedded(entryId: number): Promise<void> {
    try {
      this.udb.db.prepare("INSERT OR IGNORE INTO hnsw_meta (entry_id) VALUES (?)").run(entryId);
    } catch {
      // table may not exist
    }
  }

  async getUnembeddedEntries(limit: number): Promise<any[]> {
    try {
      return this.udb.db
        .prepare(
          `SELECT ue.id, ue.summary, ue.content, ue.entry_type
           FROM unified_entries ue
           LEFT JOIN hnsw_meta hm ON hm.entry_id = ue.id
           WHERE hm.entry_id IS NULL AND ue.entry_type != 'tool'
           ORDER BY ue.id DESC
           LIMIT ?`
        )
        .all(limit);
    } catch {
      return [];
    }
  }

  // =========================================================================
  // Feedback
  // =========================================================================

  async storeFeedback(params: {
    agentId?: string;
    sessionKey?: string;
    taskDescription: string;
    rating: number;
    comment?: string;
    skillName?: string;
    trajectoryId?: string;
  }): Promise<number> {
    const r = this.udb.db
      .prepare(
        `INSERT INTO feedback (agent_id, session_key, task_description, rating, comment, skill_name, trajectory_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.agentId ?? "main",
        params.sessionKey ?? null,
        params.taskDescription,
        params.rating,
        params.comment ?? null,
        params.skillName ?? null,
        params.trajectoryId ?? null
      );
    return r.lastInsertRowid as number;
  }

  async getFeedback(opts?: {
    agentId?: string;
    rating?: number;
    limit?: number;
    skillName?: string;
  }): Promise<Array<{ id: number; agent_id: string; task_description: string; rating: number; comment: string | null; skill_name: string | null; created_at: string }>> {
    const clauses: string[] = ["1=1"];
    const params: any[] = [];

    if (opts?.agentId) {
      clauses.push("agent_id = ?");
      params.push(opts.agentId);
    }
    if (opts?.rating != null) {
      clauses.push("rating = ?");
      params.push(opts.rating);
    }
    if (opts?.skillName) {
      clauses.push("skill_name = ?");
      params.push(opts.skillName);
    }

    const limit = opts?.limit ?? 20;
    params.push(limit);

    return this.udb.db
      .prepare(
        `SELECT id, agent_id, task_description, rating, comment, skill_name, created_at
         FROM feedback
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...params) as any[];
  }

  async getFeedbackStats(agentId?: string): Promise<{
    total: number;
    positive: number;
    negative: number;
    neutral: number;
    topSkills: Array<{ skill: string; avgRating: number; count: number }>;
  }> {
    const agentClause = agentId ? "WHERE agent_id = ?" : "";
    const agentParams = agentId ? [agentId] : [];

    const row = this.udb.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS positive,
           SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) AS negative,
           SUM(CASE WHEN rating = 0 THEN 1 ELSE 0 END) AS neutral
         FROM feedback ${agentClause}`
      )
      .get(...agentParams) as any;

    const skills = this.udb.db
      .prepare(
        `SELECT skill_name AS skill, AVG(rating) AS avg_rating, COUNT(*) AS count
         FROM feedback
         WHERE skill_name IS NOT NULL ${agentId ? "AND agent_id = ?" : ""}
         GROUP BY skill_name
         ORDER BY avg_rating DESC, count DESC
         LIMIT 10`
      )
      .all(...agentParams) as any[];

    return {
      total: row?.total ?? 0,
      positive: row?.positive ?? 0,
      negative: row?.negative ?? 0,
      neutral: row?.neutral ?? 0,
      topSkills: skills.map((s: any) => ({
        skill: s.skill,
        avgRating: Number(Number(s.avg_rating).toFixed(2)),
        count: s.count,
      })),
    };
  }

  // =========================================================================
  // Search Aliases (no-op for SQLite — Postgres-only feature)
  // =========================================================================

  async expandQuery(query: string): Promise<string> {
    return query;
  }

  async addAlias(_alias: string, _canonical: string, _relatedTerms?: string[]): Promise<void> {
    // no-op for SQLite backend
  }

  // =========================================================================
  // Maintenance
  // =========================================================================

  async runDataCleanup(): Promise<CleanupResult> {
    const result: CleanupResult = {
      toolEntriesDeleted: 0,
      stagingCleared: 0,
      conversationsArchived: 0,
      vacuumed: false,
    };

    try {
      // 1. Delete tool entries from unified_entries
      const delTool = this.udb.db
        .prepare("DELETE FROM unified_entries WHERE entry_type = 'tool'")
        .run();
      result.toolEntriesDeleted = delTool.changes;

      // 2. Delete orphaned hnsw_meta
      try {
        this.udb.db
          .prepare("DELETE FROM hnsw_meta WHERE entry_id NOT IN (SELECT id FROM unified_entries)")
          .run();
      } catch {
        // hnsw_meta may not exist
      }

      // 3. Clear vec_entries_staging if exists
      try {
        const staging = this.udb.db
          .prepare("SELECT count(*) as c FROM vec_entries_staging")
          .get() as any;
        if (staging?.c > 0) {
          this.udb.db.prepare("DELETE FROM vec_entries_staging").run();
          result.stagingCleared = staging.c;
        }
      } catch {
        // table may not exist
      }

      // 4. Archive old resolved conversations (>7 days)
      const archConv = this.udb.db
        .prepare(
          "UPDATE conversations SET status = 'archived' WHERE status = 'resolved' AND resolved_at < datetime('now', '-7 days')"
        )
        .run();
      result.conversationsArchived = archConv.changes;

      // 5. Rebuild FTS5
      try {
        this.udb.db.exec("INSERT INTO unified_fts(unified_fts) VALUES('rebuild')");
      } catch {
        try {
          this.udb.db.exec("DROP TABLE IF EXISTS unified_fts");
          this.udb.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS unified_fts USING fts5(
              content, summary, tags, hnsw_key,
              content='unified_entries', content_rowid='id'
            );
            INSERT INTO unified_fts(unified_fts) VALUES('rebuild');
          `);
        } catch {
          // FTS rebuild failed
        }
      }

      // 6. VACUUM
      try {
        this.udb.db.exec("VACUUM");
        result.vacuumed = true;
      } catch {
        // vacuum failed
      }
    } catch {
      // cleanup error
    }

    return result;
  }

  async vacuum(): Promise<void> {
    this.udb.db.exec("VACUUM");
  }

  async rebuildFTS(): Promise<void> {
    try {
      this.udb.db.exec("INSERT INTO unified_fts(unified_fts) VALUES('rebuild')");
    } catch {
      // FTS corrupted — drop and recreate
      this.udb.db.exec("DROP TABLE IF EXISTS unified_fts");
      this.udb.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS unified_fts USING fts5(
          content, summary, tags, hnsw_key,
          content='unified_entries', content_rowid='id'
        );
        INSERT INTO unified_fts(unified_fts) VALUES('rebuild');
      `);
    }
  }

  async getDbStats(): Promise<any> {
    const stats: Record<string, any> = {
      totalEntries: 0,
      entryBreakdown: {},
      vectorCount: 0,
      factsCount: 0,
      dbSizeMB: 0,
      conversationsActive: 0,
    };

    try {
      const total = this.udb.db.prepare("SELECT count(*) as c FROM unified_entries").get() as any;
      stats.totalEntries = total?.c ?? 0;

      const breakdown = this.udb.db
        .prepare("SELECT entry_type, count(*) as c FROM unified_entries GROUP BY entry_type")
        .all() as any[];
      for (const row of breakdown) {
        stats.entryBreakdown[row.entry_type] = row.c;
      }

      try {
        const vecCount = this.udb.db.prepare("SELECT count(*) as c FROM hnsw_meta").get() as any;
        stats.vectorCount = vecCount?.c ?? 0;
      } catch {
        stats.vectorCount = 0;
      }

      const facts = this.udb.db
        .prepare("SELECT count(*) as c FROM memory_facts WHERE status = 'active'")
        .get() as any;
      stats.factsCount = facts?.c ?? 0;

      const conv = this.udb.db
        .prepare("SELECT count(*) as c FROM conversations WHERE status = 'active'")
        .get() as any;
      stats.conversationsActive = conv?.c ?? 0;
    } catch {
      // stats collection error
    }

    return stats;
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async close(): Promise<void> {
    return Promise.resolve(this.udb.close());
  }
}
