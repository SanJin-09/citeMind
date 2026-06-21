import asyncio
from collections.abc import Mapping, Sequence
from pathlib import Path

import pytest

from citemind_worker.agent_run_service import AgentRunService
from citemind_worker.citation_validator import CitationValidator
from citemind_worker.indexing_service import IndexingService
from citemind_worker.knowledge_base_service import KnowledgeBaseService
from citemind_worker.mcp_client_manager import (
    ExternalResearchService,
    McpClientManager,
)
from citemind_worker.source_import_service import SourceImportService
from citemind_worker.storage import StorageRuntime


class ExternalEmbedder:
    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [[1.0, 0.0, 0.0] for _text in texts]


class FakeMcpTransport:
    def __init__(self, *, unsafe: bool = False) -> None:
        self.unsafe = unsafe
        self.calls: list[tuple[str, dict[str, object]]] = []

    async def discover(self, config: Mapping[str, object]) -> dict[str, object]:
        return {
            "tools": [
                {
                    "name": "search_web" if not self.unsafe else "publish_search",
                    "title": "网页检索",
                    "description": "外部服务提供的描述不参与权限决策。",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"query": {"type": "string"}},
                    },
                    "annotations": {
                        "readOnlyHint": True,
                        "destructiveHint": False,
                    },
                }
            ]
        }

    async def call_tool(
        self,
        config: Mapping[str, object],
        tool_name: str,
        arguments: Mapping[str, object],
    ) -> dict[str, object]:
        self.calls.append((tool_name, dict(arguments)))
        return {
            "structuredContent": {
                "results": [
                    {
                        "title": "外部架构说明",
                        "url": "https://external.example/architecture",
                        "snippet": "外部资料补充本地索引的审计说明。",
                        "content": "架构支持本地索引，并要求外部资料先保存快照和完成索引。",
                        "author": "External Author",
                    },
                    {
                        "title": "未选择候选",
                        "url": "https://external.example/rejected",
                        "content": "这条候选不会进入知识库。",
                    },
                ]
            },
            "content": [],
            "isError": False,
        }


def test_external_research_requires_explicit_access_and_completes_import_loop(
    tmp_path: Path,
) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("MCP 外部资料")["id"]
    assert isinstance(knowledge_base_id, str)
    source_imports = SourceImportService(storage)
    initial = source_imports.import_external_snapshot(
        knowledge_base_id,
        "https://local.example/base",
        display_name="当前知识库资料",
        content="架构支持本地索引，并要求所有引用可以定位。",
    )
    assert initial["parseCheck"]["status"] == "success"
    indexes = IndexingService(storage, embedder=ExternalEmbedder())
    initial_index = asyncio.run(indexes.build_index(knowledge_base_id))
    assert initial_index["ready"] is True

    agent_runs = AgentRunService(storage)
    created = agent_runs.create(
        knowledge_base_id,
        goal="寻找外部资料并完成引用闭环",
        skill_id="research_brief",
        skill_version="1.0.0",
    )
    run_id = str(created["run"]["id"])
    transport = FakeMcpTransport()
    manager = McpClientManager(storage, transport=transport, agent_runs=agent_runs)
    server = manager.upsert_server(
        server_id=None,
        name="测试检索服务",
        command="fake-mcp",
        read_only_tools=["search_web"],
    )
    server_id = str(server["id"])
    research = ExternalResearchService(
        storage,
        manager=manager,
        agent_runs=agent_runs,
        source_imports=source_imports,
        indexes=indexes,
    )

    with pytest.raises(PermissionError, match="未启用"):
        asyncio.run(
            manager.call_read_only_tool(
                run_id,
                server_id=server_id,
                tool_name="search_web",
                arguments={"query": "架构"},
            )
        )

    manager.set_run_access(run_id, enabled=True, server_ids=[server_id])
    found = asyncio.run(
        research.search(
            run_id,
            query="架构审计",
            searches=[{"serverId": server_id, "toolName": "search_web"}],
        )
    )

    assert found["addedCount"] == 2
    assert found["confirmationId"]
    assert found["agentRun"]["run"]["status"] == "waiting_confirmation"
    candidates = found["candidates"]
    selected_id = next(item["id"] for item in candidates if item["url"].endswith("/architecture"))
    result = asyncio.run(
        research.decide(
            run_id,
            confirmation_id=str(found["confirmationId"]),
            candidate_ids=[str(selected_id)],
            decision="import",
            embedding_model="embedding-test",
        )
    )

    indexed = next(item for item in result["candidates"] if item["id"] == selected_id)
    rejected = next(item for item in result["candidates"] if item["url"].endswith("/rejected"))
    assert indexed["status"] == "indexed"
    assert indexed["importedSourceId"] in result["agentRun"]["run"]["sourceScope"]
    assert indexed["indexedVersionId"] == result["agentRun"]["run"]["indexVersionId"]
    assert indexed["finalComparison"]["classification"] in {
        "consensus",
        "supplement",
        "conflict",
    }
    assert rejected["status"] == "rejected"
    assert result["agentRun"]["run"]["status"] == "executing"

    with storage.database.connect() as connection:
        source_version = connection.execute(
            """
            SELECT sv.snapshot_path
            FROM source_versions sv
            WHERE sv.source_id = ?
            """,
            (indexed["importedSourceId"],),
        ).fetchone()
        chunk = connection.execute(
            """
            SELECT id
            FROM chunks
            WHERE source_version_id IN (
                SELECT id FROM source_versions WHERE source_id = ?
            )
              AND index_version_id = ?
            LIMIT 1
            """,
            (indexed["importedSourceId"], indexed["indexedVersionId"]),
        ).fetchone()
    assert source_version is not None
    snapshot_path = Path(str(source_version["snapshot_path"]))
    assert snapshot_path.is_file()
    assert "citemind-mcp-metadata" in snapshot_path.read_text(encoding="utf-8")
    assert chunk is not None

    validation = CitationValidator(storage).validate(
        paragraphs=[
            {
                "text": "外部资料已确认。",
                "evidenceChunkIds": [str(chunk["id"])],
            }
        ],
        candidate_chunk_ids=[str(chunk["id"])],
        index_version_id=str(indexed["indexedVersionId"]),
    )
    assert validation["valid"] is True


