import { Type } from "@sinclair/typebox";
import type { ToolDef, ToolResult, UnifiedDB } from "../types";
import type { EntryType } from "../config";
import type { VectorManager } from "../db/vector-manager";

export function createUnifiedSearchTool(udb: UnifiedDB, lanceManager: VectorManager | null): ToolDef {
  return {
    name: "unified_search",
    label: "Unified Memory Search",
    description: "Search across USMD skills and HNSW vector memory. Combines structured SQL + semantic search.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      type: Type.Optional(Type.String({ description: "Filter by entry type: skill/protocol/config/history/tool/result/task" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
      agent_id: Type.Optional(Type.String({ description: "Filter by agent (e.g. wiki, jarvis, hermes). Omit to search all agents." })),
    }),
    async execute(_id, params): Promise<ToolResult> {
      const query = params.query as string;
      const entryType = params.type as EntryType | undefined;
      const limit = (params.limit as number) ?? 10;
      const agentId = params.agent_id as string | undefined;

      // FTS5 keyword search via SQLite
      const sqlResults = udb.ftsSearch(query, entryType, limit, agentId);

      // Semantic vector search via sqlite-vec + Nemotron embeddings
      let vectorLines: string[] = [];
      let vectorCount = 0;
      if (lanceManager?.isReady()) {
        try {
          const vectorResults = await lanceManager.search(query, limit);
          vectorCount = vectorResults.length;
          for (const r of vectorResults) {
            // Enrich with text from SQLite by entryId
            const entry = udb.getEntryById?.(r.entryId);
            const text = entry?.summary || entry?.content?.slice(0, 120) || `entry#${r.entryId}`;
            const similarity = Math.max(0, Math.round((1 - (r.distance || 0)) * 100));
            vectorLines.push(`- [${similarity}%] [${entry?.entry_type || "?"}] ${text}`);
          }
        } catch {}
      }

      const lines = [
        `## SQL results (${sqlResults.length}):`,
        ...sqlResults.map((e: any) => `- [${e.entry_type}] ${e.summary || e.content?.slice(0, 100)}`),
        `\n## Vector results (${vectorCount}):`,
        ...vectorLines,
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { sqlCount: sqlResults.length, vectorCount },
      };
    },
  };
}
