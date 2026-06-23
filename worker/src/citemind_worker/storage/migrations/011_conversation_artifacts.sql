ALTER TABLE messages
    ADD COLUMN artifact_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE agent_runs
    ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE;

ALTER TABLE agent_runs
    ADD COLUMN assistant_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX agent_runs_by_conversation
    ON agent_runs(conversation_id, updated_at DESC)
    WHERE conversation_id IS NOT NULL;

CREATE INDEX agent_runs_by_assistant_message
    ON agent_runs(assistant_message_id)
    WHERE assistant_message_id IS NOT NULL;

INSERT OR IGNORE INTO conversations(id, knowledge_base_id, title, model_id, created_at, updated_at)
SELECT
    'conversation-legacy-research-' || id,
    knowledge_base_id,
    COALESCE(NULLIF(json_extract(research_workspace_json, '$.title'), ''), title),
    json_extract(models_json, '$.chat'),
    created_at,
    updated_at
FROM agent_runs
WHERE skill_id = 'research_brief'
  AND research_workspace_json != '{}'
  AND conversation_id IS NULL;

INSERT OR IGNORE INTO messages(
    id, conversation_id, role, content, model_id, model_params_json,
    index_version_id, artifact_json, created_at
)
SELECT
    'message-legacy-research-user-' || id,
    'conversation-legacy-research-' || id,
    'user',
    goal,
    NULL,
    '{}',
    index_version_id,
    '{}',
    created_at
FROM agent_runs
WHERE skill_id = 'research_brief'
  AND research_workspace_json != '{}'
  AND conversation_id IS NULL;

INSERT OR IGNORE INTO messages(
    id, conversation_id, role, content, model_id, model_params_json,
    index_version_id, artifact_json, created_at
)
SELECT
    'message-legacy-research-assistant-' || id,
    'conversation-legacy-research-' || id,
    'assistant',
    '已归档研究简报：' ||
        COALESCE(NULLIF(json_extract(research_workspace_json, '$.title'), ''), title),
    json_extract(models_json, '$.chat'),
    '{}',
    index_version_id,
    json_object(
        'type', 'research_brief',
        'runId', id,
        'display', 'full'
    ),
    updated_at
FROM agent_runs
WHERE skill_id = 'research_brief'
  AND research_workspace_json != '{}'
  AND conversation_id IS NULL;

UPDATE agent_runs
SET conversation_id = 'conversation-legacy-research-' || id,
    assistant_message_id = 'message-legacy-research-assistant-' || id
WHERE skill_id = 'research_brief'
  AND research_workspace_json != '{}'
  AND conversation_id IS NULL;
