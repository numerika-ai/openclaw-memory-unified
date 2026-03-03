-- memory-unified schema: extends USMD with unified entry table

-- Original USMD tables (preserved for backward compat)
CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    category TEXT,
    description TEXT,
    procedure TEXT NOT NULL,
    tools_used TEXT,
    config JSON,
    tier TEXT DEFAULT 'CORE',
    source_path TEXT,
    tags TEXT,
    wikilink TEXT,
    version INTEGER DEFAULT 1,
    last_used TIMESTAMP,
    use_count INTEGER DEFAULT 0,
    success_rate REAL DEFAULT 0.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skill_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER NOT NULL REFERENCES skills(id),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    summary TEXT NOT NULL,
    input_context TEXT,
    output_summary TEXT,
    artifacts TEXT,
    status TEXT CHECK(status IN ('success','error','partial')) DEFAULT 'success',
    duration_ms INTEGER,
    tokens_used INTEGER,
    session_key TEXT,
    lancedb_ids TEXT
);

CREATE TABLE IF NOT EXISTS execution_details (
    execution_id INTEGER PRIMARY KEY REFERENCES skill_executions(id),
    full_input TEXT,
    full_output TEXT,
    error_log TEXT,
    metadata JSON
);

CREATE TABLE IF NOT EXISTS procedure_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER NOT NULL REFERENCES skills(id),
    proposed_procedure TEXT NOT NULL,
    reason TEXT,
    evidence_ids TEXT,
    status TEXT CHECK(status IN ('draft','pending','approved','rejected')) DEFAULT 'draft',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP,
    reviewed_by TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name TEXT NOT NULL,
    params_preview TEXT,
    result_preview TEXT,
    status TEXT DEFAULT 'success',
    session_key TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    path TEXT NOT NULL,
    wikilink TEXT,
    file_type TEXT,
    size_bytes INTEGER,
    description TEXT,
    created_by_skill_id INTEGER REFERENCES skills(id),
    created_by_tool_call_id INTEGER REFERENCES tool_calls(id),
    task_id TEXT,
    source TEXT DEFAULT 'manual',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- NEW: Unified memory entries (bridging USMD <-> HNSW)
CREATE TABLE IF NOT EXISTS unified_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_type TEXT CHECK(entry_type IN ('skill','protocol','config','history','tool','result')) NOT NULL,
    tags TEXT,
    content TEXT NOT NULL,
    summary TEXT,
    source_path TEXT,
    hnsw_key TEXT,
    skill_id INTEGER REFERENCES skills(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
CREATE INDEX IF NOT EXISTS idx_executions_skill ON skill_executions(skill_id);
CREATE INDEX IF NOT EXISTS idx_executions_time ON skill_executions(timestamp);
CREATE INDEX IF NOT EXISTS idx_executions_status ON skill_executions(status);
CREATE INDEX IF NOT EXISTS idx_unified_type ON unified_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_unified_hnsw ON unified_entries(hnsw_key);
CREATE INDEX IF NOT EXISTS idx_unified_skill ON unified_entries(skill_id);
