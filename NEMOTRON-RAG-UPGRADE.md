# Nemotron RAG Upgrade Plan — memory-unified

> Upgrade from Qwen3-embedding:8b to NVIDIA Nemotron RAG stack for better accuracy, speed, and Polish language support.

## Overview

| Component | Current | Target | Benefit |
|-----------|---------|--------|---------|
| **Embedding** | Qwen3-embedding:8b (6GB, 4096-dim) | Nemotron Embed 1B v2 (2GB, 2048-dim) | 3x less VRAM, 4x faster, native Polish |
| **Reranking** | ❌ none | Nemotron Rerank 1B v2 (2GB) | +10-20% RAG accuracy |
| **Memory Bank search** | Embed-per-fact at runtime (10s) | Pre-embedded + vector search (<100ms) | 100x faster |
| **Extraction LLM** | Offline (Spark down) | Nemotron 3 Super 120B (local) | Zero API cost |

## Phase 1 — Fix Memory Bank Performance (no new models)

### 1.1 Pre-embed Memory Bank facts on write

**File:** `src/memory-bank/consolidator.ts`

Currently, STEP 6 in `rag-injection.ts` embeds EVERY fact at query time:
```typescript
// CURRENT (slow) — O(n) embeddings per query
for (const f of activeFacts) {
  const fEmb = await qwenEmbed(f.fact);  // ~200ms each!
  const sim = cosineSim(queryEmb, fEmb);
}
```

**Fix:** Store embedding at write time, search via sqlite-vec:
```typescript
// NEW — O(1) vector search
const results = sqliteVecSearch(queryEmbedding, 'memory_facts_vec', topK);
```

**Steps:**
- [ ] Add `embedding BLOB` column to `memory_facts` table
- [ ] On fact insert/update → generate embedding → store in `memory_facts_vec` virtual table
- [ ] Replace STEP 6 in `rag-injection.ts` with sqlite-vec query
- [ ] Backfill existing facts with embeddings

### 1.2 Index Memory Bank facts in sqlite-vec

**File:** `src/db/sqlite.ts`

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_vec USING vec0(
  fact_id INTEGER PRIMARY KEY,
  embedding float[2048]  -- will be 2048 after Nemotron migration
);
```

## Phase 2 — Nemotron Embed + Rerank

### 2.1 Replace Qwen3-embedding with Nemotron Embed 1B v2

**Model:** `nvidia/llama-nemotron-embed-1b-v2`
- 1B params, ~2GB VRAM
- 2048-dim embeddings (Matryoshka: configurable 384/512/768/1024/2048)
- 26 languages including Polish
- Max context: 8192 tokens
- License: NVIDIA Open Model License (commercial OK)

**Serving:** HuggingFace TEI (Text Embeddings Inference) — already running on Tank as `openclaw-tei`

**Steps:**
- [ ] Pull Nemotron Embed 1B v2 model to Tank
- [ ] Update TEI container to serve `nvidia/llama-nemotron-embed-1b-v2`
- [ ] Update `src/embedding/ollama.ts` → rename to `src/embedding/nemotron.ts`
- [ ] Change embedding dimension from 4096 → 2048 in config
- [ ] Add query/passage prefixes (`"query: "` / `"passage: "`) per model requirements
- [ ] Rebuild sqlite-vec table with new dimension
- [ ] Re-embed all entries (14K+ vectors)

**Config change (`ollama.ts` → `nemotron.ts`):**
```typescript
// OLD
export const QWEN_EMBED_URL = process.env.QWEN_EMBED_URL ?? "http://localhost:11434/v1/embeddings";
export const QWEN_MODEL = "qwen3-embedding:8b";

