import asyncio
import json
from collections.abc import Mapping
from pathlib import Path

import pytest

from citemind_worker.agent_run_service import AgentRunService
from citemind_worker.agent_subagent_service import AgentSubAgentService
from citemind_worker.knowledge_base_service import KnowledgeBaseService
from citemind_worker.storage import StorageRuntime


class FakeSubAgentTools:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def __call__(
        self,
        tool_name: str,
        params: Mapping[str, object],
        step_id: str,
        action_summary: str,
    ) -> dict[str, object]:
        self.calls.append(
            {
                "toolName": tool_name,
                "params": dict(params),
                "stepId": step_id,
                "actionSummary": action_summary,
            }
        )
        if tool_name == "source.status_check":
            return {"summary": {"ready": 1, "unavailable": 0}}
        if tool_name == "hybrid_retrieval.search":
            return {
                "indexVersion": {"id": "index-current"},
                "results": [
                    {
                        "chunkId": "chunk-alpha",
                        "source": {"id": "source-alpha"},
                    }
                ],
            }
        if tool_name == "source.read":
            return {
                "chunks": [
                    {
                        "chunkId": "chunk-alpha",
                        "source": {
                            "id": "source-alpha",
                            "displayName": "Alpha.pdf",
                        },
                        "text": {
                            "original": "架构支持离线运行。",
                            "normalized": "架构支持离线运行。",
                        },
                    }
                ]
            }
        if tool_name == "citation.validate":
            paragraphs = params.get("paragraphs")
            return {
                "valid": True,
                "paragraphs": paragraphs if isinstance(paragraphs, list) else [],
                "validCitations": [
                    {
                        "paragraphIndex": 0,
                        "chunkId": "chunk-alpha",
                    }
                ],
                "invalidCitations": [],
            }
        raise AssertionError(f"unexpected tool: {tool_name}")


def test_evidence_scout_uses_minimal_scope_and_persists_audit_record(
    tmp_path: Path,
) -> None:
    storage, run_id = _seed_sub_agent_storage(tmp_path)
    tools = FakeSubAgentTools()
    service = AgentSubAgentService(storage)

    result = asyncio.run(
        service.run(
            run_id,
            role="Evidence Scout",
            task="只研究 Alpha 来源的离线能力",
            input_scope={
                "question": "是否支持离线运行？",
                "sourceIds": ["source-alpha"],
                "limit": 4,
                "candidateLimit": 8,
            },
            executor=tools,
        )
    )

    output = result["output"]
    assert output["candidateChunkIds"] == ["chunk-alpha"]
    assert [call["toolName"] for call in tools.calls] == [
        "source.status_check",
        "hybrid_retrieval.search",
        "source.read",
    ]
    assert tools.calls[1]["params"]["sourceIds"] == ["source-alpha"]
    response = AgentRunService(storage).get(run_id)
    delegation = response["delegations"][0]
    assert delegation["delegateeRole"] == "Evidence Scout"
    assert delegation["status"] == "completed"
    assert delegation["inputScope"]["sourceIds"] == ["source-alpha"]
    assert delegation["inputScope"]["canDelegate"] is False
    assert delegation["inputScope"]["allowedTools"] == [
        "source.status_check",
        "hybrid_retrieval.search",
        "source.read",
    ]
    assert delegation["output"]["candidateCount"] == 1
    assert delegation["stopReason"] == "completed_within_budget"


def test_auditor_independently_validates_citations(tmp_path: Path) -> None:
    storage, run_id = _seed_sub_agent_storage(tmp_path)
    tools = FakeSubAgentTools()
    service = AgentSubAgentService(storage)

    result = asyncio.run(
        service.run(
            run_id,
            role="Auditor",
            task="独立审计引用",
            input_scope={
                "sourceIds": ["source-alpha"],
                "paragraphs": [
                    {
                        "text": "架构支持离线运行。",
                        "evidenceChunkIds": ["chunk-alpha"],
                    }
                ],
                "candidateChunkIds": ["chunk-alpha"],
            },
            executor=tools,
        )
    )

    output = result["output"]
    assert output["validation"]["valid"] is True
    assert output["auditedParagraphCount"] == 1
    assert [call["toolName"] for call in tools.calls] == [
        "source.read",
        "citation.validate",
    ]
    delegation = AgentRunService(storage).get(run_id)["delegations"][0]
    assert delegation["output"]["valid"] is True
    assert delegation["output"]["invalidCitationCount"] == 0
    assert delegation["stopReason"] == "completed_within_budget"


