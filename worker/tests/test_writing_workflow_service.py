import asyncio
import base64
from pathlib import Path

import pytest

from citemind_worker.knowledge_base_service import KnowledgeBaseService
from citemind_worker.storage import StorageRuntime
from citemind_worker.writing_workflow_service import WritingWorkflowService


class FakeWritingRetrieval:
    def __init__(self) -> None:
        self.calls = 0

    async def retrieve(
        self,
        knowledge_base_id: str,
        query: str,
        **_kwargs: object,
    ) -> dict[str, object]:
        self.calls += 1
        return {
            "knowledgeBaseId": knowledge_base_id,
            "query": query,
            "indexVersion": {"id": "index-current"},
            "results": [
                {"chunkId": "chunk-a"},
                {"chunkId": "chunk-b"},
            ],
            "context": [
                {"chunk_id": "chunk-a", "text": {"normalized": "Alpha evidence"}},
                {"chunk_id": "chunk-b", "text": {"normalized": "Beta evidence"}},
            ],
        }


class FakeWritingGateway:
    def __init__(self, *, fail_draft_once: bool = False) -> None:
        self.fail_draft_once = fail_draft_once
        self.draft_calls = 0

    async def generate_structured(
        self,
        request: dict[str, object],
        schema: dict[str, object],
    ) -> dict[str, object]:
        del request
        properties = schema.get("properties")
        if isinstance(properties, dict) and "sections" in properties:
            return {
                "title": "知识库复习提纲",
                "summary": "围绕核心证据复习",
                "sections": [
                    {
                        "title": "核心概念",
                        "purpose": "总结 Alpha 与 Beta",
                        "review_points": ["Alpha", "Beta"],
                        "evidence_chunk_ids": ["chunk-a", "chunk-b", "invented"],
                    }
                ],
            }
        self.draft_calls += 1
        if self.fail_draft_once and self.draft_calls == 1:
            raise RuntimeError("temporary draft failure")
        return {
            "paragraphs": [
                {
                    "text": "Alpha 是核心概念。",
                    "evidence_chunk_ids": ["chunk-a"],
                },
                {
                    "text": "Beta 是补充概念。",
                    "evidence_chunk_ids": ["chunk-b"],
                },
            ]
        }


def test_creates_review_outline_and_writes_audited_section_with_word_export(
    tmp_path: Path,
) -> None:
    storage, knowledge_base_id = _seed_writing_storage(tmp_path)
    retrieval = FakeWritingRetrieval()
    gateway = FakeWritingGateway()
    service = WritingWorkflowService(
        storage,
        retrieval=retrieval,  # type: ignore[arg-type]
        gateway_factory=lambda _key, _base, _model: gateway,
    )

    created = asyncio.run(
        service.create_project(
            knowledge_base_id,
            goal="复习知识库架构",
            workflow_type="review",
            api_key="test-key",
        )
    )
    project_id = str(created["project"]["id"])
    section_id = str(created["sections"][0]["id"])

    assert created["project"]["outline"]["sections"][0]["evidenceChunkIds"] == [
        "chunk-a",
        "chunk-b",
    ]

    completed = asyncio.run(
        service.run_section(
            project_id,
            section_id=section_id,
            revise=False,
            api_key="test-key",
        )
    )
    section = completed["sections"][0]

    assert section["status"] == "completed"
    assert section["audit"]["valid"] is True
    assert len(section["citations"]) == 2
    assert {item["step"] for item in completed["checkpoints"]} >= {
        "outline",
        "retrieval",
        "draft",
        "audit",
        "persist",
    }

    exported = service.export_word(project_id)
    assert exported["fileName"] == "知识库复习提纲.docx"
    assert base64.b64decode(str(exported["base64"])).startswith(b"PK")


def test_langgraph_failure_resumes_from_latest_checkpoint(tmp_path: Path) -> None:
    storage, knowledge_base_id = _seed_writing_storage(tmp_path)
    retrieval = FakeWritingRetrieval()
    gateway = FakeWritingGateway(fail_draft_once=True)
    service = WritingWorkflowService(
        storage,
        retrieval=retrieval,  # type: ignore[arg-type]
        gateway_factory=lambda _key, _base, _model: gateway,
    )
    created = asyncio.run(
        service.create_project(
            knowledge_base_id,
            goal="撰写证据简报",
            workflow_type="article",
            api_key="test-key",
        )
    )
    project_id = str(created["project"]["id"])
    section_id = str(created["sections"][0]["id"])

    with pytest.raises(ValueError, match="可从检查点恢复"):
        asyncio.run(
            service.run_section(
                project_id,
                section_id=section_id,
                revise=False,
                api_key="test-key",
            )
        )
    failed = service.project(project_id)
    assert failed["sections"][0]["status"] == "failed"

    resumed = asyncio.run(
        service.run_section(
            project_id,
            section_id=section_id,
            revise=False,
            api_key="test-key",
        )
    )

    assert resumed["sections"][0]["status"] == "completed"
    assert retrieval.calls == 2
    assert gateway.draft_calls == 2


