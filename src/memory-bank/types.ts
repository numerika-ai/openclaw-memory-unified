/**
 * Memory Bank type definitions
 */

export type FactStatus = "active" | "stale" | "contradicted" | "archived";
export type TemporalType = "current_state" | "historical" | "permanent";

export interface MemoryFact {
  id: number;
  topic: string;
  fact: string;
  confidence: number;
  status: FactStatus;
  scope: string;
  source_type: string;
  temporal_type: TemporalType;
  source_session: string | null;
  source_summary: string | null;
  agent_id: string;
  ttl_days: number | null;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
  expired_at: string | null;
  hnsw_key: string | null;
}

export interface MemoryRevision {
  id: number;
  fact_id: number;
  revision_type: "created" | "updated" | "merged" | "expired" | "manual_edit" | "contradicted" | "decay" | "deleted";
  old_content: string | null;
  new_content: string | null;
  reason: string | null;
  created_at: string;
}

export interface MemoryTopic {
  id: number;
  name: string;
  description: string | null;
  extraction_prompt: string | null;
  ttl_days: number | null;
  priority: number;
  enabled: number;
  created_at: string;
}

export interface ExtractedFact {
  fact: string;
  topic: string;
  confidence: number;
  temporal_type?: TemporalType;
  scope?: string;
}

export interface ConsolidationResult {
  action: "created" | "updated" | "boosted" | "skipped" | "contradicted";
  factId: number | null;
  similarity: number;
}

export interface MemoryBankConfig {
  enabled: boolean;
  extractionModel: string;
  extractionUrl: string;
  extractionApiKey?: string;
  minConversationLength: number;
  consolidationThreshold: number;
  maxFactsPerTurn: number;
  ragTopK: number;
}
