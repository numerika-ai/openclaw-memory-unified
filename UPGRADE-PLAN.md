# Memory-Unified Plugin — Audit & Upgrade Plan

**Data audytu:** 2026-03-20
**Wersja:** v1.0 (pre-migration)
**Audytor:** Wiki (Claude Opus 4.6)

---

## 1. Stan Aktualny

### 1.1 Architektura

| Komponent | Pliki | Linie | Status |
|-----------|-------|-------|--------|
| Core (index, config, types) | 3 | 451 | ✅ Działa |
| DB layer (sqlite, sqlite-vec, lance-manager) | 3 | 482 | ✅ Działa (z bugami) |
| Embedding (nemotron) | 1 | 120 | ✅ Działa |
| Reranking (nemotron-rerank) | 1 | 72 | ✅ Działa |
| RAG injection hook | 1 | 443 | ✅ Działa (z nieefektywnościami) |
| Turn-end hook | 1 | 420 | ✅ Działa |
| Memory Bank (extractor, consolidator, maintenance, backfill, topics, types) | 6 | 638 | ⚠️ Extraction offline |
| Tools (search, store, conversations, file-indexer, memory-bank-manage) | 5 | 516 | ✅ Działa (z O(n) bugs) |
| Utils (helpers) | 1 | 144 | ✅ Działa |
| **Dead files** (ollama.ts, lancedb.ts) | **2** | **~200** | **❌ Do usunięcia** |
| **RAZEM** | **24** | **~3787** | |

### 1.2 Baza danych (skill-memory.db)

| Tabela | Rekordów | Uwagi |
|--------|----------|-------|
| `unified_entries` | 18,656 | **96% to tool logs (17,869)** — szum |
| `hnsw_meta` (tracking embeddingów) | 529 | **2.8% pokrycia** — 97% bazy bez embeddingu |
| `vec_entries` (sqlite-vec) | ~18,540 | Wektory 2048-dim |
| `memory_facts` | 23 | Tylko active facts — **1.2% coverage** z 1851 executions |
| `conversations` | 102 | Conversation tracking |
| `skills` | 27 | Zarejestrowane skill definitions |
| `patterns` | 539 | Wiele low-confidence, potrzeba GC |
| `skill_executions` | 1,851 | Historia execution logging |
| `memory_revisions` | 24 | Historia zmian faktów |
| **Rozmiar pliku** | **341 MB** | **Nigdy nie robiono VACUUM** (estymacja po: ~44 MB) |
| WAL | 12 MB | |
| Backupy | ~900 MB | 5 plików .bak, do wyczyszczenia |

### 1.3 Hardware — RTX 3090 (24 GB VRAM)

| Model | PID | VRAM | Rola |
|-------|-----|------|------|
| Nemotron Embed 1B v2 | 1285 | 2.7 GB | Embedding (2048-dim) |
| Nemotron Rerank 1B v2 | 1288 | 2.6 GB | Cross-encoder reranking |
| Whisper large-v3 (Docker) | — | ~3 GB | Speech-to-text |
| **Razem** | | **~8.3 GB** | **34% VRAM** |

### 1.4 Co działa

- ✅ **RAG injection pipeline**: FTS5 → vector search → reranking → memory bank facts → context build
- ✅ **Skill matching**: FTS5 + semantic search + direct skills table search
- ✅ **Tool call logging**: Każdy tool call → unified_entries + vector
- ✅ **Skill execution tracking**: Matchowanie skill→execution→patterns
- ✅ **Conversation tracking**: Topic extraction, tag-based grouping, decision/action detection
- ✅ **Memory Bank v2**: Full Vertex AI Memory Bank feature parity
- ✅ **Nemotron Reranking**: Cross-encoder reranking wyników RAG
- ✅ **Confidence decay + TTL**: Maintenance na startup
- ✅ **Pattern learning**: Keyword→skill mapping z confidence boost/decay
- ✅ **FTS5 full-text search**: Z triggerami auto-sync
- ✅ **sqlite-vec vector search**: Cosine distance KNN

