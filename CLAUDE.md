# CLAUDE.md — Memory-Unified Plugin Improvement Plan

## Context
Plugin: `memory-unified` for OpenClaw — unified memory layer (SQLite + sqlite-vec + RAG pipeline).
Full audit: `UPGRADE-PLAN.md` (w tym katalogu).

## Build & Test
```bash
npm run build          # TypeScript → dist/
# Zero errors required. Check with:
grep -r "ollama" dist/ # must return nothing
grep -r "lancedb" dist/ # must return nothing
```

## Rules
- **NEVER** use `rm` — move to `.trash/` directory instead
- **NEVER** modify `openclaw.json`
- **NEVER** restart the gateway
- Run `npm run build` after ALL changes — must pass with zero errors
- Check TypeScript types before committing

---

## Step-by-Step Implementation

### Step 1: Fix bulkIndex() — CRITICAL [lance-manager.ts]

**Problem:** `DELETE FROM hnsw_meta` at start of bulkIndex() destroys ALL embedding tracking on every gateway restart. Only 500 entries get re-embedded per restart, so the database never gets full coverage (currently 2.8%).

**File:** `src/db/lance-manager.ts` ~line 63

**Changes:**
1. REMOVE the line `this.db.exec('DELETE FROM hnsw_meta');`
2. Change `LIMIT 500` → `LIMIT 2000`
3. The LEFT JOIN query already handles "find unembedded entries" — removing DELETE makes it incremental

**Before:**
```typescript
async bulkIndex(): Promise<void> {
    this.db.exec('DELETE FROM hnsw_meta');  // ← REMOVE THIS LINE
    const unembedded = this.db.prepare(`...LIMIT 500`).all();  // ← CHANGE TO 2000
```

**After:**
```typescript
async bulkIndex(): Promise<void> {
    // Incremental: only index entries not yet in hnsw_meta
    const unembedded = this.db.prepare(`...LIMIT 2000`).all();
```

### Step 2: Skip tool entries in embedding [lance-manager.ts]

**Problem:** 96% of entries (17,869) are tool call logs — noise that pollutes vector search.

**File:** `src/db/lance-manager.ts` in `addEntry()` method

**Changes:** After getting entry metadata, skip tool entries:
```typescript
async addEntry(entryId: number, text: string): Promise<boolean> {
    // ... existing skip if already embedded ...
    
    const entry = this.db.prepare('SELECT entry_type, tags FROM unified_entries WHERE id = ?').get(entryId) as any;
    const entryType = entry?.entry_type || '';
    
    // Skip tool entries — they're 96% of the database and pollute vector search
    if (entryType === 'tool') return false;
    
    // ... rest of embedding logic ...
```

### Step 3: Fix config defaults [config.ts]

**Problem:** DEFAULT_DB_PATH points to Hermes, rerankUrl points to SearXNG port.

**File:** `src/config.ts`

**Changes:**
```typescript
// BEFORE:
const DEFAULT_DB_PATH = "/home/hermes/.openclaw/workspace/skill-memory.db";
// AFTER:
const DEFAULT_DB_PATH = "skill-memory.db";  // relative, resolved by api.resolvePath()

// BEFORE (in parse()):
rerankUrl: typeof cfg.rerankUrl === "string" ? cfg.rerankUrl : "http://localhost:8081/rerank",
// AFTER:
rerankUrl: typeof cfg.rerankUrl === "string" ? cfg.rerankUrl : "http://localhost:8082/rerank",
```

### Step 4: Lower rerank threshold [rag-injection.ts]

**Problem:** Reranking only triggers at 10+ candidates. Most turns have 3-7.

**File:** `src/hooks/rag-injection.ts` ~line 228

**Change:**
```typescript
// BEFORE:
if (cfg.rerankEnabled && slimLines.length > 10) {
// AFTER:
if (cfg.rerankEnabled && slimLines.length > 3) {
```

### Step 5: Add batch embedding API [nemotron.ts]

**Problem:** Single embed requests waste latency. TEI supports batch natively.

**File:** `src/embedding/nemotron.ts`

**Add new function:**
```typescript
/**
 * Batch embed multiple texts. TEI supports batch natively.
 * Returns array of embeddings (null for failures).
 */
export async function embedBatch(
  texts: string[],
  type: "query" | "passage" = "passage"
): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  
  // Process in chunks of 32 (TEI batch limit)
  const BATCH_SIZE = 32;
  const results: (number[] | null)[] = [];
  
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    try {
      const url = USE_QWEN_LEGACY ? QWEN_EMBED_URL_ENV! : EMBED_URL;
      const model = USE_QWEN_LEGACY ? QWEN_MODEL : EMBED_MODEL;
      
      const inputs = batch.map(t => {
        const trimmed = t.slice(0, 7500);
        return USE_QWEN_LEGACY ? trimmed : (type === "query" ? QUERY_PREFIX : PASSAGE_PREFIX) + trimmed;
      });
      
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: inputs }),
        signal: AbortSignal.timeout(30000),
      });
      
      if (!resp.ok) {
        results.push(...batch.map(() => null));
        continue;
      }
      
      const data = (await resp.json()) as any;
      const embeddings = data?.data as any[];
      
      for (let j = 0; j < batch.length; j++) {
        const emb = embeddings?.[j]?.embedding;
        results.push(Array.isArray(emb) && emb.length > 0 ? emb : null);
      }
    } catch {
      results.push(...batch.map(() => null));
    }
  }
  
  return results;
}
```

