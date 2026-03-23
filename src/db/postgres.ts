/**
 * db/postgres.ts — PostgresPort adapter
 *
 * Implements DatabasePort using node-postgres (pg) with pgvector for vector
 * operations and pg_trgm for full-text search against the openclaw schema.
 */

import { Pool } from "pg";
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
import type { EntryType } from "../config";

const DEFAULT_COMPANY_ID = "a1b2c3d4-0000-0000-0000-000000000001";
const DEFAULT_AGENT_ID = "f551d6b6-3d4e-487b-99b1-a16cbb0b28c3";

export class PostgresPort implements DatabasePort {
  private pool: Pool;
  private companyId: string;
  private defaultAgentId: string;
  private agentMap: Map<string, string> = new Map();
  public readonly embeddingDim: number;
  private initialized = false;

  constructor(connectionString: string, embeddingDim: number = 4096) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      options: "-c search_path=openclaw,public",
    });
    this.companyId = DEFAULT_COMPANY_ID;
    this.defaultAgentId = DEFAULT_AGENT_ID;
    this.embeddingDim = embeddingDim;
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.createMissingTables();
    await this.addMissingColumns();
    await this.loadAgentMap();
    this.initialized = true;
  }

  private async createMissingTables(): Promise<void> {
    await this.pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS openclaw.agent_skill_definitions (
        id BIGSERIAL PRIMARY KEY,
        company_id UUID NOT NULL DEFAULT '${DEFAULT_COMPANY_ID}',
        name TEXT UNIQUE NOT NULL,
        category TEXT,
        description TEXT,
        procedure TEXT,
        config TEXT,
        keywords TEXT,
        required_tools TEXT,
        use_count INTEGER DEFAULT 0,
        success_rate REAL DEFAULT 0,
        last_used TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS openclaw.agent_skill_executions (
        id BIGSERIAL PRIMARY KEY,
        skill_id BIGINT NOT NULL,
        summary TEXT,
        status TEXT,
        output_summary TEXT,
        session_key TEXT,
        duration_ms INTEGER,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS openclaw.agent_memory_revisions (
        id BIGSERIAL PRIMARY KEY,
        fact_id BIGINT NOT NULL,
        revision_type TEXT NOT NULL,
        old_content TEXT,
        new_content TEXT,
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS openclaw.agent_memory_topics (
        id BIGSERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        extraction_prompt TEXT,
        ttl_days INTEGER,
        priority INTEGER DEFAULT 5,
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS openclaw.agent_conversation_messages (
        id BIGSERIAL PRIMARY KEY,
        conversation_id BIGINT NOT NULL,
        role TEXT NOT NULL,
        content_summary TEXT NOT NULL,
        has_decision BOOLEAN DEFAULT false,
        has_action BOOLEAN DEFAULT false,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS openclaw.agent_pattern_history (
        id BIGSERIAL PRIMARY KEY,
        pattern_id BIGINT NOT NULL,
        event_type TEXT NOT NULL,
        old_confidence REAL,
        new_confidence REAL,
        context TEXT,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS openclaw.feedback (
        id BIGSERIAL PRIMARY KEY,
        agent_id TEXT DEFAULT 'main',
        session_key TEXT,
        task_description TEXT NOT NULL,
        rating INTEGER CHECK (rating BETWEEN -1 AND 1),
        comment TEXT,
        skill_name TEXT,
        trajectory_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_agent ON openclaw.feedback(agent_id)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_rating ON openclaw.feedback(rating)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_created ON openclaw.feedback(created_at)`);

    // pg_trgm indexes for full-text search
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_entries_content_trgm
        ON openclaw.agent_entries USING gin (content gin_trgm_ops)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_entries_summary_trgm
        ON openclaw.agent_entries USING gin (summary gin_trgm_ops)
    `);
  }

  private async addMissingColumns(): Promise<void> {
    // Extra columns on agent_conversations
    const convColumns = [
      { name: "tags", def: "TEXT" },
      { name: "channel", def: "TEXT" },
      { name: "details", def: "TEXT" },
      { name: "key_facts", def: "TEXT" },
      { name: "confidence", def: "REAL DEFAULT 0.8" },
      { name: "decay_rate", def: "REAL DEFAULT 0.98" },
      { name: "last_accessed_at", def: "TIMESTAMPTZ" },
      { name: "resolved_at", def: "TIMESTAMPTZ" },
    ];
    for (const col of convColumns) {
      await this.pool.query(
        `ALTER TABLE openclaw.agent_conversations ADD COLUMN IF NOT EXISTS ${col.name} ${col.def}`
      );
    }

    // Extra columns on agent_knowledge
    const knowledgeColumns = [
      { name: "status", def: "TEXT DEFAULT 'active'" },
      { name: "hnsw_key", def: "TEXT" },
      { name: "source_summary", def: "TEXT" },
      { name: "access_count", def: "INTEGER DEFAULT 0" },
      { name: "last_accessed_at", def: "TIMESTAMPTZ" },
    ];
    for (const col of knowledgeColumns) {
      await this.pool.query(
        `ALTER TABLE openclaw.agent_knowledge ADD COLUMN IF NOT EXISTS ${col.name} ${col.def}`
      );
    }
  }

  private async loadAgentMap(): Promise<void> {
    try {
      const result = await this.pool.query(
        "SELECT id, slug FROM openclaw.agents"
      );
      for (const row of result.rows) {
        this.agentMap.set(row.slug, row.id);
      }
    } catch {
      // agents table may not exist yet
    }
    if (!this.agentMap.has("main"))
      this.agentMap.set("main", this.defaultAgentId);
    if (!this.agentMap.has("unknown"))
      this.agentMap.set("unknown", this.defaultAgentId);
  }

  private resolveAgentId(textId?: string): string {
    if (!textId) return this.defaultAgentId;
    if (textId.includes("-") && textId.length > 30) return textId;
    return this.agentMap.get(textId) ?? this.defaultAgentId;
  }

  private vectorToString(embedding: number[]): string {
    return "[" + embedding.join(",") + "]";
  }

  // ===========================================================================
  // Entries
  // ===========================================================================

  async storeEntry(params: StoreEntryParams): Promise<number> {
    const agentId = this.resolveAgentId(params.agentId);
    const result = await this.pool.query(
      `INSERT INTO openclaw.agent_entries
         (company_id, agent_id, entry_type, tags, content, summary, source_path, hnsw_key, skill_id)
       VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        this.companyId,
        agentId,
        params.entryType,
        params.tags ?? null,
        params.content,
        params.summary ?? null,
        params.sourcePath ?? null,
        params.hnswKey ?? null,
        params.skillId ?? null,
      ]
    );
    return Number(result.rows[0].id);
  }

  async queryEntries(options: QueryEntriesOptions): Promise<any[]> {
    if (options.ids && options.ids.length > 0) {
      const placeholders = options.ids.map((_, i) => `$${i + 1}`).join(",");
      const result = await this.pool.query(
        `SELECT * FROM openclaw.agent_entries WHERE id IN (${placeholders})`,
        options.ids
      );
      return result.rows;
    }

    const clauses: string[] = ["1=1"];
    const params: any[] = [];
    let idx = 1;

    if (options.entryType) {
      clauses.push(`entry_type = $${idx++}`);
      params.push(options.entryType);
    }
    if (options.agentId) {
      clauses.push(`agent_id = $${idx++}::uuid`);
      params.push(this.resolveAgentId(options.agentId));
    }

    const limit = options.limit ?? 20;
    clauses.push(`1=1`); // placeholder for ordering
    params.push(limit);

    const result = await this.pool.query(
      `SELECT * FROM openclaw.agent_entries
       WHERE ${clauses.slice(0, -1).join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${idx}`,
      params
    );
    return result.rows;
  }

  async ftsSearch(
    query: string,
    entryType?: EntryType,
    limit?: number,
    agentId?: string
  ): Promise<any[]> {
    try {
      const maxResults = limit ?? 10;
      const params: any[] = [query, maxResults];
      let idx = 3;

      let typeClause = "";
      if (entryType) {
        typeClause = `AND entry_type = $${idx++}`;
        params.push(entryType);
      }

      let agentClause = "";
      if (agentId) {
        agentClause = `AND agent_id = $${idx++}::uuid`;
        params.push(this.resolveAgentId(agentId));
      }

      const result = await this.pool.query(
        `SELECT *,
                similarity(COALESCE(content,'') || ' ' || COALESCE(summary,''), $1) AS rank
         FROM openclaw.agent_entries
         WHERE (content % $1 OR summary % $1 OR tags % $1)
           ${typeClause}
           ${agentClause}
         ORDER BY rank DESC
         LIMIT $2`,
        params
      );
      return result.rows;
    } catch {
      return [];
    }
  }

  async ftsSearchSkills(keywords: string, limit: number = 10): Promise<any[]> {
    try {
      const result = await this.pool.query(
        `SELECT hnsw_key, content, source_path, summary, length(content) AS content_len
         FROM openclaw.agent_entries
         WHERE entry_type = 'skill'
           AND (content % $1 OR summary % $1 OR tags % $1 OR hnsw_key % $1)
         ORDER BY similarity(COALESCE(content,'') || ' ' || COALESCE(summary,''), $1) DESC
         LIMIT $2`,
        [keywords, limit]
      );
      return result.rows;
    } catch {
      return [];
    }
  }

  async updateEntryAccessCount(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    await this.pool.query(
      `UPDATE openclaw.agent_entries
       SET access_count = access_count + 1, last_accessed_at = NOW()
       WHERE id IN (${placeholders})`,
      ids
    );
  }

  async deleteEntries(options: {
    entryType?: EntryType;
    olderThanDays?: number;
  }): Promise<number> {
    if (!options.entryType) return 0;

    if (options.olderThanDays != null) {
      const result = await this.pool.query(
        `DELETE FROM openclaw.agent_entries
         WHERE entry_type = $1
           AND created_at < NOW() - ($2 || ' days')::interval
         RETURNING id`,
        [options.entryType, options.olderThanDays]
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query(
      `DELETE FROM openclaw.agent_entries WHERE entry_type = $1 RETURNING id`,
      [options.entryType]
    );
    return result.rowCount ?? 0;
  }

  // ===========================================================================
  // Skills
  // ===========================================================================

  async getSkillByName(name: string): Promise<any | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM openclaw.agent_skill_definitions WHERE name = $1`,
      [name]
    );
    return result.rows[0] ?? undefined;
  }

  async listSkills(category?: string): Promise<any[]> {
    if (category) {
      const result = await this.pool.query(
        `SELECT * FROM openclaw.agent_skill_definitions WHERE category = $1 ORDER BY use_count DESC`,
        [category]
      );
      return result.rows;
    }
    const result = await this.pool.query(
      `SELECT * FROM openclaw.agent_skill_definitions ORDER BY use_count DESC`
    );
    return result.rows;
  }

  async searchSkillsByKeywords(
    words: string[],
    limit: number = 10
  ): Promise<any[]> {
    if (words.length === 0) return [];
    const conditions = words
      .map(
        (_, i) =>
          `(s.description ILIKE '%' || $${i * 2 + 1} || '%' OR s.keywords ILIKE '%' || $${i * 2 + 2} || '%')`
      )
      .join(" OR ");
    const params: any[] = [];
    for (const w of words) {
      params.push(w, w);
    }
    params.push(limit);

    try {
      const result = await this.pool.query(
        `SELECT s.name, s.description, s.procedure, length(s.procedure) AS proc_len
         FROM openclaw.agent_skill_definitions s
         WHERE ${conditions}
         ORDER BY s.last_used DESC NULLS LAST
         LIMIT $${params.length}`,
        params
      );
      return result.rows;
    } catch {
      return [];
    }
  }

  async getRecentExecutions(limit: number = 10): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT e.*, s.name AS skill_name
       FROM openclaw.agent_skill_executions e
       LEFT JOIN openclaw.agent_skill_definitions s ON s.id = e.skill_id
       ORDER BY e.timestamp DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  async getSkillExecutionHistory(
    skillId: number,
    limit: number = 10
  ): Promise<any[]> {
    try {
      const result = await this.pool.query(
        `SELECT summary, status, timestamp
         FROM openclaw.agent_skill_executions
         WHERE skill_id = $1
         ORDER BY timestamp DESC
         LIMIT $2`,
        [skillId, limit]
      );
      return result.rows;
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
    await this.pool.query(
      `INSERT INTO openclaw.agent_skill_executions
         (skill_id, summary, status, output_summary, session_key)
       VALUES ($1, $2, $3, $4, $5)`,
      [skillId, summary, status, outputSummary, sessionKey]
    );
  }

  async updateSkillStats(skillId: number, success: boolean): Promise<void> {
    const successVal = success ? 1.0 : 0.0;
    await this.pool.query(
      `UPDATE openclaw.agent_skill_definitions
       SET use_count = use_count + 1,
           last_used = NOW(),
           success_rate = (success_rate * use_count + $1) / (use_count + 1)
       WHERE id = $2`,
      [successVal, skillId]
    );
  }

  // ===========================================================================
  // Facts (Memory Bank)
  // ===========================================================================

  async seedTopics(
    topics: Array<{
      name: string;
      description: string;
      ttl_days: number | null;
      priority: number;
    }>
  ): Promise<void> {
    for (const t of topics) {
      await this.pool.query(
        `INSERT INTO openclaw.agent_memory_topics (name, description, ttl_days, priority)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO NOTHING`,
        [t.name, t.description, t.ttl_days, t.priority]
      );
    }
  }

  async getTopics(): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT * FROM openclaw.agent_memory_topics WHERE enabled = true ORDER BY priority DESC`
    );
    return result.rows;
  }

  async storeFact(params: StoreFactParams): Promise<number> {
    const agentId = this.resolveAgentId(params.agentId);
    const result = await this.pool.query(
      `INSERT INTO openclaw.agent_knowledge
         (company_id, agent_id, topic, fact, confidence, source_type, temporal_type,
          source_session, source_summary, hnsw_key, scope, status, verification_status)
       VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', 'verified')
       RETURNING id`,
      [
        this.companyId,
        agentId,
        params.topic,
        params.fact,
        params.confidence ?? 0.8,
        params.sourceType ?? "conversation",
        params.temporalType ?? "current_state",
        params.sourceSession ?? null,
        params.sourceSummary ?? null,
        params.hnswKey ?? null,
        params.scope ?? "global",
      ]
    );
    return Number(result.rows[0].id);
  }

  async queryFacts(options: QueryFactsOptions): Promise<any[]> {
    const clauses: string[] = ["1=1"];
    const params: any[] = [];
    let idx = 1;

    if (options.id != null) {
      clauses.push(`id = $${idx++}`);
      params.push(options.id);
    }
    if (options.topic != null) {
      clauses.push(`topic = $${idx++}`);
      params.push(options.topic);
    }
    if (options.status != null) {
      clauses.push(`status = $${idx++}`);
      params.push(options.status);
    } else {
      clauses.push("expired_at IS NULL");
    }
    if (options.scope != null) {
      clauses.push(`(scope = 'global' OR scope = $${idx++})`);
      params.push(options.scope);
    }
    if (options.textSearch != null) {
      clauses.push(`fact ILIKE '%' || $${idx++} || '%'`);
      params.push(options.textSearch);
    }
    if (options.minConfidence != null) {
      clauses.push(`confidence > $${idx++}`);
      params.push(options.minConfidence);
    }

    const limit = options.limit ?? 50;
    params.push(limit);

    const result = await this.pool.query(
      `SELECT id, topic, fact, confidence, source_type, temporal_type,
              source_session, source_summary, scope, status, hnsw_key,
              access_count, last_accessed_at, created_at, updated_at, expired_at
       FROM openclaw.agent_knowledge
       WHERE ${clauses.join(" AND ")}
       ORDER BY confidence DESC, updated_at DESC
       LIMIT $${idx}`,
      params
    );
    return result.rows;
  }

  async updateFact(
    id: number,
    updates: {
      fact?: string;
      confidence?: number;
      status?: string;
      expired?: boolean;
    }
  ): Promise<void> {
    const setClauses: string[] = ["updated_at = NOW()"];
    const params: any[] = [];
    let idx = 1;

    if (updates.fact != null) {
      setClauses.push(`fact = $${idx++}`);
      params.push(updates.fact);
    }
    if (updates.confidence != null) {
      setClauses.push(`confidence = $${idx++}`);
      params.push(updates.confidence);
    }
    if (updates.status != null) {
      setClauses.push(`status = $${idx++}`);
      params.push(updates.status);
      // Keep verification_status in sync
      const vsMap: Record<string, string> = {
        active: "verified",
        stale: "stale",
        contradicted: "disputed",
        archived: "archived",
      };
      if (vsMap[updates.status]) {
        setClauses.push(`verification_status = $${idx++}`);
        params.push(vsMap[updates.status]);
      }
    }
    if (updates.expired === true) {
      setClauses.push("expired_at = NOW()");
    }

    params.push(id);

    await this.pool.query(
      `UPDATE openclaw.agent_knowledge SET ${setClauses.join(", ")} WHERE id = $${idx}`,
      params
    );
  }

  async expireFactsByTTL(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE openclaw.agent_knowledge
       SET expired_at = NOW(), status = 'archived', verification_status = 'archived'
       WHERE expired_at IS NULL
         AND status = 'active'
         AND ttl_days IS NOT NULL
         AND created_at < NOW() - (ttl_days || ' days')::interval
       RETURNING id`
    );
    return result.rowCount ?? 0;
  }

  async getFactStats(): Promise<FactStats> {
    const totalR = await this.pool.query(
      "SELECT COUNT(*) AS c FROM openclaw.agent_knowledge"
    );
    const total = Number(totalR.rows[0]?.c ?? 0);

    const activeR = await this.pool.query(
      "SELECT COUNT(*) AS c FROM openclaw.agent_knowledge WHERE status = 'active'"
    );
    const active = Number(activeR.rows[0]?.c ?? 0);

    const contradictedR = await this.pool.query(
      "SELECT COUNT(*) AS c FROM openclaw.agent_knowledge WHERE status = 'contradicted'"
    );
    const contradicted = Number(contradictedR.rows[0]?.c ?? 0);

    const archivedR = await this.pool.query(
      "SELECT COUNT(*) AS c FROM openclaw.agent_knowledge WHERE status = 'archived'"
    );
    const archived = Number(archivedR.rows[0]?.c ?? 0);

    const staleR = await this.pool.query(
      "SELECT COUNT(*) AS c FROM openclaw.agent_knowledge WHERE status = 'stale'"
    );
    const stale = Number(staleR.rows[0]?.c ?? 0);

    const byTopicR = await this.pool.query(
      `SELECT topic, COUNT(*) AS count, AVG(confidence) AS avg_conf
       FROM openclaw.agent_knowledge
       WHERE status = 'active'
       GROUP BY topic
       ORDER BY count DESC`
    );
    const byTopic = byTopicR.rows.map((r: any) => ({
      topic: r.topic,
      count: Number(r.count),
      avg_conf: Number(r.avg_conf),
    }));

    let lastExtraction: string | null = null;
    try {
      const leR = await this.pool.query(
        `SELECT created_at FROM openclaw.agent_memory_revisions
         WHERE revision_type = 'created'
         ORDER BY created_at DESC LIMIT 1`
      );
      lastExtraction = leR.rows[0]?.created_at?.toISOString() ?? null;
    } catch {
      // table may be empty
    }

    let revisionCount = 0;
    try {
      const rcR = await this.pool.query(
        "SELECT COUNT(*) AS c FROM openclaw.agent_memory_revisions"
      );
      revisionCount = Number(rcR.rows[0]?.c ?? 0);
    } catch {
      // table may not exist
    }

    return {
      total,
      active,
      contradicted,
      archived,
      stale,
      byTopic,
      lastExtraction,
      revisionCount,
    };
  }

  async updateFactAccessCount(factId: number): Promise<void> {
    await this.pool.query(
      `UPDATE openclaw.agent_knowledge
       SET access_count = access_count + 1, last_accessed_at = NOW()
       WHERE id = $1`,
      [factId]
    );
  }

  async getFactsForDecay(): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT k.id, k.confidence, k.last_accessed_at, k.created_at, k.ttl_days,
              t.ttl_days AS topic_ttl_days
       FROM openclaw.agent_knowledge k
       LEFT JOIN openclaw.agent_memory_topics t ON k.topic = t.name
       WHERE k.status = 'active' AND k.confidence > 0.3`
    );
    return result.rows;
  }

  // ===========================================================================
  // Fact Vectors
  // ===========================================================================

  async storeFactEmbedding(
    factId: number,
    embedding: number[]
  ): Promise<void> {
    const vecStr = this.vectorToString(embedding);
    await this.pool.query(
      `DELETE FROM openclaw.agent_embeddings WHERE knowledge_id = $1`,
      [factId]
    );
    await this.pool.query(
      `INSERT INTO openclaw.agent_embeddings (company_id, knowledge_id, embedding, model)
       VALUES ($1, $2, $3::vector, 'qwen3-embedding:8b')`,
      [this.companyId, factId, vecStr]
    );
  }

  async searchFactsByVector(
    queryEmbedding: number[],
    topK: number = 5,
    scope?: string
  ): Promise<VecSearchResult[]> {
    try {
      const vecStr = this.vectorToString(queryEmbedding);
      const params: any[] = [vecStr, topK];
      let idx = 3;

      let scopeClause = "";
      if (scope) {
        scopeClause = `AND (ak.scope = 'global' OR ak.scope = $${idx++})`;
        params.push(scope);
      }

      const result = await this.pool.query(
        `SELECT ae.knowledge_id AS "factId",
                (ae.embedding <=> $1::vector) AS distance,
                ak.topic, ak.fact, ak.confidence
         FROM openclaw.agent_embeddings ae
         JOIN openclaw.agent_knowledge ak ON ak.id = ae.knowledge_id
         WHERE ae.knowledge_id IS NOT NULL
           AND ak.verification_status != 'archived'
           AND ak.confidence > 0.3
           ${scopeClause}
         ORDER BY ae.embedding <=> $1::vector
         LIMIT $2`,
        params
      );
      return result.rows.map((r: any) => ({
        factId: Number(r.factId),
        distance: Number(r.distance),
        topic: r.topic,
        fact: r.fact,
        confidence: Number(r.confidence),
      }));
    } catch {
      return [];
    }
  }

  async getFactsWithoutEmbeddings(): Promise<Array<{ id: number; fact: string }>> {
    const result = await this.pool.query(
      `SELECT k.id, k.fact
       FROM openclaw.agent_knowledge k
       LEFT JOIN openclaw.agent_embeddings ae ON ae.knowledge_id = k.id AND ae.embedding IS NOT NULL
       WHERE ae.id IS NULL
         AND k.status = 'active'
         AND k.expired_at IS NULL`
    );
    return result.rows.map((r: any) => ({
      id: Number(r.id),
      fact: r.fact,
    }));
  }

  // ===========================================================================
  // Revisions
  // ===========================================================================

  async storeRevision(
    factId: number,
    revisionType: string,
    oldContent: string | null,
    newContent: string | null,
    reason: string
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO openclaw.agent_memory_revisions
         (fact_id, revision_type, old_content, new_content, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [factId, revisionType, oldContent, newContent, reason]
    );
  }

  // ===========================================================================
  // Patterns
  // ===========================================================================

  async queryPatterns(options: QueryPatternsOptions): Promise<any[]> {
    const clauses: string[] = ["1=1"];
    const params: any[] = [];
    let idx = 1;

    if (options.skillName != null) {
      clauses.push(`skill_name = $${idx++}`);
      params.push(options.skillName);
    }
    if (options.keywords != null) {
      clauses.push(`keywords = $${idx++}`);
      params.push(options.keywords);
    }
    if (options.minConfidence != null) {
      clauses.push(`confidence > $${idx++}`);
      params.push(options.minConfidence);
    }

    const limit = options.limit ?? 20;
    params.push(limit);

    const result = await this.pool.query(
      `SELECT * FROM openclaw.agent_patterns
       WHERE company_id = '${this.companyId}'
         AND ${clauses.join(" AND ")}
       ORDER BY confidence DESC
       LIMIT $${idx}`,
      params
    );
    return result.rows;
  }

  async createPattern(
    skillName: string,
    keywordsJson: string,
    confidence: number = 0.5
  ): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO openclaw.agent_patterns
         (company_id, agent_id, skill_name, keywords, confidence)
       VALUES ($1, $2::uuid, $3, $4, $5)
       RETURNING id`,
      [this.companyId, this.defaultAgentId, skillName, keywordsJson, confidence]
    );
    return Number(result.rows[0].id);
  }

  async updatePatternSuccess(id: number, newConf: number): Promise<void> {
    await this.pool.query(
      `UPDATE openclaw.agent_patterns
       SET confidence = $1,
           success_count = success_count + 1,
           updated_at = NOW(),
           last_matched_at = NOW()
       WHERE id = $2`,
      [newConf, id]
    );
  }

  async updatePatternFailure(id: number, newConf: number): Promise<void> {
    await this.pool.query(
      `UPDATE openclaw.agent_patterns
       SET confidence = $1,
           failure_count = failure_count + 1,
           updated_at = NOW()
       WHERE id = $2`,
      [newConf, id]
    );
  }

  async logPatternHistory(
    patternId: number | bigint,
    eventType: string,
    oldConf: number,
    newConf: number,
    context?: string
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO openclaw.agent_pattern_history
         (pattern_id, event_type, old_confidence, new_confidence, context)
       VALUES ($1, $2, $3, $4, $5)`,
      [patternId, eventType, oldConf, newConf, context ?? null]
    );
  }

  async cleanupStalePatterns(): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM openclaw.agent_patterns
       WHERE confidence < 0.1
         AND updated_at < NOW() - INTERVAL '30 days'
       RETURNING id`
    );
    return result.rowCount ?? 0;
  }

  // ===========================================================================
  // Conversations
  // ===========================================================================

  async queryConversations(
    options: QueryConversationsOptions
  ): Promise<any[]> {
    const clauses: string[] = ["1=1"];
    const params: any[] = [];
    let idx = 1;

    if (options.status != null && options.status !== "all") {
      clauses.push(`status = $${idx++}`);
      params.push(options.status);
    }
    if (options.query != null) {
      const q = `%${options.query}%`;
      clauses.push(
        `(topic ILIKE $${idx} OR tags ILIKE $${idx + 1} OR context_summary ILIKE $${idx + 2})`
      );
      params.push(q, q, q);
      idx += 3;
    }
    if (options.recentHours != null) {
      clauses.push(`updated_at > NOW() - ($${idx++} || ' hours')::interval`);
      params.push(options.recentHours);
    }
    if (options.minConfidence != null) {
      clauses.push(`confidence > $${idx++}`);
      params.push(options.minConfidence);
    }

    const limit = options.limit ?? 20;
    params.push(limit);

    const result = await this.pool.query(
      `SELECT * FROM openclaw.agent_conversations
       WHERE company_id = '${this.companyId}'
         AND ${clauses.join(" AND ")}
       ORDER BY updated_at DESC
       LIMIT $${idx}`,
      params
    );
    const conversations = result.rows;

    if (options.includeMessages) {
      for (const conv of conversations) {
        const msgResult = await this.pool.query(
          `SELECT role, content_summary, has_decision, has_action, timestamp
           FROM openclaw.agent_conversation_messages
           WHERE conversation_id = $1
           ORDER BY timestamp DESC
           LIMIT 20`,
          [conv.id]
        );
        conv.messages = msgResult.rows;
      }
    }

    return conversations;
  }

  async createConversation(data: CreateConversationData): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO openclaw.agent_conversations
         (company_id, primary_agent_id, thread_id, topic, tags, channel,
          participants, context_summary, details, key_facts)
       VALUES ($1, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        this.companyId,
        this.defaultAgentId,
        data.threadId,
        data.topic,
        data.tags,
        data.channel,
        data.participants,
        data.summary,
        data.details,
        data.keyFacts,
      ]
    );
    if (result.rows.length === 0) {
      // ON CONFLICT hit — look up existing
      const existing = await this.pool.query(
        `SELECT id FROM openclaw.agent_conversations WHERE thread_id = $1 AND company_id = $2`,
        [data.threadId, this.companyId]
      );
      return Number(existing.rows[0]?.id ?? 0);
    }
    return Number(result.rows[0].id);
  }

  async updateConversation(
    id: number,
    updates: UpdateConversationData
  ): Promise<void> {
    const setClauses: string[] = [
      "updated_at = NOW()",
      "last_accessed_at = NOW()",
    ];
    const params: any[] = [];
    let idx = 1;

    if (updates.summary != null) {
      setClauses.push(`context_summary = $${idx++}`);
      params.push(updates.summary);
    }
    if (updates.tags != null) {
      setClauses.push(`tags = $${idx++}`);
      params.push(updates.tags);
    }
    if (updates.incrementMessageCount) {
      setClauses.push("message_count = message_count + 1");
    }
    if (updates.details != null) {
      setClauses.push(
        `details = CASE WHEN length(COALESCE(details, '')) < 2000 THEN COALESCE(details, '') || E'\\n' || $${idx++} ELSE details END`
      );
      params.push(updates.details);
    }

    params.push(id);

    await this.pool.query(
      `UPDATE openclaw.agent_conversations SET ${setClauses.join(", ")} WHERE id = $${idx}`,
      params
    );
  }

  async addConversationMessage(
    conversationId: number,
    role: string,
    contentSummary: string,
    hasDecision: boolean,
    hasAction: boolean
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO openclaw.agent_conversation_messages
         (conversation_id, role, content_summary, has_decision, has_action)
       VALUES ($1, $2, $3, $4, $5)`,
      [conversationId, role, contentSummary, hasDecision, hasAction]
    );
  }

  async resolveConversation(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE openclaw.agent_conversations
       SET status = 'resolved', resolved_at = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  async archiveConversations(
    options: ArchiveConversationsOptions
  ): Promise<number> {
    let totalChanges = 0;

    if (options.phantom) {
      const result = await this.pool.query(
        `UPDATE openclaw.agent_conversations
         SET status = 'archived'
         WHERE status = 'active'
           AND (topic LIKE 'You are a memory extraction system%'
                OR topic LIKE 'Extract facts:%')
         RETURNING id`
      );
      totalChanges += result.rowCount ?? 0;
    }

    if (options.staleOlderThanDays != null) {
      const result = await this.pool.query(
        `UPDATE openclaw.agent_conversations
         SET status = 'archived'
         WHERE status = 'active'
           AND updated_at < NOW() - ($1 || ' days')::interval
         RETURNING id`,
        [options.staleOlderThanDays]
      );
      totalChanges += result.rowCount ?? 0;
    }

    if (options.resolvedOlderThanDays != null) {
      const result = await this.pool.query(
        `UPDATE openclaw.agent_conversations
         SET status = 'archived'
         WHERE status = 'resolved'
           AND resolved_at < NOW() - ($1 || ' days')::interval
         RETURNING id`,
        [options.resolvedOlderThanDays]
      );
      totalChanges += result.rowCount ?? 0;
    }

    return totalChanges;
  }

  // ===========================================================================
  // Entry Vectors (pgvector via agent_embeddings)
  // ===========================================================================

  async storeEntryEmbedding(
    entryId: number,
    embedding: number[],
    entryType: string,
    _text: string
  ): Promise<void> {
    const vecStr = this.vectorToString(embedding);
    await this.pool.query(
      `DELETE FROM openclaw.agent_embeddings WHERE entry_id = $1`,
      [entryId]
    );
    await this.pool.query(
      `INSERT INTO openclaw.agent_embeddings (company_id, entry_id, embedding, model)
       VALUES ($1, $2, $3::vector, 'qwen3-embedding:8b')`,
      [this.companyId, entryId, vecStr]
    );
  }

  async searchEntryEmbeddings(
    queryEmbedding: number[],
    topK: number,
    entryType?: string
  ): Promise<EntryVecSearchResult[]> {
    try {
      const vecStr = this.vectorToString(queryEmbedding);
      const params: any[] = [vecStr, topK];

      let typeClause = "";
      if (entryType) {
        typeClause = `AND ae2.entry_type = $3`;
        params.push(entryType);
      }

      // Join back to agent_entries to filter by entry_type if needed
      let query: string;
      if (entryType) {
        query = `
          SELECT ae.entry_id AS "entryId",
                 (ae.embedding <=> $1::vector) AS distance,
                 '' AS text
          FROM openclaw.agent_embeddings ae
          JOIN openclaw.agent_entries ae2 ON ae2.id = ae.entry_id
          WHERE ae.entry_id IS NOT NULL
            ${typeClause}
          ORDER BY ae.embedding <=> $1::vector
          LIMIT $2`;
      } else {
        query = `
          SELECT ae.entry_id AS "entryId",
                 (ae.embedding <=> $1::vector) AS distance,
                 '' AS text
          FROM openclaw.agent_embeddings ae
          WHERE ae.entry_id IS NOT NULL
          ORDER BY ae.embedding <=> $1::vector
          LIMIT $2`;
      }

      const result = await this.pool.query(query, params);
      return result.rows.map((r: any) => ({
        entryId: Number(r.entryId),
        distance: Number(r.distance),
        text: r.text,
      }));
    } catch {
      return [];
    }
  }

  async deleteEntryEmbedding(entryId: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM openclaw.agent_embeddings WHERE entry_id = $1`,
      [entryId]
    );
  }

  async getEntryEmbeddingCount(): Promise<number> {
    try {
      const result = await this.pool.query(
        `SELECT COUNT(*) AS count FROM openclaw.agent_embeddings WHERE entry_id IS NOT NULL`
      );
      return Number(result.rows[0]?.count ?? 0);
    } catch {
      return 0;
    }
  }

  async isEntryEmbedded(entryId: number): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `SELECT 1 FROM openclaw.agent_embeddings WHERE entry_id = $1 LIMIT 1`,
        [entryId]
      );
      return result.rows.length > 0;
    } catch {
      return false;
    }
  }

  async markEntryAsEmbedded(_entryId: number): Promise<void> {
    // No-op for Postgres: embedding existence in agent_embeddings is the marker.
    // This method exists for SQLite's separate hnsw_meta tracking table.
  }

  async getUnembeddedEntries(limit: number): Promise<any[]> {
    try {
      const result = await this.pool.query(
        `SELECT ue.id, ue.summary, ue.content, ue.entry_type
         FROM openclaw.agent_entries ue
         LEFT JOIN openclaw.agent_embeddings ae ON ae.entry_id = ue.id AND ae.embedding IS NOT NULL
         WHERE ae.id IS NULL AND ue.entry_type != 'tool'
         ORDER BY ue.id DESC
         LIMIT $1`,
        [limit]
      );
      return result.rows;
    } catch {
      return [];
    }
  }

  // ===========================================================================
  // Maintenance
  // ===========================================================================

  async runDataCleanup(): Promise<CleanupResult> {
    const result: CleanupResult = {
      toolEntriesDeleted: 0,
      stagingCleared: 0,
      conversationsArchived: 0,
      vacuumed: false,
    };

    try {
      // 1. Delete tool entries
      const delTool = await this.pool.query(
        `DELETE FROM openclaw.agent_entries WHERE entry_type = 'tool' RETURNING id`
      );
      result.toolEntriesDeleted = delTool.rowCount ?? 0;

      // 2. Delete orphaned embeddings (entry_id references that no longer exist)
      await this.pool.query(
        `DELETE FROM openclaw.agent_embeddings
         WHERE entry_id IS NOT NULL
           AND entry_id NOT IN (SELECT id FROM openclaw.agent_entries)`
      );

      // 3. Delete orphaned knowledge embeddings
      await this.pool.query(
        `DELETE FROM openclaw.agent_embeddings
         WHERE knowledge_id IS NOT NULL
           AND knowledge_id NOT IN (SELECT id FROM openclaw.agent_knowledge)`
      );

      // 4. Archive old resolved conversations (>7 days)
      const archConv = await this.pool.query(
        `UPDATE openclaw.agent_conversations
         SET status = 'archived'
         WHERE status = 'resolved'
           AND resolved_at < NOW() - INTERVAL '7 days'
         RETURNING id`
      );
      result.conversationsArchived = archConv.rowCount ?? 0;

      // 5. Postgres auto-vacuums, but we can ANALYZE for fresh statistics
      await this.pool.query("ANALYZE openclaw.agent_entries");
      await this.pool.query("ANALYZE openclaw.agent_knowledge");
      await this.pool.query("ANALYZE openclaw.agent_embeddings");
      result.vacuumed = true;
    } catch {
      // cleanup error — return partial results
    }

    return result;
  }

  async vacuum(): Promise<void> {
    // VACUUM cannot run inside a transaction, use a dedicated connection
    const client = await this.pool.connect();
    try {
      await client.query("VACUUM ANALYZE openclaw.agent_entries");
      await client.query("VACUUM ANALYZE openclaw.agent_knowledge");
      await client.query("VACUUM ANALYZE openclaw.agent_embeddings");
      await client.query("VACUUM ANALYZE openclaw.agent_conversations");
      await client.query("VACUUM ANALYZE openclaw.agent_patterns");
    } finally {
      client.release();
    }
  }

  async rebuildFTS(): Promise<void> {
    // No-op for Postgres: pg_trgm GIN indexes are maintained automatically.
    // Reindex if needed:
    try {
      await this.pool.query(
        "REINDEX INDEX openclaw.idx_agent_entries_content_trgm"
      );
      await this.pool.query(
        "REINDEX INDEX openclaw.idx_agent_entries_summary_trgm"
      );
    } catch {
      // indexes may not exist
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
      const totalR = await this.pool.query(
        "SELECT count(*) AS c FROM openclaw.agent_entries"
      );
      stats.totalEntries = Number(totalR.rows[0]?.c ?? 0);

      const breakdownR = await this.pool.query(
        "SELECT entry_type, count(*) AS c FROM openclaw.agent_entries GROUP BY entry_type"
      );
      for (const row of breakdownR.rows) {
        stats.entryBreakdown[row.entry_type] = Number(row.c);
      }

      const vecR = await this.pool.query(
        "SELECT count(*) AS c FROM openclaw.agent_embeddings"
      );
      stats.vectorCount = Number(vecR.rows[0]?.c ?? 0);

      const factsR = await this.pool.query(
        "SELECT count(*) AS c FROM openclaw.agent_knowledge WHERE status = 'active'"
      );
      stats.factsCount = Number(factsR.rows[0]?.c ?? 0);

      const convR = await this.pool.query(
        "SELECT count(*) AS c FROM openclaw.agent_conversations WHERE status = 'active'"
      );
      stats.conversationsActive = Number(convR.rows[0]?.c ?? 0);

      // Database size in MB
      const sizeR = await this.pool.query(
        "SELECT pg_database_size(current_database()) AS size_bytes"
      );
      stats.dbSizeMB = Math.round(
        Number(sizeR.rows[0]?.size_bytes ?? 0) / (1024 * 1024)
      );
    } catch {
      // stats collection error
    }

    return stats;
  }

  // ===========================================================================
  // Feedback
  // ===========================================================================

  async storeFeedback(params: {
    agentId?: string;
    sessionKey?: string;
    taskDescription: string;
    rating: number;
    comment?: string;
    skillName?: string;
    trajectoryId?: string;
  }): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO openclaw.feedback (agent_id, session_key, task_description, rating, comment, skill_name, trajectory_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        params.agentId ?? "main",
        params.sessionKey ?? null,
        params.taskDescription,
        params.rating,
        params.comment ?? null,
        params.skillName ?? null,
        params.trajectoryId ?? null,
      ]
    );
    return Number(result.rows[0].id);
  }

  async getFeedback(opts?: {
    agentId?: string;
    rating?: number;
    limit?: number;
    skillName?: string;
  }): Promise<Array<{ id: number; agent_id: string; task_description: string; rating: number; comment: string | null; skill_name: string | null; created_at: string }>> {
    const clauses: string[] = ["1=1"];
    const params: any[] = [];
    let idx = 1;

    if (opts?.agentId) {
      clauses.push(`agent_id = $${idx++}`);
      params.push(opts.agentId);
    }
    if (opts?.rating != null) {
      clauses.push(`rating = $${idx++}`);
      params.push(opts.rating);
    }
    if (opts?.skillName) {
      clauses.push(`skill_name = $${idx++}`);
      params.push(opts.skillName);
    }

    const limit = opts?.limit ?? 20;
    params.push(limit);

    const result = await this.pool.query(
      `SELECT id, agent_id, task_description, rating, comment, skill_name, created_at
       FROM openclaw.feedback
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${idx}`,
      params
    );
    return result.rows.map((r: any) => ({
      id: Number(r.id),
      agent_id: r.agent_id,
      task_description: r.task_description,
      rating: Number(r.rating),
      comment: r.comment,
      skill_name: r.skill_name,
      created_at: String(r.created_at),
    }));
  }

  async getFeedbackStats(agentId?: string): Promise<{
    total: number;
    positive: number;
    negative: number;
    neutral: number;
    topSkills: Array<{ skill: string; avgRating: number; count: number }>;
  }> {
    const agentClause = agentId ? "WHERE agent_id = $1" : "";
    const agentParams = agentId ? [agentId] : [];

    const totals = await this.pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE rating = 1) AS positive,
         COUNT(*) FILTER (WHERE rating = -1) AS negative,
         COUNT(*) FILTER (WHERE rating = 0) AS neutral
       FROM openclaw.feedback ${agentClause}`,
      agentParams
    );

    const row = totals.rows[0];

    const skillsR = await this.pool.query(
      `SELECT skill_name AS skill, AVG(rating) AS avg_rating, COUNT(*) AS count
       FROM openclaw.feedback
       WHERE skill_name IS NOT NULL ${agentId ? "AND agent_id = $1" : ""}
       GROUP BY skill_name
       ORDER BY avg_rating DESC, count DESC
       LIMIT 10`,
      agentParams
    );

    return {
      total: Number(row.total),
      positive: Number(row.positive),
      negative: Number(row.negative),
      neutral: Number(row.neutral),
      topSkills: skillsR.rows.map((s: any) => ({
        skill: s.skill,
        avgRating: Number(Number(s.avg_rating).toFixed(2)),
        count: Number(s.count),
      })),
    };
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async close(): Promise<void> {
    await this.pool.end();
  }
}
