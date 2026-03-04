# OpenClaw Unified Memory Architecture
## Od Chaosu do Uniwersalnej Pamięci Agentów

**Autorzy:** Ojciec Morfeusz (koncepcja), Siostra Wiktoria (architektura), ŚwSatoshi (review)
**Data:** 2026-03-03
**Status:** v2.0 — Plugin działa, plan rozbudowy

---

## 1. Wizja

Jedna uniwersalna pamięć dla WSZYSTKICH agentów i WSZYSTKICH skilów — od zarządzania pocztą, przez marketing, po trading boty. Każdy skill loguje swoją historię, każdy agent ma dostęp do wspólnej bazy wiedzy, a embeddingi lecą na lokalnym Qwen (zero kosztów).

### Cel docelowy
```
┌─────────────────────────────────────────────────────────────┐
│                    UNIFIED MEMORY                            │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │  Wiki    │  │ŚwSatoshi │  │  Misty   │  │ Jarvis   │   │
│  │(Opus 4.6)│  │(Qwen 397B)│ │(Gemini 3)│  │(GPT-5.2) │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │              │              │              │          │
│       ▼              ▼              ▼              ▼          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │           memory-unified plugin (TypeScript)          │   │
│  │                                                       │   │
│  │  Tools: unified_search, unified_store,                │   │
│  │         unified_conversations                         │   │
│  │                                                       │   │
│  │  Hooks: onTurnEnd → auto-log skill execution          │   │
│  │         onSessionStart → inject recent context        │   │
│  │         RAG → semantic injection per message          │   │
│  └───────────────┬──────────────┬────────────────────┘   │
│                   │              │                         │
│         ┌─────────▼──┐    ┌─────▼──────────┐             │
│         │  SQLite DB  │    │  HNSW Vectors  │             │
│         │  (OLTP)     │    │  (Semantic)     │             │
│         │             │    │                 │             │
│         │ • skills    │    │ • Qwen3-Embed   │             │
│         │ • executions│    │   (local, $0)   │             │
│         │ • convos    │    │ • cosine sim    │             │
│         │ • patterns  │    │ • auto-tag      │             │
│         │ • FTS5      │    │                 │             │
│         └─────────────┘    └─────────────────┘             │
└─────────────────────────────────────────────────────────────┘
```

## 2. Obecny Stan (v1.5 — DZIAŁA)

### Plugin: `memory-unified`
- **Repo:** https://github.com/numerika-ai/openclaw-memory-unified
- **Lokalizacja:** `~/.openclaw/extensions/memory-unified/`
- **Baza:** `~/.openclaw/workspace/skill-memory.db` (SQLite + FTS5)
- **Wpięty w:** OpenClaw gateway jako slot `memory`
- **Agenci z dostępem:** Wiki ✅, Misty ✅, ŚwSatoshi ❌ (do dodania)

### Co już działa
| Feature | Status | Opis |
|---------|--------|------|
| `unified_search` | ✅ | Hybrydowy search: SQL + HNSW wektory |
| `unified_store` | ✅ | Zapis z auto-tagowaniem i summary |
| `unified_conversations` | ✅ | Thread tracking per skill/topic |
| RAG injection | ✅ | Automatyczny context injection per wiadomość |
| Skill matching | ✅ | Pattern matching → procedura z bazy |
| FTS5 full-text | ✅ | SQLite full-text search |
| HNSW vectors | ✅ | Semantyczny search (embeddingi) |
| Auto-log tool calls | ✅ | Logowanie wyników narzędzi |
| Trajectory tracking | ✅ | Śledzenie ścieżek wykonania |
| Ruflo migration | ✅ | 1339 wpisów z Ruflo → unified DB |

