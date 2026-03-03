# memory-unified — OpenClaw Plugin

Unified memory layer for [OpenClaw](https://github.com/openclaw/openclaw) that merges **USMD SQLite** skill database with **Ruflo HNSW** vector search. Gives your AI agent structured + semantic long-term memory.

## Features

- **Dual storage:** SQLite for structured data (skills, tool calls, artifacts) + HNSW for semantic search
- **RAG on agent start:** injects relevant micro-summaries from vector memory into context
- **Tool call logging:** every tool invocation stored with auto-tags for trajectory analysis
- **Skill learning:** tracks skill executions, success rates, and proposes procedure improvements
- **Unified search:** single `unified_search` tool queries both backends simultaneously

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    memory-unified plugin                     │
├─────────────────────┬───────────────────────────────────────┤
│   USMD SQLite       │          Ruflo HNSW                   │
│   (structured)      │          (semantic)                   │
│                     │                                       │
│ • skills table      │ • ruflo_memory_store (ns: unified)    │
│ • skill_executions  │ • ruflo_memory_search (vector sim)    │
│ • unified_entries   │ • trajectory tracking (SONA)          │
│ • tool_calls        │                                       │
│ • artifacts         │                                       │
└─────────────────────┴───────────────────────────────────────┘
```

## Installation

### Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- Node.js 22+

### Install from GitHub

```bash
# Clone the repo
git clone https://github.com/numerika-ai/openclaw-memory-unified.git
cd openclaw-memory-unified

# Install dependencies
npm install

# Build
npm run build

# Register in OpenClaw
openclaw plugin install ./
```

### Manual install

```bash
# Copy to extensions directory
cp -r . ~/.openclaw/extensions/memory-unified/
cd ~/.openclaw/extensions/memory-unified/
npm install && npm run build
```

### Configure in `openclaw.json`

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

Restart OpenClaw after configuration:
```bash
openclaw gateway restart
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dbPath` | string | `skill-memory.db` | Path to SQLite database (created automatically) |
| `ragSlim` | boolean | `true` | Inject micro-summaries into agent context on start |
| `logToolCalls` | boolean | `true` | Store every tool call in HNSW with auto-tags |
| `trajectoryTracking` | boolean | `true` | Track agent trajectories for self-learning |
| `ragTopK` | number | `5` | Number of HNSW results to inject on agent start |

## Tools

The plugin exposes these tools to your AI agent:

| Tool | Description |
|------|-------------|
| `unified_search` | Search across USMD + HNSW (structured + semantic). Supports filtering by entry type |
| `unified_store` | Store entry to both backends with auto-tagging and summarization |
| `unified_conversations` | List and search conversation threads |

## Schema

The SQLite database includes:

- **skills** — learned procedures with success rates
- **skill_executions** — execution history with timing and token usage
- **unified_entries** — bridge table linking USMD ↔ HNSW entries
- **tool_calls** — tool invocation log
- **artifacts** — tracked files and outputs
- **procedure_proposals** — proposed skill improvements

See [schema.sql](schema.sql) for full DDL.

## Hooks

| Hook | Action |
|------|--------|
| `before_agent_start` | RAG slim: injects micro-summaries (20-30 tokens + keys) |
| `after_tool_call` | Logs tool call to USMD + HNSW with auto-tags |
| `agent_end` | Ends SONA trajectory with success/failure label |

## Migration

Migrate existing USMD skills to Ruflo HNSW:

```bash
npx ts-node migrate.ts                     # default DB path
npx ts-node migrate.ts --db /path/to/db    # custom path
```

## Development

```bash
# Watch mode
npm run dev

# Build
npm run build
```

## License

MIT

## Links

- [OpenClaw](https://github.com/openclaw/openclaw) — AI agent framework
- [OpenClaw Docs](https://docs.openclaw.ai)
- [ClaWHub Skills](https://clawhub.com) — community skills marketplace