**Then update bulkIndex() in lance-manager.ts to use batch:**
```typescript
import { qwenEmbed, embedBatch, EMBED_DIM } from "../embedding/nemotron";

// In bulkIndex(), replace single-request loop with batch:
const BATCH = 32;
for (let i = 0; i < unembedded.length; i += BATCH) {
    const batch = unembedded.slice(i, i + BATCH);
    const texts = batch.map((e: any) => {
        const text = e.summary || (e.content || '').slice(0, 500);
        return text.length >= 10 ? text : '';
    });
    
    const embeddings = await embedBatch(texts.filter(t => t.length > 0), "passage");
    
    let embIdx = 0;
    for (const entry of batch) {
        const text = entry.summary || (entry.content || '').slice(0, 500);
        if (text.length < 10) continue;
        
        const emb = embeddings[embIdx++];
        if (!emb || emb.length !== EMBED_DIM) continue;
        
        const entryMeta = this.db.prepare('SELECT entry_type FROM unified_entries WHERE id = ?').get(entry.id) as any;
        if (entryMeta?.entry_type === 'tool') continue;
        
        this.sqliteVecStore.store(entry.id, text, emb, entryMeta?.entry_type || '');
        this.db.prepare('INSERT OR IGNORE INTO hnsw_meta (entry_id) VALUES (?)').run(entry.id);
        indexed++;
    }
}
```

### Step 6: Vector-first consolidation [consolidator.ts]

**Problem:** O(n²) — embeds EVERY existing fact per topic (up to 50) for each new fact.

**File:** `src/memory-bank/consolidator.ts`

**Change the similarity search to use sqlite-vec instead of per-fact embedding:**

The function needs access to a `searchFactsByVector` method. Add it as a parameter:

```typescript
// Add to consolidateFact signature:
export async function consolidateFact(
  newFact: ExtractedFact,
  db: Database,
  config: MemoryBankConfig,
  _unused: unknown,
  logger: { ... },
  scope?: string,
  embeddingStore?: FactEmbeddingStore | null,
): Promise<ConsolidationResult> {
  const newEmb = await embed(newFact.fact, "passage");
  if (!newEmb) { /* ... existing no-embed fallback ... */ }
  
  // REPLACE the O(n²) loop with sqlite-vec query:
  // BEFORE: for (const ex of existing) { const exEmb = await embed(ex.fact); ... }
  // AFTER:
  const vecResults = db.prepare(`
    SELECT v.fact_id, v.distance, mf.fact, mf.confidence, mf.hnsw_key
    FROM memory_facts_vec v
    JOIN memory_facts mf ON mf.id = v.fact_id
    WHERE v.embedding MATCH ?
    AND k = 5
    AND mf.topic = ?
    AND mf.status = 'active'
  `).all(new Float32Array(newEmb), newFact.topic) as any[];
  
  let bestSim = 0;
  let bestMatch = null;
  for (const r of vecResults) {
    const sim = 1 - r.distance;
    if (sim > bestSim) {
      bestSim = sim;
      bestMatch = { id: r.fact_id, fact: r.fact, confidence: r.confidence, hnsw_key: r.hnsw_key };
    }
  }
  
  // ... rest of consolidation logic uses bestSim/bestMatch as before ...
```

Note: sqlite-vec query requires `import { embeddingToBuffer } from "../embedding/nemotron"` and passing buffer:
```typescript
const embBuf = embeddingToBuffer(newEmb);
// Use embBuf in the MATCH clause
```

### Step 7: Vector-first memory bank search [memory-bank-manage.ts]

**Problem:** O(n) per-fact embedding in searchFacts (100 embed calls per search).

**File:** `src/tools/memory-bank-manage.ts`

**Changes:**
1. Pass the full `UnifiedDBImpl` (not just `Database`) to `createMemoryBankManageTool`
2. Use `searchFactsByVector()` instead of manual embed loop:

