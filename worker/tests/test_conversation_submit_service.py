import asyncio
from collections.abc import Mapping, Sequence
from pathlib import Path

import pytest

from citemind_worker.agent_run_service import AgentRunService
from citemind_worker.conversation_service import ConversationService
from citemind_worker.conversation_submit_service import ConversationSubmitService
from citemind_worker.knowledge_base_service import KnowledgeBaseService
from citemind_worker.research_brief_service import ResearchBriefService
from citemind_worker.storage import StorageRuntime


class EmptyRetrieval:
    async def retrieve(
        self,
        knowledge_base_id: str,
        query: str,
        **_kwargs: object,
    ) -> dict[str, object]:
        return {
            "knowledgeBaseId": knowledge_base_id,
            "query": query,
            "indexVersion": {
                "id": "index-current",
                "embeddingProvider": "ark",
                "embeddingModel": "embedding",
                "embeddingDimension": 3,
                "chunkingVersion": "chunk-v1",
                "parserVersion": "parser-v1",
                "status": "ready",
                "isCurrent": True,
                "createdAt": "",
                "chunkCount": 0,
            },
            "limits": {"resultLimit": 8, "candidateLimit": 24},
            "retrieval": {
                "keywordCandidateCount": 0,
                "semanticCandidateCount": 0,
                "mergedCandidateCount": 0,
                "fusion": "reciprocal_rank_fusion",
                "rrfK": 60,
            },
            "rerank": {
                "available": False,
                "applied": False,
                "modelVersion": None,
            },
            "results": [],
            "context": {"chunkCount": 0, "chunks": [], "text": ""},
        }


class RouteGateway:
    def __init__(self, route: str, confidence: float) -> None:
        self.route = route
        self.confidence = confidence
        self.calls = 0

    async def generate_structured(
        self,
        request: dict[str, object],
        schema: dict[str, object],
    ) -> dict[str, object]:
        self.calls += 1
        return {
            "route": self.route,
            "confidence": self.confidence,
            "reason": "test",
        }


class FakeAgentSkillService:
    def __init__(self, agent_runs: AgentRunService) -> None:
        self.agent_runs = agent_runs

    async def run_skill(
        self,
        *,
        knowledge_base_id: str,
        skill_id: str,
        goal: str,
        source_ids: Sequence[str] | None = None,
        inputs: Mapping[str, object] | None = None,
        **_kwargs: object,
    ) -> dict[str, object]:
        created = self.agent_runs.create(
            knowledge_base_id,
            goal=goal,
            skill_id=skill_id,
            skill_version="test",
            source_ids=source_ids,
        )
        run_id = str(_mapping(created["run"])["id"])
        self.agent_runs.transition(run_id, "executing")
        instruction = str((inputs or {}).get("query") or goal)
        content = (
            "# 对话内研究简报\n\n"
            "## 结论\n\n"
            f"已按要求处理：{instruction}\n\n"
            "## 证据\n\nAlpha 证据支持本地研究流程。"
        )
        self.agent_runs.save_output(
            run_id,
            output_type="final",
            title="对话内研究简报",
            content=content,
            payload={
                "skillOutput": {
                    "researchQuestions": ["如何在对话中持续修订？"],
                    "citationValidation": {"valid": True},
                    "conflicts": [],
                    "gaps": [],
                }
            },
            citations=[{"paragraphIndex": 1, "chunkId": "chunk-a"}],
        )
        self.agent_runs.transition(run_id, "completed")
        return self.agent_runs.get(run_id)


