# Memory Bank v2 — Local-First Implementation Spec

## Overview
Inspired by Google Vertex AI Memory Bank, running 100% locally with full feature parity:
- LLM-powered fact extraction with temporal context awareness
- Memory consolidation with contradiction detection
- Topic-based organization with TTL + confidence decay
- Fact status lifecycle (active → stale → contradicted → archived)
- User/scope separation (global + per-agent facts)
- Management tool for manual CRUD operations
- Revision history for all state changes

## Schema

### memory_facts
```sql
CREATE TABLE IF NOT EXISTS memory_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    fact TEXT NOT NULL,
    confidence REAL DEFAULT 0.8,
    status TEXT DEFAULT 'active',          -- active | stale | contradicted | archived
    scope TEXT DEFAULT 'global',           -- 'global' or agent_id
    source_type TEXT DEFAULT 'conversation',
    temporal_type TEXT DEFAULT 'current_state', -- current_state | historical | permanent
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
```

### memory_revisions
```sql
CREATE TABLE IF NOT EXISTS memory_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fact_id INTEGER NOT NULL REFERENCES memory_facts(id),
    revision_type TEXT CHECK(revision_type IN (
        'created','updated','merged','expired','manual_edit',
        'contradicted','decay','deleted'
    )) NOT NULL,
    old_content TEXT,
    new_content TEXT,
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### memory_topics
```sql
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
```

## Default Topics
| Topic | Description | TTL | Priority |
|-------|-------------|-----|----------|
| user_preferences | User preferences, habits, style | NULL | 9 |
| technical_facts | Configs, architectures, versions | 90d | 8 |
| project_context | Active project details, goals | 30d | 7 |
| instructions | Explicit user rules | NULL | 10 |
| people_orgs | People, organizations | NULL | 6 |
| decisions | Key decisions + reasoning | 60d | 7 |
| learned_patterns | Patterns from interactions | 90d | 5 |

## Fact Status Lifecycle

Facts go through a status lifecycle:

- **active** — Default state. Fact is valid and injected into RAG.
- **stale** — Confidence has decayed significantly but not yet archived.
- **contradicted** — A newer fact contradicts this one. Kept for audit trail.
- **archived** — Expired via TTL, manually deleted, or otherwise retired.

Only `active` facts are injected into RAG context.

## Extraction Pipeline (agent_end hook)

1. Filter: skip short (<100 chars), cron/heartbeat, system messages
2. Send conversation to LLM with extraction prompt (includes temporal type instructions)
3. Parse JSON array of facts with fields: `fact`, `topic`, `confidence`, `temporal_type`
4. Per fact: semantic search existing active facts (Qwen3, cosine similarity)
   - **>0.95**: boost confidence only (near-duplicate)
   - **0.90-0.95**: update content (similar fact evolved)
   - **0.70-0.90**: contradiction detection via LLM
     - If contradiction: mark old as `contradicted`, create new fact
     - If not: create new fact (different topic)
   - **<0.70**: create new fact
5. Store in SQLite with scope (global or agent-specific)
6. Embed in LanceDB (fire and forget)
7. Log revision

### Temporal Types
The extractor classifies facts into temporal categories:
- **current_state** — Facts about current state (confidence 0.9+)
- **historical** — Facts that were true but may have changed (confidence 0.6-0.7)
- **permanent** — Timeless facts unlikely to change (confidence 0.85+)

## Contradiction Detection

When two facts have 0.70-0.90 cosine similarity, the system queries the LLM:
```
Do these two facts contradict each other?
Fact A: <existing fact>
Fact B: <new fact>
Answer YES or NO with brief reason.
```

If YES: old fact → `status='contradicted'`, new fact created with `status='active'`.
Both OpenAI-compatible and Anthropic API formats are supported (auto-detected by URL).

## Maintenance (TTL + Confidence Decay)

`runMaintenance(db, logger)` runs on plugin startup:

### TTL Enforcement
- Facts where `created_at + ttl_days < now` → `status='archived'`, `expired_at` set
- Revision logged with type `expired`

### Confidence Decay
- Facts not accessed in >7 days: `confidence *= 0.99`
- Facts not accessed in >30 days: `confidence *= 0.95`
- Topics with `ttl_days = NULL` (infinite TTL like `instructions`, `user_preferences`): decay 2x slower
- Never decay below 0.3
- Revision logged with type `decay`

## Scope Separation

Facts have a `scope` column:
- `global` — visible to all agents (default)
- `<agent_id>` — visible only to that specific agent

RAG injection filters: include `global` + current agent's scope.
Extraction sets scope based on which agent session produced the conversation.

## Memory Bank Management Tool

Tool name: `memory_bank_manage`

Actions:
| Action | Description | Required Params |
|--------|-------------|----------------|
| `list` | List facts with optional topic/status filter | — |
| `search` | Semantic search across active facts | `query` |
| `add` | Manually add a fact | `fact` |
| `edit` | Edit fact content (logs revision) | `fact_id`, `fact` |
| `delete` | Soft-delete (set status=archived) | `fact_id` |
| `status` | Show stats (totals, per-topic, per-status) | — |

Optional params: `topic`, `status`, `confidence`, `scope`, `limit`

## RAG Integration

`before_agent_start` hook injects relevant active facts:
1. Embed user prompt with Qwen3
2. Cosine similarity search against active facts (scope-filtered)
3. Top-K facts injected as `[memory bank]` section
4. Access stats updated (access_count, last_accessed_at)

## LLM Config
- URL: `http://192.168.1.80:11434/v1/chat/completions` (default, Ollama on Spark)
- Model: `qwen3:32b` (primary), configurable
- API key: optional (required for Anthropic/OpenAI hosted endpoints)
- Supports both OpenAI-compatible and Anthropic API formats

## Config Extension
```typescript
memoryBank: {
  enabled: boolean;              // true
  extractionModel: string;       // 'qwen3:32b'
  extractionUrl: string;         // 'http://192.168.1.80:11434/v1/chat/completions'
  extractionApiKey?: string;     // API key (optional for local Ollama)
  minConversationLength: number; // 0
  consolidationThreshold: number;// 0.85
  maxFactsPerTurn: number;       // 10
  ragTopK: number;               // 5
}
```

## Files
### Memory Bank Core
- `src/memory-bank/types.ts` — Type definitions (FactStatus, TemporalType, etc.)
- `src/memory-bank/extractor.ts` — LLM fact extraction with temporal context
- `src/memory-bank/consolidator.ts` — Dedup, merge, contradiction detection
- `src/memory-bank/maintenance.ts` — TTL enforcement + confidence decay
- `src/memory-bank/topics.ts` — Default topic seeds
- `src/memory-bank/index.ts` — Barrel exports

### Tools
- `src/tools/memory-bank-manage.ts` — Management tool (list, search, add, edit, delete, status)

### Modified Files
- `src/db/sqlite.ts` — Schema with status, scope, temporal_type columns
- `src/config.ts` — extractionApiKey config field
- `src/hooks/on-turn-end.ts` — Scope-aware consolidation
- `src/hooks/rag-injection.ts` — Status + scope filtering
- `src/index.ts` — Tool registration + startup maintenance
- `openclaw.plugin.json` — JSON schema for new config fields

## Implementation History
- **v1** (2026-03-11): Initial implementation — extraction, consolidation, topics, RAG
- **v2** (2026-03-13): Full Vertex AI parity — status system, TTL enforcement, contradiction detection, confidence decay, management tool, scope separation, temporal context
