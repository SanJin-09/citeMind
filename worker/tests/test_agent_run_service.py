from pathlib import Path

import pytest

from citemind_worker.agent_run_service import AgentRunService
from citemind_worker.background_job_service import BackgroundJobService
from citemind_worker.knowledge_base_service import KnowledgeBaseService
from citemind_worker.storage import StorageRuntime


def test_agent_run_persists_context_audit_records_outputs_and_citations(
    tmp_path: Path,
) -> None:
    storage, knowledge_base_id = _seed_agent_storage(tmp_path)
    service = AgentRunService(storage)
    BackgroundJobService(storage).create("source.import", "source-a")

    created = service.create(
        knowledge_base_id,
        goal="生成可信研究简报",
        skill_id="research_brief",
        skill_version="v1",
        source_ids=["source-a"],
        models={"chat": "chat-v1", "embedding": "embedding-v1"},
        budgets={"maxSteps": 5, "maxModelCalls": 3, "maxDurationSeconds": 600},
    )
    run = created["run"]

    assert run["status"] == "planning"
    assert run["knowledgeBaseId"] == knowledge_base_id
    assert run["sourceScope"] == ["source-a"]
    assert run["indexVersionId"] == "index-current"
    assert run["skillId"] == "research_brief"
    assert run["skillVersion"] == "v1"
    assert run["models"] == {"chat": "chat-v1", "embedding": "embedding-v1"}
    assert run["budgets"]["maxSteps"] == 5
    assert created["events"][0]["eventType"] == "run.created"

    run_id = str(run["id"])
    planned = service.update_plan(
        run_id,
        {"steps": [{"id": "s1", "title": "检索证据"}]},
        summary="拆分研究步骤",
    )
    assert planned["run"]["plan"]["steps"][0]["id"] == "s1"

    service.transition(run_id, "executing", stage="retrieval", summary="开始检索")
    tool_started = service.start_tool_call(
        run_id,
        tool_name="hybrid_retrieval.search",
        action_summary="检索可信证据",
        step_id="s1",
        skill_id="research_brief",
        skill_version="v1",
        working_directory="/tmp/citemind",
        sanitized_params={"query": "架构", "apiKey": "***"},
    )
    tool_call_id = str(tool_started["toolCalls"][0]["id"])
    tool_finished = service.finish_tool_call(
        tool_call_id,
        status="completed",
        exit_code=0,
        stdout_summary="找到 1 条证据",
    )
    assert tool_finished["toolCalls"][0]["status"] == "completed"
    assert tool_finished["toolCalls"][0]["sanitizedParams"]["apiKey"] == "***"

    waiting = service.request_confirmation(
        run_id,
        prompt="是否导入外部资料候选？",
        options=[{"id": "reject", "label": "不导入"}],
    )
    confirmation_id = str(waiting["confirmations"][0]["id"])
    assert waiting["run"]["status"] == "waiting_confirmation"
    resolved = service.resolve_confirmation(
        confirmation_id,
        status="rejected",
        decision={"optionId": "reject"},
    )
    assert resolved["run"]["status"] == "executing"

    delegated = service.record_delegation(
        run_id,
        delegatee_role="Auditor",
        task="检查引用有效性",
        input_scope={"chunkIds": ["chunk-a"]},
    )
    assert delegated["delegations"][0]["delegateeRole"] == "Auditor"

    drafted = service.save_output(
        run_id,
        output_type="draft",
        title="研究简报草稿",
        content="Alpha 结论来自证据。",
        citations=[{"paragraphIndex": 0, "chunkId": "chunk-a"}],
    )
    assert drafted["run"]["draft"]["title"] == "研究简报草稿"
    assert drafted["citations"][0]["chunkId"] == "chunk-a"

    final = service.save_output(
        run_id,
        output_type="final",
        title="研究简报",
        content="Alpha 结论来自证据。",
        citations=[{"paragraphIndex": 0, "chunkId": "chunk-a"}],
    )
    completed = service.transition(run_id, "completed", stop_reason="done")

    assert final["run"]["finalOutput"]["title"] == "研究简报"
    assert completed["run"]["status"] == "completed"
    assert completed["run"]["completedAt"] is not None
    assert [event["sequence"] for event in completed["events"]] == list(
        range(1, len(completed["events"]) + 1)
    )
    with storage.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM background_jobs").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM agent_runs").fetchone()[0] == 1