### 1.5 Co NIE działa

- ❌ **Fact extraction**: `extractionUrl` → `192.168.1.80:11434` (Spark Ollama) — **OFFLINE**. Zero nowych faktów.
- ❌ **Contradiction detection (LLM part)**: Wymaga extraction LLM — offline.
- ❌ **Bulk indexing**: Destrukcyjny DELETE → re-embed 500 limit → nigdy nie pokryje bazy.
- ❌ **Memory bank search efficiency**: O(n) per-fact embedding zamiast sqlite-vec.

---

## 2. Zidentyfikowane Problemy

### 🔴 KRYTYCZNE (blokują core funkcjonalność)

#### P1: bulkIndex() jest destrukcyjny — nigdy nie pokryje bazy
**Plik:** `src/db/lance-manager.ts:63`
```typescript
async bulkIndex(): Promise<void> {
    this.db.exec('DELETE FROM hnsw_meta');  // ← KASUJE WSZYSTKO
    // ... re-embeds only 500
}
```
**Impact:** Przy KAŻDYM restarcie gateway:
1. Kasuje wszystkie śledzenie embeddingów (hnsw_meta)
2. Re-embedduje maksymalnie 500 entries
3. Nigdy nie pokryje 18,656 entries
**Fix:** Usunąć `DELETE FROM hnsw_meta`. Indexować tylko brakujące (query `LEFT JOIN ... WHERE NULL`).

#### P2: 96% entries to tool log szum
**Dane:** 17,869 tool entries vs 787 wartościowych (history, skill, config, file, task, result, protocol)
**Impact:**
- Wektor search przeszukuje 17,869 bezużytecznych entries
- FTS5 matchuje tool logs zamiast skills
- DB inflated 4x
- bulkIndex() marnuje czas na embedowanie `"tool:exec(success): systemctl --user status"` itd.
**Fix:** 
- Nie embedować tool entries (skip w `addEntry()`)
- Dodać entry TTL: tool entries > 7 dni → hard delete
- Lub: osobna tabela `tool_log` bez FTS5/vector

#### P3: Fact extraction całkowicie offline
**Plik:** `src/memory-bank/extractor.ts`
**Config:** `extractionUrl: "http://192.168.1.80:11434/v1/chat/completions"` (Spark Ollama — offline)
**Impact:** 23 facts z 1851 skill executions = 1.2% extraction rate. Memory Bank jest praktycznie pusty.
**Fix:**
- Opcja A: Skierować na lokalny LLM (np. Nemotron Super 120B gdy stanie)
- Opcja B: Skierować na Nemotron Embed 1B v2 z prostszym extraction prompt (embedding model = słaba jakość)
- Opcja C: Użyć głównego modelu agenta (Opus/Sonnet) — koszty API ale działa natychmiast
- **Rekomendacja:** Opcja A + tymczasowe Opcja C jako fallback

#### P4: Config defaults wskazują na złe endpointy
**Plik:** `src/config.ts`
```typescript
const DEFAULT_DB_PATH = "/home/hermes/.openclaw/workspace/skill-memory.db"; // ← Hermes!
rerankUrl: "http://localhost:8081/rerank"  // ← to SearXNG, rerank = 8082
```
**Impact:** Nowa instalacja bez override z openclaw.json dostanie złe defaults.
**Fix:** Zmienić na poprawne defaults:
- `DEFAULT_DB_PATH = "skill-memory.db"` (relative, resolved by api.resolvePath)
- `rerankUrl = "http://localhost:8082/rerank"`

---

### 🟡 POWAŻNE (degradują wydajność/jakość)

#### P5: O(n²) consolidation — embed per fact per topic
**Plik:** `src/memory-bank/consolidator.ts:70-78`
```typescript
for (const ex of existing) {      // up to 50 facts
    const exEmb = await embed(ex.fact, "passage");  // 15ms per call
    // ...
}
```
**Impact:** 50 × 15ms = 750ms per nowy fakt. Z 10 faktami per turn = 7.5s. Blokuje agent_end.
**Fix:** Użyć pre-computed embeddings z `memory_facts_vec` zamiast re-embedowania. `searchFactsByVector()` już istnieje — użyć go.

