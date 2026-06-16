CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    skill_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN (
            'planning',
            'waiting_confirmation',
            'executing',
            'paused',
            'completed',
            'cancelled',
            'failed'
        )
    ),
    source_scope_json TEXT NOT NULL DEFAULT '[]',
    index_version_id TEXT REFERENCES index_versions(id) ON DELETE SET NULL,
    models_json TEXT NOT NULL DEFAULT '{}',
    budgets_json TEXT NOT NULL DEFAULT '{}',
    usage_json TEXT NOT NULL DEFAULT '{}',
    plan_json TEXT NOT NULL DEFAULT '{}',
    draft_json TEXT NOT NULL DEFAULT '{}',
    final_output_json TEXT NOT NULL DEFAULT '{}',
    error_message TEXT,
    stop_reason TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE agent_run_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    event_type TEXT NOT NULL,
    stage TEXT,
    status TEXT,
    title TEXT NOT NULL,
    summary TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(run_id, sequence)
);

CREATE TABLE agent_run_tool_calls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    step_id TEXT,
    tool_name TEXT NOT NULL,
    skill_id TEXT,
    skill_version TEXT,
    action_summary TEXT NOT NULL,
    working_directory TEXT,
    sanitized_params_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
    ),
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT,
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    exit_code INTEGER,
    stdout_summary TEXT,
    stderr_summary TEXT,
    error_message TEXT
);

CREATE TABLE agent_run_confirmations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'confirmed', 'rejected', 'cancelled')
    ),
    options_json TEXT NOT NULL DEFAULT '[]',
    decision_json TEXT NOT NULL DEFAULT '{}',
    requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    resolved_at TEXT
);

CREATE TABLE agent_run_delegations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    child_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
    delegatee_role TEXT NOT NULL,
    task TEXT NOT NULL,
    input_scope_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
    ),
    output_json TEXT NOT NULL DEFAULT '{}',
    stop_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT
);

CREATE TABLE agent_run_outputs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    output_type TEXT NOT NULL CHECK (
        output_type IN ('draft', 'final', 'intermediate')
    ),
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE agent_run_citations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    output_id TEXT REFERENCES agent_run_outputs(id) ON DELETE CASCADE,
    paragraph_index INTEGER NOT NULL CHECK (paragraph_index >= 0),
    chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(output_id, paragraph_index, chunk_id)
);

CREATE INDEX agent_runs_by_knowledge_base
    ON agent_runs(knowledge_base_id, updated_at DESC);

CREATE INDEX agent_runs_by_status
    ON agent_runs(status, updated_at DESC);

CREATE INDEX agent_run_events_by_run_sequence
    ON agent_run_events(run_id, sequence);

CREATE INDEX agent_run_tool_calls_by_run
    ON agent_run_tool_calls(run_id, started_at DESC);

CREATE INDEX agent_run_outputs_by_run
    ON agent_run_outputs(run_id, updated_at DESC);
