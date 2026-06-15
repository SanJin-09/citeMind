CREATE TABLE writing_projects (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    workflow_type TEXT NOT NULL CHECK (workflow_type IN ('review', 'article')),
    status TEXT NOT NULL CHECK (
        status IN ('planning', 'ready', 'running', 'needs_revision', 'completed', 'failed')
    ),
    model_id TEXT,
    index_version_id TEXT REFERENCES index_versions(id) ON DELETE SET NULL,
    outline_json TEXT NOT NULL DEFAULT '{}',
    audit_json TEXT NOT NULL DEFAULT '{}',
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE writing_sections (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES writing_projects(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    title TEXT NOT NULL,
    purpose TEXT NOT NULL,
    review_points_json TEXT NOT NULL DEFAULT '[]',
    outline_evidence_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'running', 'needs_review', 'needs_revision', 'completed', 'failed')
    ),
    content TEXT NOT NULL DEFAULT '',
    paragraphs_json TEXT NOT NULL DEFAULT '[]',
    audit_json TEXT NOT NULL DEFAULT '{}',
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(project_id, position)
);

CREATE TABLE writing_citations (
    id TEXT PRIMARY KEY,
    section_id TEXT NOT NULL REFERENCES writing_sections(id) ON DELETE CASCADE,
    paragraph_index INTEGER NOT NULL CHECK (paragraph_index >= 0),
    chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(section_id, paragraph_index, chunk_id)
);

CREATE TABLE writing_checkpoints (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES writing_projects(id) ON DELETE CASCADE,
    section_id TEXT REFERENCES writing_sections(id) ON DELETE CASCADE,
    step TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
    state_json TEXT NOT NULL DEFAULT '{}',
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX writing_projects_by_knowledge_base
    ON writing_projects(knowledge_base_id, updated_at DESC);

CREATE INDEX writing_sections_by_project
    ON writing_sections(project_id, position);

CREATE INDEX writing_checkpoints_by_section
    ON writing_checkpoints(section_id, created_at DESC);
