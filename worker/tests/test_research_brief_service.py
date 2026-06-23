import asyncio
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

from citemind_worker.agent_run_service import AgentRunService
from citemind_worker.knowledge_base_service import KnowledgeBaseService
from citemind_worker.research_brief_service import ResearchBriefService
from citemind_worker.storage import StorageRuntime


class FakeAgentSkillService:
    def __init__(self, agent_runs: AgentRunService) -> None:
        self.agent_runs = agent_runs
        self.before_return: Callable[[], None] | None = None
        self.call_count = 0

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
        self.call_count += 1
        created = self.agent_runs.create(
            knowledge_base_id,
            goal=goal,
            skill_id=skill_id,
            skill_version="test",
            source_ids=source_ids,
        )
        run_id = str(created["run"]["id"])
        self.agent_runs.update_plan(
            run_id,
            {"steps": [{"id": "step-1", "title": "生成研究简报"}]},
        )
        self.agent_runs.transition(run_id, "executing")
        if skill_id == "citation_conflict_audit":
            content = "引用审计完成。"
            skill_output: dict[str, object] = {
                "valid": False,
                "invalidCitations": [{"chunkId": "chunk-a"}],
                "conflicts": [{"summary": "来源表述存在差异"}],
            }
        else:
            content = (
                "# 研究简报\n\n"
                "## 核心结论\n\nAlpha 证据支持本地研究流程。\n\n"
                "## 风险\n\n仍需补充外部资料。"
            )
            skill_output = {
                "researchQuestions": ["本地研究流程是否可靠？"],
                "citationValidation": {"valid": True},
                "conflicts": [],
                "gaps": [{"summary": "缺少外部资料"}],
                "inputs": dict(inputs or {}),
            }
        self.agent_runs.save_output(
            run_id,
            output_type="final",
            title="本地研究流程简报",
            content=content,
            payload={"skillOutput": skill_output},
            citations=[{"paragraphIndex": 0, "chunkId": "chunk-a"}],
        )
        self.agent_runs.transition(run_id, "completed")
        if self.before_return is not None:
            callback = self.before_return
            self.before_return = None
            callback()
        return self.agent_runs.get(run_id)


def test_research_brief_persists_manual_edits_and_exports(tmp_path: Path) -> None:
    storage, knowledge_base_id = _seed_research_storage(tmp_path)
    agent_runs = AgentRunService(storage)
    fake_skills = FakeAgentSkillService(agent_runs)
    service = ResearchBriefService(
        storage,
        agent_runs=agent_runs,
        agent_skills=fake_skills,  # type: ignore[arg-type]
    )

    created = asyncio.run(
        service.create(
            knowledge_base_id,
            goal="研究本地工作流",
            source_ids=["source-a"],
        )
    )
    run_id = str(created["brief"]["runId"])

    assert created["brief"]["agentRevision"] == 1
    assert created["workspace"]["sections"]
    assert service.list_briefs(knowledge_base_id)["briefs"][0]["runId"] == run_id

    updated = service.update(
        run_id,
        expected_revision=0,
        patch={"draft": "人工修订后的草稿", "title": "人工标题"},
        source_ids=[],
    )

    assert updated["brief"]["userRevision"] == 1
    assert updated["brief"]["sourceIds"] == []
    assert updated["workspace"]["draft"] == "人工修订后的草稿"
    assert updated["workspace"]["lastEditOrigin"] == "user"
    exported = service.export_markdown(run_id)
    assert exported["fileName"] == "人工标题.md"


def test_agent_update_waits_for_merge_when_user_edits_during_operation(
    tmp_path: Path,
) -> None:
    storage, knowledge_base_id = _seed_research_storage(tmp_path)
    agent_runs = AgentRunService(storage)
    fake_skills = FakeAgentSkillService(agent_runs)
    service = ResearchBriefService(
        storage,
        agent_runs=agent_runs,
        agent_skills=fake_skills,  # type: ignore[arg-type]
    )
    created = asyncio.run(
        service.create(
            knowledge_base_id,
            goal="研究并发编辑保护",
            source_ids=["source-a"],
        )
    )
    run_id = str(created["brief"]["runId"])
    original_draft = str(created["workspace"]["draft"])
    fake_skills.before_return = lambda: service.update(
        run_id,
        expected_revision=0,
        patch={"draft": "执行期间的人工编辑"},
    )

    pending = asyncio.run(
        service.operate(
            run_id,
            action="continue_research",
            expected_revision=0,
            selection_text="继续补充这一结论",
        )
    )

    assert pending["workspace"]["draft"] == "执行期间的人工编辑"
    assert pending["brief"]["hasPendingAgentUpdate"] is True
    assert pending["pendingAgentUpdate"]["action"] == "continue_research"
    assert pending["workspace"]["draft"] != original_draft

    applied = service.resolve_pending(
        run_id,
        decision="apply",
        expected_revision=1,
    )
    assert applied["brief"]["hasPendingAgentUpdate"] is False
    assert len(applied["workspace"]["sections"]) == 3


def test_research_brief_audits_selected_text_without_replacing_draft(
    tmp_path: Path,
) -> None:
    storage, knowledge_base_id = _seed_research_storage(tmp_path)
    agent_runs = AgentRunService(storage)
    service = ResearchBriefService(
        storage,
        agent_runs=agent_runs,
        agent_skills=FakeAgentSkillService(agent_runs),  # type: ignore[arg-type]
    )
    created = asyncio.run(
        service.create(
            knowledge_base_id,
            goal="审计研究结论",
            source_ids=["source-a"],
        )
    )
    run_id = str(created["brief"]["runId"])
    draft = str(created["workspace"]["draft"])

    audited = asyncio.run(
        service.operate(
            run_id,
            action="audit_citations",
            expected_revision=0,
            selection_text="Alpha 证据支持本地研究流程。",
        )
    )

    assert audited["workspace"]["draft"] == draft
    assert audited["workspace"]["latestAudit"]["invalidCitations"]
    assert audited["workspace"]["conflicts"]


def _seed_research_storage(tmp_path: Path) -> tuple[StorageRuntime, str]:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = str(KnowledgeBaseService(storage).create("研究简报测试")["id"])
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
                original_text, normalized_text, content_hash
            )
            VALUES ('chunk-a', ?, 'version-a', 'index-current',
                    'Alpha 证据支持本地研究流程。',
                    'Alpha 证据支持本地研究流程。',
                    'hash-a')
            """,
            (knowledge_base_id,),
        )
        connection.commit()
    return storage, knowledge_base_id
