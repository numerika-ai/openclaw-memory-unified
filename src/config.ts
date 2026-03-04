/**
 * memory-unified plugin configuration
 */

const DEFAULT_DB_PATH = "/home/hermes/.openclaw/workspace/skill-memory.db";
const ALLOWED_KEYS = ["dbPath", "ragSlim", "logToolCalls", "trajectoryTracking", "ragTopK"];

export interface UnifiedMemoryConfig {
  dbPath: string;
  ragSlim: boolean;
  logToolCalls: boolean;
  trajectoryTracking: boolean;
  ragTopK: number;
}

export const ENTRY_TYPES = [
  "skill",
  "protocol",
  "config",
  "history",
  "tool",
  "result",
  "task",
  "file",
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

function assertAllowedKeys(obj: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new Error(`Unknown ${label} key: "${key}". Allowed: ${allowed.join(", ")}`);
    }
  }
}

export const unifiedConfigSchema = {
  parse(value: unknown): UnifiedMemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        dbPath: DEFAULT_DB_PATH,
        ragSlim: true,
        logToolCalls: true,
        trajectoryTracking: true,
        ragTopK: 5,
      };
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(cfg, ALLOWED_KEYS, "memory-unified config");

    const ragTopK = typeof cfg.ragTopK === "number" ? Math.floor(cfg.ragTopK) : 5;
    if (ragTopK < 1 || ragTopK > 20) throw new Error("ragTopK must be 1-20");

    return {
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH,
      ragSlim: cfg.ragSlim !== false,
      logToolCalls: cfg.logToolCalls !== false,
      trajectoryTracking: cfg.trajectoryTracking !== false,
      ragTopK,
    };
  },
};
