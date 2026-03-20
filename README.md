# memory-unified — OpenClaw Plugin

Unified memory layer for [OpenClaw](https://github.com/openclaw/openclaw) that merges **SQLite** structured storage with **sqlite-vec** vector search and **Qwen3-Embedding-8B** local embeddings. Zero-cost semantic memory for AI agents.

## What It Does

One plugin that gives your agent:
- **Structured memory** — SQLite with 8 entry types, FTS5 full-text search
- **Semantic search** — sqlite-vec cosine KNN with 4096-dim Qwen3-Embedding-8B embeddings
- **RAG injection** — multi-layer pipeline: FTS5 + vector search + Nemotron Rerank 1B v2 cross-encoder + Memory Bank facts
- **Memory Bank v2** — long-term fact extraction, contradiction detection, confidence decay, TTL management (full Vertex AI Memory Bank feature parity + extras)
- **Reranking** — Nemotron Rerank 1B v2 cross-encoder for improved RAG accuracy
- **Skill learning** — tracks tool usage, detects patterns, proposes improvements
- **Conversation threading** — groups messages into topics with lifecycle management
- **File indexing** — scan workspace files into searchable memory
- **Task tracking** — store and query work items with status

**Cost: $0/month** — uses local Nemotron models on RTX 3090 (no cloud API needed).

## Architecture

```
┌────────────────────────────────────────────────────┐
│              memory-unified plugin                  │
│                                                    │
│         skill-memory.db (single file)              │
│  ┌──────────────────┬─────────────────────────┐   │
│  │  SQLite tables   │  sqlite-vec (vec0)      │   │
│  │                  │                         │   │
│  │ • unified_entries│ • vec_entries            │   │
│  │ • skills         │   float[4096] cosine    │   │
│  │ • conversations  │   entry_type filtering  │   │
│  │ • patterns       │                         │   │
│  │ • memory_facts   │ • memory_facts_vec      │   │
│  │ • memory_topics  │   float[4096] cosine    │   │
│  │ • skill_execs    │   pre-embedded facts    │   │
│  │ • FTS5 index     │                         │   │
│  └──────────────────┴─────────────────────────┘   │
│         │                      │                   │
│    SQL + FTS5           Semantic similarity         │
│    (exact match)        (meaning-based KNN)         │
│                                                    │
│  ┌─────────────────────────────────────────────┐   │
│  │  GPU Models (RTX 3090, ~20.6 GB VRAM)      │   │
│  │  • Qwen3-Embedding-8B (4096-dim, vLLM)     │   │
│  │  • Nemotron Rerank 1B v2 (cross-encoder)   │   │
│  └─────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────┘
```

**Vector backend:** sqlite-vec only (migration complete). Single file, no async, ACID transactions.

## RAG Pipeline (before_agent_start)

On every message, the plugin automatically:
1. **FTS5 skill search** — matches keywords, injects best SKILL.md procedure
2. **Direct skills table search** — LIKE fallback on `skills.description` + `skills.keywords`
3. **Vector search** — sqlite-vec KNN finds semantically similar entries (tool entries excluded)
4. **Nemotron Rerank** — cross-encoder reranks candidates (threshold: 3+ results)
5. **Semantic skill search** — Nemotron embedding similarity on skill cache
6. **Pattern boosting** — keyword→skill confidence patterns
7. **Conversation context** — active thread summaries
8. **Memory Bank facts** — pre-embedded facts via `memory_facts_vec` sqlite-vec search

## Memory Bank v2

Full Vertex AI Memory Bank feature parity plus extras:

| Feature | Status |
|---------|--------|
| LLM Fact Extraction | Configurable endpoint (Ollama/Anthropic/local) |
| Contradiction Detection | Cosine similarity + LLM verification |
| Confidence Decay | Time-based with per-topic TTL, slow mode for infinite TTL |
| TTL Expiry | Per-fact + per-topic TTL |
| Topic Organization | 7 default topics, auto-assign |
| Status Lifecycle | active → stale → contradicted → archived |
| Semantic Search | sqlite-vec pre-embedded facts (single KNN query) |
| Management API | `memory_bank_manage` tool (list/search/add/edit/delete/status) |
| Revision History | Full audit trail in `memory_revisions` |
| Multi-agent Scope | global/per-agent scoping |
| Temporal Types | current_state / historical / permanent |

## Entry Types

| Type       | Purpose                          |
|------------|----------------------------------|
| `skill`    | Learned procedures, SKILL.md     |
| `protocol` | Reusable workflows, SOPs         |
| `config`   | Infrastructure, settings         |
| `history`  | Facts, conversation logs         |
| `tool`     | Tool usage logs (excluded from vector index) |
| `result`   | Task outputs, deliverables       |
| `task`     | Work items with status           |
| `file`     | Indexed file content             |

## Agent Tools

| Tool | Description |
|------|-------------|
| `unified_search` | Search across SQL entries + vector memory |
| `unified_store` | Store entry to both SQLite and vector index |
| `unified_conversations` | List/search conversation threads |
| `unified_index_files` | Scan directory and index files into memory |
| `memory_bank_manage` | Manage long-term memory facts (list/search/add/edit/delete/status) |

## Embedding Setup

Uses Qwen3-Embedding-8B via vLLM (OpenAI-compatible API) on local GPU:

```
Model: Qwen/Qwen3-Embedding-8B (FP16)
Dimensions: 4096
Runtime: vLLM (OpenAI-compatible /v1/embeddings)
GPU: RTX 3090 (~15 GB VRAM)
Latency: ~20ms/query
Batch support: Yes (vLLM native)
```

## Reranking

Nemotron Rerank 1B v2 cross-encoder for improved RAG accuracy:

```
Model: nvidia/llama-nemotron-rerank-1b-v2 (FP16)
Runtime: vLLM
GPU: RTX 3090 (~2.6 GB VRAM)
Latency: ~30ms/10 docs
Endpoint: http://localhost:8082/rerank
```

## Install

```bash
cd ~/.openclaw/extensions/
git clone <repo-url> memory-unified
cd memory-unified
npm install
npm run build
```

Add to `openclaw.json`:
```json
{
  "extensions": ["memory-unified"]
}
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `better-sqlite3` | SQLite database with FTS5 |
| `sqlite-vec` | Vector search extension (brute-force KNN, in-process) |
| `@sinclair/typebox` | Schema validation |

## Upgrade Plan

See [UPGRADE-PLAN.md](UPGRADE-PLAN.md) for the full audit and phased improvement plan.

## Docs

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture overview
- [CHANGELOG.md](docs/CHANGELOG.md) — version history
- [CUDA-SETUP.md](docs/CUDA-SETUP.md) — GPU embedding setup

---
*Last updated: 2026-03-20*
