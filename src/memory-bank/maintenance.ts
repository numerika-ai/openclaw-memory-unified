/**
 * Memory Bank maintenance — TTL enforcement + confidence decay
 *
 * Called on plugin startup and can be triggered periodically.
 */

import type { Database } from "better-sqlite3";

interface Logger {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
}

interface MaintenanceResult {
  expired: number;
  decayed: number;
}

/**
 * Run all maintenance tasks: TTL expiry + confidence decay.
 */
export function runMaintenance(db: Database, logger: Logger): MaintenanceResult {
  const expired = expireFacts(db, logger);
  const decayed = decayConfidence(db, logger);
  const gcPatterns = cleanupPatterns(db, logger);
  if (expired > 0 || decayed > 0 || gcPatterns > 0) {
    logger.info?.(`memory-bank maintenance: expired=${expired}, decayed=${decayed}, patternsGC=${gcPatterns}`);
  }
  return { expired, decayed };
}

/**
 * Clean up low-confidence stale patterns.
 * Deletes patterns with confidence < 0.1 that haven't been updated in 30+ days.
 */
function cleanupPatterns(db: Database, logger: Logger): number {
  try {
    const result = db.prepare(
      "DELETE FROM patterns WHERE confidence < 0.1 AND updated_at < datetime('now', '-30 days')"
    ).run();
    const deleted = result.changes;
    if (deleted > 0) {
      logger.info?.(`memory-bank: GC'd ${deleted} stale patterns`);
    }
    return deleted;
  } catch {
    return 0;
  }
}

/**
 * Expire facts where created_at + ttl_days < now.
 * Sets expired_at, status='archived', and logs revision.
 */
function expireFacts(db: Database, logger: Logger): number {
  // Find facts that have exceeded their TTL
  const expiredFacts = db.prepare(`
    SELECT id, fact, topic, ttl_days FROM memory_facts
    WHERE status = 'active'
      AND ttl_days IS NOT NULL
      AND expired_at IS NULL
      AND julianday('now') - julianday(created_at) > ttl_days
  `).all() as Array<{ id: number; fact: string; topic: string; ttl_days: number }>;

  if (expiredFacts.length === 0) return 0;

  const updateStmt = db.prepare(
    "UPDATE memory_facts SET status = 'archived', expired_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  );
  const revisionStmt = db.prepare(
    "INSERT INTO memory_revisions (fact_id, revision_type, old_content, new_content, reason) VALUES (?, 'expired', ?, NULL, ?)"
  );

  const txn = db.transaction(() => {
    for (const fact of expiredFacts) {
      updateStmt.run(fact.id);
      revisionStmt.run(fact.id, fact.fact, `TTL expired (${fact.ttl_days} days)`);
    }
  });
  txn();

  logger.info?.(`memory-bank: expired ${expiredFacts.length} facts past TTL`);
  return expiredFacts.length;
}

/**
 * Apply confidence decay to facts not recently accessed.
 *
 * - >7 days since last access: confidence *= 0.99
 * - >30 days since last access: confidence *= 0.95
 * - Topics with ttl_days=NULL (infinite TTL): decay 2x slower
 * - Never decay below 0.3
 */
function decayConfidence(db: Database, logger: Logger): number {
  // Get all active facts that haven't been accessed recently
  const facts = db.prepare(`
    SELECT f.id, f.confidence, f.last_accessed_at, f.created_at, f.ttl_days,
           t.ttl_days AS topic_ttl_days
    FROM memory_facts f
    LEFT JOIN memory_topics t ON f.topic = t.name
    WHERE f.status = 'active'
      AND f.confidence > 0.3
  `).all() as Array<{
    id: number;
    confidence: number;
    last_accessed_at: string | null;
    created_at: string;
    ttl_days: number | null;
    topic_ttl_days: number | null;
  }>;

  const now = Date.now();
  const DAY_MS = 86400000;
  let decayCount = 0;

  const updateStmt = db.prepare(
    "UPDATE memory_facts SET confidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  );
  const revisionStmt = db.prepare(
    "INSERT INTO memory_revisions (fact_id, revision_type, old_content, new_content, reason) VALUES (?, 'decay', NULL, NULL, ?)"
  );

  const txn = db.transaction(() => {
    for (const fact of facts) {
      const lastAccess = fact.last_accessed_at ? new Date(fact.last_accessed_at).getTime() : new Date(fact.created_at).getTime();
      const daysSinceAccess = (now - lastAccess) / DAY_MS;

      // Determine if this topic has infinite TTL (decay slower)
      const isInfiniteTtl = fact.ttl_days === null && fact.topic_ttl_days === null;

      let decayFactor = 1.0;
      if (daysSinceAccess > 30) {
        decayFactor = isInfiniteTtl ? 0.975 : 0.95; // 2x slower for infinite TTL
      } else if (daysSinceAccess > 7) {
        decayFactor = isInfiniteTtl ? 0.995 : 0.99; // 2x slower for infinite TTL
      }

      if (decayFactor < 1.0) {
        const newConf = Math.max(0.3, fact.confidence * decayFactor);
        if (Math.abs(newConf - fact.confidence) > 0.001) {
          updateStmt.run(newConf, fact.id);
          revisionStmt.run(fact.id, `confidence decay ${fact.confidence.toFixed(3)} -> ${newConf.toFixed(3)} (${daysSinceAccess.toFixed(0)}d since access${isInfiniteTtl ? ", slow decay" : ""})`);
          decayCount++;
        }
      }
    }
  });
  txn();

  if (decayCount > 0) {
    logger.info?.(`memory-bank: decayed confidence for ${decayCount} facts`);
  }
  return decayCount;
}