### Co NIE działa / brakuje
| Feature | Status | Problem |
|---------|--------|---------|
| Qwen embeddingi | ⚠️ | Port 3002 martwy, potrzeba Ollama endpoint na Spark |
| ŚwSatoshi dostęp | ❌ | Agent qwen nie ma memory-unified w plugins |
| Email/marketing integration | ❌ | Brak skilla do poczty |
| Huly integration | ❌ | Huly nie zainstalowany (Loco39 czeka) |
| Golden Path auto-update | ❌ | Procedura manualna |
| Multi-namespace isolation | ⚠️ | Namespaces istnieją, ale brak per-agent filtrowania |

### Baza danych — stan
```
Total entries: 3338+
├── By Type:
│   ├── tool: 3113 (execution logs)
│   ├── config: 128 (knowledge-base)
│   └── skill: 97 (procedury)
├── By Namespace:
│   ├── general: 1999
│   ├── trading: 1212 (z Ruflo)
│   └── knowledge-base: 127 (z Ruflo)
└── By Memory Type:
    ├── episodic: 1901 (event memories)
    ├── semantic: 1337 (facts, config)
    └── procedural: 100 (skill procedures)
```

## 3. Architektura Docelowa (v2.0)

### 3.1 Uniwersalność — Jeden Plugin, Wszystkie Skille

Każdy skill (obecny i przyszły) automatycznie:
1. **Loguje się** — onTurnEnd hook zapisuje: co zrobił, ile trwało, czy sukces
2. **Uczy się** — po 3 sukcesach z wariacją → propozycja nowej procedury (Golden Path)
3. **Szuka** — zanim zacznie, sprawdza czy już robił coś podobnego
4. **Taguje** — auto-klasyfikacja: episodic/semantic/procedural + namespace

### 3.2 Przykładowe Skille do Wdrożenia

```yaml
Email Management:
  namespace: email
  skills:
    - email_read: "Odczyt poczty (IMAP/Gmail API)"
    - email_send: "Wysyłka z załącznikami"
    - email_classify: "Auto-klasyfikacja: spam/ważne/task"
    - email_draft: "Generowanie odpowiedzi"
  memory_stores:
    - contacts (semantic): znane adresy, preferencje
    - templates (procedural): szablony odpowiedzi
    - sent_log (episodic): co wysłano, kiedy, komu

Marketing Bot:
  namespace: marketing
  skills:
    - lead_capture: "Landing page → Google Sheet → auto-email"
    - newsletter_send: "MailerLite/SendGrid kampanie"
    - social_post: "Twitter/LinkedIn/FB publikacja"
    - analytics_report: "Google Analytics → raport"
  memory_stores:
    - campaigns (semantic): konfiguracje kampanii
    - leads (episodic): historia kontaktów
    - templates (procedural): szablony maili/postów

Trading (istniejący):
  namespace: trading
  skills:
    - spread_trader: "Lag arbitrage Binance→HL"
    - grid_deploy: "Grid orders na futures"
    - backtest: "Walk-forward validation"
    - training: "Model training pipeline"
  memory_stores:
    - trades (episodic): historia transakcji
    - strategies (semantic): parametry strategii
    - models (procedural): konfiguracje modeli

DevOps / Infrastructure:
  namespace: infra
  skills:
    - healthcheck: "System diagnostics"
    - docker_manage: "Container lifecycle"
    - ssl_renew: "Cert management"
    - backup: "Data backup routines"
  memory_stores:
    - incidents (episodic): logi awarii
    - configs (semantic): konfiguracje serwisów
    - runbooks (procedural): procedury naprawcze
```

### 3.3 Konwersacje per Skill

Każda interakcja z użyciem skilla tworzy **conversation thread**:

