import type { PluginApi, UnifiedDB, RufloHNSW } from "../types";
import type { UnifiedMemoryConfig } from "../config";
import { autoTag } from "../utils/helpers";
import { 
  extractKeywords, 
  extractTopic, 
  extractConversationTags, 
  generateThreadId,
  isDecision,
  isActionRequest,
  isResolution
} from "../utils/helpers";

// State variables shared across hooks
interface MemoryState {
  activeTrajectoryId: string | null;
  matchedSkillName: string | null;
  matchedSkillId: number | null;
  turnPrompt: string | null;
  agentId: string | null;
}

interface NativeLanceManager {
  isReady(): boolean;
  addEntry(entryId: number, text: string): Promise<boolean>;
}

interface HookDependencies {
  udb: UnifiedDB;
  ruflo: RufloHNSW | null;
  lanceManager: NativeLanceManager | null;
  cfg: UnifiedMemoryConfig;
  memoryState: MemoryState;
}

/**
 * Creates the tool call logging hook for after_tool_call
 */
export function createToolCallLogHook(deps: HookDependencies) {
  const { udb, ruflo, lanceManager, memoryState } = deps;

  return async function(api: PluginApi, event: Record<string, unknown>) {
    try {
      // OpenClaw may pass tool info in different field names
      const toolName = (event.toolName ?? event.name ?? event.tool ?? "unknown") as string;
      const params = (event.params ?? event.arguments ?? event.input) as Record<string, unknown> | undefined;
      const result = (event.result ?? event.output ?? "") as string;
      const error = (event.error ?? event.err) as string | undefined;

      // Skip our own tools and internal tools
      if (toolName.startsWith("skill_") || toolName.startsWith("unified_") || toolName === "artifact_register") return;
      if (toolName === "unknown") return;

      const paramsPreview = params ? JSON.stringify(params).slice(0, 500) : "";
      const resultStr = typeof result === "string" ? result : JSON.stringify(result ?? "");
      const resultPreview = error ? `ERROR: ${error}`.slice(0, 300) : resultStr.slice(0, 300);
      const status = error ? "error" : "success";

      // Store in SQLite unified_entries
      const tags = autoTag(`${toolName} ${paramsPreview}`);
      const summary = `${toolName}(${status}): ${paramsPreview.slice(0, 80)}`;
      const hnswKey = `tool:${toolName}:${Date.now()}`;

      const agentId = (event.agentId ?? event.agent_id ?? (globalThis as any).__openclawAgentId ?? "unknown") as string;
      const toolEntryId = udb.storeEntry({
        entryType: "tool",
        tags: tags.join(","),
        content: JSON.stringify({ tool: toolName, params: paramsPreview, result: resultPreview, status }),
        summary,
        hnswKey,
        agentId,
      });

      // Store in HNSW (fire and forget, don't block agent)
      if (ruflo) {
        ruflo.store(hnswKey, { tool: toolName, summary, status, tags }, { tags: [toolName, ...tags], namespace: "unified" }).catch(() => {});
      }

      // Native HNSW indexing (fire and forget, don't block agent)
      if (lanceManager?.isReady()) {
        lanceManager.addEntry(toolEntryId, summary).catch(() => {});
      }

      // MoE Auto-Routing: when sessions_spawn is called, log the model routing decision
      if (toolName === "sessions_spawn" && ruflo && params) {
        try {
          const task = (params.task ?? params.message ?? "") as string;
          const modelUsed = (params.model ?? "unknown") as string;

          // Log routing decision as pattern
          const routingPattern = `moe-route: task="${task.slice(0, 100)}" → model=${modelUsed}`;
          await ruflo.store(`moe:${Date.now()}`, routingPattern, {
            tags: ["moe", "model-routing", modelUsed],
            namespace: "pattern",
          });

          api.logger.info?.(`memory-unified: MoE logged: ${modelUsed} for "${task.slice(0, 50)}"`);
        } catch {} // non-critical
      }

      // Trajectory step (fire and forget)
      if (memoryState.activeTrajectoryId && ruflo) {
        ruflo.trajectoryStep(memoryState.activeTrajectoryId, `tool:${toolName}`, status, status === "success" ? 0.8 : 0.2).catch(() => {});
      }
    } catch (err) {
      // Silently skip — tool logging should never break the agent
      api.logger.warn?.("memory-unified: tool log failed:", String(err).slice(0, 100));
    }
  };
}

