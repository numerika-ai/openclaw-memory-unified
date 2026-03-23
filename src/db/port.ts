/**
 * db/port.ts — DatabasePort interface
 *
 * Backend-agnostic database interface implemented by both SqlitePort and PostgresPort.
 * All methods are async to support both sync SQLite (wrapped in Promise.resolve) and async Postgres.
 */

import type { EntryType } from "../config";

// === Parameter types ===

export interface StoreEntryParams {
  entryType: EntryType;
  tags?: string;
  content: string;
  summary?: string;
  sourcePath?: string;
  hnswKey?: string;
  skillId?: number;
  agentId?: string;
}

export interface StoreFactParams {
  topic: string;
  fact: string;
  confidence?: number;
  sourceType?: string;
  temporalType?: string;
  sourceSession?: string;
  sourceSummary?: string;
  agentId?: string;
  hnswKey?: string;
  scope?: string;
}

export interface QueryEntriesOptions {
  entryType?: EntryType;
  agentId?: string;
  ids?: number[];
  limit?: number;
}

export interface QueryFactsOptions {
  id?: number;
  topic?: string;
  status?: string;
  scope?: string;
  textSearch?: string;
  minConfidence?: number;
  limit?: number;
}

export interface QueryPatternsOptions {
  skillName?: string;
  keywords?: string;
  minConfidence?: number;
  limit?: number;
}

export interface QueryConversationsOptions {
  status?: string;
  query?: string;
  recentHours?: number;
  minConfidence?: number;
  limit?: number;
  includeMessages?: boolean;
}

export interface CreateConversationData {
  threadId: string;
  topic: string;
  tags: string;
  channel: string;
  participants: string;
  summary: string;
  details: string;
  keyFacts: string;
}

export interface UpdateConversationData {
  summary?: string;
  tags?: string;
  details?: string;
  incrementMessageCount?: boolean;
}

export interface ArchiveConversationsOptions {
  phantom?: boolean;
  staleOlderThanDays?: number;
  resolvedOlderThanDays?: number;
}

export interface VecSearchResult {
  factId: number;
  distance: number;
  topic: string;
  fact: string;
  confidence: number;
}

export interface EntryVecSearchResult {
  entryId: number;
  distance: number;
  text: string;
}

export interface FactStats {
  total: number;
  active: number;
  contradicted: number;
  archived: number;
  stale: number;
  byTopic: Array<{ topic: string; count: number; avg_conf: number }>;
  lastExtraction: string | null;
  revisionCount: number;
}

export interface CleanupResult {
  toolEntriesDeleted: number;
  stagingCleared: number;
  conversationsArchived: number;
  vacuumed: boolean;
}

// === Main interface ===

export interface DatabasePort {
  readonly embeddingDim: number;

  // === Entries ===
  storeEntry(params: StoreEntryParams): Promise<number>;
  queryEntries(options: QueryEntriesOptions): Promise<any[]>;
  ftsSearch(query: string, entryType?: EntryType, limit?: number, agentId?: string): Promise<any[]>;
  ftsSearchSkills(keywords: string, limit?: number): Promise<any[]>;
  updateEntryAccessCount(ids: number[]): Promise<void>;
  deleteEntries(options: { entryType?: EntryType; olderThanDays?: number }): Promise<number>;

  // === Skills ===
  getSkillByName(name: string): Promise<any | undefined>;
  listSkills(category?: string): Promise<any[]>;
  searchSkillsByKeywords(words: string[], limit?: number): Promise<any[]>;
  getRecentExecutions(limit?: number): Promise<any[]>;
  getSkillExecutionHistory(skillId: number, limit?: number): Promise<any[]>;
  logSkillExecution(skillId: number, summary: string, status: string, outputSummary: string, sessionKey: string): Promise<void>;
  updateSkillStats(skillId: number, success: boolean): Promise<void>;

  // === Facts (Memory Bank) ===
  seedTopics(topics: Array<{ name: string; description: string; ttl_days: number | null; priority: number }>): Promise<void>;
  getTopics(): Promise<any[]>;
  storeFact(params: StoreFactParams): Promise<number>;
  queryFacts(options: QueryFactsOptions): Promise<any[]>;
  updateFact(id: number, updates: { fact?: string; confidence?: number; status?: string; expired?: boolean }): Promise<void>;
  expireFactsByTTL(): Promise<number>;
  getFactStats(): Promise<FactStats>;
  updateFactAccessCount(factId: number): Promise<void>;
  getFactsForDecay(): Promise<any[]>;

  // === Fact Vectors ===
  storeFactEmbedding(factId: number, embedding: number[]): Promise<void>;
  searchFactsByVector(queryEmbedding: number[], topK?: number, scope?: string): Promise<VecSearchResult[]>;
  getFactsWithoutEmbeddings(): Promise<Array<{ id: number; fact: string }>>;

  // === Revisions ===
  storeRevision(factId: number, revisionType: string, oldContent: string | null, newContent: string | null, reason: string): Promise<void>;

  // === Patterns ===
  queryPatterns(options: QueryPatternsOptions): Promise<any[]>;
  createPattern(skillName: string, keywordsJson: string, confidence?: number): Promise<number>;
  updatePatternSuccess(id: number, newConf: number): Promise<void>;
  updatePatternFailure(id: number, newConf: number): Promise<void>;
  logPatternHistory(patternId: number | bigint, eventType: string, oldConf: number, newConf: number, context?: string): Promise<void>;
  cleanupStalePatterns(): Promise<number>;

  // === Conversations ===
  queryConversations(options: QueryConversationsOptions): Promise<any[]>;
  createConversation(data: CreateConversationData): Promise<number>;
  updateConversation(id: number, updates: UpdateConversationData): Promise<void>;
  addConversationMessage(conversationId: number, role: string, contentSummary: string, hasDecision: boolean, hasAction: boolean): Promise<void>;
  resolveConversation(id: number): Promise<void>;
  archiveConversations(options: ArchiveConversationsOptions): Promise<number>;

  // === Entry Vectors (HNSW meta + sqlite-vec / pgvector) ===
  storeEntryEmbedding(entryId: number, embedding: number[], entryType: string, text: string): Promise<void>;
  searchEntryEmbeddings(queryEmbedding: number[], topK: number, entryType?: string): Promise<EntryVecSearchResult[]>;
  deleteEntryEmbedding(entryId: number): Promise<void>;
  getEntryEmbeddingCount(): Promise<number>;
  isEntryEmbedded(entryId: number): Promise<boolean>;
  markEntryAsEmbedded(entryId: number): Promise<void>;
  getUnembeddedEntries(limit: number): Promise<any[]>;

  // === Feedback ===
  storeFeedback(params: { agentId?: string; sessionKey?: string; taskDescription: string; rating: number; comment?: string; skillName?: string; trajectoryId?: string }): Promise<number>;
  getFeedback(opts?: { agentId?: string; rating?: number; limit?: number; skillName?: string }): Promise<Array<{ id: number; agent_id: string; task_description: string; rating: number; comment: string | null; skill_name: string | null; created_at: string }>>;
  getFeedbackStats(agentId?: string): Promise<{ total: number; positive: number; negative: number; neutral: number; topSkills: Array<{ skill: string; avgRating: number; count: number }> }>;

  // === Maintenance ===
  runDataCleanup(): Promise<CleanupResult>;
  vacuum(): Promise<void>;
  rebuildFTS(): Promise<void>;
  getDbStats(): Promise<any>;

  // === Lifecycle ===
  close(): Promise<void>;
}
