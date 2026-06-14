ALTER TABLE sources ADD COLUMN current_version_id TEXT;
ALTER TABLE sources ADD COLUMN replacement_source_id TEXT;
ALTER TABLE sources ADD COLUMN review_at TEXT;
ALTER TABLE sources ADD COLUMN expiry_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE sources ADD COLUMN model_suggestion_json TEXT;
ALTER TABLE sources ADD COLUMN last_checked_at TEXT;

ALTER TABLE source_versions ADD COLUMN etag TEXT;
ALTER TABLE source_versions ADD COLUMN last_modified TEXT;
ALTER TABLE source_versions ADD COLUMN checked_at TEXT;
ALTER TABLE source_versions ADD COLUMN previous_version_id TEXT;
ALTER TABLE source_versions ADD COLUMN review_status TEXT NOT NULL DEFAULT 'current';
ALTER TABLE source_versions ADD COLUMN change_summary_json TEXT;

ALTER TABLE index_versions ADD COLUMN reused_chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE index_versions ADD COLUMN embedded_chunk_count INTEGER NOT NULL DEFAULT 0;

UPDATE sources
SET current_version_id = (
    SELECT sv.id
    FROM source_versions sv
    WHERE sv.source_id = sources.id
    ORDER BY sv.version_number DESC
    LIMIT 1
);

UPDATE source_versions
SET review_status = 'superseded';

UPDATE source_versions
SET review_status = 'current'
WHERE id IN (
    SELECT current_version_id
    FROM sources
    WHERE current_version_id IS NOT NULL
);

CREATE INDEX source_versions_by_source_and_review
    ON source_versions(source_id, review_status, version_number DESC);

CREATE INDEX sources_by_review_at
    ON sources(source_type, review_at, last_checked_at);