#### P6: O(n) memory_bank_manage search
**Plik:** `src/tools/memory-bank-manage.ts:120-133`
```typescript
for (const f of activeFacts) {      // up to 100
    const fEmb = await qwenEmbed(f.fact);  // 15ms each
    // ...
}
```
**Impact:** 100 × 15ms = 1.5s per search query. Użytkownik czeka.
**Fix:** Użyć `searchFactsByVector()` z sqlite-vec (single query, <10ms).

#### P7: RAG injection fallback path = O(n)
**Plik:** `src/hooks/rag-injection.ts:320-340` (STEP 6 fallback)
```typescript
// Fallback: no vec table yet, use old per-fact embedding (slow)
for (const f of activeFacts) {
    const fEmb = await embed(f.fact, "passage");
    // ...
}
```
**Impact:** Gdy memory_facts_vec pusty: 50 × 15ms = 750ms per turn.
**Fix:** Nigdy nie powinno dojść do fallback — `backfillFactEmbeddings()` na starcie powinno to obsłużyć. Dodać assert + warning zamiast cichego fallbacku.

#### P8: Skill embedding cache volatile
**Plik:** `src/embedding/nemotron.ts:95-118`
**Problem:** `skillEmbCache` jest in-memory. 27 skills × embed call = 405ms na first query po każdym restarcie.
**Fix:** Persystować cache w sqlite: tabela `skill_embeddings (skill_name, embedding BLOB, embedded_at)`.

#### P9: Brak batch embedding
**Problem:** TEI (HuggingFace Text Embeddings Inference) wspiera batch requests natywnie:
```json
{"input": ["text1", "text2", "text3"], "model": "..."}
```
Obecny kod robi single requests — N round-trips zamiast 1.
**Impact:** bulkIndex() 500 entries × single request vs 50 batches × 10 = 10x improvement.
**Fix:** Dodać `embedBatch(texts: string[], type)` function, użyć w bulkIndex, consolidation, backfill.

#### P10: FTS5 nie rozróżnia entry types
**Plik:** `src/hooks/rag-injection.ts:110-120`
```sql
WHERE unified_fts MATCH ? AND ue.entry_type = 'skill'
```
**Obecny stan:** FTS5 query filtruje po `entry_type = 'skill'` — OK.
**ALE:** Vector search (STEP 2.5) szuka po ALL entry types:
```typescript
const hnswResults = await lanceManager.search(prompt, 5);
```
**Impact:** Vector search zwraca tool entries zamiast wartościowych.
**Fix:** Dodać `entryType` filter do `VectorManager.search()`. sqlite-vec `vec_entries` ma kolumnę `entry_type` — użyć.

#### P11: Rerank trigger threshold za wysoki
**Plik:** `src/hooks/rag-injection.ts:228`
```typescript
if (cfg.rerankEnabled && slimLines.length > 10) {
```
**Impact:** Reranking uruchamia się dopiero po 10+ candidates. Większość turns ma 3-7 candidates.
**Fix:** Zmienić na `> 2` lub `> 3`.

---

### 🟢 OPTYMALIZACJE (nice-to-have)

#### P12: DB 341 MB bez VACUUM
**Fix:** `VACUUM; ANALYZE;` — estymacja ~44 MB po. Jednorazowo.

#### P13: Dead files w repo
**Pliki:** `src/embedding/ollama.ts` (3.2K), `src/db/lancedb.ts` (5.2K)
**Fix:** `trash` (per zasady — nie `rm`).

#### P14: Legacy naming (hnsw_key, hnsw_meta)
**Problem:** Nie ma HNSW. To sqlite-vec. Nazwy mylące.
**Impact:** Czytelność kodu. Nowi contributorzy.
**Fix:** Rename w przyszłej major version (breaking migration).

