# memory-unified — OpenClaw Plugin

Unified memory layer for [OpenClaw](https://github.com/openclaw/openclaw) that merges **SQLite** structured storage with **vector search** and **Qwen3** local embeddings. Zero-cost semantic memory for AI agents.

## What It Does

One plugin that gives your agent:
- **Structured memory** — SQLite with 8 entry types, FTS5 full-text search
- **Semantic search** — Vector similarity with 4096-dim Qwen3 embeddings
- **RAG injection** — automatically surfaces relevant context on each message
- **Skill learning** — tracks tool usage, detects patterns, proposes improvements
- **Conversation threading** — groups messages into topics with lifecycle management
- **File indexing** — scan workspace files into searchable memory
- **Task tracking** — store and query work items with status

**Cost: $0/month** — uses local Qwen3-Embedding via Ollama (no OpenAI needed).

## Architecture

**Current (v2.2):** SQLite + LanceDB (two separate stores). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Target (v3.0):** SQLite + sqlite-vec (single database file). See [docs/ARCHITECTURE-V3.md](docs/ARCHITECTURE-V3.md).

```
┌────────────────────────────────────────────────────┐
│              memory-unified plugin v3.0              │
│                                                    │
│         skill-memory.db (single file)              │
│  ┌──────────────────┬─────────────────────────┐   │
│  │  SQLite tables   │  vec0 virtual table     │   │
│  │                  │                         │   │
│  │ • unified_entries│ • vec_entries            │   │
│  │ • skills         │   float[4096] cosine    │   │
│  │ • conversations  │   metadata filtering    │   │
│  │ • patterns       │   entry_type column     │   │
│  │ • FTS5 index     │                         │   │
│  └──────────────────┴─────────────────────────┘   │
│         │                      │                   │
│    SQL + FTS5           Semantic similarity         │
│    (exact match)        (meaning-based)             │
└────────────────────────────────────────────────────┘
```

**Vector backend:** sqlite-vec (brute-force KNN in-process, loaded into better-sqlite3 via `loadExtension`).
**Why:** Single file, no async, ACID transactions, ~130MB fewer dependencies. See [v3.0 architecture](docs/ARCHITECTURE-V3.md) for full rationale.

## Entry Types

| Type       | Purpose                          | Example                          |
|------------|----------------------------------|----------------------------------|
| `skill`    | Learned procedures, SKILL.md     | "How to deploy via Docker"       |
| `protocol` | Reusable workflows, SOPs         | "Subagent spawn protocol"        |
| `config`   | Infrastructure, settings         | "Server IPs, Docker ports"       |
| `history`  | Facts, conversation logs         | "User prefers dark mode"         |
| `tool`     | Tool usage patterns, results     | "ffmpeg conversion flags"        |
| `result`   | Task outputs, deliverables       | "Report generated at /tmp/..."   |
| `task`     | Work items with status           | "Deploy v2 — status: in_progress"|
| `file`     | Indexed file content             | "README.md chunk 1/3"           |

## Agent Tools

The plugin exposes 3 tools + 1 utility:

| Tool | Description |
|------|-------------|
| `unified_search` | Search across SQL entries + vector memory |
| `unified_store` | Store entry to both SQLite and vector index |
| `unified_conversations` | List/search conversation threads |
| `unified_index_files` | Scan directory and index files into memory |

## RAG Pipeline (before_agent_start)

On every message, the plugin automatically:
1. **FTS5 skill search** — matches keywords → injects best SKILL.md procedure
2. **Vector search** — finds semantically similar past entries
3. **Recent executions** — shows last skill usage results
4. **Active conversations** — surfaces ongoing thread context

## Embedding Setup

Uses Qwen3-Embedding (8B) via Ollama on a remote GPU server:

```
Embedding host: Spark (192.168.1.80)
Ollama port: 11434
Model: qwen3-embedding:8b
Dimensions: 4096
Latency: ~50ms over LAN
```

Configure in plugin config:
```json
{
  "embedUrl": "http://192.168.1.80:11434/v1/embeddings",
  "embedModel": "qwen3-embedding:8b"
}
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
| `sqlite-vec` | Vector search extension (v3.0, replaces LanceDB) |
| `@sinclair/typebox` | Schema validation |

## Migration Status (LanceDB → sqlite-vec)

| Phase | Description | Status |
|-------|-------------|--------|
| **Phase 1** | Dual-write: store vectors in both LanceDB + sqlite-vec | ✅ Complete, deployed on Hermes |
| **Phase 2** | Read from sqlite-vec, LanceDB as fallback | 🔜 Next |
| **Phase 3** | Remove LanceDB dependency entirely | ⬜ Planned |

**Key fix (2026-03-04):** sqlite-vec vec0 virtual table requires BigInt for INTEGER PRIMARY KEY — standard JavaScript Number is rejected. Fixed in commit 18f2dd2.

**Test environment:** Hermes VM (OpenClaw agent on loco39) — 7/7 entries dual-written successfully.

## Docs

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — current v2.2 architecture
- [ARCHITECTURE-V3.md](docs/ARCHITECTURE-V3.md) — v3.0 migration plan (LanceDB → sqlite-vec)
- [CHANGELOG.md](docs/CHANGELOG.md) — version history
- [CUDA-SETUP.md](docs/CUDA-SETUP.md) — GPU embedding setup

---
*Last edited by Wiki — 2026-03-04 20:36 UTC*
