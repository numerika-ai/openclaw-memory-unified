/**
 * memory-unified plugin configuration
 */

const DEFAULT_DB_PATH = "skill-memory.db";
const ALLOWED_KEYS = ["dbPath", "backend", "postgresUrl", "embeddingUrl", "ragSlim", "logToolCalls", "logToolCallsFilter", "trajectoryTracking", "ragTopK", "memoryBank", "embeddingDim", "embeddingModel", "rerankUrl", "rerankEnabled"];

export interface UnifiedMemoryConfig {
  dbPath: string;
  backend: "sqlite" | "postgres";
  postgresUrl: string;
  ragSlim: boolean;
  logToolCalls: boolean;
  logToolCallsFilter: "all" | "none" | "whitelist" | string[];  // "all" = log everything, "none" = log nothing, "whitelist" = built-in, string[] = custom
  trajectoryTracking: boolean;
  ragTopK: number;
  embeddingUrl: string;
  embeddingDim: number;
  embeddingModel: string;
  rerankUrl: string;
  rerankEnabled: boolean;
  memoryBank?: {
    enabled: boolean;
    extractionModel: string;
    extractionUrl: string;
    extractionApiKey?: string;
    minConversationLength: number;
    consolidationThreshold: number;
    maxFactsPerTurn: number;
    ragTopK: number;
  };
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
        backend: "postgres" as const,
        postgresUrl: process.env.POSTGRES_URL ?? "postgresql://openclaw:OpenClaw2026%21@192.168.1.76:5432/openclaw_platform",
        ragSlim: true,
        logToolCalls: true,
        logToolCallsFilter: "whitelist",
        trajectoryTracking: true,
        ragTopK: 5,
        embeddingUrl: "http://localhost:8080/v1/embeddings",
        embeddingDim: 4096,
        embeddingModel: "Qwen/Qwen3-Embedding-8B",
        rerankUrl: "http://localhost:8082/rerank",
        rerankEnabled: true,
      };
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(cfg, ALLOWED_KEYS, "memory-unified config");

    const ragTopK = typeof cfg.ragTopK === "number" ? Math.floor(cfg.ragTopK) : 5;
    if (ragTopK < 1 || ragTopK > 20) throw new Error("ragTopK must be 1-20");

    // Parse memoryBank config with defaults
    let memoryBank: UnifiedMemoryConfig["memoryBank"] = undefined;
    if (cfg.memoryBank !== undefined) {
      const mb = (cfg.memoryBank && typeof cfg.memoryBank === "object" ? cfg.memoryBank : {}) as Record<string, unknown>;
      memoryBank = {
        enabled: mb.enabled !== false,
        extractionModel: typeof mb.extractionModel === "string" ? mb.extractionModel : "qwen3:32b",
        extractionUrl: typeof mb.extractionUrl === "string" ? mb.extractionUrl : "http://192.168.1.80:11434/v1/chat/completions",
        extractionApiKey: typeof mb.extractionApiKey === "string" ? mb.extractionApiKey : undefined,
        minConversationLength: typeof mb.minConversationLength === "number" ? mb.minConversationLength : 0,
        consolidationThreshold: typeof mb.consolidationThreshold === "number" ? mb.consolidationThreshold : 0.85,
        maxFactsPerTurn: typeof mb.maxFactsPerTurn === "number" ? mb.maxFactsPerTurn : 10,
        ragTopK: typeof mb.ragTopK === "number" ? mb.ragTopK : 5,
      };
    } else {
      // Default: enabled
      memoryBank = {
        enabled: true,
        extractionModel: "qwen3:32b",
        extractionUrl: "http://192.168.1.80:11434/v1/chat/completions",
        minConversationLength: 0,
        consolidationThreshold: 0.85,
        maxFactsPerTurn: 10,
        ragTopK: 5,
      };
    }

    // Parse logToolCallsFilter: "all", "none", string[], or default "whitelist" (uses built-in whitelist)
    let logToolCallsFilter: "all" | "none" | string[] = "whitelist" as any;
    if (cfg.logToolCallsFilter === "all" || cfg.logToolCallsFilter === "none") {
      logToolCallsFilter = cfg.logToolCallsFilter;
    } else if (Array.isArray(cfg.logToolCallsFilter)) {
      logToolCallsFilter = cfg.logToolCallsFilter as string[];
    }

    return {
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH,
      backend: (cfg.backend === "sqlite" ? "sqlite" : "postgres") as "sqlite" | "postgres",
      postgresUrl: typeof cfg.postgresUrl === "string" ? cfg.postgresUrl : (process.env.POSTGRES_URL ?? "postgresql://openclaw:OpenClaw2026%21@192.168.1.76:5432/openclaw_platform"),
      ragSlim: cfg.ragSlim !== false,
      logToolCalls: cfg.logToolCalls !== false,
      logToolCallsFilter,
      trajectoryTracking: cfg.trajectoryTracking !== false,
      ragTopK,
      embeddingUrl: typeof cfg.embeddingUrl === "string" ? cfg.embeddingUrl : "http://localhost:8080/v1/embeddings",
      embeddingDim: typeof cfg.embeddingDim === "number" ? cfg.embeddingDim : 4096,
      embeddingModel: typeof cfg.embeddingModel === "string" ? cfg.embeddingModel : "Qwen/Qwen3-Embedding-8B",
      rerankUrl: typeof cfg.rerankUrl === "string" ? cfg.rerankUrl : "http://localhost:8082/rerank",
      rerankEnabled: cfg.rerankEnabled !== false,
      memoryBank,
    };
  },
};
