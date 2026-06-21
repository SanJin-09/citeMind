import asyncio
import json
import os
import re
import shutil
import sqlite3
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol, cast
from uuid import uuid4

from citemind_worker.agent_run_service import AgentRunService
from citemind_worker.indexing_service import IndexingService
from citemind_worker.model_catalog import DEFAULT_ARK_BASE_URL, DEFAULT_EMBEDDING_MODEL
from citemind_worker.source_import_service import SourceImportService
from citemind_worker.storage import StorageRuntime

MCP_PROTOCOL_VERSION = "2025-11-25"
MAX_TOOL_RESULT_CHARS = 500_000
MAX_CANDIDATE_CONTENT_CHARS = 200_000
MAX_CANDIDATES_PER_SEARCH = 20
UNSAFE_TOOL_NAME = re.compile(
    r"(create|delete|destroy|drop|edit|execute|install|mutate|patch|post|publish|remove|"
    r"rename|send|shell|update|upload|write)",
    re.IGNORECASE,
)


class McpTransport(Protocol):
    async def discover(self, config: Mapping[str, object]) -> dict[str, object]:
        pass

    async def call_tool(
        self,
        config: Mapping[str, object],
        tool_name: str,
        arguments: Mapping[str, object],
    ) -> dict[str, object]:
        pass


