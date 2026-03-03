/**
 * migrate.ts — Migrate USMD SQLite skills to Ruflo HNSW
 *
 * Usage: npx ts-node migrate.ts [--db /path/to/skill-memory.db]
 *
 * Reads all skills from USMD SQLite and stores them in Ruflo HNSW
 * via the queue file mechanism (daemon picks them up).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";

const DEFAULT_DB = "/home/hermes/.openclaw/workspace/skill-memory.db";
const HNSW_QUEUE_DIR = "/home/hermes/.openclaw/workspace/.hnsw-queue";

interface Skill {
  id: number;
  name: string;
  category: string | null;
  description: string | null;
  procedure: string;
  tools_used: string | null;
  tags: string | null;
  use_count: number;
  success_rate: number;
}

function migrate(dbPath: string): void {
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const skills = db.prepare("SELECT * FROM skills ORDER BY name").all() as Skill[];

  if (!fs.existsSync(HNSW_QUEUE_DIR)) {
    fs.mkdirSync(HNSW_QUEUE_DIR, { recursive: true });
  }

  console.log(`Migrating ${skills.length} skills from USMD → Ruflo HNSW queue...`);

  let migrated = 0;
  for (const skill of skills) {
    // Create summary (20-30 tokens max)
    const summary = `${skill.name} [${skill.category ?? "other"}]: ${(skill.description ?? "").slice(0, 80)}`;

    // Create HNSW entry
    const entry = {
      key: `skill:${skill.name}`,
      value: JSON.stringify({
        name: skill.name,
        category: skill.category,
        summary,
        description: (skill.description ?? "").slice(0, 200),
        tools: skill.tools_used,
        useCount: skill.use_count,
        successRate: skill.success_rate,
        entryType: "skill",
      }),
      tags: [
        skill.name,
        skill.category ?? "other",
        "skill",
        "usmd-migrated",
        ...(skill.tags ? skill.tags.split(",").map((t: string) => t.trim()) : []),
      ],
      namespace: "unified",
      ts: Date.now(),
    };

    const filename = `${Date.now()}-skill-${skill.name.slice(0, 30)}.json`;
    fs.writeFileSync(path.join(HNSW_QUEUE_DIR, filename), JSON.stringify(entry));
    migrated++;

    // Also store the full procedure as a separate chunk
    if (skill.procedure && skill.procedure.length > 100) {
      const procEntry = {
        key: `procedure:${skill.name}`,
        value: JSON.stringify({
          name: skill.name,
          procedure: skill.procedure.slice(0, 2000),
          entryType: "protocol",
          summary: `Procedure for ${skill.name}: ${skill.procedure.slice(0, 80)}`,
        }),
        tags: [skill.name, "procedure", "protocol", skill.category ?? "other"],
        namespace: "unified",
        ts: Date.now() + 1,
      };
      const procFilename = `${Date.now()}-proc-${skill.name.slice(0, 30)}.json`;
      fs.writeFileSync(path.join(HNSW_QUEUE_DIR, procFilename), JSON.stringify(procEntry));
    }

    if (migrated % 50 === 0) console.log(`  ... ${migrated}/${skills.length}`);
  }

  db.close();
  console.log(`✓ Migrated ${migrated} skills to HNSW queue at ${HNSW_QUEUE_DIR}`);
  console.log(`  Run the HNSW daemon or 'openclaw ingest' to process the queue.`);
}

// CLI
const args = process.argv.slice(2);
const dbIdx = args.indexOf("--db");
const dbPath = dbIdx >= 0 && args[dbIdx + 1] ? args[dbIdx + 1] : DEFAULT_DB;
migrate(dbPath);