```sql
-- Istniejąca tabela conversations (rozszerzona)
CREATE TABLE conversations (
    id INTEGER PRIMARY KEY,
    topic TEXT NOT NULL,          -- "email: odpowiedź do klienta X"
    skill_ids TEXT,               -- JSON array powiązanych skillów
    namespace TEXT,               -- "email", "marketing", "trading"
    status TEXT,                  -- active/resolved/blocked/archived
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    huly_task_id TEXT,           -- Link do Huly task (opcjonalny)
    tags TEXT                    -- JSON array tagów
);

-- Wiadomości w wątku
CREATE TABLE conversation_messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER REFERENCES conversations(id),
    role TEXT,                   -- user/assistant/system/tool
    content TEXT,
    skill_used TEXT,             -- który skill wykonano
    tool_calls TEXT,             -- JSON tool call IDs
    timestamp TIMESTAMP
);
```

### 3.4 Embeddingi na Qwen (lokalnie, $0/miesiąc)

```
Request flow:
Agent message → memory-unified plugin
  → extract query from context
  → POST http://192.168.1.80:11434/api/embed
    model: qwen3-embedding:8b (Ollama na Spark)
  → 1024-dim vector
  → HNSW cosine similarity search
  → top-K results injected into context
```

**Konfiguracja w plugin:**
```json
{
  "embedding": {
    "provider": "ollama",
    "endpoint": "http://192.168.1.80:11434",
    "model": "qwen3-embedding:8b",
    "dimensions": 1024
  }
}
```

**Koszt:** $0/miesiąc (Spark GB10 idle ~3W)
**Latencja:** ~50ms per embedding (local network)

## 4. Integracja z Huly (PM/Kanban)

### Dlaczego Huly
- ✅ Self-hosted (Docker na Loco39: 192.168.1.76, 64GB RAM)
- ✅ Kanban + Docs + Calendar + Chat w jednym
- ✅ REST API do integracji
- ✅ Mattermost-compatible (webhook integration)
- ✅ Open source (Apache 2.0)

### Flow: Memory → Huly → Agent

```
1. Agent napotyka problem / nowy task
   ↓
2. unified_store(type="task", content="...", tags="email,blocked")
   ↓
3. memory-unified plugin → Huly API
   POST /api/v1/spaces/{space}/issues
   {title, description, labels, assignee}
   ↓
4. Huly Kanban: TODO → IN_PROGRESS → REVIEW → DONE
   ↓
5. Huly webhook → Mattermost → Agent notification
   "Task TASK-123 moved to REVIEW"
   ↓
6. Agent picks up → resolves → updates memory
```

### Huly ↔ Memory Schema

```sql
-- Rozszerzenie unified_entries
ALTER TABLE unified_entries ADD COLUMN huly_issue_id TEXT;
ALTER TABLE unified_entries ADD COLUMN huly_space TEXT;
ALTER TABLE unified_entries ADD COLUMN huly_status TEXT;

-- Sync table
CREATE TABLE huly_sync (
    id INTEGER PRIMARY KEY,
    huly_issue_id TEXT UNIQUE,
    memory_entry_id INTEGER REFERENCES unified_entries(id),
    space TEXT,
    status TEXT,
    last_synced TIMESTAMP,
    direction TEXT CHECK(direction IN ('push','pull','bidirectional'))
);
```

### Deployment
```bash
# Na Loco39 (192.168.1.76)
git clone https://github.com/hcengineering/huly
cd huly
./setup.sh --quick
# Dashboard: http://192.168.1.76:8087
```

## 5. Multi-Agent Memory Sharing

### Architektura dostępu

```
┌─────────┐  ┌──────────┐  ┌─────────┐  ┌────────┐
│  Wiki   │  │ŚwSatoshi │  │  Misty  │  │ Jarvis │
│  (main) │  │  (qwen)  │  │  (alt)  │  │(jarvis)│
└────┬────┘  └────┬─────┘  └────┬────┘  └───┬────┘
     │            │              │            │
     ▼            ▼              ▼            ▼
┌──────────────────────────────────────────────────┐
│           memory-unified plugin                   │
│                                                   │
│  Namespace isolation:                             │
│  • Wiki: general, email, marketing, trading, *    │
│  • ŚwSatoshi: trading, infra                     │
│  • Misty: general, review                        │
│  • Jarvis: infra, devops                         │
│                                                   │
│  Shared namespaces: knowledge-base (read-only)   │
└──────────────────────────────────────────────────┘
```