```typescript
// Change signature:
export function createMemoryBankManageTool(db: Database, udb?: { searchFactsByVector: Function }): ToolDef {

// In searchFacts():
async function searchFacts(db: Database, params: Record<string, unknown>, limit: number): Promise<ToolResult> {
    const query = params.query as string;
    if (!query) return { ... };
    
    const queryEmb = await qwenEmbed(query);
    if (!queryEmb) { /* ... existing LIKE fallback ... */ }
    
    // Use sqlite-vec directly instead of O(n) loop
    const embBuf = embeddingToBuffer(queryEmb);
    
    // Try sqlite-vec first
    try {
        const vecResults = db.prepare(`
            SELECT v.fact_id, v.distance, mf.topic, mf.fact, mf.confidence, mf.scope
            FROM memory_facts_vec v
            JOIN memory_facts mf ON mf.id = v.fact_id
            WHERE v.embedding MATCH ? AND k = ?
            AND mf.status = 'active'
        `).all(embBuf, limit) as any[];
        
        const lines = vecResults.map(f => 
            `#${f.fact_id} [${f.topic}] (${((1 - f.distance) * 100).toFixed(0)}% sim, ${(f.confidence * 100).toFixed(0)}% conf, scope=${f.scope}) ${f.fact}`
        );
        return {
            content: [{ type: "text", text: `## Semantic Search Results (${vecResults.length})\n${lines.join("\n")}` }],
            details: { count: vecResults.length, method: "sqlite-vec" },
        };
    } catch {
        // Fall back to old O(n) method if sqlite-vec fails
        // ... existing code ...
    }
}
```

Also need to add import: `import { embeddingToBuffer } from "../embedding/nemotron";`

### Step 8: Trash dead files

```bash
mkdir -p .trash
mv src/embedding/ollama.ts .trash/
mv src/db/lancedb.ts .trash/
```

Verify no imports reference them:
```bash
grep -r "ollama" src/ --include="*.ts" | grep -v ".trash"   # should be empty
grep -r "lancedb" src/ --include="*.ts" | grep -v ".trash"  # should be empty
```

### Step 9: Add Polish stop words [helpers.ts]

**File:** `src/utils/helpers.ts`

Add to STOP_WORDS set:
```typescript
'może', 'mam', 'masz', 'żeby', 'albo', 'teraz', 'sobie', 'tutaj',
'jakie', 'kiedy', 'więc', 'coś', 'będzie', 'bardzo', 'dobra', 'dobrze',
'proszę', 'działa', 'trzeba', 'można', 'chcę', 'mogę', 'musisz',
'zrób', 'sprawdź', 'napisz', 'pokaż', 'daj', 'weź',
```

### Step 10: Pattern GC on startup [maintenance.ts]

**File:** `src/memory-bank/maintenance.ts`

Add to `runMaintenance()`:
```typescript
export function runMaintenance(db: Database, logger: Logger): MaintenanceResult {
    const expired = expireFacts(db, logger);
    const decayed = decayConfidence(db, logger);
    const patternsGC = cleanupPatterns(db, logger);  // ← ADD
    if (expired > 0 || decayed > 0 || patternsGC > 0) {
        logger.info?.(`memory-bank maintenance: expired=${expired}, decayed=${decayed}, patterns_gc=${patternsGC}`);
    }
    return { expired, decayed };
}

function cleanupPatterns(db: Database, logger: Logger): number {
    try {
        const result = db.prepare(
            "DELETE FROM patterns WHERE confidence < 0.1 AND updated_at < datetime('now', '-30 days')"
        ).run();
        if (result.changes > 0) {
            logger.info?.(`memory-bank: cleaned up ${result.changes} dead patterns`);
        }
        return result.changes;
    } catch {
        return 0;
    }
}
```

### Step 11: Update README.md

Rewrite README.md to reflect current state:
- **Embedding:** Nemotron Embed 1B v2 (2048-dim) on RTX 3090, NOT Qwen3/Ollama
- **Vector store:** sqlite-vec only (v3.0 complete), NOT LanceDB
- **Migration status:** ✅ Complete — all phases done
- **New sections:**
  - Memory Bank v2 (Vertex AI feature parity table)
  - Reranking (Nemotron Rerank 1B v2)
  - Embedding upgrade path (Qwen3-8B planned)
- **Architecture diagram:** Remove LanceDB, add memory_facts_vec, add reranking layer
- **Dependencies:** Remove @lancedb/lancedb, update description
- **Add link to UPGRADE-PLAN.md** for full audit details
- **Cost:** Still $0/month (all local)

### Step 12: Build & Verify

```bash
npm run build
grep -r "ollama" dist/   # MUST return nothing
grep -r "lancedb" dist/  # MUST return nothing  
grep -r "8081/rerank" dist/  # MUST return nothing (should be 8082)
grep -r "/home/hermes" dist/ # MUST return nothing
echo "✅ All checks passed"
```

---

## Execution Order
1 → 2 → 3 → 4 → 8 (quick, no deps)
5 → then 6, 7 (batch API needed for vector-first)
9 → 10 (independent)
11 (README — do last, after all code changes)
12 (verify — absolute last)

## Expected Results After All Steps
- bulkIndex() incremental (not destructive)
- Tool entries excluded from embeddings
- Config defaults correct
- Reranking triggers on 3+ candidates
- Batch embedding 10x faster indexing
- Consolidation O(1) instead of O(n²)
- Memory bank search O(1) instead of O(n)
- Dead files cleaned up
- Better Polish NLP
- Pattern table auto-maintained
- README accurate

---
*Plan created by Wiki — 2026-03-20 16:22 UTC*
