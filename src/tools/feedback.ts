/**
 * Feedback capture tool — rate, list, stats
 *
 * Uses DatabasePort (async) for backend-agnostic DB access.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDef, ToolResult } from "../types";
import type { DatabasePort } from "../db/port";

export function createFeedbackTool(port: DatabasePort): ToolDef {
  return {
    name: "feedback",
    label: "Feedback",
    description: "Capture task feedback: rate a task (+1/0/-1), list recent feedback, or view aggregated stats.",
    parameters: Type.Object({
      action: Type.String({ description: "Action: rate | list | stats" }),
      rating: Type.Optional(Type.Number({ description: "Rating for 'rate' action: 1 (good), 0 (neutral), -1 (bad)" })),
      task: Type.Optional(Type.String({ description: "Task description (for 'rate' action)" })),
      comment: Type.Optional(Type.String({ description: "Optional comment — what went well or wrong" })),
      skill: Type.Optional(Type.String({ description: "Skill name associated with this feedback" })),
      agent_id: Type.Optional(Type.String({ description: "Agent ID (defaults to current agent)" })),
      limit: Type.Optional(Type.Number({ description: "Max results for 'list' (default: 20)" })),
    }),
    async execute(_id, params): Promise<ToolResult> {
      const action = params.action as string;

      switch (action) {
        case "rate":
          return rateFeedback(port, params);
        case "list":
          return listFeedback(port, params);
        case "stats":
          return statsFeedback(port, params);
        default:
          return { content: [{ type: "text", text: `Unknown action: ${action}. Use: rate, list, stats` }] };
      }
    },
  };
}

function parseRating(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (n >= 1) return 1;
  if (n <= -1) return -1;
  return 0;
}

async function rateFeedback(port: DatabasePort, params: Record<string, unknown>): Promise<ToolResult> {
  const task = params.task as string | undefined;
  if (!task || task.length < 3) {
    return { content: [{ type: "text", text: "Error: 'task' parameter required (min 3 chars)" }] };
  }

  const rating = parseRating(params.rating);
  if (rating == null) {
    return { content: [{ type: "text", text: "Error: 'rating' parameter required (-1, 0, or 1)" }] };
  }

  const agentId = (params.agent_id as string) ?? (globalThis as any).__openclawAgentId ?? "main";
  const sessionKey = (globalThis as any).__openclawSessionKey as string | undefined;

  const id = await port.storeFeedback({
    agentId,
    sessionKey,
    taskDescription: task,
    rating,
    comment: (params.comment as string) ?? undefined,
    skillName: (params.skill as string) ?? undefined,
  });

  const emoji = rating === 1 ? "+" : rating === -1 ? "-" : "~";
  return {
    content: [{ type: "text", text: `Feedback #${id} recorded [${emoji}${rating}] for: ${task}` }],
    details: { id, rating },
  };
}

async function listFeedback(port: DatabasePort, params: Record<string, unknown>): Promise<ToolResult> {
  const limit = (params.limit as number) ?? 20;
  const agentId = params.agent_id as string | undefined;
  const skill = params.skill as string | undefined;

  const entries = await port.getFeedback({
    agentId,
    skillName: skill,
    limit,
  });

  if (entries.length === 0) {
    return { content: [{ type: "text", text: "No feedback entries found." }] };
  }

  const lines = entries.map((e) => {
    const emoji = e.rating === 1 ? "+" : e.rating === -1 ? "-" : "~";
    const skill = e.skill_name ? ` [${e.skill_name}]` : "";
    const comment = e.comment ? ` — ${e.comment}` : "";
    return `#${e.id} [${emoji}${e.rating}]${skill} ${e.task_description}${comment} (${e.created_at})`;
  });

  return {
    content: [{ type: "text", text: `## Recent Feedback (${entries.length})\n${lines.join("\n")}` }],
    details: { count: entries.length },
  };
}

async function statsFeedback(port: DatabasePort, params: Record<string, unknown>): Promise<ToolResult> {
  const agentId = params.agent_id as string | undefined;
  const stats = await port.getFeedbackStats(agentId);

  const positiveRate = stats.total > 0 ? ((stats.positive / stats.total) * 100).toFixed(0) : "0";
  const negativeRate = stats.total > 0 ? ((stats.negative / stats.total) * 100).toFixed(0) : "0";

  const lines = [
    `## Feedback Stats${agentId ? ` (agent: ${agentId})` : ""}`,
    `Total: ${stats.total} | Positive: ${stats.positive} (${positiveRate}%) | Negative: ${stats.negative} (${negativeRate}%) | Neutral: ${stats.neutral}`,
  ];

  if (stats.topSkills.length > 0) {
    lines.push("", "### Skills by Rating");
    for (const s of stats.topSkills) {
      const avg = s.avgRating > 0 ? `+${s.avgRating}` : String(s.avgRating);
      lines.push(`- ${s.skill}: avg ${avg} (${s.count} ratings)`);
    }
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: stats,
  };
}
