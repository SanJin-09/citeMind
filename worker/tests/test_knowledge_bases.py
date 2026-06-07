from pathlib import Path

from citemind_worker.knowledge_base_service import KnowledgeBaseService
from citemind_worker.storage import StorageRuntime


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
