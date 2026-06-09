ALTER TABLE index_versions ADD COLUMN activated_at TEXT;
ALTER TABLE index_versions ADD COLUMN retained_until TEXT;
ALTER TABLE index_versions ADD COLUMN failure_reason TEXT;

CREATE INDEX index_versions_by_knowledge_base_and_created_at
    ON index_versions(knowledge_base_id, created_at DESC);
