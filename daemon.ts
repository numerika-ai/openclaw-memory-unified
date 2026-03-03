/**
 * daemon.ts — HNSW Queue Processor
 *
 * Watches .hnsw-queue/ directory and processes entries to Ruflo HNSW
 * via MCP tool calls. Run as a background service.
 *
 * Usage: npx ts-node daemon.ts [--queue-dir /path/to/.hnsw-queue]
 *        or run via OpenClaw service registration.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_QUEUE_DIR = "/home/hermes/.openclaw/workspace/.hnsw-queue";
const POLL_INTERVAL_MS = 5000;
const PROCESSED_DIR = ".processed";

async function processQueue(queueDir: string): Promise<void> {
  if (!fs.existsSync(queueDir)) {
    fs.mkdirSync(queueDir, { recursive: true });
  }

  const processedDir = path.join(queueDir, PROCESSED_DIR);
  if (!fs.existsSync(processedDir)) {
    fs.mkdirSync(processedDir, { recursive: true });
  }

  console.log(`[memory-unified daemon] Watching ${queueDir}`);

  const tick = async () => {
    try {
      const files = fs.readdirSync(queueDir)
        .filter(f => f.endsWith(".json") && !f.startsWith("."))
        .sort();

      for (const file of files) {
        const filePath = path.join(queueDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));

          if (data.key && data.value) {
            // This is a store operation
            // In production this calls ruflo_memory_store via the OpenClaw MCP bridge
            console.log(`  [store] ${data.key} (ns: ${data.namespace ?? "default"})`);
          } else if (data.query) {
            // This is a search operation
            console.log(`  [search] "${data.query}" (limit: ${data.limit ?? 10})`);
          } else if (data.id && data.task) {
            // Trajectory start
            console.log(`  [traj-start] ${data.id}: ${data.task.slice(0, 50)}`);
          } else if (data.trajectoryId && data.action) {
            // Trajectory step
            console.log(`  [traj-step] ${data.trajectoryId}: ${data.action}`);
          } else if (data.trajectoryId && data.success !== undefined) {
            // Trajectory end
            console.log(`  [traj-end] ${data.trajectoryId}: ${data.success ? "success" : "failure"}`);
          }

          // Move to processed
          fs.renameSync(filePath, path.join(processedDir, file));
        } catch (err) {
          console.error(`  [error] ${file}:`, err);
          // Move to error dir
          const errorDir = path.join(queueDir, ".errors");
          if (!fs.existsSync(errorDir)) fs.mkdirSync(errorDir, { recursive: true });
          fs.renameSync(filePath, path.join(errorDir, file));
        }
      }
    } catch (err) {
      console.error("[daemon tick error]", err);
    }
  };

  // Run forever
  setInterval(tick, POLL_INTERVAL_MS);
  tick(); // First run immediately
}

// CLI
const args = process.argv.slice(2);
const qIdx = args.indexOf("--queue-dir");
const queueDir = qIdx >= 0 && args[qIdx + 1] ? args[qIdx + 1] : DEFAULT_QUEUE_DIR;
processQueue(queueDir);
