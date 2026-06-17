import asyncio
import json
from collections.abc import Sequence
from pathlib import Path

import pytest

from citemind_worker.agent_run_service import AgentRunService
from citemind_worker.agent_skill_service import AgentSkillService
from citemind_worker.knowledge_base_service import KnowledgeBaseService
from citemind_worker.retrieval_service import HybridRetrievalService
from citemind_worker.storage import StorageRuntime
from citemind_worker.storage.full_text import FullTextIndex


class SkillEmbedder:
    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for text in texts:
            if "beta" in text.lower() or "反对" in text:
                vectors.append([0.0, 1.0, 0.0])
            else:
                vectors.append([1.0, 0.0, 0.0])
        return vectors


def test_agent_skill_registry_exposes_versioned_skills_and_native_tools(
    tmp_path: Path,
) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    service = AgentSkillService(storage)

    registry = service.list_skills()
    skill_ids = {skill["id"] for skill in registry["skills"]}
    tool_names = {tool["name"] for tool in registry["nativeTools"]}
    research = service.get_skill("research_brief")

    assert {"research_brief", "multi_source_compare", "citation_conflict_audit"} <= skill_ids
    assert {
        "hybrid_retrieval.search",
        "source.read",
        "source.status_check",
        "citation.validate",
        "output.save",
    } <= tool_names
    assert research["version"] == "1.0.0"
    assert research["executionConstraints"]["mustClassifyEveryFactualClaim"] is True
    assert "verified_evidence" in {item["id"] for item in research["factClasses"]}


def test_research_brief_runs_controlled_tools_and_saves_validated_output(
    tmp_path: Path,
) -> None:
    emitted: list[dict[str, object]] = []
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_skill_fixture(storage)
    agent_runs = AgentRunService(storage, event_sink=emitted.append)
    service = AgentSkillService(
        storage,
        retrieval=HybridRetrievalService(storage, embedder=SkillEmbedder()),
        agent_runs=agent_runs,
    )

    response = asyncio.run(
        service.run_skill(
            knowledge_base_id=knowledge_base_id,
            skill_id="research_brief",
            goal="研究架构决策",
            source_ids=["source-alpha", "source-beta"],
            limit=4,
            candidate_limit=4,
        )
    )

    assert response["run"]["status"] == "completed"
    tool_names = {tool["toolName"] for tool in response["toolCalls"]}
    assert {
        "hybrid_retrieval.search",
        "source.read",
        "source.status_check",
        "citation.validate",
        "output.save",
    } <= tool_names
    final_output = response["outputs"][0]
    skill_output = final_output["payload"]["skillOutput"]
    assert skill_output["skillId"] == "research_brief"
    assert all(
        conclusion["claimType"]
        in {
            "verified_evidence",
            "source_conflict",
            "model_inference",
            "insufficient_evidence",
        }
        for conclusion in skill_output["conclusions"]
    )
    assert response["citations"]
    assert {event["eventType"] for event in emitted} >= {
        "skill.loaded",
        "tool_call.started",
        "output.final.saved",
        "run.completed",
    }


