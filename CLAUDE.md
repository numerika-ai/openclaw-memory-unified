# OpenClaw Memory Unified Plugin — Reorganization

## Zadanie
Reorganizacja repozytorium do profesjonalnej struktury. NIE zmieniaj logiki kodu — tylko przenieś pliki do nowej struktury i zaktualizuj importy.

## Architektura
- Język: TypeScript
- Runtime: Node.js (OpenClaw plugin)
- Baza: SQLite (better-sqlite3) + HNSW vectors
- Repo: https://github.com/numerika-ai/openclaw-memory-unified

## Obecna struktura (flat)
```
index.ts          — główny plik (1671 linii, register tools + hooks)
config.ts         — konfiguracja (60 linii)
db.ts             — (nieużywany w prod, stary USMD)
daemon.ts         — daemon service (83 linii)
migrate.ts        — migracje schema (107 linii)
```

## Docelowa struktura
```
src/
  index.ts           — main register(), hooks, startup
  config.ts          — config schema + validation
  migrate.ts         — schema migrations
  daemon.ts          — daemon service
  tools/
    unified-search.ts
    unified-store.ts
    unified-conversations.ts
  hooks/
    on-turn-end.ts
    rag-injection.ts
  embedding/
    provider.ts       — abstract interface
    ollama.ts         — Ollama/Qwen embeddings
  utils/
    hnsw.ts           — HNSW vector operations
    auto-tag.ts       — classification
docs/
  ARCHITECTURE.md     — skopiuj z workspace (podany niżej)
  SETUP.md            — installation guide
  API.md              — tool reference
tests/
  (placeholder test files)
```

## Ważne
- NIE zmieniaj logiki kodu — TYLKO reorganizuj
- Zachowaj WSZYSTKIE exporty z index.ts
- Po przeniesieniu: upewnij się że `npm run build` działa
- Zaktualizuj package.json jeśli trzeba
- Zaktualizuj README.md z nową strukturą
- Skopiuj /home/tank/.openclaw/workspace/UNIFIED-MEMORY-ARCHITECTURE.md do docs/ARCHITECTURE.md

## Konwencje
- Importy: relative paths
- Każdy tool w osobnym pliku
- Każdy hook w osobnym pliku

## Testy
- Placeholder test files (describe + it blocks, TODO implementation)
- Uruchomienie: `npx tsc --noEmit` (type check)
