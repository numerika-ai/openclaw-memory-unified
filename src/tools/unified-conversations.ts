import { Type } from "@sinclair/typebox";
import type { ToolDef, ToolResult, UnifiedDB } from "../types";

export function createUnifiedConversationsTool(udb: UnifiedDB): ToolDef {
  return {
    name: "unified_conversations",
    label: "Conversation Threads",
    description: "List or search conversation threads. Use to recall what was discussed.",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "Filter by status: active/resolved/blocked/archived/all (default: active)" })),
      query: Type.Optional(Type.String({ description: "Search topic/tags/summary" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
      details: Type.Optional(Type.Boolean({ description: "Include full details and messages (default: false)" })),
    }),
    async execute(_id, params): Promise<ToolResult> {
      const status = (params.status as string) || 'active';
      const limit = Math.min((params.limit as number) || 10, 50);
      const query = (params.query as string) || '';
      const includeDetails = (params.details as boolean) || false;

      let sql = 'SELECT * FROM conversations WHERE 1=1';
      const sqlParams: any[] = [];

      if (status !== 'all') {
        sql += ' AND status = ?';
        sqlParams.push(status);
      }
      if (query) {
        sql += ' AND (topic LIKE ? OR tags LIKE ? OR summary LIKE ?)';
        const q = `%${query}%`;
        sqlParams.push(q, q, q);
      }
      sql += ' ORDER BY updated_at DESC LIMIT ?';
      sqlParams.push(limit);

      const conversations = udb.db.prepare(sql).all(...sqlParams) as any[];

      if (includeDetails) {
        for (const conv of conversations) {
          conv.messages = udb.db.prepare(
            'SELECT role, content_summary, has_decision, has_action, timestamp FROM conversation_messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT 20'
          ).all(conv.id);
        }
      }

      const text = JSON.stringify(conversations, null, 2);
      return {
        content: [{ type: "text" as const, text }],
        details: { count: conversations.length, status, query: query || undefined },
      };
    },
  };
}