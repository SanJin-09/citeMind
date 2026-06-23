ALTER TABLE agent_runs
    ADD COLUMN research_workspace_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE agent_runs
    ADD COLUMN research_user_revision INTEGER NOT NULL DEFAULT 0 CHECK (
        research_user_revision >= 0
    );

ALTER TABLE agent_runs
    ADD COLUMN research_agent_revision INTEGER NOT NULL DEFAULT 0 CHECK (
        research_agent_revision >= 0
    );

ALTER TABLE agent_runs
    ADD COLUMN research_pending_update_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX agent_runs_research_workspaces
    ON agent_runs(knowledge_base_id, updated_at DESC)
    WHERE skill_id = 'research_brief' AND research_workspace_json != '{}';
