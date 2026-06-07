CREATE TABLE knowledge_bases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE index_versions (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    embedding_provider TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    embedding_dimension INTEGER NOT NULL CHECK (embedding_dimension > 0),
    chunking_version TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed', 'retired')),
    is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX one_current_index_per_knowledge_base
    ON index_versions(knowledge_base_id)
    WHERE is_current = 1;

CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL CHECK (source_type IN ('pdf', 'docx', 'image', 'web')),
    display_name TEXT NOT NULL,
    uri TEXT,
    original_hash TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX sources_by_knowledge_base ON sources(knowledge_base_id);

CREATE TABLE source_versions (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL CHECK (version_number > 0),
    content_hash TEXT,
    original_path TEXT,
    snapshot_path TEXT,
    parse_artifact_path TEXT,
    status TEXT NOT NULL DEFAULT 'processing',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(source_id, version_number)
);

CREATE TABLE chunks (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
    index_version_id TEXT REFERENCES index_versions(id) ON DELETE SET NULL,
    page_number INTEGER CHECK (page_number IS NULL OR page_number > 0),
    bounding_box_json TEXT,
    heading_path_json TEXT,
    anchor TEXT,
    original_text TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX chunks_by_knowledge_base_and_index
    ON chunks(knowledge_base_id, index_version_id);
CREATE INDEX chunks_by_source_version ON chunks(source_version_id);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
    chunk_id UNINDEXED,
    knowledge_base_id UNINDEXED,
    index_version_id UNINDEXED,
    search_text,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE seed_api_credentials (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    encrypted_key_ref TEXT NOT NULL,
    default_chat_model TEXT,
    default_embedding_model TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE model_capabilities (
    id TEXT PRIMARY KEY,
    credential_id TEXT NOT NULL REFERENCES seed_api_credentials(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    capability_json TEXT NOT NULL DEFAULT '{}',
    checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(credential_id, model_id, role)
);

CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    model_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
    content TEXT NOT NULL,
    model_id TEXT,
    model_params_json TEXT,
    index_version_id TEXT REFERENCES index_versions(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX messages_by_conversation ON messages(conversation_id, created_at);

CREATE TABLE answer_citations (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    paragraph_index INTEGER NOT NULL CHECK (paragraph_index >= 0),
    chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(message_id, paragraph_index, chunk_id)
);

CREATE TABLE background_jobs (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'running', 'completed', 'paused', 'cancelled', 'failed', 'retrying')
    ),
    progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
    checkpoint_json TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX background_jobs_by_status ON background_jobs(status, updated_at);
