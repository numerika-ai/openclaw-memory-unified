#!/usr/bin/env python3
"""
Memory Graph Dashboard API — Flask micro-API for live memory visualization.
Serves entity graph, facts, stats, and timeline from PostgreSQL.
Port: 8091
"""

import os
import json
from datetime import datetime
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import psycopg2
import psycopg2.extras

DASHBOARD_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=DASHBOARD_DIR)
CORS(app)


@app.route("/")
def serve_dashboard():
    """Serve the dashboard HTML at root."""
    return send_from_directory(DASHBOARD_DIR, "index.html")

DB_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://openclaw:OpenClaw2026!@localhost:5432/openclaw_platform"
)

def get_conn():
    return psycopg2.connect(DB_URL)

@app.route("/api/graph")
def graph():
    """Knowledge graph — nodes (entities) + edges (relations)."""
    conn = get_conn()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Nodes: entities with mention counts
    cur.execute("""
        SELECT e.id, e.name, e.entity_type, e.aliases,
               COALESCE(mc.cnt, 0) as mention_count,
               e.created_at
        FROM openclaw.agent_entities e
        LEFT JOIN (
            SELECT entity_id, COUNT(*) as cnt
            FROM openclaw.agent_entity_mentions
            GROUP BY entity_id
        ) mc ON mc.entity_id = e.id
        ORDER BY mc.cnt DESC NULLS LAST
        LIMIT 500
    """)
    entities = cur.fetchall()

    nodes = []
    for e in entities:
        nodes.append({
            "id": e["id"],
            "label": e["name"],
            "type": e["entity_type"],
            "group": e["entity_type"],
            "size": max(10, min(50, 10 + (e["mention_count"] or 0) * 3)),
            "mentions": e["mention_count"] or 0,
            "aliases": e["aliases"] or [],
            "created": e["created_at"].isoformat() if e["created_at"] else None,
        })

    # Edges: relations
    cur.execute("""
        SELECT r.id, r.source_entity_id as "from", r.target_entity_id as "to",
               r.relation_type, r.confidence,
               se.name as source_name, te.name as target_name
        FROM openclaw.agent_entity_relations r
        JOIN openclaw.agent_entities se ON se.id = r.source_entity_id
        JOIN openclaw.agent_entities te ON te.id = r.target_entity_id
        ORDER BY r.confidence DESC
        LIMIT 1000
    """)
    relations = cur.fetchall()

    edges = []
    for r in relations:
        edges.append({
            "from": r["from"],
            "to": r["to"],
            "label": r["relation_type"],
            "arrows": "to",
            "confidence": r["confidence"],
            "source_name": r["source_name"],
            "target_name": r["target_name"],
        })

    cur.close()
    conn.close()
    return jsonify({"nodes": nodes, "edges": edges})


