import { Type } from "@sinclair/typebox";
import type { ToolDef, ToolResult, UnifiedDB } from "../types";
import type { EntryType } from "../config";
import type { NativeLanceManager } from "../db/lance-manager";

export function createUnifiedSearchTool(udb: UnifiedDB, lanceManager: NativeLanceManager | null): ToolDef {
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

      // FTS5 keyword search via SQLite
      const sqlResults = udb.ftsSearch(query, entryType, limit);

      // Semantic vector search via LanceDB + Qwen3 embeddings
      let vectorResults: any[] = [];
      if (lanceManager?.isReady()) {
        try {
          vectorResults = await lanceManager.search(query, limit);
        } catch {}
      }

      const lines = [
        `## SQL results (${sqlResults.length}):`,
        ...sqlResults.map((e: any) => `- [${e.entry_type}] ${e.summary || e.content?.slice(0, 100)}`),
        `\n## Vector results (${vectorResults.length}):`,
        ...vectorResults.map((r: any) => `- [${(r.similarity * 100).toFixed(0)}%] ${r.text?.slice(0, 120)}`),
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { sqlCount: sqlResults.length, vectorCount: vectorResults.length },
      };
    },
  };
}