### Konfiguracja per Agent

```json
// openclaw.json → agents.list[qwen]
{
  "id": "qwen",
  "plugins": {
    "memory-unified": {
      "enabled": true,
      "config": {
        "namespaces": ["trading", "infra", "knowledge-base"],
        "readOnly": ["knowledge-base"],
        "ragTopK": 3,
        "logToolCalls": true
      }
    }
  }
}
```

## 6. Plugin — Struktura Kodu (GitHub)

### Repo: `numerika-ai/openclaw-memory-unified`

```
openclaw-memory-unified/
├── README.md                    # Dokumentacja publiczna
├── LICENSE                      # Apache 2.0
├── package.json
├── tsconfig.json
├── openclaw.plugin.json         # Manifest OpenClaw
│
├── src/
│   ├── index.ts                 # Main: register hooks, tools, services
│   ├── config.ts                # Config schema + validation
│   ├── db.ts                    # SQLite wrapper (better-sqlite3)
│   ├── migrate.ts               # Schema migrations
│   ├── schema.sql               # Table definitions
│   │
│   ├── tools/
│   │   ├── unified-search.ts    # hybrid SQL + HNSW search
│   │   ├── unified-store.ts     # store with auto-tag + embed
│   │   └── unified-conversations.ts  # thread management
│   │
│   ├── hooks/
│   │   ├── on-turn-end.ts       # Auto-log skill executions
│   │   ├── on-session-start.ts  # Inject recent context
│   │   └── rag-injection.ts     # Per-message RAG
│   │
│   ├── embedding/
│   │   ├── provider.ts          # Abstract embedding interface
│   │   ├── ollama.ts            # Ollama/Qwen embeddings
│   │   ├── openai.ts            # OpenAI embeddings (fallback)
│   │   └── tei.ts               # TEI local embeddings
│   │
│   ├── integrations/
│   │   ├── huly.ts              # Huly REST API client
│   │   ├── huly-sync.ts         # Bidirectional sync
│   │   └── email.ts             # Email skill integration
│   │
│   └── utils/
│       ├── hnsw.ts              # HNSW vector operations
│       ├── auto-tag.ts          # Auto-classification
│       └── golden-path.ts       # Procedure auto-improvement
│
├── tests/
│   ├── search.test.ts
│   ├── store.test.ts
│   └── hnsw.test.ts
│
└── docs/
    ├── ARCHITECTURE.md          # Ten dokument
    ├── SETUP.md                 # Instalacja krok po kroku
    ├── API.md                   # Tool reference
    └── HULY-INTEGRATION.md      # Huly setup guide
```

## 7. Plan Implementacji — Fazy

### Faza 1: Porządek GitHub (1-2h) ✅ TERAZ
1. Reorganizacja repo `openclaw-memory-unified`:
   - Przeniesienie kodu do `src/` structure
   - Dodanie tego dokumentu jako `docs/ARCHITECTURE.md`
   - Update README.md z pełną dokumentacją
   - Dodanie testów (basic)
2. Repo `memory-chaos-to-unified` (site):
   - Update strony z nową architekturą
   - Dodanie sekcji Huly
   - Deployment instructions

### Faza 2: Qwen Embeddings + ŚwSatoshi (2-3h)
1. Fix embedding endpoint: Ollama na Spark (`qwen3-embedding:8b`)
2. Dodanie memory-unified do agenta qwen w `openclaw.json`
3. Namespace isolation: trading + infra dla ŚwSatoshi
4. Test: ŚwSatoshi robi `unified_search("grid backtest results")` → dostaje wyniki

