import { Type } from "@sinclair/typebox";
import type { ToolDef, ToolResult } from "../types";
import type { DatabasePort } from "../db/port";
import type { EntryType } from "../config";

interface VectorSearcher {
  isReady(): boolean;
  search(query: string, topK?: number, excludeTypes?: string[]): Promise<Array<{ entryId: number; distance: number }>>;
}

export function createUnifiedSearchTool(port: DatabasePort, lanceManager: VectorSearcher | null): ToolDef {
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
      const rawQuery = params.query as string;
      const entryType = params.type as EntryType | undefined;
      const limit = (params.limit as number) ?? 10;
      const agentId = params.agent_id as string | undefined;

      // Expand query using search aliases (short acronyms → full terms)
      const query = await port.expandQuery(rawQuery);

      // FTS5 keyword search (ftsSearch also expands internally, but we pass expanded for vector)
      const sqlResults = await port.ftsSearch(rawQuery, entryType, limit, agentId);

      // Semantic vector search
      let vectorLines: string[] = [];
      let vectorCount = 0;
      const allHitIds: number[] = [];

      if (lanceManager?.isReady()) {
        try {
          const vectorResults = await lanceManager.search(query, limit);
          vectorCount = vectorResults.length;
          for (const r of vectorResults) {
            allHitIds.push(r.entryId);
            const entries = await port.queryEntries({ ids: [r.entryId] });
            const entry = entries[0];
            const text = entry?.summary || entry?.content?.slice(0, 120) || `entry#${r.entryId}`;
            const similarity = Math.max(0, Math.round((1 - (r.distance || 0)) * 100));
            vectorLines.push(`- [${similarity}%] [${entry?.entry_type || "?"}] ${text}`);
          }
        } catch {}
      }

      // Track access_count for returned results
      for (const e of sqlResults) { if (e.id) allHitIds.push(e.id); }
      if (allHitIds.length > 0) {
        try {
          await port.updateEntryAccessCount([...new Set(allHitIds)]);
        } catch {} // non-critical
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