def test_multi_source_compare_marks_source_conflict(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_skill_fixture(storage)
    service = AgentSkillService(
        storage,
        retrieval=HybridRetrievalService(storage, embedder=SkillEmbedder()),
    )

    response = asyncio.run(
        service.run_skill(
            knowledge_base_id=knowledge_base_id,
            skill_id="multi_source_compare",
            goal="架构决策是否支持离线运行",
            source_ids=["source-alpha", "source-beta"],
            limit=4,
            candidate_limit=4,
        )
    )

    skill_output = response["outputs"][0]["payload"]["skillOutput"]

    assert response["run"]["status"] == "completed"
    assert skill_output["skillId"] == "multi_source_compare"
    assert skill_output["conflicts"][0]["claimType"] == "source_conflict"
    assert skill_output["consensus"][0]["claimType"] == "verified_evidence"


def test_citation_conflict_audit_flags_invalid_and_unsupported_claims(
    tmp_path: Path,
) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_skill_fixture(storage)
    service = AgentSkillService(
        storage,
        retrieval=HybridRetrievalService(storage, embedder=SkillEmbedder()),
    )

    response = asyncio.run(
        service.run_skill(
            knowledge_base_id=knowledge_base_id,
            skill_id="citation_conflict_audit",
            goal="审计引用",
            source_ids=["source-alpha"],
            inputs={
                "paragraphs": [
                    {"text": "这是没有证据的结论。", "evidenceChunkIds": []},
                    {"text": "这是错误引用。", "evidenceChunkIds": ["chunk-missing"]},
                ],
                "candidateChunkIds": ["chunk-alpha"],
            },
        )
    )

    skill_output = response["outputs"][0]["payload"]["skillOutput"]

    assert response["run"]["status"] == "completed"
    assert skill_output["unsupportedClaims"][0]["claimType"] == "insufficient_evidence"
    assert skill_output["invalidCitations"]
    assert skill_output["insufficientEvidence"]


def test_agent_tool_invocation_enforces_allowed_tools_and_run_scope(
    tmp_path: Path,
) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_skill_fixture(storage)
    service = AgentSkillService(
        storage,
        retrieval=HybridRetrievalService(storage, embedder=SkillEmbedder()),
    )
    created = service.agent_runs.create(
        knowledge_base_id,
        goal="受控 Tool 测试",
        skill_id="research_brief",
        skill_version="1.0.0",
        source_ids=["source-alpha"],
    )
    run_id = str(created["run"]["id"])

    status = asyncio.run(
        service.invoke_tool(
            run_id,
            tool_name="source.status_check",
            params={},
        )
    )

    assert status["result"]["summary"]["ready"] == 1
    with pytest.raises(ValueError, match="not allowed"):
        asyncio.run(
            service.invoke_tool(
                run_id,
                tool_name="shell.exec",
                params={"cmd": "rm -rf /"},
            )
        )
    with pytest.raises(ValueError, match="source scope"):
        asyncio.run(
            service.invoke_tool(
                run_id,
                tool_name="source.read",
                params={"chunkIds": ["chunk-beta"]},
            )
        )


def _seed_skill_fixture(storage: StorageRuntime) -> str:
    knowledge_base_id = KnowledgeBaseService(storage).create("Skill 测试")["id"]
    assert isinstance(knowledge_base_id, str)
    with storage.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO index_versions(
                id, knowledge_base_id, embedding_provider, embedding_model,
                embedding_dimension, chunking_version, parser_version, status, is_current
            )
            VALUES ('index-current', ?, 'ark', 'embedding-current', 3,
                    'chunk-v1', 'parser-v1', 'ready', 1)
            """,
            (knowledge_base_id,),
        )
        connection.execute(
            """
            INSERT INTO sources(id, knowledge_base_id, source_type, display_name, uri, status)
            VALUES
                ('source-alpha', ?, 'pdf', 'Alpha.pdf', NULL, 'ready'),
                ('source-beta', ?, 'pdf', 'Beta.pdf', NULL, 'ready')
            """,
            (knowledge_base_id, knowledge_base_id),
        )
        connection.execute(
            """
            INSERT INTO source_versions(id, source_id, version_number, status, review_status)
            VALUES
                ('version-alpha', 'source-alpha', 1, 'ready', 'current'),
                ('version-beta', 'source-beta', 1, 'ready', 'current')
            """
        )
        connection.executemany(
            """
            INSERT INTO chunks(
                id, knowledge_base_id, source_version_id, index_version_id,
                page_number, bounding_box_json, heading_path_json, anchor,
                original_text, normalized_text, content_hash
            )
            VALUES (?, ?, ?, 'index-current', ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "chunk-alpha",
                    knowledge_base_id,
                    "version-alpha",
                    1,
                    json.dumps({"x": 1, "y": 2, "width": 3, "height": 4}),
                    json.dumps(["架构"], ensure_ascii=False),
                    "alpha",
                    "架构决策支持离线运行，保留本地 Worker 和本地索引。",
                    "架构决策支持离线运行，保留本地 Worker 和本地索引。",
                    "hash-alpha",
                ),
                (
                    "chunk-beta",
                    knowledge_base_id,
                    "version-beta",
                    2,
                    json.dumps({"x": 2, "y": 3, "width": 4, "height": 5}),
                    json.dumps(["架构"], ensure_ascii=False),
                    "beta",
                    "Beta 来源不支持离线运行，这与 Alpha 来源存在冲突。",
                    "Beta 来源不支持离线运行，这与 Alpha 来源存在冲突。",
                    "hash-beta",
                ),
            ],
        )
        connection.commit()
    full_text = FullTextIndex(storage.database)
    for chunk_id, text in (
        ("chunk-alpha", "架构决策支持离线运行，保留本地 Worker 和本地索引。"),
        ("chunk-beta", "Beta 来源不支持离线运行，这与 Alpha 来源存在冲突。"),
    ):
        full_text.upsert(
            chunk_id=chunk_id,
            knowledge_base_id=knowledge_base_id,
            index_version_id="index-current",
            text=text,
        )
    storage.vector_index.add(
        chunk_id="chunk-alpha",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-current",
        vector=[1.0, 0.0, 0.0],
    )
    storage.vector_index.add(
        chunk_id="chunk-beta",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-current",
        vector=[0.0, 1.0, 0.0],
    )
    return knowledge_base_id
