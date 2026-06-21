CREATE TABLE mcp_server_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    transport TEXT NOT NULL CHECK (transport IN ('stdio')),
    command TEXT NOT NULL,
    args_json TEXT NOT NULL DEFAULT '[]',
    env_keys_json TEXT NOT NULL DEFAULT '[]',
    read_only_tools_json TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    timeout_seconds INTEGER NOT NULL DEFAULT 30 CHECK (
        timeout_seconds BETWEEN 1 AND 300
    ),
    last_error TEXT,
    last_discovered_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE agent_run_mcp_access (
    run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    server_ids_json TEXT NOT NULL DEFAULT '[]',
    enabled_at TEXT,
    disabled_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE external_research_candidates (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL REFERENCES mcp_server_configs(id) ON DELETE RESTRICT,
    tool_name TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    snippet TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    source_metadata_json TEXT NOT NULL DEFAULT '{}',
    initial_comparison_json TEXT NOT NULL DEFAULT '{}',
    final_comparison_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK (
        status IN ('candidate', 'rejected', 'importing', 'indexed', 'failed')
    ),
    imported_source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
    indexed_version_id TEXT REFERENCES index_versions(id) ON DELETE SET NULL,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(run_id, url)
);

CREATE INDEX external_candidates_by_run
    ON external_research_candidates(run_id, created_at DESC);

CREATE INDEX external_candidates_by_source
    ON external_research_candidates(imported_source_id)
    WHERE imported_source_id IS NOT NULL;