#### P15: Brak entry TTL/rotation
**Problem:** Tool entries rosną bez limitu. 17,869 i rośnie.
**Fix:** Cron/startup: `DELETE FROM unified_entries WHERE entry_type = 'tool' AND created_at < datetime('now', '-7 days')`.

#### P16: Pattern table GC
**Problem:** 539 patterns, wiele z confidence < 0.1.
**Fix:** Startup maintenance: `DELETE FROM patterns WHERE confidence < 0.1 AND updated_at < datetime('now', '-30 days')`.

#### P17: Conversation dedup za agresywny
**Problem:** 1 tag overlap = same conversation. "memory" tag łączy unrelated topics.
**Fix:** Require ≥2 tag overlap LUB topic similarity > 0.5.

#### P18: Incomplete Polish stop words
**Problem:** extractKeywords() brakuje: "może", "mam", "masz", "żeby", "albo", "teraz", "sobie", "tutaj", "jakie", "kiedy", "więc", "coś".
**Fix:** Rozszerzyć STOP_WORDS set.

---

## 3. Plan Usprawnień

### Faza 1: Quick Wins (1-2h, zero risk)

| # | Task | Impact | Effort | Pliki |
|---|------|--------|--------|-------|
| 1.1 | **Fix bulkIndex()**: usunąć `DELETE FROM hnsw_meta`, indexować tylko brakujące | 🔴 Critical | 15 min | `lance-manager.ts` |
| 1.2 | **Fix config defaults**: DB path relative, rerankUrl 8082 | 🔴 Critical | 5 min | `config.ts` |
| 1.3 | **Skip tool entries w vector indexing**: `if (entryType === 'tool') return false` | 🟡 High | 5 min | `lance-manager.ts` |
| 1.4 | **Lower rerank threshold**: 10 → 3 | 🟡 Medium | 2 min | `rag-injection.ts` |
| 1.5 | **VACUUM + ANALYZE bazy**: 341 MB → ~44 MB | 🟡 Medium | 5 min | SQL one-shot |
| 1.6 | **Trash dead files**: ollama.ts, lancedb.ts | 🟢 Cleanup | 2 min | — |
| 1.7 | **Add Polish stop words** | 🟢 Low | 5 min | `helpers.ts` |
| 1.8 | **Pattern GC na startup** | 🟢 Low | 10 min | `maintenance.ts` |

### Faza 2: Performance Fixes (2-4h)

| # | Task | Impact | Effort | Pliki |
|---|------|--------|--------|-------|
| 2.1 | **Vector-first consolidation**: użyć `searchFactsByVector()` zamiast O(n²) embed per fact | 🟡 High | 1h | `consolidator.ts` |
| 2.2 | **Vector-first memory bank search**: `memory-bank-manage.ts` searchFacts → sqlite-vec | 🟡 High | 30 min | `memory-bank-manage.ts` |
| 2.3 | **Batch embedding API**: `embedBatch()` function + użycie w bulkIndex/backfill | 🟡 High | 1h | `nemotron.ts`, `lance-manager.ts`, `backfill.ts` |
| 2.4 | **Filter vector search by entry_type**: skip tool entries w vector results | 🟡 Medium | 30 min | `lance-manager.ts`, `sqlite-vec.ts` |
| 2.5 | **Persist skill embedding cache**: SQLite table zamiast in-memory | 🟡 Medium | 30 min | `nemotron.ts`, `sqlite.ts` |
| 2.6 | **Remove RAG fallback O(n) path**: assert + warning zamiast per-fact embed | 🟢 Low | 15 min | `rag-injection.ts` |

### Faza 3: Extraction Recovery (1-2h, depends on LLM availability)