def test_sub_agent_rejects_recursive_delegation_and_out_of_scope_source(
    tmp_path: Path,
) -> None:
    storage, run_id = _seed_sub_agent_storage(tmp_path)
    service = AgentSubAgentService(storage)
    tools = FakeSubAgentTools()

    with pytest.raises(PermissionError, match="recursive"):
        asyncio.run(
            service.run(
                run_id,
                role="Evidence Scout",
                task="递归委派",
                input_scope={"question": "测试"},
                executor=tools,
                caller_delegation_id="delegation-parent",
            )
        )
    with pytest.raises(ValueError, match="source scope"):
        asyncio.run(
            service.run(
                run_id,
                role="Evidence Scout",
                task="越界来源",
                input_scope={
                    "question": "测试",
                    "sourceIds": ["source-beta"],
                },
                executor=tools,
            )
        )
    assert AgentRunService(storage).get(run_id)["delegations"] == []


def test_sub_agent_parallel_limits_are_enforced(tmp_path: Path) -> None:
    storage, run_id = _seed_sub_agent_storage(tmp_path)
    service = AgentSubAgentService(storage)
    tools = FakeSubAgentTools()

    with pytest.raises(ValueError, match="parallel batch limit"):
        asyncio.run(
            service.run_many(
                run_id,
                [
                    {
                        "role": "Evidence Scout",
                        "task": f"问题 {index}",
                        "inputScope": {"question": f"问题 {index}"},
                    }
                    for index in range(3)
                ],
                executor=tools,
            )
        )

    agent_runs = AgentRunService(storage)
    delegation_ids: list[str] = []
    for index in range(3):
        response = agent_runs.record_delegation(
            run_id,
            delegatee_role="Auditor",
            task=f"审计 {index}",
            input_scope={"candidateChunkIds": ["chunk-alpha"]},
        )
        delegation = next(
            item for item in response["delegations"] if item["task"] == f"审计 {index}"
        )
        delegation_ids.append(str(delegation["id"]))
    agent_runs.start_delegation(delegation_ids[2])
    agent_runs.start_delegation(delegation_ids[1])
    with pytest.raises(ValueError, match="parallel limit"):
        agent_runs.start_delegation(delegation_ids[0])


def _seed_sub_agent_storage(tmp_path: Path) -> tuple[StorageRuntime, str]:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = str(KnowledgeBaseService(storage).create("子 Agent 测试")["id"])
    with storage.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO index_versions(
                id, knowledge_base_id, embedding_provider, embedding_model,
                embedding_dimension, chunking_version, parser_version, status, is_current
            )
            VALUES (
                'index-current', ?, 'ark', 'embedding', 3,
                'chunk-v1', 'parser-v1', 'ready', 1
            )
            """,
            (knowledge_base_id,),
        )
        connection.execute(
            """
            INSERT INTO sources(
                id, knowledge_base_id, source_type, display_name, status
            )
            VALUES ('source-alpha', ?, 'pdf', 'Alpha.pdf', 'ready')
            """,
            (knowledge_base_id,),
        )
        connection.execute(
            """
            INSERT INTO source_versions(
                id, source_id, version_number, status, review_status
            )
            VALUES ('version-alpha', 'source-alpha', 1, 'ready', 'current')
            """
        )
        connection.execute(
            """
            INSERT INTO chunks(
                id, knowledge_base_id, source_version_id, index_version_id,
                page_number, bounding_box_json, original_text, normalized_text,
                content_hash
            )
            VALUES (
                'chunk-alpha', ?, 'version-alpha', 'index-current',
                1, ?, '架构支持离线运行。', '架构支持离线运行。', 'hash-alpha'
            )
            """,
            (
                knowledge_base_id,
                json.dumps({"x": 1, "y": 1, "width": 10, "height": 10}),
            ),
        )
        connection.commit()
    created = AgentRunService(storage).create(
        knowledge_base_id,
        goal="执行受限子 Agent",
        skill_id="research_brief",
        skill_version="1.0.0",
        source_ids=["source-alpha"],
    )
    return storage, str(created["run"]["id"])
