import { Type } from "@sinclair/typebox";
import type { ToolDef, ToolResult, RufloHNSW, UnifiedDB } from "../types";
import type { EntryType } from "../config";

export function createUnifiedSearchTool(udb: UnifiedDB, ruflo: RufloHNSW | null): ToolDef {
  return {
    name: "unified_search",
    label: "Unified Memory Search",
    description: "Search across USMD skills and HNSW vector memory. Combines structured SQL + semantic search.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      type: Type.Optional(Type.String({ description: "Filter by entry type: skill/protocol/config/history/tool/result/task" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
    }),
    async execute(_id, params): Promise<ToolResult> {
      const query = params.query as string;
      const entryType = params.type as EntryType | undefined;
      const limit = (params.limit as number) ?? 10;

      const sqlResults = udb.searchEntries(entryType, limit);
      let hnswResults: any[] = [];
      if (ruflo) {
        try {
          hnswResults = await ruflo.search(query, { limit, namespace: "unified" });
        } catch {}
      }

      const lines = [
        `## SQL results (${sqlResults.length}):`,
        ...sqlResults.map((e: any) => `- [${e.entry_type}] ${e.summary || e.content?.slice(0, 100)}`),
        `\n## HNSW results (${hnswResults.length}):`,
        ...hnswResults.map((r: any) => `- [${(r.similarity * 100).toFixed(0)}%] ${r.key}: ${typeof r.value === "string" ? r.value.slice(0, 100) : JSON.stringify(r.value).slice(0, 100)}`),
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { sqlCount: sqlResults.length, hnswCount: hnswResults.length },
      };
    },
  };
}