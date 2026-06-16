CREATE TABLE quality_metrics (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    unit TEXT NOT NULL,
    labels_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX quality_metrics_by_name_and_time
    ON quality_metrics(metric_name, created_at DESC);

CREATE INDEX quality_metrics_by_knowledge_base_and_time
    ON quality_metrics(knowledge_base_id, created_at DESC);
