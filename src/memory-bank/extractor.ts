/**
 * Memory Bank fact extractor — calls Ollama (Spark) to extract facts from conversations
 */

import type { MemoryBankConfig, ExtractedFact, TemporalType } from "./types";
import { DEFAULT_TOPICS } from "./topics";

const VALID_TOPICS = new Set(DEFAULT_TOPICS.map(t => t.name));
const VALID_TEMPORAL_TYPES = new Set<TemporalType>(["current_state", "historical", "permanent"]);

const EXTRACTION_PROMPT = `You are a memory extraction system. Analyze the conversation below and extract key facts worth remembering long-term.

For each fact, output a JSON array of objects with these fields:
- "fact": A concise, standalone statement (one sentence)
- "topic": One of: user_preferences, technical_facts, project_context, instructions, people_orgs, decisions, learned_patterns
- "confidence": 0.0-1.0 how confident you are this is a real, stable fact
- "temporal_type": One of: "current_state", "historical", "permanent"

Temporal type rules:
- "current_state": Facts about the CURRENT STATE of things (active projects, current configs, current preferences). Confidence 0.9+
- "historical": Facts that WERE true but may have changed (past decisions, old configs, previous approaches). Confidence 0.6-0.7
- "permanent": Timeless facts unlikely to change (person's name, organization structure, fundamental rules). Confidence 0.85+

Rules:
- Only extract facts that would be useful in future conversations
- Skip ephemeral details (timestamps, transient errors, greetings)
- Each fact must be self-contained and understandable without context
- Prefer fewer high-quality facts over many low-quality ones
- Output ONLY a JSON array, no other text

Conversation:
`;

export async function extractFacts(
  conversationText: string,
  config: MemoryBankConfig,
): Promise<ExtractedFact[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

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

    const body = isAnthropic
      ? JSON.stringify({
          model: config.extractionModel,
          messages: [{ role: "user", content: EXTRACTION_PROMPT + conversationText.slice(0, 4000) }],
          temperature: 0.3,
          max_tokens: 2000,
        })
      : JSON.stringify({
          model: config.extractionModel,
          messages: [{ role: "user", content: EXTRACTION_PROMPT + conversationText.slice(0, 4000) }],
          temperature: 0.3,
          max_tokens: 2000,
        });

    const resp = await fetch(config.extractionUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) return [];

    const data = (await resp.json()) as any;
    // Support both OpenAI-compatible and Anthropic response formats
    const content = isAnthropic
      ? (data?.content?.[0]?.text ?? "")
      : (data?.choices?.[0]?.message?.content ?? "");

    // Extract JSON array from response (may have markdown fences)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as unknown[];
    if (!Array.isArray(parsed)) return [];

    const facts: ExtractedFact[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;

      const fact = typeof obj.fact === "string" ? obj.fact.trim() : "";
      let topic = typeof obj.topic === "string" ? obj.topic.trim() : "learned_patterns";
      const confidence = typeof obj.confidence === "number" ? Math.min(1, Math.max(0, obj.confidence)) : 0.5;
      let temporalType = typeof obj.temporal_type === "string" ? obj.temporal_type.trim() as TemporalType : "current_state";

      if (!fact || fact.length < 10) continue;

      // Validate topic, fallback to learned_patterns
      if (!VALID_TOPICS.has(topic)) topic = "learned_patterns";

      // Validate temporal_type, fallback to current_state
      if (!VALID_TEMPORAL_TYPES.has(temporalType)) temporalType = "current_state";

      facts.push({ fact, topic, confidence, temporal_type: temporalType });

      if (facts.length >= config.maxFactsPerTurn) break;
    }

    return facts;
  } catch {
    // Ollama unreachable or parse error — graceful fallback
    return [];
  }
}
