# memory-unified — OpenClaw Plugin

**v2.0 "Lambo"** — The most advanced open-source memory system for AI agents. Entity resolution, knowledge graph, 4-strategy parallel retrieval, Ebbinghaus forgetting curve, and memory tiering — all running locally at zero cost.

## What It Does

One plugin that gives your agent:

- **🧠 Entity Resolution + Knowledge Graph** — LLM-based entity extraction (people, orgs, projects, tools), alias resolution, relationship tracking, graph traversal queries
- **🔍 4-Strategy Parallel Retrieval** — semantic + keyword + graph + temporal searches run in parallel with score fusion and cross-encoder reranking
- **💭 `unified_reflect` Tool** — synthesize and reason across stored memories using multi-strategy retrieval + entity graph + LLM reasoning
- **🗂️ Memory Tiering** — automatic hot/warm/cold tier management based on access patterns, with auto-promotion and demotion
- **📉 Ebbinghaus Forgetting Curve** — scientifically-grounded memory decay: `R = e^(-t/S)` where strength grows with each access (replaces naive linear decay)
- **🏦 Memory Bank v2** — long-term fact extraction, contradiction detection, scope separation, TTL management
- **🔗 Conversation Threading** — groups messages into topics with lifecycle management
- **📊 Topic Timeline** — track topic activity over time with trends and chronological events
- **🎯 Feedback Capture** — rate tasks, track skill performance, inject negative feedback warnings into RAG
- **⚡ Pattern Learning** — detects recurring tool usage patterns, proposes skill improvements

**Backends:** PostgreSQL (recommended, with pgvector) or SQLite (sqlite-vec).  
**Cost: $0/month** — uses local GPU models (no cloud API needed).

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                  memory-unified v2.0                        │
│                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐   │
│  │   Entities    │  │  Relations   │  │   Mentions     │   │
│  │ name, type,   │──│ source→target│──│ entity↔entry   │   │
│  │ aliases, meta │  │ rel_type     │  │ linking        │   │
│  └──────────────┘  └──────────────┘  └────────────────┘   │
│         Knowledge Graph (Entity Resolution)                │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  4-Strategy Parallel Retrieval                      │   │
│  │                                                     │   │
│  │  Semantic (0.4) ──┐                                 │   │
│  │  Keyword  (0.25)──┼── Score Fusion ── Rerank ── Top │   │
│  │  Graph    (0.2) ──┤                                 │   │
│  │  Temporal (0.15)──┘                                 │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐   │
│  │ Memory Bank   │  │ Tiering      │  │ Ebbinghaus     │   │
│  │ facts, topics │  │ hot/warm/cold│  │ R = e^(-t/S)   │   │
│  │ contradictions│  │ auto-promote │  │ strength grows  │   │
│  └──────────────┘  └──────────────┘  └────────────────┘   │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  GPU Models (local, zero cost)                      │   │
│  │  • Qwen3-Embedding-8B (4096-dim embeddings)         │   │
│  │  • Nemotron Rerank 1B v2 (cross-encoder)            │   │
│  │  • Any OpenAI-compatible LLM (fact extraction)      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                            │
│  Backend: PostgreSQL + pgvector  │  SQLite + sqlite-vec    │
└────────────────────────────────────────────────────────────┘
```

## How It Compares

| Feature | memory-unified v2.0 | Mem0 Pro | Letta | Hindsight |
|---------|---------------------|----------|-------|-----------|
| Entity Resolution | ✅ LLM + alias matching | ✅ ($249/mo) | ❌ | ✅ |
| Knowledge Graph | ✅ entities + relations + traversal | ✅ (Pro only) | ❌ | ✅ |
| Multi-Strategy Retrieval | ✅ 4 parallel strategies | ⚠️ vector + graph | ⚠️ tiered | ✅ 4 strategies |
| Memory Tiering | ✅ hot/warm/cold auto | ❌ | ✅ core/recall/archival | ❌ |
| Forgetting Curve | ✅ Ebbinghaus (R=e^(-t/S)) | ❌ | ❌ | ❌ |
| Cross-Encoder Rerank | ✅ Nemotron 1B | ❌ | ❌ | ❌ |
| Reflect/Synthesize | ✅ unified_reflect | ❌ | ❌ | ✅ |
| Multi-Agent | ✅ scoped (global + per-agent) | ✅ | ❌ | ❌ |
| Contradiction Detection | ✅ LLM-based | ❌ | ❌ | ❌ |
| Local/Air-gapped | ✅ fully local | ❌ cloud | ❌ cloud | ❌ cloud |
| Cost | **$0/month** | **$249/month** | **$99/month** | **$49/month** |

## Agent Tools

| Tool | Description |
|------|-------------|
| `unified_search` | Search across SQL + vector + entity graph |
| `unified_store` | Store entry with auto-tagging and embedding |
| `unified_reflect` | **NEW** — Synthesize and reason across stored memories |
| `unified_conversations` | List/search conversation threads |
| `unified_index_files` | Scan directory and index files into memory |
| `memory_bank_manage` | Manage long-term facts (list/search/add/edit/delete/status) |
| `feedback` | Rate tasks (+1/0/-1), list feedback, view stats |
| `topic_timeline` | **NEW** — Track topic trends, timeline events, register topics |

## RAG Pipeline (4-Strategy)

On every message, the plugin automatically runs **4 retrieval strategies in parallel**:

1. **Keyword Strategy** — FTS5 full-text search + direct skill matching
2. **Semantic Strategy** — pgvector/sqlite-vec KNN with query expansion
3. **Graph Strategy** — Entity resolution → relation traversal → linked entries
4. **Temporal Strategy** — Recent entries from same agent scope, time-weighted

Results are fused with configurable weights (default: semantic 0.4, keyword 0.25, graph 0.2, temporal 0.15), then reranked by Nemotron cross-encoder. Hot tier facts are always injected.

## Memory Tiering

Facts automatically move between tiers based on access patterns:

| Tier | Criteria | Behavior |
|------|----------|----------|
| **🔥 hot** | Accessed 5+ times, last 7 days | Always injected into RAG |
| **🟡 warm** | Default tier | Retrieved on relevance |
| **❄️ cold** | No access in 30+ days | Archived, rarely retrieved |

Promotion: warm → hot (frequent access). Demotion: hot → warm (30d no access), warm → cold (90d no access).

## Ebbinghaus Forgetting Curve

Replaces naive linear decay (`confidence *= 0.99`) with a scientifically-grounded model:

```
R = e^(-t/S)

