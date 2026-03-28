# Changelog

## [2.0.0] "Lambo" — 2026-03-28

### Added — Entity Resolution + Knowledge Graph
- `src/entity/extractor.ts` — LLM-based entity extraction (people, orgs, projects, tools, concepts)
- Entity alias resolution via embedding similarity (threshold 0.85)
- 3 new Postgres tables: `agent_entities`, `agent_entity_relations`, `agent_entity_mentions`
- Graph traversal queries in DatabasePort: `findOrCreateEntity`, `storeEntityRelation`, `linkEntityToEntry`, `getRelatedEntities`, `getEntityMentions`
- Entity extraction runs automatically during Memory Bank fact consolidation

### Added — 4-Strategy Parallel Retrieval
- Complete rewrite of `rag-injection.ts` with 4 parallel retrieval strategies:
  - **Semantic** (weight 0.4) — pgvector/sqlite-vec KNN with query expansion
  - **Keyword** (weight 0.25) — FTS5 full-text search + direct skill matching
  - **Graph** (weight 0.2) — entity resolution → relation traversal → linked entries
  - **Temporal** (weight 0.15) — recent entries from same agent scope, time-weighted
- Score fusion: weighted combination of all strategies, deduplication by entry ID
- Hot tier facts always injected regardless of search results

### Added — `unified_reflect` Tool
- `src/tools/unified-reflect.ts` — synthesize and reason across stored memories
- Runs multi-strategy retrieval + entity graph lookup + LLM synthesis
- Returns structured answer with sources and confidence

### Added — `topic_timeline` Tool
- `src/tools/topic-timeline.ts` — track topic activity over time
- Actions: `trends` (what's hot), `timeline` (chronological events), `register` (new topic)
- `topic_events` + `topic_registry` Postgres tables

### Added — Memory Tiering
- 3 tiers: hot (accessed 5+, last 7d), warm (default), cold (30d+ no access)
- `tier` + `strength` columns in `agent_knowledge`
- Auto-promotion: warm → hot (frequent access)
- Auto-demotion: hot → warm (30d), warm → cold (90d)
- Hot tier facts always injected in RAG

### Added — Ebbinghaus Forgetting Curve
- Replaces linear confidence decay (`*= 0.99`) with `R = e^(-t/S)`
- Strength increases with each access (spacing effect)
- Strength factor: `S_new = S_old * 1.5` per access
- Scientifically-grounded memory retention model

### Added — Configurable Embedding URL
- `embeddingUrl` config option (default: `http://localhost:8080/v1/embeddings`)
- `openclaw.plugin.json` schema updated with all new config keys

### Changed — Maintenance Ported to DatabasePort
- Complete rewrite of `maintenance.ts` to use async `DatabasePort`
- Works with both PostgreSQL and SQLite backends
- Ebbinghaus decay + tiering in single maintenance pass

### Changed — RAG Injection
- 4-strategy parallel retrieval replaces sequential FTS5 → vector → rerank pipeline
- Graph strategy adds entity-aware context enrichment
- Temporal strategy adds recency-weighted results from agent scope
- Score fusion configurable via weights

### Changed — On-Turn-End Hook
- Expanded tool whitelist: added `unified_search`, `memory_bank_manage`, `web_search`, `web_fetch`, `unified_reflect`
- Entity extraction integrated into Memory Bank extraction flow
- Conversation dedup fix: require `overlap >= 2` tags instead of `>= 1` (was too aggressive)

### Fixed
- Conversation dedup merging unrelated threads (overlap threshold 1 → 2)
- Maintenance functions using raw SQLite calls on Postgres backend
- Pattern GC now cleans up low-confidence stale patterns
- `skill_embeddings` table for persistent skill embedding cache (avoids re-embedding)

### Stats
- 15 files changed, +1976 / -538 lines
- 3 new files: `entity/extractor.ts`, `tools/unified-reflect.ts`, `tools/topic-timeline.ts`
- 4 new Postgres tables: `agent_entities`, `agent_entity_relations`, `agent_entity_mentions`, `skill_embeddings`

---

## [1.3.0] — 2026-03-21
### Added
- Search aliases + query expansion for better retrieval
- Recency boost + size boost in search scoring
- Feedback capture system — `feedback` tool, DB table, RAG integration

### Changed
- Search now expands queries with aliases before vector search
- Results boosted by recency (recent = higher score) and content size

## [1.2.0] — 2026-03-17
### Added
- Nemotron RAG integration — Embed 1B v2 + Rerank 1B v2
- Smart tool logging — whitelist filter (Phase 4), reduced DB from 204 MB → 37 MB
- Startup data cleanup — purge old tool entries, clear staging, VACUUM

### Changed
- `logToolCallsFilter: "whitelist"` now default
- access_count tracking on every search hit

## [1.1.0] — 2026-03-14
### Added
- Memory Bank v2 — full Vertex AI Memory Bank feature parity
- Fact extraction via configurable LLM endpoint
- Contradiction detection (cosine similarity + LLM verification)
- Confidence decay with TTL enforcement
- `memory_bank_manage` tool (list/search/add/edit/delete/status)
- Multi-agent scope separation (global + per-agent)
- Temporal types (current_state / historical / permanent)
- `file` entry type + `unified_index_files` tool

### Changed
- Modularized monolith: `src/tools/`, `src/hooks/`, `src/utils/`, `src/embedding/`

## [1.0.0] — 2026-03-01
### Added
- Initial release: SQLite + HNSW vector search
- 7 entry types: skill, protocol, config, history, tool, result, task
- FTS5 full-text search
- RAG slim injection on agent start
- Skill execution tracking with pattern recognition
- Conversation threading with lifecycle
- Qwen3-Embedding via Ollama (4096-dim, local, free)
- 3 tools: unified_search, unified_store, unified_conversations
- 3 hooks: before_agent_start, after_tool_call, agent_end

## [0.x] — 2026-02-11 to 2026-02-28
### Pre-release
- Ruflo MCP integration (later deprecated)
- Initial USMD SQLite schema
- Migration from separate memory-lancedb plugin
- First HNSW implementation with hnswlib-node