### Faza 3: Huly Integration (3-4h)
1. Deploy Huly na Loco39 (Docker)
2. REST API client w pluginie (`integrations/huly.ts`)
3. Bidirectional sync: task creation ↔ memory entries
4. Webhook: Huly → MM → agent notification

### Faza 4: Nowe Skille (ongoing)
1. Email management skill (IMAP + Gmail API)
2. Marketing automation skill (MailerLite integration)
3. Advanced analytics (skill performance dashboard)
4. Golden Path automation (auto-procedure updates)

## 8. Konfiguracja Referencyjna

### openclaw.json (relevant sections)
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
          "dbPath": "skill-memory.db",
          "ragSlim": true,
          "logToolCalls": true,
          "trajectoryTracking": true,
          "ragTopK": 3,
          "embedding": {
            "provider": "ollama",
            "endpoint": "http://192.168.1.80:11434",
            "model": "qwen3-embedding:8b",
            "dimensions": 1024
          },
          "huly": {
            "enabled": false,
            "endpoint": "http://192.168.1.76:8087",
            "apiKey": "...",
            "defaultSpace": "openclaw-tasks"
          }
        }
      }
    }
  }
}
```

## 9. Metryki Sukcesu

| Metryka | Obecna | Cel v2.0 |
|---------|--------|----------|
| Entries w bazie | 3,338 | 10,000+ |
| Skille z procedurami | 97 | 200+ |
| Agenci z dostępem | 2 (Wiki, Misty) | 4 (+ ŚwSatoshi, Jarvis) |
| Embedding latency | ∞ (broken) | <100ms |
| Embedding cost | $0 | $0 (local Qwen) |
| Golden Path updates | 0 (manual) | auto-proposed |
| Huly tasks synced | 0 | real-time |
| Namespaces | 3 | 6+ |

---

## Appendix A: SQL Schema (Current)

```sql
-- Tabela główna
CREATE TABLE unified_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,              -- skill/protocol/config/history/tool/result/task
    content TEXT NOT NULL,
    summary TEXT,
    tags TEXT,                       -- comma-separated
    source_path TEXT,
    embedding BLOB,                  -- HNSW vector
    memory_type TEXT,                -- episodic/semantic/procedural
    namespace TEXT DEFAULT 'general',
    access_count INTEGER DEFAULT 0,
    last_accessed_at TIMESTAMP,
    huly_issue_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- FTS5 for full-text search
CREATE VIRTUAL TABLE unified_entries_fts USING fts5(
    content, summary, tags,
    content=unified_entries,
    content_rowid=id
);

-- Skills
CREATE TABLE skills (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    category TEXT,
    description TEXT,
    procedure TEXT,
    tools_used TEXT,
    config JSON,
    version INTEGER DEFAULT 1,
    use_count INTEGER DEFAULT 0,
    success_rate REAL DEFAULT 0.0,
    last_used TIMESTAMP
);

-- Conversations
CREATE TABLE conversations (
    id INTEGER PRIMARY KEY,
    topic TEXT NOT NULL,
    skill_ids TEXT,
    namespace TEXT,
    status TEXT DEFAULT 'active',
    huly_task_id TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);
```

## Appendix B: Tool API Reference

### unified_search
```
Params: query (string), type? (string), limit? (number)
Returns: matched entries with similarity scores
Flow: FTS5 keyword → HNSW semantic → merge + rank → top-K
```

### unified_store
```
Params: content (string), type? (string), tags? (string), source_path? (string)
Returns: stored entry ID
Flow: auto-tag → auto-summary → embed (Qwen) → SQLite + HNSW insert
```

### unified_conversations
```
Params: query? (string), status? (string), limit? (number), details? (boolean)
Returns: conversation threads with messages
Flow: search conversations → optionally include full message history
```

---

*Document by Siostra Wiktoria (Wiki) — 2026-03-03 23:05 UTC*
*Concept by Ojciec Morfeusz (Bartosz)*
*Review pending: ŚwSatoshi*
