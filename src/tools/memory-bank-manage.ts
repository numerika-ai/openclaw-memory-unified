/**
 * Memory Bank management tool — list, search, add, edit, delete, status
 */

import { Type } from "@sinclair/typebox";
import type { Database } from "better-sqlite3";
import type { ToolDef, ToolResult } from "../types";
import { qwenEmbed, cosineSim } from "../embedding/ollama";
import type { MemoryFact } from "../memory-bank/types";

export function createMemoryBankManageTool(db: Database): ToolDef {
  return {
    name: "memory_bank_manage",
    label: "Memory Bank Manager",
    description: "Manage long-term memory facts: list, search, add, edit, delete facts, or view stats.",
    parameters: Type.Object({
      action: Type.String({ description: "Action: list | search | add | edit | delete | status" }),
      topic: Type.Optional(Type.String({ description: "Filter by topic (for list/add)" })),
      status: Type.Optional(Type.String({ description: "Filter by status: active | stale | contradicted | archived (for list)" })),
      query: Type.Optional(Type.String({ description: "Search query (for search action)" })),
      fact_id: Type.Optional(Type.Number({ description: "Fact ID (for edit/delete)" })),
      fact: Type.Optional(Type.String({ description: "Fact content (for add/edit)" })),
      confidence: Type.Optional(Type.Number({ description: "Confidence 0.0-1.0 (for add/edit)" })),
      scope: Type.Optional(Type.String({ description: "Scope: global or agent_id (for add)" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 20)" })),
    }),
    async execute(_id, params): Promise<ToolResult> {
      const action = params.action as string;
      const limit = (params.limit as number) ?? 20;

      switch (action) {
        case "list":
          return listFacts(db, params, limit);
        case "search":
          return searchFacts(db, params, limit);
        case "add":
          return addFact(db, params);
        case "edit":
          return editFact(db, params);
        case "delete":
          return deleteFact(db, params);
        case "status":
          return getStatus(db);
        default:
          return { content: [{ type: "text", text: `Unknown action: ${action}. Use: list, search, add, edit, delete, status` }] };
      }
    },
  };
}

function listFacts(db: Database, params: Record<string, unknown>, limit: number): ToolResult {
  const topic = params.topic as string | undefined;
  const status = (params.status as string) ?? "active";

  let query = "SELECT id, topic, fact, confidence, status, scope, temporal_type, access_count, created_at, updated_at FROM memory_facts WHERE status = ?";
  const args: unknown[] = [status];

  if (topic) {
    query += " AND topic = ?";
    args.push(topic);
  }

  query += " ORDER BY confidence DESC, updated_at DESC LIMIT ?";
  args.push(limit);

  const facts = db.prepare(query).all(...args) as any[];

  if (facts.length === 0) {
    return { content: [{ type: "text", text: `No facts found (status=${status}${topic ? `, topic=${topic}` : ""})` }] };
  }

  const lines = facts.map((f: any) =>
    `#${f.id} [${f.topic}] (${(f.confidence * 100).toFixed(0)}%, ${f.status}, scope=${f.scope}) ${f.fact}`
  );

  return {
    content: [{ type: "text", text: `## Memory Facts (${facts.length} results)\n${lines.join("\n")}` }],
    details: { count: facts.length },
  };
}

async function searchFacts(db: Database, params: Record<string, unknown>, limit: number): Promise<ToolResult> {
  const query = params.query as string;
  if (!query) {
    return { content: [{ type: "text", text: "Error: query parameter required for search" }] };
  }

  const queryEmb = await qwenEmbed(query);

  const activeFacts = db.prepare(
    "SELECT id, topic, fact, confidence, status, scope FROM memory_facts WHERE status = 'active' ORDER BY confidence DESC LIMIT 100"
  ).all() as Array<Pick<MemoryFact, "id" | "topic" | "fact" | "confidence" | "status" | "scope">>;

  if (!queryEmb) {
    // Fallback to LIKE search if embedding unavailable
    const likeFacts = db.prepare(
      "SELECT id, topic, fact, confidence, status, scope FROM memory_facts WHERE status = 'active' AND fact LIKE ? ORDER BY confidence DESC LIMIT ?"
    ).all(`%${query}%`, limit) as any[];

    const lines = likeFacts.map((f: any) =>
      `#${f.id} [${f.topic}] (${(f.confidence * 100).toFixed(0)}%) ${f.fact}`
    );
    return {
      content: [{ type: "text", text: `## Text Search Results (${likeFacts.length})\n${lines.join("\n")}` }],
      details: { count: likeFacts.length, method: "text" },
    };
  }

  const scored: Array<{ id: number; topic: string; fact: string; confidence: number; scope: string; similarity: number }> = [];
  for (const f of activeFacts) {
    const fEmb = await qwenEmbed(f.fact);
    if (!fEmb) continue;
    const sim = cosineSim(queryEmb, fEmb);
    if (sim > 0.3) {
      scored.push({ ...f, scope: f.scope ?? "global", similarity: sim });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  const topFacts = scored.slice(0, limit);

  const lines = topFacts.map(f =>
    `#${f.id} [${f.topic}] (${(f.similarity * 100).toFixed(0)}% sim, ${(f.confidence * 100).toFixed(0)}% conf, scope=${f.scope}) ${f.fact}`
  );

  return {
    content: [{ type: "text", text: `## Semantic Search Results (${topFacts.length})\n${lines.join("\n")}` }],
    details: { count: topFacts.length, method: "semantic" },
  };
}

function addFact(db: Database, params: Record<string, unknown>): ToolResult {
  const fact = params.fact as string;
  const topic = (params.topic as string) ?? "learned_patterns";
  const confidence = (params.confidence as number) ?? 0.8;
  const scope = (params.scope as string) ?? "global";

  if (!fact || fact.length < 5) {
    return { content: [{ type: "text", text: "Error: fact parameter required (min 5 chars)" }] };
  }

  const hnswKey = `memfact:${topic}:${Date.now()}`;
  const result = db.prepare(`
    INSERT INTO memory_facts (topic, fact, confidence, source_type, scope, hnsw_key)
    VALUES (?, ?, ?, 'manual', ?, ?)
  `).run(topic, fact, Math.min(1, Math.max(0, confidence)), scope, hnswKey);

  const factId = result.lastInsertRowid as number;

  db.prepare(
    "INSERT INTO memory_revisions (fact_id, revision_type, old_content, new_content, reason) VALUES (?, 'created', NULL, ?, 'manual add')"
  ).run(factId, fact);

  return {
    content: [{ type: "text", text: `Created fact #${factId} [${topic}] (conf=${confidence}, scope=${scope})` }],
    details: { factId },
  };
}

function editFact(db: Database, params: Record<string, unknown>): ToolResult {
  const factId = params.fact_id as number;
  const newFact = params.fact as string;
  const newConf = params.confidence as number | undefined;

  if (!factId) {
    return { content: [{ type: "text", text: "Error: fact_id parameter required" }] };
  }
  if (!newFact) {
    return { content: [{ type: "text", text: "Error: fact parameter required for edit" }] };
  }

  const existing = db.prepare("SELECT id, fact, confidence FROM memory_facts WHERE id = ?").get(factId) as any;
  if (!existing) {
    return { content: [{ type: "text", text: `Error: fact #${factId} not found` }] };
  }

  const conf = newConf !== undefined ? Math.min(1, Math.max(0, newConf)) : existing.confidence;
  db.prepare("UPDATE memory_facts SET fact = ?, confidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(newFact, conf, factId);

  db.prepare(
    "INSERT INTO memory_revisions (fact_id, revision_type, old_content, new_content, reason) VALUES (?, 'manual_edit', ?, ?, 'manual edit')"
  ).run(factId, existing.fact, newFact);

  return {
    content: [{ type: "text", text: `Updated fact #${factId}: "${newFact}" (conf=${conf.toFixed(2)})` }],
    details: { factId },
  };
}

function deleteFact(db: Database, params: Record<string, unknown>): ToolResult {
  const factId = params.fact_id as number;
  if (!factId) {
    return { content: [{ type: "text", text: "Error: fact_id parameter required" }] };
  }

  const existing = db.prepare("SELECT id, fact FROM memory_facts WHERE id = ?").get(factId) as any;
  if (!existing) {
    return { content: [{ type: "text", text: `Error: fact #${factId} not found` }] };
  }

  // Soft delete: set status to archived
  db.prepare("UPDATE memory_facts SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(factId);

  db.prepare(
    "INSERT INTO memory_revisions (fact_id, revision_type, old_content, new_content, reason) VALUES (?, 'deleted', ?, NULL, 'manual delete (soft)')"
  ).run(factId, existing.fact);

  return {
    content: [{ type: "text", text: `Archived fact #${factId} (soft delete)` }],
    details: { factId },
  };
}

function getStatus(db: Database): ToolResult {
  const total = (db.prepare("SELECT COUNT(*) as c FROM memory_facts").get() as any)?.c ?? 0;
  const active = (db.prepare("SELECT COUNT(*) as c FROM memory_facts WHERE status = 'active'").get() as any)?.c ?? 0;
  const contradicted = (db.prepare("SELECT COUNT(*) as c FROM memory_facts WHERE status = 'contradicted'").get() as any)?.c ?? 0;
  const archived = (db.prepare("SELECT COUNT(*) as c FROM memory_facts WHERE status = 'archived'").get() as any)?.c ?? 0;
  const stale = (db.prepare("SELECT COUNT(*) as c FROM memory_facts WHERE status = 'stale'").get() as any)?.c ?? 0;

  const byTopic = db.prepare(
    "SELECT topic, COUNT(*) as count, AVG(confidence) as avg_conf FROM memory_facts WHERE status = 'active' GROUP BY topic ORDER BY count DESC"
  ).all() as Array<{ topic: string; count: number; avg_conf: number }>;

  const lastExtraction = db.prepare(
    "SELECT created_at FROM memory_revisions WHERE revision_type = 'created' ORDER BY created_at DESC LIMIT 1"
  ).get() as { created_at: string } | undefined;

  const revisionCount = (db.prepare("SELECT COUNT(*) as c FROM memory_revisions").get() as any)?.c ?? 0;

  const lines = [
    `## Memory Bank Status`,
    `Total facts: ${total} (active: ${active}, contradicted: ${contradicted}, archived: ${archived}, stale: ${stale})`,
    `Total revisions: ${revisionCount}`,
    `Last extraction: ${lastExtraction?.created_at ?? "never"}`,
    ``,
    `### By Topic`,
    ...byTopic.map(t => `- ${t.topic}: ${t.count} facts (avg conf: ${(t.avg_conf * 100).toFixed(0)}%)`),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { total, active, contradicted, archived, stale, revisionCount },
  };
}
