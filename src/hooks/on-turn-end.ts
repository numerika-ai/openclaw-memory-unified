import type { PluginApi } from "../types";
import type { DatabasePort } from "../db/port";
import type { UnifiedMemoryConfig } from "../config";
import type { MemoryBankConfig } from "../memory-bank/types";
import { autoTag } from "../utils/helpers";
import {
  extractKeywords,
  extractTopic,
  extractConversationTags,
  generateThreadId,
  isDecision,
  isActionRequest,
  isResolution,
  extractAgentFromSessionKey
} from "../utils/helpers";
import { extractFacts } from "../memory-bank/extractor";
import { consolidateFact } from "../memory-bank/consolidator";
import { extractAndLinkEntities } from "../entity/extractor";

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
  port: DatabasePort;
  lanceManager: NativeLanceManager | null;
  cfg: UnifiedMemoryConfig;
  memoryState: MemoryState;
  memoryBankConfig?: MemoryBankConfig;
}

/**
 * Tools worth logging — everything else (exec, read, write, process, web_fetch) is noise.
 * These tools carry decision/routing/config information that improves RAG quality.
 */
const TOOL_LOG_WHITELIST = new Set([
  "sessions_spawn",      // MoE routing decisions
  "message",             // communication decisions
  "gateway",             // config changes
  "cron",                // scheduled task changes
  "unified_store",       // explicit memory stores
  "unified_search",      // search queries reveal intent
  "memory_bank_manage",  // memory management decisions
  "web_search",          // external search queries
  "web_fetch",           // external data fetches
  "unified_reflect",     // synthesis queries (v2.0)
]);

/**
 * Creates the tool call logging hook for after_tool_call
 */