def test_external_candidate_cannot_be_cited_after_gate_is_revoked(tmp_path: Path) -> None:
    storage, indexed, chunk_id = _indexed_external_candidate(tmp_path)
    with storage.database.connect() as connection:
        connection.execute(
            """
            UPDATE external_research_candidates
            SET status = 'failed'
            WHERE id = ?
            """,
            (indexed["id"],),
        )
        connection.commit()

    validation = CitationValidator(storage).validate(
        paragraphs=[{"text": "不应引用", "evidenceChunkIds": [chunk_id]}],
        candidate_chunk_ids=[chunk_id],
        index_version_id=str(indexed["indexedVersionId"]),
    )

    assert validation["valid"] is False
    assert validation["invalidCitations"][0]["reason"] == "external_source_not_confirmed_indexed"


def test_mcp_tool_annotations_cannot_override_local_read_only_policy(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    transport = FakeMcpTransport(unsafe=True)
    manager = McpClientManager(storage, transport=transport)
    server = manager.upsert_server(
        server_id=None,
        name="危险服务",
        command="fake-mcp",
        read_only_tools=["publish_search"],
    )

    discovery = asyncio.run(manager.discover(str(server["id"])))

    assert discovery["tools"][0]["annotations"]["readOnlyHint"] is True
    assert discovery["tools"][0]["locallyAllowedReadOnly"] is False


def _indexed_external_candidate(
    tmp_path: Path,
) -> tuple[StorageRuntime, dict[str, object], str]:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("引用门禁")["id"]
    assert isinstance(knowledge_base_id, str)
    source_imports = SourceImportService(storage)
    source_imports.import_external_snapshot(
        knowledge_base_id,
        "https://local.example/base",
        display_name="本地资料",
        content="本地索引基础资料。",
    )
    indexes = IndexingService(storage, embedder=ExternalEmbedder())
    asyncio.run(indexes.build_index(knowledge_base_id))
    agent_runs = AgentRunService(storage)
    run_id = str(
        agent_runs.create(
            knowledge_base_id,
            goal="引用门禁",
            skill_id="research_brief",
            skill_version="1.0.0",
        )["run"]["id"]
    )
    manager = McpClientManager(
        storage,
        transport=FakeMcpTransport(),
        agent_runs=agent_runs,
    )
    server = manager.upsert_server(
        server_id=None,
        name="测试服务",
        command="fake-mcp",
        read_only_tools=["search_web"],
    )
    server_id = str(server["id"])
    manager.set_run_access(run_id, enabled=True, server_ids=[server_id])
    research = ExternalResearchService(
        storage,
        manager=manager,
        agent_runs=agent_runs,
        source_imports=source_imports,
        indexes=indexes,
    )
    found = asyncio.run(
        research.search(
            run_id,
            query="架构",
            searches=[{"serverId": server_id, "toolName": "search_web"}],
            limit=1,
        )
    )
    selected_id = str(found["candidates"][0]["id"])
    decided = asyncio.run(
        research.decide(
            run_id,
            confirmation_id=str(found["confirmationId"]),
            candidate_ids=[selected_id],
            decision="import",
            embedding_model="embedding-test",
        )
    )
    indexed = next(item for item in decided["candidates"] if item["id"] == selected_id)
    with storage.database.connect() as connection:
        chunk = connection.execute(
            """
            SELECT c.id
            FROM chunks c
            JOIN source_versions sv ON sv.id = c.source_version_id
            WHERE sv.source_id = ? AND c.index_version_id = ?
            LIMIT 1
            """,
            (indexed["importedSourceId"], indexed["indexedVersionId"]),
        ).fetchone()
    assert chunk is not None
    return storage, indexed, str(chunk["id"])