def test_agent_run_rejects_citations_outside_fixed_scope(tmp_path: Path) -> None:
    storage, knowledge_base_id = _seed_agent_storage(tmp_path)
    service = AgentRunService(storage)
    with storage.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO index_versions(
                id, knowledge_base_id, embedding_provider, embedding_model,
                embedding_dimension, chunking_version, parser_version, status, is_current
            )
            VALUES ('index-old', ?, 'ark', 'embedding', 3, 'chunk-v1', 'parser-v1',
                    'ready', 0)
            """,
            (knowledge_base_id,),
        )
        connection.execute(
            """
            INSERT INTO sources(id, knowledge_base_id, source_type, display_name, status)
            VALUES ('source-b', ?, 'pdf', 'Beta.pdf', 'ready')
            """,
            (knowledge_base_id,),
        )
        connection.execute(
            """
            INSERT INTO source_versions(id, source_id, version_number, status, review_status)
            VALUES ('version-b', 'source-b', 1, 'ready', 'current')
            """
        )
        connection.execute(
            """
            INSERT INTO chunks(
                id, knowledge_base_id, source_version_id, index_version_id,
                original_text, normalized_text, content_hash
            )
            VALUES ('chunk-b', ?, 'version-b', 'index-current',
                    'Beta evidence', 'Beta evidence', 'hash-b')
            """,
            (knowledge_base_id,),
        )
        connection.execute(
            """
            INSERT INTO chunks(
                id, knowledge_base_id, source_version_id, index_version_id,
                original_text, normalized_text, content_hash
            )
            VALUES ('chunk-old', ?, 'version-a', 'index-old',
                    'Old evidence', 'Old evidence', 'hash-old')
            """,
            (knowledge_base_id,),
        )
        connection.commit()
    created = service.create(
        knowledge_base_id,
        goal="固定引用范围",
        skill_id="research_brief",
        skill_version="v1",
        source_ids=["source-a"],
    )
    run_id = str(created["run"]["id"])

    with pytest.raises(ValueError, match="source scope"):
        service.save_output(
            run_id,
            output_type="draft",
            title="越界来源",
            content="Beta 不应可引用。",
            citations=[{"paragraphIndex": 0, "chunkId": "chunk-b"}],
        )
    with pytest.raises(ValueError, match="index version"):
        service.save_output(
            run_id,
            output_type="draft",
            title="越界索引",
            content="旧索引不应可引用。",
            citations=[{"paragraphIndex": 0, "chunkId": "chunk-old"}],
        )


def test_agent_run_recovery_pause_cancel_and_retry(tmp_path: Path) -> None:
    storage, knowledge_base_id = _seed_agent_storage(tmp_path)
    service = AgentRunService(storage)

    created = service.create(
        knowledge_base_id,
        goal="恢复测试",
        skill_id="research_brief",
        skill_version="v1",
    )
    run_id = str(created["run"]["id"])
    service.transition(run_id, "executing", stage="draft", summary="开始生成")

    recovered = service.recover_unfinished()

    assert recovered["runs"][0]["id"] == run_id
    assert recovered["runs"][0]["status"] == "paused"

    resumed = service.resume(run_id)
    assert resumed["run"]["status"] == "executing"
    failed = service.fail(run_id, error_message="model timeout", stage="draft")
    assert failed["run"]["status"] == "failed"
    retried = service.retry(run_id)
    assert retried["run"]["status"] == "executing"
    assert retried["run"]["retryCount"] == 1

    cancelled = service.cancel(run_id, reason="user_cancelled")
    assert cancelled["run"]["status"] == "cancelled"
    with pytest.raises(ValueError, match="Invalid AgentRun status transition"):
        service.resume(run_id)


def _seed_agent_storage(tmp_path: Path) -> tuple[StorageRuntime, str]:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = str(KnowledgeBaseService(storage).create("Agent 测试")["id"])
    with storage.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO index_versions(
                id, knowledge_base_id, embedding_provider, embedding_model,
                embedding_dimension, chunking_version, parser_version, status, is_current
            )
            VALUES ('index-current', ?, 'ark', 'embedding', 3, 'chunk-v1', 'parser-v1',
                    'ready', 1)
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
                page_number, bounding_box_json, original_text, normalized_text, content_hash
            )
            VALUES (
                'chunk-a', ?, 'version-a', 'index-current', 1,
                '{"x":1,"y":2,"width":3,"height":4}',
                'Alpha evidence', 'Alpha evidence', 'hash-a'
            )
            """,
            (knowledge_base_id,),
        )
        connection.commit()
    return storage, knowledge_base_id
