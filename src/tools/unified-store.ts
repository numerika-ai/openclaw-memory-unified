import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { ToolDef, ToolResult, RufloHNSW, UnifiedDB } from "../types";
import type { EntryType } from "../config";
import { autoTag, summarize } from "../utils/helpers";

interface NativeHnswManager {
  isReady(): boolean;
  addEntry(entryId: number, text: string): Promise<boolean>;
}

export function createUnifiedStoreTool(
  udb: UnifiedDB, 
  ruflo: RufloHNSW | null,
  hnswManager: NativeHnswManager | null
): ToolDef {
  return {
    name: "unified_store",
    label: "Unified Memory Store",
    description: "Store an entry in both USMD SQLite and Ruflo HNSW. Auto-tags and summarizes.",
    parameters: Type.Object({
      content: Type.String({ description: "Content to store" }),
      type: Type.Optional(Type.String({ description: "Entry type: skill/protocol/config/history/tool/result/task (default: history)" })),
      tags: Type.Optional(Type.String({ description: "Comma-separated tags" })),
      source_path: Type.Optional(Type.String({ description: "Source file path" })),
      agent_id: Type.Optional(Type.String({ description: "Agent identifier (e.g. wiki, jarvis, hermes). Auto-detected from session if omitted." })),
    }),
    async execute(_id, params): Promise<ToolResult> {
      const content = params.content as string;
      const entryType = (params.type as EntryType) ?? "history";
      const userTags = params.tags as string | undefined;
      const sourcePath = params.source_path as string | undefined;
      const agentId = (params.agent_id as string | undefined) ?? (globalThis as any).__openclawAgentId ?? "unknown";

      const tags = userTags ? userTags.split(",").map(t => t.trim()) : autoTag(content);
      const summary = summarize(content);
      const hnswKey = `${entryType}:${Date.now()}:${randomUUID().slice(0, 6)}`;

      const entryId = udb.storeEntry({
        entryType,
        tags: tags.join(","),
        content,
        summary,
        sourcePath,
        hnswKey,
        agentId,
      });

      if (ruflo) {
        await ruflo.store(hnswKey, { content: content.slice(0, 2000), summary, tags, entryType }, { tags, namespace: "unified" });
      }

      // Index in native HNSW (fire and forget)
      if (hnswManager?.isReady()) {
        hnswManager.addEntry(entryId, summary || content.slice(0, 2000)).catch(() => {});
      }

      return {
        content: [{ type: "text", text: `Stored unified entry #${entryId} [${entryType}] agent=${agentId} (hnsw: ${hnswKey})` }],
        details: { entryId, hnswKey, tags, agentId },
      };
    },
  };
}