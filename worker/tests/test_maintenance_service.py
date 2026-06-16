from pathlib import Path

from citemind_worker.knowledge_base_service import KnowledgeBaseService
from citemind_worker.maintenance_service import MaintenanceService
from citemind_worker.storage import StorageRuntime
from citemind_worker.storage.full_text import FullTextIndex


def test_cleanup_recycles_expired_index_and_orphan_data(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = str(KnowledgeBaseService(storage).create("清理测试")["id"])
    orphan_file = storage.paths.objects / "orphan" / "unused.pdf"
    orphan_file.parent.mkdir(parents=True)
    orphan_file.write_text("orphan", encoding="utf-8")
    old_original = storage.paths.objects / "source-a" / "old.pdf"
    old_artifact = storage.paths.artifacts / "source-versions" / "version-old.json"
    old_original.parent.mkdir(parents=True)
    old_artifact.parent.mkdir(parents=True)
    old_original.write_text("old source", encoding="utf-8")
    old_artifact.write_text("{}", encoding="utf-8")
    with storage.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO sources(
                id, knowledge_base_id, source_type, display_name, status, current_version_id
            )
            VALUES ('source-a', ?, 'pdf', 'A.pdf', 'ready', 'version-a')
            """,
            (knowledge_base_id,),
        )
        connection.execute(
            """
            INSERT INTO source_versions(id, source_id, version_number, status, review_status)
            VALUES ('version-a', 'source-a', 1, 'ready', 'current')
            """
        )
        connection.execute(
            """
            INSERT INTO source_versions(
                id, source_id, version_number, original_path, parse_artifact_path,
                status, review_status
            )
            VALUES ('version-old', 'source-a', 2, ?, ?, 'parsed', 'superseded')
            """,
            (str(old_original), str(old_artifact)),
        )
        connection.execute(
            """
            INSERT INTO index_versions(
                id, knowledge_base_id, embedding_provider, embedding_model,
                embedding_dimension, chunking_version, parser_version, status,
                is_current, retained_until
            )
            VALUES (
                'index-expired', ?, 'ark', 'embedding', 3, 'chunk-v1', 'parser-v1',
                'retired', 0, '2000-01-01T00:00:00.000Z'
            )
            """,
            (knowledge_base_id,),
        )
        connection.execute(
            """
            INSERT INTO chunks(
                id, knowledge_base_id, source_version_id, index_version_id,
                original_text, normalized_text, content_hash
            )
            VALUES ('chunk-expired', ?, 'version-a', 'index-expired', 'alpha', 'alpha', 'hash-a')
            """,
            (knowledge_base_id,),
        )
        connection.commit()
    FullTextIndex(storage.database).upsert(
        chunk_id="chunk-expired",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-expired",
        text="alpha",
    )
    storage.vector_index.add(
        chunk_id="chunk-expired",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-expired",
        vector=[1.0, 0.0, 0.0],
    )
    storage.vector_index.add(
        chunk_id="chunk-orphan",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-orphan",
        vector=[0.0, 1.0, 0.0],
    )

    service = MaintenanceService(storage)
    status = service.status()
    result = service.cleanup()

    assert status["recyclableSourceVersionCount"] == 1
    assert result["recycledIndexCount"] == 1
    assert result["recycledSourceVersionCount"] == 1
    assert result["removedFileCount"] == 3
    assert result["removedVectorCount"] == 1
    assert not orphan_file.exists()
    assert not old_original.exists()
    assert not old_artifact.exists()
    assert storage.vector_index.count_index_version("index-expired") == 0
    assert storage.vector_index.count_index_version("index-orphan") == 0
    with storage.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM index_versions").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM source_versions").fetchone()[0] == 1