// NEW
export const EMBED_URL = process.env.EMBED_URL ?? "http://localhost:8080/v1/embeddings";
export const EMBED_MODEL = "nvidia/llama-nemotron-embed-1b-v2";
export const EMBED_DIM = 2048;
export const QUERY_PREFIX = "query: ";
export const PASSAGE_PREFIX = "passage: ";
```

### 2.2 Add Nemotron Rerank 1B v2 (NEW pipeline step)

**Model:** `nvidia/llama-nemotron-rerank-1b-v2`
- 1B params, ~2GB VRAM
- Cross-encoder architecture (sees query + document TOGETHER)
- 26 languages including Polish
- Max context: 8192 tokens
- License: NVIDIA Open Model License (commercial OK)

**Serving:** TEI also supports reranking, or standalone FastAPI wrapper

**New file:** `src/reranking/nemotron-rerank.ts`
```typescript
export async function rerankResults(
  query: string,
  candidates: Array<{ id: number; text: string; score: number }>,
  topK: number = 5,
): Promise<Array<{ id: number; text: string; score: number }>> {
  const resp = await fetch(RERANK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      texts: candidates.map(c => c.text),
      truncate: true,
    }),
  });
  // Sort by rerank score, return top-K
}
```

**Integration in `rag-injection.ts`:**
```
STEP 2.5: Vector search → top-50 candidates
STEP 2.6: RERANK → top-5 (NEW)
STEP 3: Qwen semantic (removed — replaced by rerank)
```

**Steps:**
- [ ] Create `src/reranking/nemotron-rerank.ts`
- [ ] Serve Rerank model via TEI or FastAPI
- [ ] Add STEP 2.6 in `rag-injection.ts` after vector search
- [ ] Remove or demote STEP 3 (Qwen semantic search — redundant with rerank)
- [ ] Add `RERANK_URL` to config/env

### 2.3 Vector database migration

- [ ] Backup sqlite DB before migration
- [ ] Drop old `vec_unified_entries` (4096-dim)
- [ ] Create new `vec_unified_entries` (2048-dim)
- [ ] Bulk re-embed all 14K+ entries with Nemotron Embed
- [ ] Drop old LanceDB vectors, rebuild
- [ ] Update `memory_facts_vec` dimension to 2048
- [ ] Verify search quality with test queries

## Phase 3 — Nemotron 3 Super as Local LLM

### 3.1 Memory Bank extraction via Nemotron Super

**Current:** `extractionUrl` points to offline Spark or unconfigured Gemini Flash
**Target:** Nemotron 3 Super 120B on Spark via vLLM/Ollama (OpenAI-compatible API)

**Steps:**
- [ ] Deploy Nemotron 3 Super on Spark via Ollama/vLLM
- [ ] Set `extractionUrl` to Spark endpoint
- [ ] Set `extractionModel` to `NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4`
- [ ] Use `thinking=off` for extraction (fast), `thinking=on` for contradiction detection

### 3.2 Main OpenClaw model

- [ ] Configure LiteLLM on Spark to serve Nemotron Super
- [ ] Point OpenClaw `default_model` to LiteLLM endpoint
- [ ] Test tool calling, structured output, instruction following

## Final Architecture

```
                    Spark (128GB)
┌──────────────────────────────────────────┐
│  Nemotron Embed 1B v2 (2GB)   ← TEI     │
│  Nemotron Rerank 1B v2 (2GB)  ← TEI     │
│  Nemotron Super 120B NVFP4 (67GB)        │
│  ─────────────────────────────            │
│  KV cache + runtime (~57GB free)         │
└──────────────────────────────────────────┘
         ↕ HTTP API (OpenAI-compatible)
┌──────────────────────────────────────────┐
│  Tank                                     │
│  OpenClaw Gateway                         │
│  memory-unified plugin                    │
│  sqlite-vec (2048-dim vectors)           │
│  Memory Bank v2 (pre-embedded facts)     │
│  FTS5 full-text search                   │
└──────────────────────────────────────────┘
```

## Model Downloads

| Model | Source | Size | Serving |
|-------|--------|------|---------|
| `nvidia/llama-nemotron-embed-1b-v2` | HuggingFace | ~2GB | TEI container |
| `nvidia/llama-nemotron-rerank-1b-v2` | HuggingFace | ~2GB | TEI container |
| `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4` | HuggingFace | ~67GB | vLLM/Ollama |

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Nemotron Embed quality < Qwen3 | A/B test on 100 queries before full migration |
| TEI doesn't support Nemotron | Fall back to sentence-transformers Python server |
| Vector migration corrupts data | Backup sqlite DB before migration |
| Rerank adds latency | Only rerank when >10 candidates |
| Nemotron Super Mamba hybrid not in Ollama | Use vLLM which supports Mamba-2 |

## Timeline

- **Phase 1:** 1-2 days (code changes only, no new models)
- **Phase 2:** 2-3 days (model download + migration + testing)
- **Phase 3:** When Spark(s) online (model deployment + config)

---
*Created by Wiki — 2026-03-14 23:17 UTC*