def test_manual_edit_audit_creates_revision_suggestion_for_missing_citation(
    tmp_path: Path,
) -> None:
    storage, knowledge_base_id = _seed_writing_storage(tmp_path)
    service = WritingWorkflowService(
        storage,
        retrieval=FakeWritingRetrieval(),  # type: ignore[arg-type]
        gateway_factory=lambda _key, _base, _model: FakeWritingGateway(),
    )
    created = asyncio.run(
        service.create_project(
            knowledge_base_id,
            goal="撰写文章",
            workflow_type="article",
            api_key="test-key",
        )
    )
    project_id = str(created["project"]["id"])
    section_id = str(created["sections"][0]["id"])
    asyncio.run(
        service.run_section(
            project_id,
            section_id=section_id,
            revise=False,
            api_key="test-key",
        )
    )

    service.update_section(
        section_id,
        "Alpha 是核心概念。\n\nBeta 是补充概念。\n\n这是新增但没有证据的结论。",
    )
    audited = service.audit_section(section_id)
    section = audited["sections"][0]

    assert section["status"] == "needs_revision"
    assert section["audit"]["valid"] is False
    assert section["audit"]["revisionSuggestions"]


def test_audit_flags_confirmed_conflict_between_cited_sources(tmp_path: Path) -> None:
    storage, knowledge_base_id = _seed_writing_storage(tmp_path)
    with storage.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO source_relations(
                id, knowledge_base_id, source_id, related_source_id, relation_type,
                basis_json, confidence, status, origin
            )
            VALUES (
                'relation-conflict', ?, 'source-a', 'source-b', 'conflicts',
                '{"summary":"结论不一致"}', 0.9, 'confirmed', 'user'
            )
            """,
            (knowledge_base_id,),
        )
        connection.commit()
    service = WritingWorkflowService(
        storage,
        retrieval=FakeWritingRetrieval(),  # type: ignore[arg-type]
        gateway_factory=lambda _key, _base, _model: FakeWritingGateway(),
    )
    created = asyncio.run(
        service.create_project(
            knowledge_base_id,
            goal="撰写冲突说明",
            workflow_type="article",
            api_key="test-key",
        )
    )

    completed = asyncio.run(
        service.run_section(
            str(created["project"]["id"]),
            section_id=str(created["sections"][0]["id"]),
            revise=False,
            api_key="test-key",
        )
    )
    section = completed["sections"][0]

    assert section["status"] == "needs_revision"
    assert section["audit"]["conflicts"][0]["relationId"] == "relation-conflict"
    assert any(item["type"] == "conflict" for item in section["audit"]["revisionSuggestions"])


def _seed_writing_storage(tmp_path: Path) -> tuple[StorageRuntime, str]:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = str(KnowledgeBaseService(storage).create("写作测试")["id"])
    with storage.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO index_versions(
                id, knowledge_base_id, embedding_provider, embedding_model,
                embedding_dimension, chunking_version, parser_version, status, is_current
            )
            VALUES ('index-current', ?, 'ark', 'embedding', 3, 'v1', 'v1', 'ready', 1)
            """,
            (knowledge_base_id,),
        )
        for suffix in ("a", "b"):
            connection.execute(
                """
                INSERT INTO sources(
                    id, knowledge_base_id, source_type, display_name, status, current_version_id
                )
                VALUES (?, ?, 'pdf', ?, 'ready', ?)
                """,
                (f"source-{suffix}", knowledge_base_id, f"{suffix}.pdf", f"version-{suffix}"),
            )
            connection.execute(
                """
                INSERT INTO source_versions(
                    id, source_id, version_number, status, review_status
                )
                VALUES (?, ?, 1, 'ready', 'current')
                """,
                (f"version-{suffix}", f"source-{suffix}"),
            )
            connection.execute(
                """
                INSERT INTO chunks(
                    id, knowledge_base_id, source_version_id, index_version_id,
                    page_number, bounding_box_json, original_text, normalized_text, content_hash
                )
                VALUES (?, ?, ?, 'index-current', 1, '{"x":0,"y":0,"width":10,"height":10}',
                        ?, ?, ?)
                """,
                (
                    f"chunk-{suffix}",
                    knowledge_base_id,
                    f"version-{suffix}",
                    f"{suffix.upper()} evidence",
                    f"{suffix.upper()} evidence",
                    f"hash-{suffix}",
                ),
            )
        connection.commit()
    return storage, knowledge_base_id
