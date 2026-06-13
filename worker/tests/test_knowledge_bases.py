from pathlib import Path

from citemind_worker.knowledge_base_service import KnowledgeBaseService
from citemind_worker.storage import StorageRuntime
from citemind_worker.storage.full_text import FullTextIndex


def test_knowledge_base_crud_and_source_isolation(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    service = KnowledgeBaseService(storage)

    first = service.create("课程资料")
    second = service.create("产品资料")
    first_id = str(first["id"])
    second_id = str(second["id"])
    _seed_source(storage, first_id, "source-a", "A.pdf", "ready")
    _seed_source(storage, second_id, "source-b", "B.pdf", "failed")

    first_sources = service.sources(first_id)
    assert first_sources["summary"] == {
        "sourceCount": 1,
        "sourcesByStatus": {"ready": 1},
        "readyIndexCount": 0,
        "conversationCount": 0,
        "chunkCount": 0,
    }
    assert [source["displayName"] for source in first_sources["sources"]] == ["A.pdf"]

    renamed = service.rename(first_id, "课程复习资料")
    assert renamed["name"] == "课程复习资料"

    remaining = service.delete(first_id)
    assert [item["id"] for item in remaining["knowledgeBases"]] == [second_id]
    assert service.sources(second_id)["summary"]["sourcesByStatus"] == {"failed": 1}


def test_knowledge_base_service_creates_default_when_empty(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    service = KnowledgeBaseService(storage)

    result = service.list_knowledge_bases()

    assert len(result["knowledgeBases"]) == 1
    assert result["knowledgeBases"][0]["name"] == "产品与架构资料库"


def test_knowledge_base_delete_removes_files_indexes_and_jobs(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    service = KnowledgeBaseService(storage)
    knowledge_base_id = str(service.create("待删除知识库")["id"])
    retained_knowledge_base_id = str(service.create("保留知识库")["id"])
    original = storage.paths.objects / "source-a" / "document.pdf"
    snapshot = storage.paths.web_snapshots / "source-a" / "snapshot.html"
    artifact = storage.paths.artifacts / "source-a" / "parse.json"
    for path in (original, snapshot, artifact):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("content", encoding="utf-8")
    with storage.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO sources(id, knowledge_base_id, source_type, display_name, status)
            VALUES ('source-a', ?, 'pdf', 'A.pdf', 'ready')
            """,
            (knowledge_base_id,),
        )
        connection.execute(
            """
            INSERT INTO sources(id, knowledge_base_id, source_type, display_name, status)
            VALUES ('source-retained', ?, 'pdf', '共享 A.pdf', 'ready')
            """,
            (retained_knowledge_base_id,),
        )
        connection.execute(
            """
            INSERT INTO source_versions(
                id, source_id, version_number, original_path, snapshot_path,
                parse_artifact_path, status
            )
            VALUES ('version-a', 'source-a', 1, ?, ?, ?, 'ready')
            """,
            (str(original), str(snapshot), str(artifact)),
        )
        connection.execute(
            """
            INSERT INTO source_versions(
                id, source_id, version_number, original_path, status
            )
            VALUES ('version-retained', 'source-retained', 1, ?, 'ready')
            """,
            (str(original),),
        )
        connection.execute(
            """
            INSERT INTO index_versions(
                id, knowledge_base_id, embedding_provider, embedding_model,
                embedding_dimension, chunking_version, parser_version, status, is_current
            )
            VALUES ('index-a', ?, 'ark', 'embedding', 3, 'chunk-v1', 'parser-v1', 'ready', 1)
            """,
            (knowledge_base_id,),
        )
        connection.execute(
            """
            INSERT INTO chunks(
                id, knowledge_base_id, source_version_id, index_version_id,
                original_text, normalized_text, content_hash
            )
            VALUES ('chunk-a', ?, 'version-a', 'index-a', 'alpha', 'alpha', 'hash-a')
            """,
            (knowledge_base_id,),
        )
        connection.execute(
            """
            INSERT INTO background_jobs(id, job_type, target_id, status)
            VALUES ('job-a', 'index.build', 'index-a', 'paused')
            """
        )
        connection.commit()
    FullTextIndex(storage.database).upsert(
        chunk_id="chunk-a",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-a",
        text="alpha",
    )
    storage.vector_index.add(
        chunk_id="chunk-a",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-a",
        vector=[1.0, 0.0, 0.0],
    )

    service.delete(knowledge_base_id)

    assert original.exists()
    assert not snapshot.exists()
    assert not artifact.exists()
    assert storage.vector_index.count_index_version("index-a") == 0
    with storage.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM background_jobs").fetchone()[0] == 0


def _seed_source(
    storage: StorageRuntime,
    knowledge_base_id: str,
    source_id: str,
    name: str,
    status: str,
) -> None:
    with storage.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO sources(id, knowledge_base_id, source_type, display_name, status)
            VALUES (?, ?, 'pdf', ?, ?)
            """,
            (source_id, knowledge_base_id, name, status),
        )
        connection.commit()
