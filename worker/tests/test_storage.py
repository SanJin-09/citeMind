import sqlite3
from pathlib import Path

import pytest

from citemind_worker.storage.database import SqliteDatabase
from citemind_worker.storage.full_text import FullTextIndex, tokenize_for_search
from citemind_worker.storage.paths import AppDataPaths
from citemind_worker.storage.runtime import StorageRuntime
from citemind_worker.storage.vector_index import VectorIndex

REQUIRED_TABLES = {
    "knowledge_bases",
    "sources",
    "source_versions",
    "chunks",
    "index_versions",
    "seed_api_credentials",
    "model_capabilities",
    "conversations",
    "messages",
    "answer_citations",
    "background_jobs",
    "chunks_fts",
}


def test_app_data_paths_create_expected_layout(tmp_path: Path) -> None:
    paths = AppDataPaths(tmp_path / "citeMind")
    paths.ensure()

    assert paths.database.parent == paths.root
    assert paths.objects.is_dir()
    assert paths.web_snapshots.is_dir()
    assert paths.artifacts.is_dir()
    assert paths.lancedb.is_dir()
    assert paths.backups.is_dir()


def test_sqlite_migration_creates_required_tables_and_accepts_null_page_number(
    tmp_path: Path,
) -> None:
    database = SqliteDatabase(AppDataPaths(tmp_path))

    assert database.initialize() == 1
    status = database.status()
    assert status["fts5Enabled"] is True
    assert set(status["tables"]) >= REQUIRED_TABLES

    with database.connect() as connection:
        _seed_chunk_dependencies(connection)
        connection.execute(
            """
            INSERT INTO chunks(
                id, knowledge_base_id, source_version_id, index_version_id, page_number,
                original_text, normalized_text, content_hash
            )
            VALUES (
                'chunk-docx', 'kb-1', 'source-version-1', 'index-v1', NULL, '原文', '原文', 'h1'
            )
            """
        )
        connection.commit()
        row = connection.execute(
            "SELECT page_number FROM chunks WHERE id = 'chunk-docx'"
        ).fetchone()

    assert row is not None
    assert row["page_number"] is None


def test_migration_snapshots_existing_database_before_upgrade(tmp_path: Path) -> None:
    paths = AppDataPaths(tmp_path)
    paths.ensure()
    with sqlite3.connect(paths.database) as connection:
        connection.execute("CREATE TABLE legacy_marker(value TEXT)")
        connection.execute("INSERT INTO legacy_marker(value) VALUES ('keep-me')")
        connection.commit()

    database = SqliteDatabase(paths)
    database.initialize()

    snapshots = list(paths.backups.glob("metadata-before-migration-*.sqlite3"))
    assert len(snapshots) == 1
    with sqlite3.connect(snapshots[0]) as snapshot:
        assert snapshot.execute("SELECT value FROM legacy_marker").fetchone() == ("keep-me",)


def test_chinese_fts_search_and_index_version_isolation(tmp_path: Path) -> None:
    database = SqliteDatabase(AppDataPaths(tmp_path))
    database.initialize()
    index = FullTextIndex(database)

    index.upsert(
        chunk_id="chunk-v1",
        knowledge_base_id="kb-1",
        index_version_id="index-v1",
        text="机器学习可以帮助分析知识库资料",
    )
    index.upsert(
        chunk_id="chunk-v2",
        knowledge_base_id="kb-1",
        index_version_id="index-v2",
        text="机器学习的另一索引版本",
    )

    assert set(tokenize_for_search("机器学习").split()) >= {"机器", "学习"}
    results = index.search(
        knowledge_base_id="kb-1",
        index_version_id="index-v1",
        query="机器学习",
    )

    assert [result.chunk_id for result in results] == ["chunk-v1"]


def test_lancedb_read_write_and_index_version_isolation(tmp_path: Path) -> None:
    index = VectorIndex(AppDataPaths(tmp_path), dimension=3)
    index.initialize()
    index.add(
        chunk_id="chunk-v1",
        knowledge_base_id="kb-1",
        index_version_id="index-v1",
        vector=[1.0, 0.0, 0.0],
    )
    index.add(
        chunk_id="chunk-v2",
        knowledge_base_id="kb-1",
        index_version_id="index-v2",
        vector=[1.0, 0.0, 0.0],
    )

    results = index.search(
        knowledge_base_id="kb-1",
        index_version_id="index-v1",
        vector=[1.0, 0.0, 0.0],
    )

    assert [result.chunk_id for result in results] == ["chunk-v1"]
    with pytest.raises(ValueError, match="Expected vector dimension 3"):
        index.search(
            knowledge_base_id="kb-1",
            index_version_id="index-v1",
            vector=[1.0, 0.0],
        )


def test_storage_runtime_initializes_all_backends(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()

    summary = storage.health_summary()
    assert summary == {
        "ready": True,
        "schemaVersion": 1,
        "fts5Enabled": True,
        "vectorDimension": 3,
    }
    assert storage.status()["lancedb"] == {
        "path": str(tmp_path.resolve() / "indexes" / "lancedb"),
        "table": "chunk_vectors",
        "dimension": 3,
        "ready": True,
    }


def _seed_chunk_dependencies(connection: sqlite3.Connection) -> None:
    connection.execute("INSERT INTO knowledge_bases(id, name) VALUES ('kb-1', '测试知识库')")
    connection.execute(
        """
        INSERT INTO index_versions(
            id, knowledge_base_id, embedding_provider, embedding_model, embedding_dimension,
            chunking_version, parser_version, status, is_current
        )
        VALUES ('index-v1', 'kb-1', 'seed', 'embedding', 1024, 'v1', 'v1', 'ready', 1)
        """
    )
    connection.execute(
        """
        INSERT INTO sources(id, knowledge_base_id, source_type, display_name)
        VALUES ('source-1', 'kb-1', 'docx', '测试.docx')
        """
    )
    connection.execute(
        """
        INSERT INTO source_versions(id, source_id, version_number)
        VALUES ('source-version-1', 'source-1', 1)
        """
    )
