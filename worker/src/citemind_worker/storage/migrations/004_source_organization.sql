CREATE TABLE source_classifications (
    source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    title TEXT,
    author TEXT,
    document_time TEXT,
    rule_basis_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE source_tags (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    suggested_tag TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('model', 'correction', 'user')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'dismissed')),
    reason TEXT,
    confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(source_id, tag)
);

CREATE TABLE tag_corrections (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    suggested_tag TEXT NOT NULL,
    corrected_tag TEXT,
    action TEXT NOT NULL CHECK (action IN ('confirm', 'replace', 'dismiss')),
    use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(knowledge_base_id, suggested_tag)
);

CREATE TABLE source_relations (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    related_source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL CHECK (
        relation_type IN ('duplicate', 'near_duplicate', 'related', 'supplements', 'conflicts', 'replaces')
    ),
    basis_json TEXT NOT NULL DEFAULT '{}',
    confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
    status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'dismissed')),
    origin TEXT NOT NULL CHECK (origin IN ('rule', 'model', 'user')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (source_id != related_source_id),
    UNIQUE(source_id, related_source_id, relation_type)
);

CREATE INDEX source_tags_by_source_and_status
    ON source_tags(source_id, status, updated_at DESC);

CREATE INDEX source_relations_by_source
    ON source_relations(source_id, related_source_id, status);

CREATE INDEX source_relations_by_related_source
    ON source_relations(related_source_id, source_id, status);
