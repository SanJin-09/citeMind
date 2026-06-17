ALTER TABLE agent_runs ADD COLUMN trace_snapshot_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE agent_run_events ADD COLUMN started_at TEXT;
ALTER TABLE agent_run_events ADD COLUMN completed_at TEXT;
ALTER TABLE agent_run_events ADD COLUMN duration_ms INTEGER CHECK (
    duration_ms IS NULL OR duration_ms >= 0
);
ALTER TABLE agent_run_events ADD COLUMN tool_call_id TEXT;
ALTER TABLE agent_run_events ADD COLUMN step_id TEXT;

UPDATE agent_run_events
SET started_at = created_at
WHERE started_at IS NULL;

CREATE INDEX agent_run_events_by_run_created_at
    ON agent_run_events(run_id, created_at);

CREATE INDEX agent_run_events_by_tool_call
    ON agent_run_events(tool_call_id)
    WHERE tool_call_id IS NOT NULL;