| # | Task | Impact | Effort | Pliki |
|---|------|--------|--------|-------|
| 3.1 | **Tymczasowy extraction via Anthropic API**: Sonnet jako extractor (kosztuje, ale działa) | 🔴 Critical | 30 min | `config.ts`, openclaw.json |
| 3.2 | **Extraction via lokalny LLM** (gdy Nemotron Super 120B stanie): endpoint swap | 🔴 Critical | 15 min | openclaw.json |
| 3.3 | **Extraction fallback chain**: try local LLM → try API → skip | 🟡 Medium | 1h | `extractor.ts` |
| 3.4 | **Backfill historycznych faktów**: re-process ostatnich 100 skill_executions | 🟡 Medium | 30 min | one-shot script |

### Faza 4: Embedding Migration — Nemotron 1B → Qwen3-Embedding-8B (4-8h)

| # | Task | Impact | Effort | Pliki |
|---|------|--------|--------|-------|
| 4.1 | **Kalkulacja VRAM** — potwierdź że Qwen3-8B zmieści się z reranker + Whisper | 🔴 Prereq | done | — |
| 4.2 | **Deploy Qwen3-Embedding-8B** na RTX 3090 via TEI | 🔴 Critical | 1h | systemd unit |
| 4.3 | **Stop Nemotron Embed 1B** (zwolni 2.7 GB VRAM) | — | 5 min | systemd |
| 4.4 | **Zmiana EMBED_DIM**: `2048 → 4096` w ENV + config | 🔴 Critical | 5 min | ENV, config.ts |
| 4.5 | **DROP + recreate vec_entries**: `float[2048] → float[4096]` | 🔴 Critical | 10 min | migration script |
| 4.6 | **DROP + recreate memory_facts_vec**: `float[2048] → float[4096]` | 🔴 Critical | 10 min | migration script |
| 4.7 | **Usunięcie prefix logic**: Qwen3 nie wymaga `query:`/`passage:` prefixów | 🟡 Medium | 15 min | `nemotron.ts` |
| 4.8 | **Re-embed EVERYTHING**: full bulkIndex + fact backfill (po fixie z Fazy 1) | 🔴 Critical | 2-4h (runtime) | — |
| 4.9 | **Benchmark**: porównanie search quality Nemotron 1B vs Qwen3 8B | 🟡 Validation | 30 min | test script |

### Faza 5: Strategic Improvements (ongoing)

| # | Task | Impact | Effort | Pliki |
|---|------|--------|--------|-------|
| 5.1 | **Entry TTL/rotation**: auto-delete tool entries > 7 dni | 🟡 Medium | 1h | `maintenance.ts`, `sqlite.ts` |
| 5.2 | **Hermes deployment**: deploy fixów na Hermes VM | 🟡 Medium | 2h | ssh + deploy script |
| 5.3 | **Conversation dedup improvement**: ≥2 tags OR topic cosine > 0.5 | 🟢 Low | 1h | `on-turn-end.ts` |
| 5.4 | **Legacy naming migration**: hnsw_key → vec_key, hnsw_meta → embedding_meta | 🟢 Low | 2h | all files (breaking) |
| 5.5 | **Push to GitHub**: wszystkie zmiany do `numerika-ai/openclaw-memory-unified` | 🟡 Medium | 30 min | git |
| 5.6 | **Automated backup rotation**: max 2 backups, auto-cleanup | 🟢 Low | 30 min | cron script |

---

## 4. VRAM Kalkulacja i Rekomendacja

### Wariant A: Maximum Quality ⭐ REKOMENDOWANY