@dataclass(slots=True)
class StdioMcpTransport:
    async def discover(self, config: Mapping[str, object]) -> dict[str, object]:
        return await self._session(config, method="tools/list", params={})

    async def call_tool(
        self,
        config: Mapping[str, object],
        tool_name: str,
        arguments: Mapping[str, object],
    ) -> dict[str, object]:
        return await self._session(
            config,
            method="tools/call",
            params={"name": tool_name, "arguments": dict(arguments)},
        )

    async def _session(
        self,
        config: Mapping[str, object],
        *,
        method: str,
        params: Mapping[str, object],
    ) -> dict[str, object]:
        command = str(config["command"])
        args = _string_list(config.get("args"))
        env = os.environ.copy()
        for key in _string_list(config.get("envKeys")):
            if key in os.environ:
                env[key] = os.environ[key]
        timeout_value = config.get("timeoutSeconds", 30)
        timeout = timeout_value if isinstance(timeout_value, int) else 30
        executable = shutil.which(command) if not os.path.isabs(command) else command
        if not executable:
            raise ValueError(f"MCP 服务命令不存在：{command}")
        process = await asyncio.create_subprocess_exec(
            executable,
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        try:
            if process.stdin is None or process.stdout is None:
                raise RuntimeError("MCP stdio 管道创建失败")
            await self._write(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": MCP_PROTOCOL_VERSION,
                        "capabilities": {},
                        "clientInfo": {"name": "citeMind", "version": "0.1.0"},
                    },
                },
            )
            initialized = await self._read_response(process, request_id=1, timeout=timeout)
            negotiated = initialized.get("protocolVersion")
            if not isinstance(negotiated, str) or not negotiated:
                raise ValueError("MCP 服务未返回协议版本")
            await self._write(
                process,
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
            )
            await self._write(
                process,
                {"jsonrpc": "2.0", "id": 2, "method": method, "params": dict(params)},
            )
            return await self._read_response(process, request_id=2, timeout=timeout)
        finally:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=2)
                except TimeoutError:
                    process.kill()
                    await process.wait()

    @staticmethod
    async def _write(
        process: asyncio.subprocess.Process,
        payload: Mapping[str, object],
    ) -> None:
        assert process.stdin is not None
        process.stdin.write(
            (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        )
        await process.stdin.drain()

    async def _read_response(
        self,
        process: asyncio.subprocess.Process,
        *,
        request_id: int,
        timeout: int,
    ) -> dict[str, object]:
        stdout = process.stdout
        assert stdout is not None

        async def read() -> dict[str, object]:
            while True:
                line = await stdout.readline()
                if not line:
                    stderr = ""
                    if process.stderr is not None:
                        stderr = (await process.stderr.read()).decode(errors="replace")[:1000]
                    raise RuntimeError(f"MCP 服务提前退出：{stderr or '无错误输出'}")
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(message, dict):
                    continue
                if message.get("method") == "ping" and "id" in message:
                    await self._write(
                        process,
                        {"jsonrpc": "2.0", "id": message["id"], "result": {}},
                    )
                    continue
                if message.get("id") != request_id:
                    continue
                error = message.get("error")
                if isinstance(error, dict):
                    raise RuntimeError(str(error.get("message") or "MCP 调用失败"))
                result = message.get("result")
                if not isinstance(result, dict):
                    raise RuntimeError("MCP 返回结果格式无效")
                return cast(dict[str, object], result)

        return await asyncio.wait_for(read(), timeout=timeout)


class McpClientManager:
    def __init__(
        self,
        storage: StorageRuntime,
        *,
        transport: McpTransport | None = None,
        agent_runs: AgentRunService | None = None,
    ) -> None:
        self.storage = storage
        self.transport = transport or StdioMcpTransport()
        self.agent_runs = agent_runs or AgentRunService(storage)

    def list_servers(self) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM mcp_server_configs ORDER BY created_at ASC"
            ).fetchall()
        return {"servers": [self._server_record(row) for row in rows]}

    def upsert_server(
        self,
        *,
        server_id: str | None,
        name: str,
        command: str,
        args: Sequence[str] | None = None,
        env_keys: Sequence[str] | None = None,
        read_only_tools: Sequence[str] | None = None,
        enabled: bool = True,
        timeout_seconds: int = 30,
    ) -> dict[str, object]:
        clean_name = _required_text(name, "name")
        clean_command = _required_text(command, "command")
        if timeout_seconds < 1 or timeout_seconds > 300:
            raise ValueError("timeoutSeconds must be between 1 and 300")
        clean_args = [_required_text(item, "arg") for item in args or []]
        clean_env_keys = [_env_key(item) for item in env_keys or []]
        clean_tools = [_tool_name(item) for item in read_only_tools or []]
        target_id = server_id or f"mcp-server-{uuid4().hex}"
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO mcp_server_configs(
                    id, name, transport, command, args_json, env_keys_json,
                    read_only_tools_json, enabled, timeout_seconds
                )
                VALUES (?, ?, 'stdio', ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    command = excluded.command,
                    args_json = excluded.args_json,
                    env_keys_json = excluded.env_keys_json,
                    read_only_tools_json = excluded.read_only_tools_json,
                    enabled = excluded.enabled,
                    timeout_seconds = excluded.timeout_seconds,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                """,
                (
                    target_id,
                    clean_name,
                    clean_command,
                    _json(clean_args),
                    _json(clean_env_keys),
                    _json(clean_tools),
                    int(enabled),
                    timeout_seconds,
                ),
            )
            connection.commit()
        return self.get_server(target_id)

    def delete_server(self, server_id: str) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            try:
                cursor = connection.execute(
                    "DELETE FROM mcp_server_configs WHERE id = ?",
                    (server_id,),
                )
                connection.commit()
            except sqlite3.IntegrityError as error:
                raise ValueError("该 MCP 服务已有审计记录，不能删除；可将其停用") from error
        if cursor.rowcount == 0:
            raise ValueError("MCP server not found")
        return self.list_servers()

    def get_server(self, server_id: str) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM mcp_server_configs WHERE id = ?",
                (server_id,),
            ).fetchone()
        if row is None:
            raise ValueError("MCP server not found")
        return self._server_record(row)

    async def discover(self, server_id: str) -> dict[str, object]:
        config = self.get_server(server_id)
        try:
            result = await self.transport.discover(config)
            tools = [
                _safe_tool_descriptor(item, config) for item in _object_list(result.get("tools"))
            ]
            with self.storage.database.connect() as connection:
                connection.execute(
                    """
                    UPDATE mcp_server_configs
                    SET last_error = NULL,
                        last_discovered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE id = ?
                    """,
                    (server_id,),
                )
                connection.commit()
            return {"server": self.get_server(server_id), "tools": tools}
        except Exception as error:
            self._record_error(server_id, str(error))
            raise

    def set_run_access(
        self,
        run_id: str,
        *,
        enabled: bool,
        server_ids: Sequence[str],
    ) -> dict[str, object]:
        run = self.agent_runs.get(run_id)["run"]
        if not isinstance(run, dict):
            raise ValueError("AgentRun not found")
        clean_ids = list(dict.fromkeys(server_ids))
        if enabled and not clean_ids:
            raise ValueError("启用外部资料时至少选择一个 MCP 服务")
        for server_id in clean_ids:
            server = self.get_server(server_id)
            if server["enabled"] is not True:
                raise ValueError("MCP 服务已停用")
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO agent_run_mcp_access(
                    run_id, enabled, server_ids_json, enabled_at, disabled_at
                )
                VALUES (
                    ?, ?, ?,
                    CASE WHEN ? = 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END,
                    CASE WHEN ? = 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
                )
                ON CONFLICT(run_id) DO UPDATE SET
                    enabled = excluded.enabled,
                    server_ids_json = excluded.server_ids_json,
                    enabled_at = CASE
                        WHEN excluded.enabled = 1
                        THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                        ELSE agent_run_mcp_access.enabled_at
                    END,
                    disabled_at = CASE
                        WHEN excluded.enabled = 0
                        THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                        ELSE NULL
                    END,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                """,
                (run_id, int(enabled), _json(clean_ids), int(enabled), int(enabled)),
            )
            connection.commit()
        agent_run = self.agent_runs.record_external_access(
            run_id,
            enabled=enabled,
            server_ids=clean_ids,
        )
        return {
            "runId": run_id,
            "enabled": enabled,
            "serverIds": clean_ids,
            "agentRun": agent_run,
        }

    async def call_read_only_tool(
        self,
        run_id: str,
        *,
        server_id: str,
        tool_name: str,
        arguments: Mapping[str, object],
    ) -> dict[str, object]:
        self._ensure_run_access(run_id, server_id)
        config = self.get_server(server_id)
        allowed = set(_string_list(config.get("readOnlyTools")))
        clean_tool_name = _tool_name(tool_name)
        if clean_tool_name not in allowed or UNSAFE_TOOL_NAME.search(clean_tool_name):
            raise PermissionError("MCP Tool 不在本地只读白名单中")
        discovery = await self.discover(server_id)
        descriptor = next(
            (
                item
                for item in _object_list(discovery.get("tools"))
                if item.get("name") == clean_tool_name
            ),
            None,
        )
        if descriptor is None or descriptor.get("locallyAllowedReadOnly") is not True:
            raise PermissionError("MCP Tool 未通过只读能力校验")
        try:
            result = await self.transport.call_tool(
                config,
                clean_tool_name,
                _sanitize_arguments(arguments),
            )
        except Exception as error:
            self._record_error(server_id, str(error))
            raise
        if result.get("isError") is True:
            raise RuntimeError(_tool_result_text(result)[:1000] or "MCP Tool 返回错误")
        serialized = json.dumps(result, ensure_ascii=False)
        if len(serialized) > MAX_TOOL_RESULT_CHARS:
            raise ValueError("MCP Tool 返回内容超过安全限制")
        return result

    def _ensure_run_access(self, run_id: str, server_id: str) -> None:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                "SELECT enabled, server_ids_json FROM agent_run_mcp_access WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        if row is None or not bool(row["enabled"]):
            raise PermissionError("本次 AgentRun 未启用寻找外部资料")
        if server_id not in _json_string_list(row["server_ids_json"]):
            raise PermissionError("本次 AgentRun 未授权该 MCP 服务")

    def _record_error(self, server_id: str, message: str) -> None:
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE mcp_server_configs
                SET last_error = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (message[:1000], server_id),
            )
            connection.commit()

    @staticmethod
    def _server_record(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": str(row["id"]),
            "name": str(row["name"]),
            "transport": str(row["transport"]),
            "command": str(row["command"]),
            "args": _json_string_list(row["args_json"]),
            "envKeys": _json_string_list(row["env_keys_json"]),
            "readOnlyTools": _json_string_list(row["read_only_tools_json"]),
            "enabled": bool(row["enabled"]),
            "timeoutSeconds": int(row["timeout_seconds"]),
            "lastError": row["last_error"],
            "lastDiscoveredAt": row["last_discovered_at"],
            "createdAt": str(row["created_at"]),
            "updatedAt": str(row["updated_at"]),
        }


