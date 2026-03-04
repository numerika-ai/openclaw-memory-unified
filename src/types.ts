/**
 * Shared type definitions for memory-unified extension
 */

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
}

export interface PluginApi {
  pluginConfig?: Record<string, unknown>;
  resolvePath(input: string): string;
  logger: {
    info?(...args: unknown[]): void;
    warn?(...args: unknown[]): void;
    error?(...args: unknown[]): void;
  };
  registerTool(tool: ToolDef, opts?: { name?: string }): void;
  registerCli(handler: (ctx: { program: any }) => void, opts?: { commands: string[] }): void;
  registerService(svc: { id: string; start: () => void; stop: () => void }): void;
  on(hookName: string, handler: (event: Record<string, unknown>) => unknown, opts?: { priority?: number }): void;
}

export interface RufloHNSW {
  store(key: string, value: string | object, opts?: { tags?: string[]; namespace?: string }): Promise<void>;
  search(query: string, opts?: { limit?: number; threshold?: number; namespace?: string }): Promise<Array<{ key: string; value: any; similarity: number }>>;
  trajectoryStart(task: string, agent?: string): Promise<string>;
  trajectoryStep(trajectoryId: string, action: string, result: string, quality?: number): Promise<void>;
  trajectoryEnd(trajectoryId: string, success: boolean, feedback?: string): Promise<void>;
}

export interface UnifiedDB {
  searchEntries(entryType?: import("./config").EntryType, limit?: number): any[];
  ftsSearch(query: string, entryType?: import("./config").EntryType, limit?: number): any[];
  getEntryById?(id: number): any | undefined;
  storeEntry(params: {
    entryType: import("./config").EntryType;
    tags?: string;
    content: string;
    summary?: string;
    sourcePath?: string;
    hnswKey?: string;
    skillId?: number;
  }): number;
  getSkillByName(name: string): any | undefined;
  listSkills(category?: string): any[];
  getRecentExecutions(limit?: number): any[];
  close(): void;
  db: import("better-sqlite3").Database;
}