/**
 * Utility functions for memory-unified extension
 */

/**
 * Chunking utility for CLI ingest
 */
export function chunkText(text: string, maxTokens = 500): string[] {
  // Approximate: 1 token ≈ 4 chars
  const maxChars = maxTokens * 4;
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function autoTag(text: string): string[] {
  const tags: string[] = [];
  if (/\bfunction\b|\bclass\b|\bimport\b|\bexport\b/i.test(text)) tags.push("code");
  if (/\bstep\s+\d/i.test(text) || /procedure|workflow/i.test(text)) tags.push("procedure");
  if (/\bconfig|\.env|settings|parameter/i.test(text)) tags.push("config");
  if (/\btest|assert|expect|jest|vitest/i.test(text)) tags.push("testing");
  if (/\bdocker|deploy|ci\/cd|kubernetes/i.test(text)) tags.push("devops");
  if (/\bapi|endpoint|route|http/i.test(text)) tags.push("api");
  if (/\bsecurity|auth|token|encrypt/i.test(text)) tags.push("security");
  if (tags.length === 0) tags.push("general");
  return tags;
}

export function summarize(text: string, maxTokens = 25): string {
  // Ultra-slim: first sentence or first N chars
  const firstSentence = text.match(/^[^\n.!?]*[.!?]/);
  const raw = firstSentence ? firstSentence[0] : text.slice(0, maxTokens * 4);
  return raw.slice(0, maxTokens * 4).trim();
}

// ============================================================================
// Pattern Learning Helpers - Phase 1
// ============================================================================

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one',
  'our', 'out', 'day', 'had', 'has', 'his', 'how', 'its', 'may', 'new', 'now', 'old',
  'see', 'way', 'who', 'did', 'get', 'let', 'say', 'she', 'too', 'use', 'from', 'this',
  'that', 'with', 'have', 'will', 'been', 'what', 'when', 'where', 'which', 'there',
  'their', 'them', 'then', 'than', 'these', 'those', 'some', 'other', 'about', 'into',
  'your', 'just', 'also', 'more', 'would', 'could', 'should', 'each', 'make', 'like',
  'nie', 'tak', 'jest', 'ale', 'czy', 'jak', 'ten', 'tam', 'dla', 'pod', 'nad',
  'bez', 'przez', 'przy', 'przed', 'tylko', 'jeszcze', 'tego', 'jako', 'jego',
  'może', 'mam', 'masz', 'żeby', 'albo', 'teraz', 'sobie', 'tutaj', 'jakie', 'kiedy',
  'więc', 'coś', 'będzie', 'bardzo', 'dobra', 'dobrze', 'proszę', 'działa', 'trzeba',
  'można', 'chcę', 'mogę', 'musisz', 'zrób', 'sprawdź',
  'system', 'utc', 'whatsapp', 'gateway', 'connected', 'please', 'thanks', 'hello',
  'agent', 'tool', 'result', 'content', 'text', 'data', 'file', 'name', 'type',
]);

export function extractKeywords(text: string): string[] {
  if (!text) return [];
  return [...new Set(
    (text.toLowerCase().match(/[a-ząćęłńóśźż]{3,}/g) || [])
      .filter(w => !STOP_WORDS.has(w))
      .slice(0, 10)
  )];
}

// ============================================================================
// Conversation Tracking Helpers - Phase 5
// ============================================================================

export function generateThreadId(topic: string): string {
  const date = new Date().toISOString().split('T')[0];
  const slug = topic.toLowerCase()
    .replace(/[^a-z\u0105\u0107\u0119\u0142\u0144\u00f3\u015b\u017a\u017c0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${date}:${slug}`;
}

export function extractTopic(prompt: string): string {
  let clean = prompt;
  // Strip WhatsApp/audio metadata
  clean = clean.replace(/\[Audio\]\s*/gi, '');
  clean = clean.replace(/User text:\s*/gi, '');
  clean = clean.replace(/\[WhatsApp\s+[^\]]*\]\s*(<media:\w+>)?\s*/gi, '');
  clean = clean.replace(/Transcript:\s*/gi, '');
  // Strip system/cron/subagent prefixes
  clean = clean.replace(/^System:\s*\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/i, '');
  clean = clean.replace(/^\s*\[?cron:[a-f0-9-]+\s+[\w-]+\]?\s*/i, '');
  clean = clean.replace(/^\s*\[Subagent Context\][^.]*\.\s*/i, '');
  // Strip remaining bracket metadata
  clean = clean.replace(/\[.*?\]/g, '');
  clean = clean.trim();
  if (clean.length < 5) return 'misc';
  if (clean.length <= 60) return clean;
  const firstSentence = clean.match(/^[^.!?\n]+[.!?]?/)?.[0];
  return (firstSentence || clean.slice(0, 60)).trim();
}

export function extractConversationTags(prompt: string, matchedSkill?: string): string[] {
  const tags: string[] = [];
  if (matchedSkill) tags.push(matchedSkill);

  const domains: [string, RegExp][] = [
    ['memory', /memo|pami\u0119\u0107|hnsw|embed|vector|baz[aey] dan/i],
    ['trading', /trad|bot|hyperliquid|binance|pnl|spread|arbitr/i],
    ['infrastructure', /docker|systemd|ram|cpu|spark|tank|server|nginx/i],
    ['openclaw', /openclaw|gateway|plugin|config|restart|kompak/i],
    ['tts', /g\u0142os\u00f3w|voice|piper|radio|audycj|tts/i],
    ['coding', /kod|code|claude|script|html|typescript|python/i],
    ['task', /task|focalboard|kanban|sprint|priory/i],
  ];
  for (const [tag, re] of domains) {
    if (re.test(prompt)) tags.push(tag);
  }
  return [...new Set(tags)].slice(0, 5);
}

export function isActionRequest(text: string): boolean {
  return /zr\u00f3b|stw\u00f3rz|sprawdź|wyłącz|włącz|zapisz|dodaj|usuń|napraw|wdro\u017c|odpal|uruchom|zatrzymaj|wy\u015blij/i.test(text);
}

export function isDecision(text: string): boolean {
  return /zdecydowa\u0142|decyzja|robimy|wybieramy|plan:|zatwierdzam|ok ruszaj|tak prosz\u0119|lecimy/i.test(text);
}

export function isResolution(text: string): boolean {
  return /\u2705|done|gotowe|zrobione|zako\u0144czon|wdro\u017con|naprawion/i.test(text);
}

/**
 * Extract agent ID from an OpenClaw session key pattern like "agent:AGENT_ID:..."
 * Returns undefined if the pattern doesn't match.
 */
export function extractAgentFromSessionKey(sessionKey: string | undefined | null): string | undefined {
  if (!sessionKey) return undefined;
  const match = sessionKey.match(/^agent:([^:]+)/);
  return match?.[1] || undefined;
}