@app.route("/api/facts")
def facts():
    """Memory Bank facts with tier info."""
    conn = get_conn()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("""
        SELECT id, topic, fact, confidence, status,
               COALESCE(tier, 'warm') as tier,
               COALESCE(strength, 1.0) as strength,
               scope, temporal_type,
               created_at, last_accessed_at, access_count
        FROM openclaw.agent_knowledge
        WHERE status = 'active'
        ORDER BY confidence DESC, created_at DESC
        LIMIT 200
    """)
    rows = cur.fetchall()

    result = []
    for r in rows:
        result.append({
            "id": r["id"],
            "topic": r["topic"],
            "fact": r["fact"],
            "confidence": float(r["confidence"]) if r["confidence"] else 0,
            "tier": r["tier"],
            "strength": float(r["strength"]) if r["strength"] else 1.0,
            "scope": r["scope"],
            "temporal_type": r["temporal_type"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "last_accessed_at": r["last_accessed_at"].isoformat() if r["last_accessed_at"] else None,
            "access_count": r["access_count"] or 0,
        })

    cur.close()
    conn.close()
    return jsonify({"facts": result})


@app.route("/api/stats")
def stats():
    """Overall memory system statistics."""
    conn = get_conn()
    cur = conn.cursor()

    queries = {
        "entities": "SELECT COUNT(*) FROM openclaw.agent_entities",
        "relations": "SELECT COUNT(*) FROM openclaw.agent_entity_relations",
        "mentions": "SELECT COUNT(*) FROM openclaw.agent_entity_mentions",
        "facts_active": "SELECT COUNT(*) FROM openclaw.agent_knowledge WHERE status='active'",
        "facts_total": "SELECT COUNT(*) FROM openclaw.agent_knowledge",
        "entries": "SELECT COUNT(*) FROM openclaw.agent_entries",
        "patterns": "SELECT COUNT(*) FROM openclaw.agent_patterns",
        "conversations": "SELECT COUNT(*) FROM openclaw.agent_conversations",
        "skills": "SELECT COUNT(*) FROM openclaw.agent_skills",
        "topic_events": "SELECT COUNT(*) FROM openclaw.topic_timeline",
        "topics": "SELECT COUNT(*) FROM openclaw.topic_registry",
    }

    result = {}
    for key, sql in queries.items():
        try:
            cur.execute(sql)
            result[key] = cur.fetchone()[0]
        except:
            conn.rollback()
            result[key] = 0

    # Entity type breakdown
    try:
        cur.execute("""
            SELECT entity_type, COUNT(*) as cnt
            FROM openclaw.agent_entities
            GROUP BY entity_type
            ORDER BY cnt DESC
        """)
        result["entity_types"] = {r[0]: r[1] for r in cur.fetchall()}
    except:
        conn.rollback()
        result["entity_types"] = {}

    # Tier breakdown
    try:
        cur.execute("""
            SELECT COALESCE(tier, 'warm') as tier, COUNT(*) as cnt
            FROM openclaw.agent_knowledge
            WHERE status = 'active'
            GROUP BY tier
        """)
        result["tiers"] = {r[0]: r[1] for r in cur.fetchall()}
    except:
        conn.rollback()
        result["tiers"] = {}

    cur.close()
    conn.close()
    return jsonify(result)


@app.route("/api/timeline")
def timeline():
    """Timeline events — topic events + fact creation dates."""
    conn = get_conn()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    events = []

    # Topic timeline events
    try:
        cur.execute("""
            SELECT t.id, t.slug as topic, t.content, t.event_type as type,
                   t.created_at as timestamp
            FROM openclaw.topic_timeline t
            ORDER BY t.created_at DESC
            LIMIT 200
        """)
        for r in cur.fetchall():
            events.append({
                "id": f"topic:{r['id']}",
                "topic": r["topic"],
                "content": (r["content"] or "")[:200],
                "type": r["type"] or "event",
                "timestamp": r["timestamp"].isoformat() if r["timestamp"] else None,
                "source": "topic_timeline",
            })
    except:
        conn.rollback()

    # Fact creation events
    try:
        cur.execute("""
            SELECT id, topic, fact, created_at
            FROM openclaw.agent_knowledge
            WHERE status = 'active'
            ORDER BY created_at DESC
            LIMIT 100
        """)
        for r in cur.fetchall():
            events.append({
                "id": f"fact:{r['id']}",
                "topic": r["topic"],
                "content": r["fact"][:200],
                "type": "fact_created",
                "timestamp": r["created_at"].isoformat() if r["created_at"] else None,
                "source": "memory_bank",
            })
    except:
        conn.rollback()

    # Entity creation events
    try:
        cur.execute("""
            SELECT id, name, entity_type, created_at
            FROM openclaw.agent_entities
            ORDER BY created_at DESC
            LIMIT 100
        """)
        for r in cur.fetchall():
            events.append({
                "id": f"entity:{r['id']}",
                "topic": r["entity_type"],
                "content": f"Entity discovered: {r['name']} ({r['entity_type']})",
                "type": "entity_created",
                "timestamp": r["created_at"].isoformat() if r["created_at"] else None,
                "source": "entity_graph",
            })
    except:
        conn.rollback()

    # Sort all events by timestamp
    events.sort(key=lambda e: e.get("timestamp") or "", reverse=True)

    cur.close()
    conn.close()
    return jsonify({"events": events[:300]})


@app.route("/api/entity/<int:entity_id>")
def entity_detail(entity_id):
    """Detail view for a single entity — relations, mentions, linked facts."""
    conn = get_conn()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Entity info
    cur.execute("SELECT * FROM openclaw.agent_entities WHERE id = %s", (entity_id,))
    entity = cur.fetchone()
    if not entity:
        cur.close(); conn.close()
        return jsonify({"error": "not found"}), 404

    # Relations
    cur.execute("""
        SELECT r.*, se.name as source_name, te.name as target_name
        FROM openclaw.agent_entity_relations r
        JOIN openclaw.agent_entities se ON se.id = r.source_entity_id
        JOIN openclaw.agent_entities te ON te.id = r.target_entity_id
        WHERE r.source_entity_id = %s OR r.target_entity_id = %s
        ORDER BY r.confidence DESC
    """, (entity_id, entity_id))
    relations = cur.fetchall()

    # Mentions with linked facts
    cur.execute("""
        SELECT m.*, k.fact, k.topic, k.confidence as fact_confidence
        FROM openclaw.agent_entity_mentions m
        LEFT JOIN openclaw.agent_knowledge k ON k.id = m.fact_id
        WHERE m.entity_id = %s
        ORDER BY m.created_at DESC
        LIMIT 50
    """, (entity_id,))
    mentions = cur.fetchall()

    cur.close()
    conn.close()

    return jsonify({
        "entity": {
            "id": entity["id"],
            "name": entity["name"],
            "type": entity["entity_type"],
            "aliases": entity["aliases"] or [],
            "metadata": entity["metadata"] or {},
            "created_at": entity["created_at"].isoformat() if entity["created_at"] else None,
        },
        "relations": [{
            "id": r["id"],
            "source": r["source_name"],
            "target": r["target_name"],
            "type": r["relation_type"],
            "confidence": float(r["confidence"]) if r["confidence"] else 0,
        } for r in relations],
        "mentions": [{
            "id": m["id"],
            "fact": m.get("fact"),
            "topic": m.get("topic"),
            "snippet": m.get("context_snippet"),
            "created_at": m["created_at"].isoformat() if m["created_at"] else None,
        } for m in mentions],
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8091))
    print(f"🧠 Memory Graph API starting on port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
