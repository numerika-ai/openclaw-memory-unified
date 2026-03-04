# Changelog

## [Unreleased] — Phase 2: LanceDB Migration
- Replace hnswlib-node with LanceDB as vector backend
- Migrate existing HNSW vectors to LanceDB
- Add native filtered vector search
- Add delete support for vector entries

## [1.1.0] — 2026-03-04
### Added
- `file` entry type — index workspace files into memory
- `unified_index_files` tool — scan directories, auto-tag from paths
- `src/db/lancedb.ts` — LanceDB vector store module (Phase 2 prep)

### Changed
- Modularized monolith: `src/tools/`, `src/hooks/`, `src/utils/`, `src/embedding/`
- Fixed `QWEN_EMBED_URL` default → Spark (192.168.1.80:11434)
- Schema CHECK constraint extended for 'file' type

### Fixed
- Embeddings now work (Qwen3-embedding:8b on Spark, 4096-dim)
- HNSW indexing operational: 6000+ vectors from 7500+ entries

## [1.0.0] — 2026-03-01
### Added
- Initial release: SQLite + HNSW vector search
- 7 entry types: skill, protocol, config, history, tool, result, task
- FTS5 full-text search
- RAG slim injection on agent start
- Skill execution tracking with pattern recognition
- Conversation threading with lifecycle
- Trajectory tracking (SONA)
- Qwen3-Embedding via Ollama (4096-dim, local, free)
- 3 tools: unified_search, unified_store, unified_conversations
- 3 hooks: before_agent_start, after_tool_call, agent_end

## [0.x] — 2026-02-11 to 2026-02-28
### Pre-release
- Ruflo MCP integration (later stubbed — port 3002 dead)
- Initial USMD SQLite schema from skill tracking
- Migration from separate memory-lancedb plugin
- First HNSW implementation with hnswlib-node