def test_explicit_brief_entry_creates_multiple_artifacts_and_updates_in_place(
    tmp_path: Path,
) -> None:
    storage, knowledge_base_id = _seed_storage(tmp_path)
    agent_runs = AgentRunService(storage)
    conversations = ConversationService(
        storage,
        retrieval=EmptyRetrieval(),  # type: ignore[arg-type]
    )
    briefs = ResearchBriefService(
        storage,
        agent_runs=agent_runs,
        agent_skills=FakeAgentSkillService(agent_runs),  # type: ignore[arg-type]
    )
    route_gateway = RouteGateway("answer", 1)
    service = ConversationSubmitService(
        conversations,
        briefs,
        gateway_factory=lambda _key, _base, _model: route_gateway,
    )

    first = asyncio.run(
        service.submit(
            knowledge_base_id=knowledge_base_id,
            query="生成第一份研究简报",
            route_hint="research_brief",
            source_ids=["source-a"],
        )
    )
    conversation_id = str(_mapping(first["conversation"])["id"])
    first_brief = _mapping(first["brief"])
    first_run_id = str(_mapping(first_brief["brief"])["runId"])
    second = asyncio.run(
        service.submit(
            knowledge_base_id=knowledge_base_id,
            conversation_id=conversation_id,
            query="生成第二份研究简报",
            route_hint="research_brief",
            current_brief_run_id=first_run_id,
            source_ids=["source-a"],
        )
    )
    second_run_id = str(_mapping(_mapping(second["brief"])["brief"])["runId"])

    assert route_gateway.calls == 0
    assert first["kind"] == second["kind"] == "research_brief_created"
    assert first_run_id != second_run_id
    citations = first_brief["citations"]
    assert isinstance(citations, list)
    assert _mapping(_mapping(citations[0])["location"]) == {
        "pageNumber": 2,
        "boundingBox": None,
        "headingPath": [],
        "anchor": None,
    }
    loaded_value = conversations.messages(conversation_id)["messages"]
    assert isinstance(loaded_value, list)
    loaded = [_mapping(message) for message in loaded_value]
    full_artifacts = [
        _mapping(message["artifact"])
        for message in loaded
        if _mapping(message["artifact"]).get("display") == "full"
    ]
    assert {item["runId"] for item in full_artifacts} == {
        first_run_id,
        second_run_id,
    }

    update_gateway = RouteGateway("update_research_brief", 0.95)
    service.gateway_factory = lambda _key, _base, _model: update_gateway
    updated = asyncio.run(
        service.submit(
            knowledge_base_id=knowledge_base_id,
            conversation_id=conversation_id,
            query="把结论改得更具体",
            route_hint="auto",
            current_brief_run_id=first_run_id,
            api_key="test-key",
        )
    )

    assert updated["kind"] == "research_brief_updated"
    assert _mapping(_mapping(updated["assistantMessage"])["artifact"]) == {
        "type": "research_brief",
        "runId": first_run_id,
        "display": "reference",
    }
    updated_workspace = _mapping(_mapping(updated["brief"])["workspace"])
    assert "把结论改得更具体" in str(updated_workspace["final"])

    other = conversations.ensure_conversation(
        knowledge_base_id=knowledge_base_id,
        conversation_id=None,
        title="其他对话",
        model_id="test-model",
    )
    with pytest.raises(ValueError, match="does not belong"):
        asyncio.run(
            service.submit(
                knowledge_base_id=knowledge_base_id,
                conversation_id=str(other["id"]),
                query="修改第一份简报",
                route_hint="auto",
                current_brief_run_id=first_run_id,
                api_key="test-key",
            )
        )

    conversations.delete(conversation_id)
    with storage.database.connect() as connection:
        remaining = connection.execute("SELECT COUNT(*) FROM agent_runs").fetchone()[0]
    assert remaining == 0


def test_low_confidence_auto_route_falls_back_to_answer(tmp_path: Path) -> None:
    storage, knowledge_base_id = _seed_storage(tmp_path)
    agent_runs = AgentRunService(storage)
    route_gateway = RouteGateway("create_research_brief", 0.79)
    service = ConversationSubmitService(
        ConversationService(
            storage,
            retrieval=EmptyRetrieval(),  # type: ignore[arg-type]
        ),
        ResearchBriefService(
            storage,
            agent_runs=agent_runs,
            agent_skills=FakeAgentSkillService(agent_runs),  # type: ignore[arg-type]
        ),
        gateway_factory=lambda _key, _base, _model: route_gateway,
    )

    response = asyncio.run(
        service.submit(
            knowledge_base_id=knowledge_base_id,
            query="帮我解释 Alpha",
            route_hint="auto",
            api_key="test-key",
        )
    )

    assert response["kind"] == "answer"
    assert route_gateway.calls == 1
    with storage.database.connect() as connection:
        count = connection.execute(
            """
            SELECT COUNT(*)
            FROM agent_runs
            WHERE skill_id = 'research_brief'
              AND research_workspace_json != '{}'
            """
        ).fetchone()[0]
    assert count == 0


def _seed_storage(tmp_path: Path) -> tuple[StorageRuntime, str]:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = str(KnowledgeBaseService(storage).create("Artifact 测试")["id"])
    with storage.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO index_versions(
                id, knowledge_base_id, embedding_provider, embedding_model,
                embedding_dimension, chunking_version, parser_version, status, is_current
            )
            VALUES ('index-current', ?, 'ark', 'embedding', 3,
                    'chunk-v1', 'parser-v1', 'ready', 1)
            """,
            (knowledge_base_id,),
        )
        connection.execute(
            """
            INSERT INTO sources(id, knowledge_base_id, source_type, display_name, status)
            VALUES ('source-a', ?, 'pdf', 'Alpha.pdf', 'ready')
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
            INSERT INTO chunks(
                id, knowledge_base_id, source_version_id, index_version_id,
                page_number, original_text, normalized_text, content_hash
            )
            VALUES ('chunk-a', ?, 'version-a', 'index-current', 2,
                    'Alpha 证据支持本地研究流程。',
                    'Alpha 证据支持本地研究流程。',
                    'hash-a')
            """,
            (knowledge_base_id,),
        )
        connection.commit()
    return storage, knowledge_base_id


def _mapping(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}