Where:
  R = retention (maps to confidence 0.0–1.0)
  t = days since last access
  S = strength (starts at 1.0, increases with each access)
```

Each time a fact is accessed, its **strength increases** (the "spacing effect"), making it decay slower over time. This models how human memory actually works — frequently recalled facts become more durable.

## Entity Resolution

The plugin extracts entities (people, organizations, projects, tools, concepts) from conversations using an LLM, then:

1. **Resolves** against existing entities via embedding similarity + alias matching
2. **Links** entities to memory entries (bidirectional)
3. **Tracks relationships** between entities (e.g., "Bartosz → manages → Hermes")
4. **Traverses the graph** during retrieval for contextual enrichment

## Quick Start

### Install

```bash
cd ~/.openclaw/extensions/
git clone https://github.com/numerika-ai/openclaw-memory-unified.git memory-unified
cd memory-unified
npm install
npm run build
```

### Configure (PostgreSQL — recommended)

Add to `openclaw.json`:

```json
{
  "plugins": {
    "load": { "paths": ["~/.openclaw/extensions/memory-unified"] },
    "slots": { "memory": "memory-unified" },
    "entries": {
      "memory-unified": {
        "enabled": true,
        "config": {
          "backend": "postgres",
          "postgresUrl": "postgresql://user:pass@localhost:5432/openclaw",
          "embeddingUrl": "http://localhost:8080/v1/embeddings",
          "embeddingModel": "Qwen/Qwen3-Embedding-8B",
          "embeddingDim": 4096,
          "rerankUrl": "http://localhost:8082/rerank",
          "rerankEnabled": true,
          "ragTopK": 5,
          "ragSlim": true,
          "memoryBank": {
            "enabled": true,
            "extractionUrl": "http://localhost:11434/v1/chat/completions",
            "extractionModel": "qwen3:32b",
            "maintenanceOnStartup": true
          }
        }
      }
    }
  }
}
```

### Configure (SQLite — zero setup)

```json
{
  "plugins": {
    "entries": {
      "memory-unified": {
        "enabled": true,
        "config": {
          "backend": "sqlite",
          "dbPath": "skill-memory.db"
        }
      }
    }
  }
}
```

Tables are created automatically on first start.

## Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `backend` | `"sqlite" \| "postgres"` | `"postgres"` | Database backend |
| `postgresUrl` | string | — | PostgreSQL connection URL |
| `embeddingUrl` | string | `localhost:8080` | OpenAI-compatible embedding endpoint |
| `embeddingModel` | string | `Qwen/Qwen3-Embedding-8B` | Embedding model name |
| `embeddingDim` | number | `4096` | Embedding dimensions |
| `rerankUrl` | string | `localhost:8082` | Reranker endpoint |
| `rerankEnabled` | boolean | `true` | Enable cross-encoder reranking |
| `ragSlim` | boolean | `true` | Enable RAG injection on agent start |
| `ragTopK` | number | `5` | Number of results to inject |
| `logToolCalls` | boolean | `true` | Log state-changing tool calls |
| `logToolCallsFilter` | `"whitelist" \| "all"` | `"whitelist"` | Tool logging filter mode |
| `memoryBank.enabled` | boolean | `true` | Enable Memory Bank fact extraction |
| `memoryBank.extractionUrl` | string | — | LLM endpoint for fact extraction |
| `memoryBank.extractionModel` | string | `qwen3:32b` | Model for extraction |
| `memoryBank.extractionApiKey` | string | — | API key (if needed) |
| `memoryBank.maintenanceOnStartup` | boolean | `true` | Run Ebbinghaus decay + tiering on start |

## Embedding Models (Tested)

| Model | Dims | VRAM | Endpoint | Notes |
|-------|------|------|----------|-------|
| Qwen3-Embedding-8B | 4096 | ~15 GB | vLLM `/v1/embeddings` | Recommended |
| Nemotron Embed 1B v2 | 2048 | ~2.6 GB | TEI | Lighter alternative |
| OpenAI text-embedding-3-small | 1536 | — | API | Cloud option |

## PostgreSQL Tables

v2.0 creates these tables automatically in the `openclaw` schema:

- `unified_entries` — all memory entries with embeddings (pgvector)
- `skills` — learned procedures with execution tracking
- `conversations` + `conversation_messages` — threaded conversation memory
- `patterns` + `pattern_history` — detected behavioral patterns
- `agent_knowledge` — Memory Bank facts with tier + strength + Ebbinghaus
- `memory_topics` — topic definitions with TTL
- `memory_revisions` — full audit trail
- `topic_events` + `topic_registry` — topic timeline tracking
- `feedback` — task feedback ratings
- **`agent_entities`** — extracted entities (name, type, aliases)
- **`agent_entity_relations`** — entity relationships (source → target)
- **`agent_entity_mentions`** — entity ↔ entry linking
- **`skill_embeddings`** — persistent skill embedding cache

## Development

```bash
npm run build    # TypeScript → dist/
npm run watch    # Watch mode (if configured)
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `better-sqlite3` | SQLite database with FTS5 (sqlite backend) |
| `sqlite-vec` | Vector search extension (sqlite backend) |
| `pg` | PostgreSQL client (postgres backend) |
| `pgvector` | Vector search for PostgreSQL |
| `@sinclair/typebox` | Schema validation |

## Docs

- [CHANGELOG.md](docs/CHANGELOG.md) — version history
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture overview
- [MEMORY-BANK-SPEC.md](MEMORY-BANK-SPEC.md) — Memory Bank specification

## License

MIT

---
*Last updated: 2026-03-28*