class ExternalResearchService:
    def __init__(
        self,
        storage: StorageRuntime,
        *,
        manager: McpClientManager | None = None,
        agent_runs: AgentRunService | None = None,
        source_imports: SourceImportService | None = None,
        indexes: IndexingService | None = None,
    ) -> None:
        self.storage = storage
        self.agent_runs = agent_runs or AgentRunService(storage)
        self.manager = manager or McpClientManager(storage, agent_runs=self.agent_runs)
        self.source_imports = source_imports or SourceImportService(storage)
        self.indexes = indexes or IndexingService(storage)

    def list_candidates(self, run_id: str) -> dict[str, object]:
        self.agent_runs.get(run_id)
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT *
                FROM external_research_candidates
                WHERE run_id = ?
                ORDER BY created_at DESC
                """,
                (run_id,),
            ).fetchall()
        return {"runId": run_id, "candidates": [self._candidate_record(row) for row in rows]}

    async def search(
        self,
        run_id: str,
        *,
        query: str,
        searches: Sequence[Mapping[str, object]],
        limit: int = 8,
    ) -> dict[str, object]:
        clean_query = _required_text(query, "query")
        if limit < 1 or limit > MAX_CANDIDATES_PER_SEARCH:
            raise ValueError("limit must be between 1 and 20")
        if not searches:
            raise ValueError("至少选择一个 MCP 只读检索 Tool")
        run_response = self.agent_runs.get(run_id)
        run = run_response["run"]
        if not isinstance(run, dict):
            raise ValueError("AgentRun not found")
        errors: list[dict[str, str]] = []
        added: list[dict[str, object]] = []
        for search in searches:
            server_id = _required_text(str(search.get("serverId", "")), "serverId")
            tool_name = _required_text(str(search.get("toolName", "")), "toolName")
            started = self.agent_runs.start_tool_call(
                run_id,
                tool_name=f"mcp:{server_id}:{tool_name}",
                action_summary="通过外部 MCP 只读 Tool 寻找候选资料",
                sanitized_params={"query": clean_query, "limit": limit},
            )
            tool_calls = _object_list(started.get("toolCalls"))
            if not tool_calls:
                raise RuntimeError("AgentRun Tool Trace 创建失败")
            tool_call_id = str(tool_calls[0]["id"])
            try:
                result = await self.manager.call_read_only_tool(
                    run_id,
                    server_id=server_id,
                    tool_name=tool_name,
                    arguments={"query": clean_query, "limit": limit},
                )
                candidates = _extract_candidates(result)[:limit]
                for candidate in candidates:
                    record = self._save_candidate(
                        run_id=run_id,
                        server_id=server_id,
                        tool_name=tool_name,
                        candidate=candidate,
                        knowledge_base_id=str(run["knowledgeBaseId"]),
                    )
                    if record is not None:
                        added.append(record)
                self.agent_runs.finish_tool_call(
                    tool_call_id,
                    status="completed",
                    exit_code=0,
                    stdout_summary=f"发现 {len(candidates)} 条外部资料候选",
                )
            except Exception as error:
                errors.append({"serverId": server_id, "toolName": tool_name, "error": str(error)})
                self.agent_runs.finish_tool_call(
                    tool_call_id,
                    status="failed",
                    exit_code=1,
                    error_message=str(error),
                )
        response = self.list_candidates(run_id)
        response_candidates = _object_list(response.get("candidates"))
        if response_candidates:
            confirmation = self.agent_runs.request_confirmation(
                run_id,
                prompt="请选择要导入、快照并索引的外部资料候选",
                options=[
                    {
                        "id": item["id"],
                        "label": item["title"],
                        "url": item["url"],
                        "comparison": item["initialComparison"],
                    }
                    for item in response_candidates
                    if item.get("status") == "candidate"
                ],
            )
            pending = next(
                (
                    item
                    for item in _object_list(confirmation.get("confirmations"))
                    if item["status"] == "pending"
                ),
                None,
            )
            response["confirmationId"] = pending["id"] if isinstance(pending, dict) else None
        else:
            self.manager.set_run_access(run_id, enabled=False, server_ids=[])
        response["addedCount"] = len(added)
        response["errors"] = errors
        response["agentRun"] = self.agent_runs.get(run_id)
        return response

    async def decide(
        self,
        run_id: str,
        *,
        confirmation_id: str,
        candidate_ids: Sequence[str],
        decision: str,
        api_key: str | None = None,
        base_url: str = DEFAULT_ARK_BASE_URL,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
    ) -> dict[str, object]:
        if decision not in {"import", "reject"}:
            raise ValueError("decision must be import or reject")
        selected = set(candidate_ids)
        current = self.list_candidates(run_id)
        candidates = [
            item
            for item in _object_list(current.get("candidates"))
            if item.get("status") == "candidate"
        ]
        if decision == "import" and not selected:
            raise ValueError("至少选择一个外部资料候选")
        imported: list[tuple[str, str]] = []
        failures: list[dict[str, str]] = []
        for candidate in candidates:
            candidate_id = str(candidate["id"])
            should_import = decision == "import" and candidate_id in selected
            if not should_import:
                self._update_candidate(candidate_id, status="rejected")
                continue
            self._update_candidate(candidate_id, status="importing")
            try:
                result = self.source_imports.import_external_snapshot(
                    str(candidate["knowledgeBaseId"]),
                    str(candidate["url"]),
                    display_name=str(candidate["title"]),
                    content=str(candidate["content"] or candidate["snippet"]),
                    metadata={
                        "candidateId": candidate_id,
                        "serverId": candidate["serverId"],
                        "toolName": candidate["toolName"],
                        "sourceMetadata": candidate["sourceMetadata"],
                    },
                )
                parse_check = result.get("parseCheck")
                if not isinstance(parse_check, dict):
                    raise RuntimeError("外部资料导入结果无效")
                source_id = str(parse_check["sourceId"])
                if parse_check.get("status") == "duplicate":
                    self.source_imports.resolve_duplicate(source_id, "keep")
                elif parse_check.get("status") not in {"success", "needs_ocr"}:
                    raise RuntimeError(str(parse_check.get("errorMessage") or "外部资料导入失败"))
                self._update_candidate(
                    candidate_id,
                    status="importing",
                    imported_source_id=source_id,
                )
                imported.append((candidate_id, source_id))
            except Exception as error:
                failures.append({"candidateId": candidate_id, "error": str(error)})
                self._update_candidate(
                    candidate_id,
                    status="failed",
                    error_message=str(error),
                )
        index_version_id: str | None = None
        if imported:
            try:
                index_result = await self.indexes.build_index(
                    str(candidates[0]["knowledgeBaseId"]),
                    api_key=api_key,
                    base_url=base_url,
                    embedding_model=embedding_model,
                )
                index_version = index_result.get("indexVersion")
                if not isinstance(index_version, dict) or not isinstance(
                    index_version.get("id"), str
                ):
                    raise RuntimeError("外部资料索引结果无效")
                index_version_id = str(index_version["id"])
                for candidate_id, source_id in imported:
                    final_comparison = self._compare_with_knowledge_base(
                        str(candidates[0]["knowledgeBaseId"]),
                        self._candidate_content(candidate_id),
                        excluding_source_id=source_id,
                        index_version_id=index_version_id,
                    )
                    self._update_candidate(
                        candidate_id,
                        status="indexed",
                        indexed_version_id=index_version_id,
                        final_comparison=final_comparison,
                    )
                    self.agent_runs.attach_indexed_source(
                        run_id,
                        source_id=source_id,
                        index_version_id=index_version_id,
                        candidate_id=candidate_id,
                    )
            except Exception as error:
                for candidate_id, _source_id in imported:
                    failures.append({"candidateId": candidate_id, "error": str(error)})
                    self._update_candidate(
                        candidate_id,
                        status="failed",
                        error_message=f"快照已保存，但索引失败：{error}",
                    )
        confirmation_status = "confirmed" if decision == "import" else "rejected"
        self.agent_runs.resolve_confirmation(
            confirmation_id,
            status=confirmation_status,
            decision={
                "decision": decision,
                "candidateIds": list(selected),
                "indexVersionId": index_version_id,
                "failures": failures,
            },
        )
        self.manager.set_run_access(run_id, enabled=False, server_ids=[])
        response = self.list_candidates(run_id)
        response["indexVersionId"] = index_version_id
        response["failures"] = failures
        response["agentRun"] = self.agent_runs.get(run_id)
        return response

    def _save_candidate(
        self,
        *,
        run_id: str,
        server_id: str,
        tool_name: str,
        candidate: Mapping[str, object],
        knowledge_base_id: str,
    ) -> dict[str, object] | None:
        url = candidate.get("url")
        title = candidate.get("title")
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            return None
        if not isinstance(title, str) or not title.strip():
            title = url
        snippet = str(candidate.get("snippet") or "")[:4000]
        content = str(candidate.get("content") or snippet)[:MAX_CANDIDATE_CONTENT_CHARS]
        metadata = candidate.get("metadata")
        safe_metadata = _safe_metadata(metadata if isinstance(metadata, dict) else {})
        comparison = self._compare_with_knowledge_base(knowledge_base_id, content)
        candidate_id = f"external-candidate-{uuid4().hex}"
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO external_research_candidates(
                    id, run_id, server_id, tool_name, title, url, snippet, content,
                    source_metadata_json, initial_comparison_json, status
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate')
                ON CONFLICT(run_id, url) DO UPDATE SET
                    title = excluded.title,
                    snippet = excluded.snippet,
                    content = excluded.content,
                    source_metadata_json = excluded.source_metadata_json,
                    initial_comparison_json = excluded.initial_comparison_json,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                """,
                (
                    candidate_id,
                    run_id,
                    server_id,
                    tool_name,
                    title.strip()[:500],
                    url[:4000],
                    snippet,
                    content,
                    _json(safe_metadata),
                    _json(comparison),
                ),
            )
            connection.commit()
            row = connection.execute(
                "SELECT * FROM external_research_candidates WHERE run_id = ? AND url = ?",
                (run_id, url[:4000]),
            ).fetchone()
        return self._candidate_record(row) if row is not None else None

    def _compare_with_knowledge_base(
        self,
        knowledge_base_id: str,
        content: str,
        *,
        excluding_source_id: str | None = None,
        index_version_id: str | None = None,
    ) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT c.normalized_text, s.id AS source_id, s.display_name
                FROM chunks c
                JOIN source_versions sv ON sv.id = c.source_version_id
                JOIN sources s ON s.id = sv.source_id
                JOIN index_versions iv ON iv.id = c.index_version_id
                WHERE c.knowledge_base_id = ?
                  AND iv.status = 'ready'
                  AND (
                      (? IS NULL AND iv.is_current = 1)
                      OR c.index_version_id = ?
                  )
                  AND (? IS NULL OR s.id != ?)
                LIMIT 500
                """,
                (
                    knowledge_base_id,
                    index_version_id,
                    index_version_id,
                    excluding_source_id,
                    excluding_source_id,
                ),
            ).fetchall()
        candidate_terms = _terms(content)
        matches: list[dict[str, object]] = []
        candidate_negative = _has_negation(content)
        for row in rows:
            text = str(row["normalized_text"])
            terms = _terms(text)
            union = candidate_terms | terms
            overlap = len(candidate_terms & terms) / len(union) if union else 0.0
            if overlap <= 0:
                continue
            matches.append(
                {
                    "sourceId": str(row["source_id"]),
                    "displayName": str(row["display_name"]),
                    "overlap": round(overlap, 4),
                    "polarityConflict": candidate_negative != _has_negation(text),
                }
            )
        matches.sort(key=lambda item: float(str(item["overlap"])), reverse=True)
        top = matches[:3]
        has_conflict = any(
            item["polarityConflict"] is True and float(str(item["overlap"])) >= 0.08 for item in top
        )
        best_overlap = float(str(top[0]["overlap"])) if top else 0.0
        classification = (
            "conflict" if has_conflict else "consensus" if best_overlap >= 0.12 else "supplement"
        )
        return {
            "classification": classification,
            "label": {
                "consensus": "与当前知识库存在共识",
                "supplement": "补充当前知识库",
                "conflict": "与当前知识库可能冲突",
            }[classification],
            "matches": top,
        }

    def _candidate_content(self, candidate_id: str) -> str:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                "SELECT content FROM external_research_candidates WHERE id = ?",
                (candidate_id,),
            ).fetchone()
        if row is None:
            raise ValueError("External candidate not found")
        return str(row["content"])

    def _update_candidate(
        self,
        candidate_id: str,
        *,
        status: str,
        imported_source_id: str | None = None,
        indexed_version_id: str | None = None,
        final_comparison: Mapping[str, object] | None = None,
        error_message: str | None = None,
    ) -> None:
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE external_research_candidates
                SET status = ?,
                    imported_source_id = COALESCE(?, imported_source_id),
                    indexed_version_id = COALESCE(?, indexed_version_id),
                    final_comparison_json = CASE
                        WHEN ? = 0 THEN final_comparison_json
                        ELSE ?
                    END,
                    error_message = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (
                    status,
                    imported_source_id,
                    indexed_version_id,
                    int(final_comparison is not None),
                    _json(final_comparison or {}),
                    error_message[:1000] if error_message else None,
                    candidate_id,
                ),
            )
            connection.commit()

    def _candidate_record(self, row: sqlite3.Row) -> dict[str, object]:
        run = self.agent_runs.get(str(row["run_id"]))["run"]
        knowledge_base_id = run["knowledgeBaseId"] if isinstance(run, dict) else None
        return {
            "id": str(row["id"]),
            "runId": str(row["run_id"]),
            "knowledgeBaseId": knowledge_base_id,
            "serverId": str(row["server_id"]),
            "toolName": str(row["tool_name"]),
            "title": str(row["title"]),
            "url": str(row["url"]),
            "snippet": str(row["snippet"]),
            "content": str(row["content"]),
            "sourceMetadata": _json_object(row["source_metadata_json"]),
            "initialComparison": _json_object(row["initial_comparison_json"]),
            "finalComparison": _json_object(row["final_comparison_json"]),
            "status": str(row["status"]),
            "importedSourceId": row["imported_source_id"],
            "indexedVersionId": row["indexed_version_id"],
            "errorMessage": row["error_message"],
            "createdAt": str(row["created_at"]),
            "updatedAt": str(row["updated_at"]),
        }


def _safe_tool_descriptor(
    value: Mapping[str, object],
    config: Mapping[str, object],
) -> dict[str, object]:
    name = str(value.get("name") or "")
    annotations = value.get("annotations")
    hints = annotations if isinstance(annotations, dict) else {}
    locally_allowed = (
        name in set(_string_list(config.get("readOnlyTools")))
        and hints.get("readOnlyHint") is True
        and hints.get("destructiveHint") is not True
        and UNSAFE_TOOL_NAME.search(name) is None
    )
    return {
        "name": name,
        "title": str(value.get("title") or hints.get("title") or name),
        "description": str(value.get("description") or "")[:1000],
        "inputSchema": value.get("inputSchema")
        if isinstance(value.get("inputSchema"), dict)
        else {},
        "annotations": {
            "readOnlyHint": hints.get("readOnlyHint") is True,
            "destructiveHint": hints.get("destructiveHint") is not False,
        },
        "locallyAllowedReadOnly": locally_allowed,
        "trustNotice": "MCP Tool 描述和注解是不可信提示；实际调用仍受本地白名单约束。",
    }


def _extract_candidates(result: Mapping[str, object]) -> list[dict[str, object]]:
    structured = result.get("structuredContent")
    values: list[object] = []
    if isinstance(structured, dict):
        for key in ("candidates", "results", "items", "documents"):
            items = structured.get(key)
            if isinstance(items, list):
                values.extend(items)
                break
        if not values:
            values.append(structured)
    content = result.get("content")
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "resource_link":
                values.append(item)
            elif item.get("type") == "resource" and isinstance(item.get("resource"), dict):
                values.append(item["resource"])
            elif item.get("type") == "text" and isinstance(item.get("text"), str):
                text = str(item["text"])
                try:
                    parsed = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, list):
                    values.extend(parsed)
                elif isinstance(parsed, dict):
                    nested = next(
                        (
                            parsed[key]
                            for key in ("candidates", "results", "items", "documents")
                            if isinstance(parsed.get(key), list)
                        ),
                        None,
                    )
                    values.extend(nested if isinstance(nested, list) else [parsed])
    candidates: list[dict[str, object]] = []
    for value in values:
        if not isinstance(value, dict):
            continue
        url = value.get("url", value.get("uri", value.get("link")))
        title = value.get("title", value.get("name"))
        snippet = value.get("snippet", value.get("description", value.get("summary", "")))
        body = value.get("content", value.get("text", snippet))
        candidates.append(
            {
                "url": url,
                "title": title,
                "snippet": snippet,
                "content": body,
                "metadata": {
                    key: item
                    for key, item in value.items()
                    if key not in {"content", "text", "snippet", "description", "summary"}
                },
            }
        )
    return candidates


def _tool_result_text(result: Mapping[str, object]) -> str:
    texts: list[str] = []
    for item in _object_list(result.get("content")):
        if item.get("type") == "text" and isinstance(item.get("text"), str):
            texts.append(str(item["text"]))
    return "\n".join(texts)


def _sanitize_arguments(arguments: Mapping[str, object]) -> dict[str, object]:
    safe: dict[str, object] = {}
    for key, value in arguments.items():
        normalized = key.lower().replace("_", "")
        if normalized in {"apikey", "authorization", "credential", "password", "secret", "token"}:
            continue
        if isinstance(value, str):
            safe[key] = value[:10_000]
        elif isinstance(value, bool | int | float) or value is None:
            safe[key] = value
        elif isinstance(value, list):
            safe[key] = value[:100]
        elif isinstance(value, dict):
            safe[key] = _sanitize_arguments(value)
    return safe


def _safe_metadata(value: Mapping[str, object]) -> dict[str, object]:
    return {
        key: item[:2000] if isinstance(item, str) else item
        for key, item in value.items()
        if isinstance(item, str | bool | int | float) or item is None
    }


def _terms(text: str) -> set[str]:
    lowered = text.lower()
    latin = re.findall(r"[a-z0-9][a-z0-9_-]{1,}", lowered)
    chinese_runs = re.findall(r"[\u4e00-\u9fff]{2,}", lowered)
    chinese = [
        run[index : index + 2] for run in chinese_runs for index in range(max(0, len(run) - 1))
    ]
    return set(latin + chinese)


def _has_negation(text: str) -> bool:
    lowered = text.lower()
    return any(
        marker in lowered
        for marker in ("不", "无", "未", "否", "禁止", "不能", "not ", "no ", "never")
    )


def _required_text(value: str, label: str) -> str:
    clean = " ".join(value.split())
    if not clean:
        raise ValueError(f"{label} must be a non-empty string")
    return clean


def _env_key(value: str) -> str:
    clean = _required_text(value, "envKey")
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", clean) is None:
        raise ValueError("envKey 格式无效")
    return clean


def _tool_name(value: str) -> str:
    clean = _required_text(value, "toolName")
    if re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", clean) is None:
        raise ValueError("MCP toolName 格式无效")
    return clean


def _object_list(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    return [cast(dict[str, object], item) for item in value if isinstance(item, dict)]


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_object(value: object) -> dict[str, object]:
    if not isinstance(value, str):
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return cast(dict[str, object], parsed) if isinstance(parsed, dict) else {}


def _json_string_list(value: object) -> list[str]:
    if not isinstance(value, str):
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    return [item for item in parsed if isinstance(item, str)] if isinstance(parsed, list) else []