export function createToolCallLogHook(deps: HookDependencies) {
  const { port, lanceManager, cfg, memoryState } = deps;

  // Resolve filter: config can override with "all", "none", or string[] of tool names
  const filterCfg = (cfg as any).logToolCallsFilter;
  const useWhitelist = filterCfg === "all" ? false
    : filterCfg === "none" ? true  // "none" means log nothing extra
    : Array.isArray(filterCfg) ? false
    : true; // default: use whitelist
  const customFilter: Set<string> | null = Array.isArray(filterCfg)
    ? new Set(filterCfg as string[])
    : null;

  return async function(api: PluginApi, event: Record<string, unknown>) {
    try {
      // OpenClaw may pass tool info in different field names
      const toolName = (event.toolName ?? event.name ?? event.tool ?? "unknown") as string;
      const params = (event.params ?? event.arguments ?? event.input) as Record<string, unknown> | undefined;
      const result = (event.result ?? event.output ?? "") as string;
      const error = (event.error ?? event.err) as string | undefined;

      // Skip our own tools and internal tools.
      // Allow whitelisted unified_* tools (unified_store/search/reflect carry user intent
      // and were in TOOL_LOG_WHITELIST but silently dropped before this guard).
      if (toolName.startsWith("skill_") || toolName === "artifact_register") return;
      if (toolName.startsWith("unified_") && !TOOL_LOG_WHITELIST.has(toolName)) return;
      if (toolName === "unknown") return;

      // Smart filtering: only log whitelisted tools (95% noise reduction)
      if (filterCfg === "none") return;
      if (customFilter && !customFilter.has(toolName)) return;
      if (useWhitelist && !TOOL_LOG_WHITELIST.has(toolName)) return;

      const paramsPreview = params ? JSON.stringify(params).slice(0, 300) : "";
      const resultStr = typeof result === "string" ? result : JSON.stringify(result ?? "");
      const resultPreview = error ? `ERROR: ${error}`.slice(0, 200) : resultStr.slice(0, 200);
      const status = error ? "error" : "success";

      // Store in unified_entries via port
      const tags = autoTag(`${toolName} ${paramsPreview}`);
      const summary = `${toolName}(${status}): ${paramsPreview.slice(0, 80)}`;
      const hnswKey = `tool:${toolName}:${Date.now()}`;

      const agentId = (event.agentId ?? event.agent_id ?? (globalThis as any).__openclawAgentId ?? extractAgentFromSessionKey(event.sessionKey as string | undefined) ?? "main") as string;
      const toolEntryId = await port.storeEntry({
        entryType: "tool",
        tags: tags.join(","),
        content: JSON.stringify({ tool: toolName, params: paramsPreview, result: resultPreview, status }),
        summary,
        hnswKey,
        agentId,
      });

      // Native HNSW indexing (fire and forget, don't block agent)
      if (lanceManager?.isReady()) {
        lanceManager.addEntry(toolEntryId, summary).catch(() => {});
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
  const { port, cfg, memoryState, memoryBankConfig } = deps;

  return async function(api: PluginApi, event: Record<string, unknown>) {
    // Always clear dynamic tool policy — prevent stale policies across turns
    (globalThis as any).__openclawDynamicToolPolicy = undefined;

    const gg = globalThis as any;
    const sessionKey = (event.sessionKey as string | undefined) ?? "unknown";

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

          await port.logSkillExecution(
            memoryState.matchedSkillId,
            summary,
            success ? "success" : "error",
            responsePreview.slice(0, 1000),
            (event.sessionKey as string) ?? "unknown"
          );

          await port.updateSkillStats(memoryState.matchedSkillId, success);

          api.logger.info?.(`memory-unified: logged execution for skill "${memoryState.matchedSkillName}" (${success ? "success" : "error"})`);

          // ============================================================
          // PATTERN EXTRACTION (Phase 1)
          // ============================================================
          try {
            const keywords = extractKeywords(memoryState.turnPrompt || "");
            if (keywords.length >= 3) {
              const keywordsJson = JSON.stringify(keywords.sort());

              const existingPatterns = await port.queryPatterns({
                skillName: memoryState.matchedSkillName,
                keywords: keywordsJson,
              });
              const existing = existingPatterns[0] as { id: number; confidence: number; success_count: number } | undefined;

              if (existing) {
                const newConf = Math.min(0.95, existing.confidence + 0.03);
                await port.updatePatternSuccess(existing.id, newConf);
                await port.logPatternHistory(existing.id, "success", existing.confidence, newConf, (memoryState.turnPrompt || "").slice(0, 200));
                api.logger.info?.(`memory-unified: pattern boosted for "${memoryState.matchedSkillName}" (${existing.confidence.toFixed(2)} -> ${newConf.toFixed(2)})`);
              } else {
                const patternId = await port.createPattern(memoryState.matchedSkillName, keywordsJson, 0.5);
                await port.logPatternHistory(patternId, "created", 0, 0.5, (memoryState.turnPrompt || "").slice(0, 200));
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
          const failPatterns = await port.queryPatterns({ skillName: memoryState.matchedSkillName });

          for (const p of failPatterns) {
            const newConf = Math.max(0.05, p.confidence - 0.05);
            await port.updatePatternFailure(p.id, newConf);
            await port.logPatternHistory(p.id, "failure", p.confidence, newConf);
          }

          if (failPatterns.length > 0) {
            api.logger.info?.(`memory-unified: reduced confidence for ${failPatterns.length} patterns of "${memoryState.matchedSkillName}" (failure)`);
          }
        } catch (failPatErr) {
          api.logger.warn?.("memory-unified: pattern failure update failed:", failPatErr);
        }
      }

      // Resolve turnPrompt — prefer local memoryState, fall back to globalThis
      // session-keyed map (set by rag-injection; survives cross-context plugin instances).
      const turnPromptFromGlobal = gg.__openclawTurnPromptBySession?.[sessionKey];
      const resolvedTurnPrompt = memoryState.turnPrompt || turnPromptFromGlobal || "";

      // ============================================================
      // CONVERSATION TRACKING (Phase 5)
      // ============================================================
      try {
        const convPrompt = resolvedTurnPrompt;
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
          const recentConversations = await port.queryConversations({
            status: 'active',
            recentHours: 2,
            limit: 5,
          });

          let conversationId: number | null = null;
          let isNewConversation = true;

          for (const conv of recentConversations) {
            const existingTags: string[] = JSON.parse(conv.tags || '[]');
            const overlap = convTags.filter((t: string) => existingTags.includes(t)).length;
            // P6 fix: require overlap >= 2 to avoid over-merging conversations
            if (overlap >= 2 || conv.topic.toLowerCase().includes(topic.toLowerCase().slice(0, 20))) {
              conversationId = conv.id as number;
              isNewConversation = false;

              const newSummary = convResponse.length > 50
                ? convResponse.slice(0, 150).replace(/\n/g, ' ').trim()
                : conv.summary;

              await port.updateConversation(conversationId!, {
                summary: newSummary,
                tags: JSON.stringify([...new Set([...existingTags, ...convTags])]),
                incrementMessageCount: true,
                details: `[${new Date().toISOString().slice(11,16)}] ${topic.slice(0, 80)}`,
              });
              break;
            }
          }

          if (isNewConversation) {
            const threadId = generateThreadId(topic);
            const summary = convResponse.length > 50
              ? convResponse.slice(0, 150).replace(/\n/g, ' ').trim()
              : topic;

            conversationId = await port.createConversation({
              threadId,
              topic: topic.slice(0, 200),
              tags: JSON.stringify(convTags),
              channel,
              participants: JSON.stringify(['bartosz', 'wiki']),
              summary,
              details: `[${new Date().toISOString().slice(11,16)}] ${topic.slice(0, 200)}`,
              keyFacts: JSON.stringify([]),
            });
          }

          if (conversationId != null) {
            const cid = conversationId;
            const userSummary = convPrompt.slice(0, 200).replace(/\n/g, ' ').trim();
            const assistantSummary = convResponse.slice(0, 200).replace(/\n/g, ' ').trim();

            if (userSummary.length > 10) {
              await port.addConversationMessage(cid, 'user', userSummary, isDecision(convPrompt), isActionRequest(convPrompt));
            }

            if (assistantSummary.length > 10) {
              await port.addConversationMessage(cid, 'assistant', assistantSummary, isResolution(convResponse), false);
            }

            if (isResolution(convResponse) && isNewConversation) {
              await port.resolveConversation(cid);
            }
          }

          api.logger.info?.(`memory-unified: CONV ${isNewConversation ? 'NEW' : 'UPDATE'} thread=${conversationId} topic="${topic.slice(0,40)}" tags=${convTags.join(',')}`);
        }
      } catch (convErr) {
        api.logger.warn?.('memory-unified: conversation tracking error:', String(convErr));
      }

      // ============================================================
      // MEMORY BANK EXTRACTION (fire and forget)
      // ============================================================
      if (memoryBankConfig?.enabled) {
        try {
          const mbPrompt = resolvedTurnPrompt;
          const mbResponse = responsePreview || "";
          const conversationText = `User: ${mbPrompt}\nAssistant: ${mbResponse}`;

          // Skip if too short or cron/heartbeat
          const isCron = /^\s*\[?cron:|HEARTBEAT_OK|\[Subagent Context\]|Auto-handoff check/i.test(mbPrompt);
          if (!isCron && conversationText.length >= memoryBankConfig.minConversationLength) {
            const factScope = memoryState.agentId && memoryState.agentId !== "main" ? memoryState.agentId : "global";

            extractFacts(conversationText, memoryBankConfig)
              .then(async (facts) => {
                for (const fact of facts) {
                  try {
                    await consolidateFact(fact, port, memoryBankConfig, null, api.logger, factScope);
                  } catch (consErr) {
                    api.logger.warn?.("memory-bank: consolidation error:", String(consErr).slice(0, 100));
                  }
                }
                if (facts.length > 0) {
                  api.logger.info?.(`memory-bank: extracted ${facts.length} facts from conversation`);
                }
                // Entity extraction (v2.0 — fire and forget)
                try {
                  await extractAndLinkEntities(conversationText, port, memoryBankConfig, api.logger);
                } catch (entErr) {
                  api.logger.warn?.("memory-bank: entity extraction error:", String(entErr).slice(0, 100));
                }
              })
              .catch((exErr) => {
                api.logger.warn?.("memory-bank: extraction error:", String(exErr).slice(0, 100));
              });
          }
        } catch (mbErr) {
          api.logger.warn?.("memory-bank: memory bank error:", String(mbErr).slice(0, 100));
        }
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
      (globalThis as any).__openclawSessionKey = undefined;
      // Also clean the session-keyed turnPrompt map to avoid stale carry-over.
      if (gg.__openclawTurnPromptBySession && sessionKey) {
        delete gg.__openclawTurnPromptBySession[sessionKey];
      }
    }
  };
}

/**
 * Creates the before_compaction hook.
 * Extracts lessons learned and critical mistakes from the conversation
 * being compacted so they're not lost when context is trimmed.
 */
export function createCompactionHook(deps: HookDependencies) {
  const { port, memoryState, memoryBankConfig } = deps;

  return async function(api: PluginApi, event: Record<string, unknown>) {
    if (!memoryBankConfig?.enabled) return;

    try {
      const messages = event.messages as Array<{ role: string; content: string }> | undefined;
      if (!messages || messages.length < 2) return;

      // Build conversation text from messages being compacted
      const conversationText = messages
        .map(m => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 1000) : ""}`)
        .join("\n")
        .slice(0, 8000);

      if (conversationText.length < 100) return;

      // Use a specialized extraction prompt focused on lessons and mistakes
      const lessonConfig: MemoryBankConfig = {
        ...memoryBankConfig,
        maxFactsPerTurn: 5,
      };

      const facts = await extractLessonsFromCompaction(conversationText, lessonConfig);
      const factScope = memoryState.agentId ?? "global";

      let stored = 0;
      for (const fact of facts) {
        try {
          await consolidateFact(fact, port, memoryBankConfig, null, api.logger, factScope);
          stored++;
        } catch (consErr) {
          api.logger.warn?.("memory-bank: compaction consolidation error:", String(consErr).slice(0, 100));
        }
      }

      if (stored > 0) {
        api.logger.info?.(`memory-bank: extracted ${stored} lessons from compaction (${messages.length} messages)`);
      }
    } catch (compErr) {
      api.logger.warn?.("memory-bank: compaction extraction error:", String(compErr).slice(0, 100));
    }
  };
}

/**
 * Extract lessons/mistakes/rules from a conversation being compacted.
 * Uses a specialized prompt focused on errors, corrections, and "don't do X" patterns.
 */
async function extractLessonsFromCompaction(
  conversationText: string,
  config: MemoryBankConfig,
): Promise<import("../memory-bank/types").ExtractedFact[]> {
  const LESSON_PROMPT = `You are a lesson extraction system. Analyze this conversation and extract ONLY lessons learned, mistakes made, corrections given, and rules established. Focus on:
- Errors the assistant made and what the correct approach should be
- "Don't do X" / "Never do Y" rules
- Corrections from the user about wrong approaches
- Important guardrails or constraints discovered during the conversation

For each lesson, output a JSON array with:
- "fact": A clear, imperative statement (e.g., "Never restart the gateway directly — use the Wiki restart procedure")
- "topic": "lessons_learned"
- "confidence": 0.9 (high — these are explicitly stated corrections)
- "temporal_type": "permanent"

Rules:
- ONLY extract mistakes, corrections, and rules — skip normal conversation
- If no lessons/mistakes found, output an empty array []
- Output ONLY a JSON array

Conversation:
`;

  try {
    const isAnthropic = config.extractionUrl.includes("anthropic.com");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.extractionApiKey) {
      if (isAnthropic) {
        headers["x-api-key"] = config.extractionApiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["Authorization"] = `Bearer ${config.extractionApiKey}`;
      }
    }

    const resp = await fetch(config.extractionUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.extractionModel,
        messages: [{ role: "user", content: LESSON_PROMPT + conversationText.slice(0, 6000) }],
        temperature: 0.2,
        max_tokens: 1500,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) return [];

    const data = (await resp.json()) as any;
    const content = isAnthropic
      ? (data?.content?.[0]?.text ?? "")
      : (data?.choices?.[0]?.message?.content ?? "");

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as unknown[];
    if (!Array.isArray(parsed)) return [];

    const facts: import("../memory-bank/types").ExtractedFact[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const fact = typeof obj.fact === "string" ? obj.fact.trim() : "";
      if (!fact || fact.length < 10) continue;

      facts.push({
        fact,
        topic: "lessons_learned",
        confidence: typeof obj.confidence === "number" ? Math.min(1, Math.max(0.5, obj.confidence)) : 0.9,
        temporal_type: "permanent",
      });

      if (facts.length >= config.maxFactsPerTurn) break;
    }

    return facts;
  } catch {
    return [];
  }
}
