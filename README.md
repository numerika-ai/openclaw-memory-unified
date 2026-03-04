# memory-unified — OpenClaw Plugin

Unified memory layer for [OpenClaw](https://github.com/openclaw/openclaw) that merges **SQLite** structured storage with **LanceDB** vector search and **Qwen3** local embeddings. Zero-cost semantic memory for AI agents.

## What It Does

One plugin that gives your agent:
- **Structured memory** — SQLite with 8 entry types, FTS5 full-text search
- **Semantic search** — LanceDB vector store with 4096-dim Qwen3 embeddings
- **RAG injection** — automatically surfaces relevant context on each message
- **Skill learning** — tracks tool usage, detects patterns, proposes improvements
- **Conversation threading** — groups messages into topics with lifecycle management
- **File indexing** — scan workspace files into searchable memory
- **Task tracking** — store and query work items with status

**Cost: $0/month** — uses local Qwen3-Embedding via Ollama (no OpenAI needed).

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                      memory-unified plugin                           │
├───────────────────────────┬──────────────────────────────────────────┤
│     SQLite (structured)   │       LanceDB (vector search)            │
│                           │                                          │
│ • unified_entries         │ • 4096-dim Qwen3 vectors                 │
│   (skill/protocol/config/ │ • native filtered search                 │
│    history/tool/result/   │ • disk-based, scales to millions         │
│    task/file)             │ • Arrow format (Pandas/DuckDB interop)   │
│ • skills + executions     │ • delete/update support                  │
│ • tool_calls              │                                          │
│ • patterns + confidence   ├──────────────────────────────────────────┤
│ • conversations           │       Qwen3-Embedding (Ollama)           │
│ • artifacts               │ • qwen3-embedding:8b model               │
│ • FTS5 keyword search     │ • local, free, 4096 dimensions           │
└───────────────────────────┴──────────────────────────────────────────┘
         │                              │
    SQL + FTS5                   Semantic similarity
    (exact match)                (meaning-based)
```

## Entry Types

| Type | Purpose | Example |
|------|---------|---------|
| `skill` | Learned procedures, SKILL.md files | "How to deploy via Docker" |
| `protocol` | Reusable workflows, SOPs | "Subagent spawn protocol" |
| `config` | Infrastructure, settings | "Server IPs, Docker ports" |
| `history` | Facts, conversation logs | "User prefers dark mode" |
| `tool` | Tool usage patterns, results | "ffmpeg conversion flags" |
| `result` | Task outputs, deliverables | "Training run metrics" |
| `task` | Work items with status | "Hardware scan — IN_PROGRESS" |
| `file` | Indexed workspace files | "TOOLS.md contents" |

## Tools

### `unified_search`

Search across SQL + vector memory simultaneously.

```
unified_search(query="Docker containers on Tank")
unified_search(query="active work", type="task")
unified_search(query="training baseline", type="config", limit=5)
```

### `unified_store`

Store an entry with auto-tagging and embedding.

```
unified_store(content="Tank IP: 192.168.1.100", type="config", tags="infrastructure")
unified_store(content="TASK: Fix collectors", type="task", tags="active,spark")
```

### `unified_conversations`

Query conversation threads with lifecycle management.

```
unified_conversations()                              # active threads
unified_conversations(status="all", query="Docker")  # search all
```

### `unified_index_files`

Scan a directory and index files into memory.

```
unified_index_files()                                    # default: workspace
unified_index_files(directory="/path/to/project", limit=50)
```

## Installation

### Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) v0.40+
- Node.js 22+
- [Ollama](https://ollama.ai) with `qwen3-embedding:8b` model

### Quick Start

```bash
# 1. Set up embeddings (on any machine in your network)
ollama pull qwen3-embedding:8b

# 2. Clone and install
git clone https://github.com/numerika-ai/openclaw-memory-unified.git
cd openclaw-memory-unified
npm install

# 3. Configure OpenClaw (~/.openclaw/openclaw.json)
```

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-unified"
    },
    "entries": {
      "memory-unified": {
        "enabled": true,
        "config": {
          "dbPath": "~/.openclaw/workspace/skill-memory.db",
          "ragSlim": true,
          "logToolCalls": true,
          "trajectoryTracking": true,
          "ragTopK": 3
        }
      }
    }
  }
}
```

```bash
# 4. Restart
openclaw gateway restart
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QWEN_EMBED_URL` | `http://localhost:11434/v1/embeddings` | Ollama embeddings endpoint |

If Ollama runs on a different machine:
```bash
export QWEN_EMBED_URL="http://192.168.1.80:11434/v1/embeddings"
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dbPath` | string | `skill-memory.db` | SQLite database path |
| `lanceDbPath` | string | `memory-vectors.lance` | LanceDB vector store path |
| `ragSlim` | boolean | `true` | Inject context into agent on start |
| `logToolCalls` | boolean | `true` | Log every tool call to memory |
| `trajectoryTracking` | boolean | `true` | Track agent session trajectories |
| `ragTopK` | number | `5` | Vector results to inject per query |

## RAG Pipeline

On each incoming message, the plugin automatically:

1. **FTS5 search** — keyword match against skills database
2. **LanceDB search** — semantic similarity against all stored vectors
3. **Thread context** — recent conversation threads with summaries
4. **Pattern match** — recurring patterns with confidence scores
5. **Active tasks** — surfaced in context for continuity

Results are injected as `<unified-memory>` block in the agent's context.

## Agent Hooks

| Hook | Trigger | Action |
|------|---------|--------|
| `before_agent_start` | New message | RAG: injects skills + vectors + threads |
| `after_tool_call` | Tool completes | Logs call to memory with auto-tags |
| `agent_end` | Session ends | Closes trajectory, updates patterns |

## Database Schema

| Table | Purpose |
|-------|---------|
| `unified_entries` | All stored entries (8 types) with FTS5 |
| `skills` | Learned procedures with success rates |
| `skill_executions` | Execution history with timing |
| `tool_calls` | Tool invocation log |
| `patterns` | Detected recurring patterns |
| `conversations` | Conversation threads |
| `conversation_messages` | Messages within threads |
| `artifacts` | Tracked files and outputs |

## Project Structure

```
memory-unified/
├── index.ts                 # Main plugin (compiled, runs in production)
├── src/
│   ├── db/
│   │   └── lancedb.ts       # LanceDB vector store
│   ├── embedding/
│   │   ├── ollama.ts        # Qwen3 via Ollama
│   │   └── provider.ts      # Embedding interface
│   ├── hooks/
│   │   ├── rag-injection.ts # RAG context injection
│   │   └── on-turn-end.ts   # Tool logging + skill tracking
│   ├── tools/
│   │   ├── unified-search.ts
│   │   ├── unified-store.ts
│   │   └── unified-conversations.ts
│   ├── utils/
│   │   ├── helpers.ts       # Auto-tag, summarize, etc.
│   │   └── hnsw.ts          # Legacy HNSW (migration compatibility)
│   ├── config.ts
│   ├── daemon.ts
│   ├── migrate.ts
│   └── types.ts
├── docs/
│   ├── ARCHITECTURE.md
│   └── CHANGELOG.md
├── package.json
└── tsconfig.json
```

## Why This Exists

OpenClaw's built-in memory options are either too simple (markdown files) or too expensive (OpenAI embeddings). This plugin combines:

- **SQLite** for structured data (fast, reliable, queryable)
- **LanceDB** for vectors (scalable, disk-based, filterable)
- **Qwen3** for embeddings (free, local, 4096-dim)
- **FTS5** for keyword search (instant, no network)

All in one plugin, zero external costs.

## License

MIT

## Links

- [OpenClaw](https://github.com/openclaw/openclaw)
- [OpenClaw Docs](https://docs.openclaw.ai)
- [Plugin Architecture](docs/ARCHITECTURE.md)