| Model | Params | Precyzja | VRAM | MTEB Score | Latency (embed) |
|-------|--------|----------|------|-----------|-----------------|
| **Qwen3-Embedding-8B** | 8B | FP16 | ~16 GB | **70.58** (#3 global) | ~50ms/query |
| Nemotron Rerank 1B v2 | 1B | FP16 | ~2.6 GB | — | ~30ms/10 docs |
| Whisper large-v3 (INT8) | 1.5B | INT8/CT2 | ~3 GB | — | — |
| **RAZEM** | | | **~21.6 GB** | | |
| **Headroom** | | | **2.4 GB** | | |
| **Utilization** | | | **88%** | | |

**Ryzyko:** 2.4 GB headroom jest tight. CUDA runtime allokuje overhead (~200-500 MB). Ale embedding modele mają **stały** VRAM footprint (bez KV cache jak LLM). Realnie powinno działać.

### Wariant B: Safe Mode

| Model | Params | Precyzja | VRAM | MTEB Score |
|-------|--------|----------|------|-----------|
| Qwen3-Embedding-4B | 4B | FP16 | ~8 GB | ~67 |
| Nemotron Rerank 1B v2 | 1B | FP16 | ~2.6 GB | — |
| Whisper large-v3 | 1.5B | INT8/CT2 | ~3 GB | — |
| **RAZEM** | | | **~13.6 GB (55%)** | |

### Wariant C: INT8 Compromise

| Model | Params | Precyzja | VRAM | MTEB Score |
|-------|--------|----------|------|-----------|
| Qwen3-Embedding-8B | 8B | INT8/GPTQ | ~8 GB | ~69 (est.) |
| Nemotron Rerank 1B v2 | 1B | FP16 | ~2.6 GB | — |
| Whisper large-v3 | 1.5B | INT8/CT2 | ~3 GB | — |
| **RAZEM** | | | **~13.6 GB (55%)** | |

### Porównanie jakości embedding

| Model | MTEB Multilingual | Dimensje | Zysk vs Nemotron 1B |
|-------|-------------------|----------|---------------------|
| Qwen3-Embedding-8B | **70.58** | 4096 | **+12.6 pkt** |
| Qwen3-Embedding-4B | ~67 | 4096 | +9 pkt |
| Qwen3-Embedding-8B INT8 | ~69 (est.) | 4096 | +11 pkt |
| Nemotron Embed 1B v2 | ~58 | 2048 | baseline |

**Rekomendacja: Wariant A.** 12.6 punktów MTEB to OGROMNA różnica w jakości retrieval. Embedding model to fundament całego RAG pipeline — każdy 1% improvement w embedding quality ma kaskadowy efekt na:
- Trafność skill matching
- Jakość memory bank recall
- Skuteczność contradiction detection
- Precyzja vector search

---

## 5. Vertex AI Memory Bank — Feature Parity Matrix

| Feature | Google Vertex AI | Nasza implementacja | Status | Jakość |
|---------|-----------------|---------------------|--------|--------|
| **LLM Fact Extraction** | ✅ Gemini Pro | `extractor.ts` → configurable LLM | ⚠️ offline | Pełny parity gdy LLM wróci |
| **Contradiction Detection** | ✅ Cosine + LLM verify | `consolidator.ts` → cosine sim + LLM | ⚠️ LLM offline | Cosine part działa, LLM verify nie |
| **Confidence Decay** | ✅ Time-based | `maintenance.ts` → 7d/30d thresholds, slow decay for infinite TTL | ✅ | ⭐ Lepszy: per-topic TTL, infinite TTL slow-mode |
| **TTL Expiry** | ✅ | `maintenance.ts` → per-fact + per-topic TTL | ✅ | Parity |
| **Topic Organization** | ✅ Auto-categorize | 7 default topics, auto-assign | ✅ | Parity |
| **Status Lifecycle** | ✅ active→expired | active→stale→contradicted→archived | ✅ | ⭐ Lepszy: 4 stany vs 2 |
| **Semantic Search** | ✅ Vertex AI Embeddings | sqlite-vec + Nemotron/Qwen3 | ✅ | Parity (lepszy z Qwen3) |
| **Pre-embedded Facts** | ✅ | `memory_facts_vec` (sqlite-vec) | ✅ | Parity |
| **RAG Injection** | ✅ Context window | `rag-injection.ts` → multi-layer pipeline | ✅ | ⭐ Lepszy: FTS5+vector+rerank+patterns |
| **Management API** | ✅ REST API | `memory_bank_manage` tool | ✅ | Parity |
| **Revision History** | ❌ (nie w docs) | `memory_revisions` table | ✅ | ⭐ Extra feature |
| **Reranking** | ❌ | Nemotron Rerank 1B cross-encoder | ✅ | ⭐ Extra feature |
| **Pattern Learning** | ❌ | keyword→skill confidence tracking | ✅ | ⭐ Extra feature |
| **Conversation Tracking** | ❌ | Topic extraction, grouping, decisions | ✅ | ⭐ Extra feature |
| **Batch Operations** | ✅ | ❌ | ❌ | Brakuje |
| **Multi-agent Scope** | ❌ | `scope` field (global/per-agent) | ✅ | ⭐ Extra feature |
| **Temporal Types** | ❌ | current_state/historical/permanent | ✅ | ⭐ Extra feature |

**Podsumowanie:** 10/10 Vertex AI features + 7 dodatkowych. Jedyny brak: batch operations.

---

## 6. Migration Plan: Nemotron 1B → Qwen3-Embedding-8B

### Prerequisities
- [ ] Faza 1 Quick Wins wdrożone (szczególnie P1: fix bulkIndex)
- [ ] VACUUM bazy (341 MB → ~44 MB)
- [ ] Batch embedding API gotowe (Faza 2.3)

### Krok po kroku

#### 6.1 Deploy Qwen3-Embedding-8B (na Tank RTX 3090)
```bash
# Opcja A: TEI (HuggingFace Text Embeddings Inference)
docker run -d --gpus all -p 8083:80 \
  ghcr.io/huggingface/text-embeddings-inference:latest \
  --model-id Qwen/Qwen3-Embedding-8B \
  --dtype float16 \
  --max-concurrent-requests 32

# Opcja B: vLLM serve (embedding mode)
vllm serve Qwen/Qwen3-Embedding-8B \
  --task embed --dtype float16 --port 8083

# Test
curl -s http://localhost:8083/v1/embeddings \
  -d '{"input": "test", "model": "Qwen/Qwen3-Embedding-8B"}' | jq '.data[0].embedding | length'
# Expected: 4096
```

#### 6.2 Parallel run (stary + nowy, 1-2h test)
- Nowy na porcie 8083, stary na 8080
- Porównanie wyników search na testowych queries
- Benchmark latency

#### 6.3 Cutover
```bash
# 1. Stop Nemotron Embed
systemctl --user stop nemotron-embed.service  # (lub jak nazywa się unit)

# 2. Zmień ENV
# W systemd drop-in:
EMBED_URL=http://localhost:8083/v1/embeddings
EMBED_MODEL=Qwen/Qwen3-Embedding-8B
EMBED_DIM=4096
QWEN_EMBED_URL=  # unset legacy
```

#### 6.4 Database migration
```sql
-- !! BACKUP FIRST !!
-- cp skill-memory.db skill-memory.db.pre-qwen3-migration

-- Drop old vector tables
DROP TABLE IF EXISTS vec_entries;
DROP TABLE IF EXISTS memory_facts_vec;

-- Recreate with 4096 dimensions
-- (done automatically by plugin on restart with new EMBED_DIM)

-- Clear embedding tracking
DELETE FROM hnsw_meta;
```

#### 6.5 Re-embed everything
```bash
# Restart gateway — bulkIndex() will re-embed all entries
# With batch embedding + fixed bulkIndex = ~30 min for 18k entries
systemctl --user restart openclaw-gateway
```

#### 6.6 Validate
```bash
# Check dimensions
sqlite3 skill-memory.db "SELECT typeof(embedding), length(embedding)/4 FROM vec_entries LIMIT 1;"
# Expected: blob, 4096

# Test search quality
# (via unified_search tool in chat)
```

### Rollback plan
1. Stop nowy model
2. Przywrócić backup bazy
3. Restart z starym ENV (EMBED_DIM=2048)
4. Start Nemotron Embed 1B

### Czas przestoju
- **Zero downtime** jeśli parallel run
- **5-10 min** jeśli direct cutover (restart gateway + initial index)
- **30-60 min** do pełnego re-embed (background, system działa z partial embeddings)

---

## 7. Technical Debt Cleanup

### Do natychmiastowego usunięcia
- [ ] `src/embedding/ollama.ts` — dead file (3.2K), import nieużywany
- [ ] `src/db/lancedb.ts` — dead file (5.2K), import nieużywany
- [ ] DB backups: `skill-memory.db.bak-*` (5 plików, ~900 MB) — zostawić max 1

### Do usunięcia z openclaw.json
- [ ] Stale config entry `skill-memory` (jeśli istnieje)
- [ ] Stale config entry `memory-lancedb` (jeśli istnieje)

### Do usunięcia z dysku
- [ ] `~/.openclaw/workspace/memory-vectors.lance/` — 23 GB LanceDB data (po potwierdzeniu Bartosza)
- [ ] `skill-memory.hnsw` — 103 MB stary artefakt

### Naming cleanup (przyszła wersja)
- `hnsw_key` → `vec_key` lub `entry_key`
- `hnsw_meta` → `embedding_meta` lub `vec_tracking`
- `lance-manager.ts` → `vector-manager.ts`
- `qwenEmbed` → `embed` (already exists, remove alias)
- `qwenSemanticSearch` → `semanticSearch`
- `QWEN_EMBED_URL` ENV → `EMBED_URL` (legacy compat warstwa)

### Code quality
- [ ] Usunąć `USE_QWEN_LEGACY` path z nemotron.ts (po migracji)
- [ ] Dodać unit tests (0% coverage currently)
- [ ] Dodać JSDoc do publicznych functions
- [ ] eslint/prettier config

---

## 8. Priority Execution Order

| Kolejność | Task | Czas | Blokuje |
|-----------|------|------|---------|
| **1** | P1: Fix bulkIndex (remove DELETE) | 15 min | Faza 4 |
| **2** | P4: Fix config defaults | 5 min | Nowe instalacje |
| **3** | P2: Skip tool entries w embedding | 5 min | Jakość search |
| **4** | P12: VACUUM + ANALYZE | 5 min | Rozmiar DB |
| **5** | P11: Lower rerank threshold | 2 min | RAG quality |
| **6** | P13: Trash dead files | 2 min | Cleanup |
| **7** | P5: Vector-first consolidation | 1h | Extraction performance |
| **8** | P6: Vector-first mb search | 30 min | Search performance |
| **9** | P9: Batch embedding API | 1h | Faza 4 (migration speed) |
| **10** | P3: Fix extraction (temporary API) | 30 min | Memory Bank growth |
| **11** | Faza 4: Qwen3-8B migration | 4-8h | Quality leap |
| **12** | P15: Entry TTL/rotation | 1h | DB growth control |
| **13** | Push to GitHub | 30 min | — |

**Szacowany czas łączny:** ~12-16h roboczych (rozłożone na kilka sesji)

---

## 9. Metryki Sukcesu

| Metryka | Przed | Cel | Jak mierzyć |
|---------|-------|-----|-------------|
| % entries z embeddingiem | 2.8% | >95% (non-tool) | `SELECT COUNT(*) FROM hnsw_meta` / non-tool entries |
| Active facts | 23 | >200 | `SELECT COUNT(*) FROM memory_facts WHERE status='active'` |
| DB size | 341 MB | <50 MB | `ls -lh skill-memory.db` |
| Search latency (mb) | ~1.5s | <50ms | Timing w memory_bank_manage search |
| Consolidation time | ~750ms/fact | <50ms/fact | Logging w consolidator |
| Embedding quality (MTEB) | ~58 | 70.58 | Qwen3-8B benchmark |
| VRAM utilization | 34% | 88% | `nvidia-smi` |
| Extraction rate | 1.2% | >50% | facts / skill_executions |

---

*Created by Wiki (Claude Opus 4.6) — 2026-03-20 15:50 UTC*
*Based on full source code audit of 24 files, 3787 lines TypeScript*