/**
 * Creates the agent end hook for agent_end
 */
export function createAgentEndHook(deps: HookDependencies) {
  const { udb, ruflo, cfg, memoryState } = deps;

  return async function(api: PluginApi, event: Record<string, unknown>) {
    // Always clear dynamic tool policy — prevent stale policies across turns
    (globalThis as any).__openclawDynamicToolPolicy = undefined;

    try {
      const success = event.success !== false;
      const response = (event.response ?? event.output ?? event.reply ?? "") as string;
      const responsePreview = typeof response === "string" ? response.slice(0, 500) : JSON.stringify(response).slice(0, 500);

      // ============================================================
      // SKILL EXECUTION LOGGING — closes the learning loop
      // ============================================================
      if (memoryState.matchedSkillName && memoryState.matchedSkillId) {
        try {
          const summary = `${memoryState.turnPrompt?.slice(0, 100) ?? "?"} → ${responsePreview.slice(0, 200)}`;
          udb.db.prepare(`
            INSERT INTO skill_executions (skill_id, summary, status, output_summary, session_key)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            memoryState.matchedSkillId,
            summary,
            success ? "success" : "error",
            responsePreview.slice(0, 1000),
            event.sessionKey ?? "unknown"
          );

          // Update skill use_count and success_rate
          udb.db.prepare(`
            UPDATE skills SET 
              use_count = use_count + 1,
              last_used = CURRENT_TIMESTAMP,
              success_rate = (success_rate * use_count + ?) / (use_count + 1)
            WHERE id = ?
          `).run(success ? 1.0 : 0.0, memoryState.matchedSkillId);

          api.logger.info?.(`memory-unified: logged execution for skill "${memoryState.matchedSkillName}" (${success ? "success" : "error"})`);

          // Feed Ruflo Intelligence — store pattern from successful executions
          if (success && ruflo) {
            try {
              const patternKey = `pattern:skill:${memoryState.matchedSkillName}:${Date.now()}`;
              const patternVal = `skill:${memoryState.matchedSkillName} | query: ${memoryState.turnPrompt?.slice(0, 100)} | result: success | ts: ${new Date().toISOString()}`;
              await ruflo.store(patternKey, patternVal, {
                tags: ["pattern", "skill-execution", memoryState.matchedSkillName],
                namespace: "pattern",
              });
            } catch {} // non-critical
          }

          // ============================================================
          // PATTERN EXTRACTION (Phase 1)
          // ============================================================
          try {
            const keywords = extractKeywords(memoryState.turnPrompt || "");
            if (keywords.length >= 3) {
              const keywordsJson = JSON.stringify(keywords.sort());

              const existing = udb.db.prepare(
                "SELECT id, confidence, success_count FROM patterns WHERE skill_name = ? AND keywords = ?"
              ).get(memoryState.matchedSkillName, keywordsJson) as { id: number; confidence: number; success_count: number } | undefined;

              if (existing) {
                // Boost confidence: +0.03 per success, cap at 0.95
                const newConf = Math.min(0.95, existing.confidence + 0.03);
                udb.db.prepare(
                  "UPDATE patterns SET confidence = ?, success_count = success_count + 1, updated_at = CURRENT_TIMESTAMP, last_matched_at = CURRENT_TIMESTAMP WHERE id = ?"
                ).run(newConf, existing.id);
                udb.db.prepare(
                  "INSERT INTO pattern_history (pattern_id, event_type, old_confidence, new_confidence, context) VALUES (?, 'success', ?, ?, ?)"
                ).run(existing.id, existing.confidence, newConf, (memoryState.turnPrompt || "").slice(0, 200));
                api.logger.info?.(`memory-unified: pattern boosted for "${memoryState.matchedSkillName}" (${existing.confidence.toFixed(2)} -> ${newConf.toFixed(2)})`);
              } else {
                // New pattern starts at 0.5
                const info = udb.db.prepare(
                  "INSERT INTO patterns (skill_name, keywords, confidence) VALUES (?, ?, 0.5)"
                ).run(memoryState.matchedSkillName, keywordsJson);
                // Log creation in history
                if (info.lastInsertRowid) {
                  udb.db.prepare(
                    "INSERT INTO pattern_history (pattern_id, event_type, old_confidence, new_confidence, context) VALUES (?, 'created', 0, 0.5, ?)"
                  ).run(info.lastInsertRowid, (memoryState.turnPrompt || "").slice(0, 200));
                }
                api.logger.info?.(`memory-unified: new pattern created for "${memoryState.matchedSkillName}" with ${keywords.length} keywords`);
              }
            }
          } catch (patErr) {
            api.logger.warn?.("memory-unified: pattern extraction failed:", patErr);
          }

        } catch (logErr) {
          api.logger.warn?.("memory-unified: skill execution log failed:", logErr);
        }
      }

      // ============================================================
      // PATTERN FAILURE (Phase 1)
      // ============================================================
      if (memoryState.matchedSkillName && !success) {
        try {
          const failPatterns = udb.db.prepare(
            "SELECT id, confidence FROM patterns WHERE skill_name = ?"
          ).all(memoryState.matchedSkillName) as Array<{ id: number; confidence: number }>;

          for (const p of failPatterns) {
            const newConf = Math.max(0.05, p.confidence - 0.05);
            udb.db.prepare(
              "UPDATE patterns SET confidence = ?, failure_count = failure_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
            ).run(newConf, p.id);
            udb.db.prepare(
              "INSERT INTO pattern_history (pattern_id, event_type, old_confidence, new_confidence) VALUES (?, 'failure', ?, ?)"
            ).run(p.id, p.confidence, newConf);
          }

          if (failPatterns.length > 0) {
            api.logger.info?.(`memory-unified: reduced confidence for ${failPatterns.length} patterns of "${memoryState.matchedSkillName}" (failure)`);
          }
        } catch (failPatErr) {
          api.logger.warn?.("memory-unified: pattern failure update failed:", failPatErr);
        }
      }

      // ============================================================
      // CONVERSATION TRACKING (Phase 5)
      // ============================================================
      try {
        const convPrompt = memoryState.turnPrompt || "";
        const convResponse = responsePreview || "";

        if (convPrompt.length > 20) {
          // Skip cron heartbeats, subagent contexts, and system reconnects
          const skipConv = /^\s*\[?cron:|HEARTBEAT_OK|\[Subagent Context\]|Auto-handoff check|WhatsApp gateway (dis)?connected/i.test(convPrompt);
          if (skipConv) {
            api.logger.info?.('memory-unified: CONV SKIP (system/cron message)');
            throw new Error('skip');  // caught by outer try/catch, no-op
          }
          const topic = extractTopic(convPrompt);
          const convTags = extractConversationTags(convPrompt, memoryState.matchedSkillName || undefined);
          const channel = convPrompt.match(/\[WhatsApp|Mattermost|Discord/i)?.[0]?.replace('[','') || 'unknown';

          // Find existing active conversation with similar tags
          const recentConversations = udb.db.prepare(
            "SELECT id, thread_id, topic, tags, summary, message_count, details FROM conversations WHERE status = 'active' AND updated_at > datetime('now', '-2 hours') ORDER BY updated_at DESC LIMIT 5"
          ).all() as any[];

          let conversationId: number | null = null;
          let isNewConversation = true;

          for (const conv of recentConversations) {
            const existingTags: string[] = JSON.parse(conv.tags || '[]');
            const overlap = convTags.filter(t => existingTags.includes(t)).length;
            if (overlap >= 1 || conv.topic.toLowerCase().includes(topic.toLowerCase().slice(0, 20))) {
              conversationId = conv.id;
              isNewConversation = false;

              const newSummary = convResponse.length > 50
                ? convResponse.slice(0, 150).replace(/\n/g, ' ').trim()
                : conv.summary;

              udb.db.prepare(`
                UPDATE conversations
                SET summary = ?,
                    message_count = message_count + 1,
                    updated_at = CURRENT_TIMESTAMP,
                    last_accessed_at = CURRENT_TIMESTAMP,
                    tags = ?,
                    details = CASE WHEN length(details || '') < 2000
                      THEN (COALESCE(details, '') || char(10) || ?)
                      ELSE details END
                WHERE id = ?
              `).run(
                newSummary,
                JSON.stringify([...new Set([...existingTags, ...convTags])]),
                `[${new Date().toISOString().slice(11,16)}] ${topic.slice(0, 80)}`,
                conversationId
              );
              break;
            }
          }

          if (isNewConversation) {
            const threadId = generateThreadId(topic);
            const summary = convResponse.length > 50
              ? convResponse.slice(0, 150).replace(/\n/g, ' ').trim()
              : topic;

            const result = udb.db.prepare(`
              INSERT OR IGNORE INTO conversations (thread_id, topic, tags, channel, participants, summary, details, key_facts)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              threadId,
              topic.slice(0, 200),
              JSON.stringify(convTags),
              channel,
              JSON.stringify(['bartosz', 'wiki']),
              summary,
              `[${new Date().toISOString().slice(11,16)}] ${topic.slice(0, 200)}`,
              JSON.stringify([])
            );
            conversationId = result.lastInsertRowid as number;
          }

          if (conversationId) {
            const userSummary = convPrompt.slice(0, 200).replace(/\n/g, ' ').trim();
            const assistantSummary = convResponse.slice(0, 200).replace(/\n/g, ' ').trim();

            if (userSummary.length > 10) {
              udb.db.prepare(`
                INSERT INTO conversation_messages (conversation_id, role, content_summary, has_decision, has_action)
                VALUES (?, 'user', ?, ?, ?)
              `).run(conversationId, userSummary, isDecision(convPrompt) ? 1 : 0, isActionRequest(convPrompt) ? 1 : 0);
            }

            if (assistantSummary.length > 10) {
              udb.db.prepare(`
                INSERT INTO conversation_messages (conversation_id, role, content_summary, has_decision, has_action)
                VALUES (?, 'assistant', ?, ?, ?)
              `).run(conversationId, assistantSummary, isResolution(convResponse) ? 1 : 0, 0);
            }

            if (isResolution(convResponse) && isNewConversation) {
              udb.db.prepare("UPDATE conversations SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?")
                .run(conversationId);
            }
          }

          api.logger.info?.(`memory-unified: CONV ${isNewConversation ? 'NEW' : 'UPDATE'} thread=${conversationId} topic="${topic.slice(0,40)}" tags=${convTags.join(',')}`);
        }
      } catch (convErr) {
        api.logger.warn?.('memory-unified: conversation tracking error:', String(convErr));
      }

      // Trajectory end (Ruflo SONA)
      if (memoryState.activeTrajectoryId && ruflo) {
        try {
          await ruflo.trajectoryEnd(
            memoryState.activeTrajectoryId,
            success,
            memoryState.matchedSkillName ? `Skill: ${memoryState.matchedSkillName}` : "No skill matched"
          );
        } catch {}
      }

      api.logger.info?.(`memory-unified: turn ended (skill: ${memoryState.matchedSkillName ?? "none"}, success: ${success})`);
    } catch (err) {
      api.logger.warn?.("memory-unified: agent_end failed:", err);
    } finally {
      memoryState.activeTrajectoryId = null;
      memoryState.matchedSkillName = null;
      memoryState.matchedSkillId = null;
      memoryState.turnPrompt = null;
      memoryState.agentId = null;
      (globalThis as any).__openclawAgentId = undefined;
    }
  };
}