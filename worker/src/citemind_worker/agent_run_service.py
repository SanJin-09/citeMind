import json
import re
import sqlite3
from collections.abc import Callable, Mapping, Sequence
from typing import Literal, cast
from uuid import uuid4

from citemind_worker.model_catalog import DEFAULT_CHAT_MODEL, DEFAULT_EMBEDDING_MODEL
from citemind_worker.storage import StorageRuntime

AgentRunStatus = Literal[
    "planning",
    "waiting_confirmation",
    "executing",
    "paused",
    "completed",
    "cancelled",
    "failed",
]

TERMINAL_STATUSES = {"completed", "cancelled"}
RECOVERABLE_STATUSES = {"planning", "executing"}

ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "planning": {"waiting_confirmation", "executing", "paused", "cancelled", "failed"},
    "waiting_confirmation": {"executing", "paused", "cancelled", "failed"},
    "executing": {"waiting_confirmation", "paused", "completed", "cancelled", "failed"},
    "paused": {"planning", "waiting_confirmation", "executing", "cancelled", "failed"},
    "completed": set(),
    "cancelled": set(),
    "failed": set(),
}

DEFAULT_BUDGETS: dict[str, object] = {
    "maxSteps": 24,
    "maxModelCalls": 12,
    "maxInputTokens": 120000,
    "maxOutputTokens": 24000,
    "maxEstimatedCostCny": None,
    "maxDurationSeconds": 1800,
}

DEFAULT_USAGE: dict[str, object] = {
    "steps": 0,
    "modelCalls": 0,
    "inputTokens": 0,
    "outputTokens": 0,
    "estimatedCostCny": None,
}

TRACE_PHASES: tuple[dict[str, str], ...] = (
    {"id": "planning", "label": "规划"},
    {"id": "evidence_retrieval", "label": "检索证据"},
    {"id": "source_reading", "label": "读取来源"},
    {"id": "tool_calling", "label": "调用 Tool"},
    {"id": "drafting", "label": "生成草稿"},
    {"id": "citation_validation", "label": "引用校验"},
    {"id": "conflict_audit", "label": "冲突审计"},
    {"id": "waiting_confirmation", "label": "等待用户确认"},
    {"id": "finalizing", "label": "整理最终结果"},
)

TRACE_SENSITIVE_KEYS = {
    "apikey",
    "api_key",
    "authorization",
    "credential",
    "documenttext",
    "fullprompt",
    "password",
    "prompt",
    "rawcontent",
    "secret",
    "token",
}
TRACE_TEXT_LIMIT = 800
TRACE_SUMMARY_LIMIT = 240
TraceEventSink = Callable[[dict[str, object]], None]
DELEGATE_ROLES = {"Evidence Scout", "Auditor"}
MAX_PARALLEL_DELEGATIONS = 2


class AgentRunService:
    def __init__(
        self,
        storage: StorageRuntime,
        *,
        event_sink: TraceEventSink | None = None,
    ) -> None:
        self.storage = storage
        self._event_sink = event_sink

    def set_event_sink(self, event_sink: TraceEventSink | None) -> None:
        self._event_sink = event_sink

    def create(
        self,
        knowledge_base_id: str,
        *,
        goal: str,
        skill_id: str,
        skill_version: str,
        title: str | None = None,
        source_ids: Sequence[str] | None = None,
        index_version_id: str | None = None,
        models: Mapping[str, object] | None = None,
        budgets: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        clean_goal = _required_text(goal, "goal")
        clean_skill_id = _required_text(skill_id, "skillId")
        clean_skill_version = _required_text(skill_version, "skillVersion")
        self._ensure_knowledge_base(knowledge_base_id)
        resolved_index_version_id = index_version_id or self._current_index_version_id(
            knowledge_base_id
        )
        if resolved_index_version_id is None:
            raise ValueError("当前知识库没有可用于 AgentRun 的索引版本")
        self._ensure_index_version(knowledge_base_id, resolved_index_version_id)
        source_scope = self._source_scope(knowledge_base_id, source_ids)
        normalized_models = {
            "chat": DEFAULT_CHAT_MODEL,
            "embedding": DEFAULT_EMBEDDING_MODEL,
            **dict(models or {}),
        }
        normalized_budgets = _normalize_budgets(budgets)
        run_id = f"agent-run-{uuid4().hex}"
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO agent_runs(
                    id, knowledge_base_id, title, goal, skill_id, skill_version,
                    status, source_scope_json, index_version_id, models_json,
                    budgets_json, usage_json, started_at
                )
                VALUES (
                    ?, ?, ?, ?, ?, ?, 'planning', ?, ?, ?, ?, ?,
                    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                )
                """,
                (
                    run_id,
                    knowledge_base_id,
                    _title(title, clean_goal),
                    clean_goal,
                    clean_skill_id,
                    clean_skill_version,
                    _json(source_scope),
                    resolved_index_version_id,
                    _json(normalized_models),
                    _json(normalized_budgets),
                    _json(DEFAULT_USAGE),
                ),
            )
            event = self._insert_event(
                connection,
                run_id,
                event_type="run.created",
                stage="planning",
                status="planning",
                title="AgentRun 已创建",
                summary=clean_goal,
                payload={
                    "knowledgeBaseId": knowledge_base_id,
                    "sourceScope": source_scope,
                    "indexVersionId": resolved_index_version_id,
                    "skillId": clean_skill_id,
                    "skillVersion": clean_skill_version,
                    "models": normalized_models,
                    "budgets": normalized_budgets,
                },
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def list_runs(
        self,
        knowledge_base_id: str,
        *,
        include_terminal: bool = True,
        limit: int = 50,
    ) -> dict[str, object]:
        self._ensure_knowledge_base(knowledge_base_id)
        if limit < 1 or limit > 200:
            raise ValueError("limit must be between 1 and 200")
        where = "knowledge_base_id = ?"
        params: list[object] = [knowledge_base_id]
        if not include_terminal:
            where += " AND status NOT IN ('completed', 'cancelled')"
        params.append(limit)
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                f"""
                SELECT *
                FROM agent_runs
                WHERE {where}
                ORDER BY updated_at DESC, created_at DESC
                LIMIT ?
                """,
                params,
            ).fetchall()
        return {
            "knowledgeBaseId": knowledge_base_id,
            "runs": [self._run_record(row) for row in rows],
        }

    def get(self, run_id: str) -> dict[str, object]:
        row = self._run_row(run_id)
        with self.storage.database.connect() as connection:
            events = connection.execute(
                """
                SELECT *
                FROM agent_run_events
                WHERE run_id = ?
                ORDER BY sequence ASC
                """,
                (run_id,),
            ).fetchall()
            tool_calls = connection.execute(
                """
                SELECT *
                FROM agent_run_tool_calls
                WHERE run_id = ?
                ORDER BY started_at DESC
                """,
                (run_id,),
            ).fetchall()
            confirmations = connection.execute(
                """
                SELECT *
                FROM agent_run_confirmations
                WHERE run_id = ?
                ORDER BY requested_at DESC
                """,
                (run_id,),
            ).fetchall()
            delegations = connection.execute(
                """
                SELECT *
                FROM agent_run_delegations
                WHERE run_id = ?
                ORDER BY created_at DESC
                """,
                (run_id,),
            ).fetchall()
            outputs = connection.execute(
                """
                SELECT *
                FROM agent_run_outputs
                WHERE run_id = ?
                ORDER BY updated_at DESC, created_at DESC
                """,
                (run_id,),
            ).fetchall()
            citations = connection.execute(
                """
                SELECT *
                FROM agent_run_citations
                WHERE run_id = ?
                ORDER BY output_id, paragraph_index, chunk_id
                """,
                (run_id,),
            ).fetchall()
        return {
            "run": self._run_record(row),
            "events": [self._event_record(item) for item in events],
            "toolCalls": [self._tool_call_record(item) for item in tool_calls],
            "confirmations": [self._confirmation_record(item) for item in confirmations],
            "delegations": [self._delegation_record(item) for item in delegations],
            "outputs": [self._output_record(item) for item in outputs],
            "citations": [self._citation_record(item) for item in citations],
        }

    def update_plan(
        self,
        run_id: str,
        plan: Mapping[str, object],
        *,
        summary: str | None = None,
    ) -> dict[str, object]:
        self._ensure_mutable(run_id)
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE agent_runs
                SET plan_json = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (_json(plan), run_id),
            )
            event = self._insert_event(
                connection,
                run_id,
                event_type="plan.updated",
                stage="planning",
                status=self._status_in_connection(connection, run_id),
                title="计划已更新",
                summary=summary,
                payload={"plan": dict(plan)},
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def record_stage(
        self,
        run_id: str,
        *,
        stage: str,
        status: Literal["started", "completed"],
        title: str | None = None,
        summary: str | None = None,
        step_id: str | None = None,
        duration_ms: int | None = None,
    ) -> dict[str, object]:
        self._ensure_active_or_failed(run_id)
        event_type = f"stage.{status}"
        with self.storage.database.connect() as connection:
            event = self._insert_event(
                connection,
                run_id,
                event_type=event_type,
                stage=stage,
                status=self._status_in_connection(connection, run_id),
                title=title or _stage_label(stage, status),
                summary=summary,
                payload={"stepId": step_id} if step_id is not None else {},
                step_id=step_id,
                duration_ms=duration_ms if status == "completed" else None,
                completed_at="now" if status == "completed" else None,
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def record_workspace_event(
        self,
        run_id: str,
        *,
        event_type: str,
        title: str,
        summary: str | None = None,
        payload: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        """Record workspace activity without requiring the anchor run to be active."""
        self._run_row(run_id)
        with self.storage.database.connect() as connection:
            event = self._insert_event(
                connection,
                run_id,
                event_type=_required_text(event_type, "eventType"),
                stage="drafting",
                status=self._status_in_connection(connection, run_id),
                title=_required_text(title, "title"),
                summary=summary,
                payload=dict(payload or {}),
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def record_skill_loaded(
        self,
        run_id: str,
        *,
        skill_id: str,
        skill_version: str,
        summary: str | None = None,
    ) -> dict[str, object]:
        self._ensure_active_or_failed(run_id)
        clean_skill_id = _required_text(skill_id, "skillId")
        clean_skill_version = _required_text(skill_version, "skillVersion")
        with self.storage.database.connect() as connection:
            event = self._insert_event(
                connection,
                run_id,
                event_type="skill.loaded",
                stage="planning",
                status=self._status_in_connection(connection, run_id),
                title=f"Skill 已加载：{clean_skill_id}",
                summary=summary or clean_skill_version,
                payload={"skillId": clean_skill_id, "skillVersion": clean_skill_version},
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def transition(
        self,
        run_id: str,
        status: AgentRunStatus,
        *,
        stage: str | None = None,
        summary: str | None = None,
        error_message: str | None = None,
        stop_reason: str | None = None,
    ) -> dict[str, object]:
        current = self._run_row(run_id)
        current_status = str(current["status"])
        _ensure_transition(current_status, status)
        event_type = _event_type_for_status(status)
        with self.storage.database.connect() as connection:
            completed_at_sql = (
                "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
                if status in TERMINAL_STATUSES or status == "failed"
                else "completed_at"
            )
            connection.execute(
                f"""
                UPDATE agent_runs
                SET status = ?,
                    error_message = ?,
                    stop_reason = ?,
                    completed_at = {completed_at_sql},
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (status, error_message, stop_reason, run_id),
            )
            event = self._insert_event(
                connection,
                run_id,
                event_type=event_type,
                stage=stage,
                status=status,
                title=_title_for_status(status),
                summary=summary or stop_reason or error_message,
                payload={
                    "fromStatus": current_status,
                    "toStatus": status,
                    "errorMessage": error_message,
                    "stopReason": stop_reason,
                },
                completed_at="now" if status in TERMINAL_STATUSES or status == "failed" else None,
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def pause(self, run_id: str) -> dict[str, object]:
        return self.transition(run_id, "paused", summary="AgentRun 已暂停")

    def resume(self, run_id: str) -> dict[str, object]:
        return self.transition(run_id, "executing", summary="AgentRun 已恢复")

    def cancel(self, run_id: str, *, reason: str | None = None) -> dict[str, object]:
        return self.transition(
            run_id,
            "cancelled",
            summary=reason or "用户取消 AgentRun",
            stop_reason=reason or "user_cancelled",
        )

    def fail(
        self,
        run_id: str,
        *,
        error_message: str,
        stage: str | None = None,
    ) -> dict[str, object]:
        return self.transition(
            run_id,
            "failed",
            stage=stage,
            error_message=error_message,
            stop_reason="error",
        )

    def retry(self, run_id: str) -> dict[str, object]:
        current = self._run_row(run_id)
        if str(current["status"]) != "failed":
            raise ValueError("Only failed AgentRun can be retried")
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE agent_runs
                SET status = 'executing',
                    retry_count = retry_count + 1,
                    error_message = NULL,
                    stop_reason = NULL,
                    completed_at = NULL,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (run_id,),
            )
            event = self._insert_event(
                connection,
                run_id,
                event_type="run.retrying",
                stage="executing",
                status="executing",
                title="AgentRun 重试",
                summary="从失败状态恢复执行",
                payload={"fromStatus": "failed", "toStatus": "executing"},
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def recover_unfinished(self) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT id, status
                FROM agent_runs
                WHERE status IN ('planning', 'executing')
                ORDER BY updated_at DESC, created_at DESC
                """
            ).fetchall()
            run_ids = [str(row["id"]) for row in rows]
            events: list[dict[str, object]] = []
            for row in rows:
                run_id = str(row["id"])
                connection.execute(
                    """
                    UPDATE agent_runs
                    SET status = 'paused',
                        stop_reason = 'recovered_after_restart',
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE id = ?
                    """,
                    (run_id,),
                )
                events.append(
                    self._insert_event(
                        connection,
                        run_id,
                        event_type="run.recovered",
                        stage="paused",
                        status="paused",
                        title="AgentRun 已恢复为暂停状态",
                        summary="应用异常退出后恢复，等待用户继续执行",
                        payload={"fromStatus": str(row["status"]), "toStatus": "paused"},
                    )
                )
            connection.commit()
        for event in events:
            self._emit_event(event)
        return {"runs": [self.get(run_id)["run"] for run_id in run_ids]}

    def record_tool_output(
        self,
        tool_call_id: str,
        *,
        stdout_summary: str | None = None,
        stderr_summary: str | None = None,
        payload: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        tool_call = self._tool_call_row(tool_call_id)
        run_id = str(tool_call["run_id"])
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE agent_run_tool_calls
                SET stdout_summary = COALESCE(?, stdout_summary),
                    stderr_summary = COALESCE(?, stderr_summary)
                WHERE id = ?
                """,
                (
                    _safe_trace_text(stdout_summary, TRACE_SUMMARY_LIMIT),
                    _safe_trace_text(stderr_summary, TRACE_SUMMARY_LIMIT),
                    tool_call_id,
                ),
            )
            event = self._insert_event(
                connection,
                run_id,
                event_type="tool_call.output",
                stage="tool_calling",
                status=self._status_in_connection(connection, run_id),
                title=f"Tool 输出：{tool_call['tool_name']}",
                summary=stdout_summary or stderr_summary,
                payload={
                    "toolCallId": tool_call_id,
                    "stdoutSummary": stdout_summary,
                    "stderrSummary": stderr_summary,
                    **dict(payload or {}),
                },
                tool_call_id=tool_call_id,
                step_id=tool_call["step_id"],
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def start_tool_call(
        self,
        run_id: str,
        *,
        tool_name: str,
        action_summary: str,
        step_id: str | None = None,
        skill_id: str | None = None,
        skill_version: str | None = None,
        working_directory: str | None = None,
        sanitized_params: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        self._ensure_active(run_id)
        tool_call_id = f"agent-tool-call-{uuid4().hex}"
        clean_tool_name = _required_text(tool_name, "toolName")
        clean_summary = _required_text(action_summary, "actionSummary")
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO agent_run_tool_calls(
                    id, run_id, step_id, tool_name, skill_id, skill_version,
                    action_summary, working_directory, sanitized_params_json, status
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')
                """,
                (
                    tool_call_id,
                    run_id,
                    step_id,
                    clean_tool_name,
                    skill_id,
                    skill_version,
                    clean_summary,
                    working_directory,
                    _json(_sanitize_trace_payload(sanitized_params or {})),
                ),
            )
            event = self._insert_event(
                connection,
                run_id,
                event_type="tool_call.started",
                stage="tool_calling",
                status=self._status_in_connection(connection, run_id),
                title=f"Tool 调用开始：{clean_tool_name}",
                summary=clean_summary,
                payload={
                    "toolCallId": tool_call_id,
                    "stepId": step_id,
                    "toolName": clean_tool_name,
                    "skillId": skill_id,
                    "skillVersion": skill_version,
                    "workingDirectory": working_directory,
                    "sanitizedParams": dict(sanitized_params or {}),
                },
                tool_call_id=tool_call_id,
                step_id=step_id,
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def finish_tool_call(
        self,
        tool_call_id: str,
        *,
        status: str,
        exit_code: int | None = None,
        stdout_summary: str | None = None,
        stderr_summary: str | None = None,
        error_message: str | None = None,
    ) -> dict[str, object]:
        if status not in {"completed", "failed", "cancelled"}:
            raise ValueError("toolCall status must be completed, failed, or cancelled")
        tool_call = self._tool_call_row(tool_call_id)
        run_id = str(tool_call["run_id"])
        started_at = str(tool_call["started_at"])
        with self.storage.database.connect() as connection:
            duration_ms = int(
                connection.execute(
                    """
                    SELECT ROUND(
                        (julianday(strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) - julianday(?))
                        * 86400000
                    )
                    """,
                    (started_at,),
                ).fetchone()[0]
                or 0
            )
            connection.execute(
                """
                UPDATE agent_run_tool_calls
                SET status = ?,
                    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    duration_ms = ?,
                    exit_code = ?,
                    stdout_summary = ?,
                    stderr_summary = ?,
                    error_message = ?
                WHERE id = ?
                """,
                (
                    status,
                    max(0, duration_ms),
                    exit_code,
                    _safe_trace_text(stdout_summary, TRACE_SUMMARY_LIMIT),
                    _safe_trace_text(stderr_summary, TRACE_SUMMARY_LIMIT),
                    _safe_trace_text(error_message, TRACE_SUMMARY_LIMIT),
                    tool_call_id,
                ),
            )
            event = self._insert_event(
                connection,
                run_id,
                event_type=f"tool_call.{status}",
                stage="tool_calling",
                status=self._status_in_connection(connection, run_id),
                title=f"Tool 调用{_tool_status_label(status)}：{tool_call['tool_name']}",
                summary=error_message or stdout_summary,
                payload={
                    "toolCallId": tool_call_id,
                    "exitCode": exit_code,
                    "durationMs": max(0, duration_ms),
                },
                tool_call_id=tool_call_id,
                step_id=tool_call["step_id"],
                completed_at="now",
                duration_ms=max(0, duration_ms),
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def request_confirmation(
        self,
        run_id: str,
        *,
        prompt: str,
        options: Sequence[Mapping[str, object]] | None = None,
    ) -> dict[str, object]:
        self._ensure_active(run_id)
        confirmation_id = f"agent-confirmation-{uuid4().hex}"
        clean_prompt = _required_text(prompt, "prompt")
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO agent_run_confirmations(
                    id, run_id, prompt, status, options_json
                )
                VALUES (?, ?, ?, 'pending', ?)
                """,
                (confirmation_id, run_id, clean_prompt, _json(list(options or []))),
            )
            connection.execute(
                """
                UPDATE agent_runs
                SET status = 'waiting_confirmation',
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (run_id,),
            )
            event = self._insert_event(
                connection,
                run_id,
                event_type="confirmation.requested",
                stage="waiting_confirmation",
                status="waiting_confirmation",
                title="等待用户确认",
                summary=clean_prompt,
                payload={"confirmationId": confirmation_id, "options": list(options or [])},
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def resolve_confirmation(
        self,
        confirmation_id: str,
        *,
        decision: Mapping[str, object],
        status: str,
    ) -> dict[str, object]:
        if status not in {"confirmed", "rejected", "cancelled"}:
            raise ValueError("confirmation status must be confirmed, rejected, or cancelled")
        row = self._confirmation_row(confirmation_id)
        run_id = str(row["run_id"])
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE agent_run_confirmations
                SET status = ?,
                    decision_json = ?,
                    resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (status, _json(decision), confirmation_id),
            )
            next_status = "cancelled" if status == "cancelled" else "executing"
            connection.execute(
                """
                UPDATE agent_runs
                SET status = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    completed_at = CASE
                        WHEN ? = 'cancelled' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                        ELSE completed_at
                    END,
                    stop_reason = CASE
                        WHEN ? = 'cancelled' THEN 'confirmation_cancelled'
                        ELSE stop_reason
                    END
                WHERE id = ?
                """,
                (next_status, next_status, next_status, run_id),
            )
            event = self._insert_event(
                connection,
                run_id,
                event_type=f"confirmation.{status}",
                stage=next_status,
                status=next_status,
                title="用户确认已处理",
                summary=str(row["prompt"]),
                payload={"confirmationId": confirmation_id, "decision": dict(decision)},
                completed_at="now" if next_status == "cancelled" else None,
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def record_delegation(
        self,
        run_id: str,
        *,
        delegatee_role: str,
        task: str,
        input_scope: Mapping[str, object] | None = None,
        child_run_id: str | None = None,
    ) -> dict[str, object]:
        self._ensure_active(run_id)
        clean_role = _required_text(delegatee_role, "delegateeRole")
        if clean_role not in DELEGATE_ROLES:
            raise ValueError("delegateeRole must be Evidence Scout or Auditor")
        delegation_id = f"agent-delegation-{uuid4().hex}"
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO agent_run_delegations(
                    id, run_id, child_run_id, delegatee_role, task, input_scope_json, status
                )
                VALUES (?, ?, ?, ?, ?, ?, 'pending')
                """,
                (
                    delegation_id,
                    run_id,
                    child_run_id,
                    clean_role,
                    _required_text(task, "task"),
                    _json(_sanitize_trace_payload(input_scope or {})),
                ),
            )
            event = self._insert_event(
                connection,
                run_id,
                event_type="delegation.created",
                stage="executing",
                status=self._status_in_connection(connection, run_id),
                title=f"子 Agent 委派已记录：{clean_role}",
                summary=task,
                payload={
                    "delegationId": delegation_id,
                    "childRunId": child_run_id,
                    "delegateeRole": clean_role,
                    "inputScope": dict(input_scope or {}),
                },
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def start_delegation(self, delegation_id: str) -> dict[str, object]:
        row = self._delegation_row(delegation_id)
        run_id = str(row["run_id"])
        self._ensure_active(run_id)
        with self.storage.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute(
                "SELECT status FROM agent_run_delegations WHERE id = ?",
                (delegation_id,),
            ).fetchone()
            if current is None:
                raise ValueError("AgentRun delegation not found")
            if str(current["status"]) != "pending":
                raise ValueError("Only pending delegation can be started")
            running_count = int(
                connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM agent_run_delegations
                    WHERE run_id = ? AND status = 'running'
                    """,
                    (run_id,),
                ).fetchone()[0]
            )
            if running_count >= MAX_PARALLEL_DELEGATIONS:
                raise ValueError("AgentRun sub-agent parallel limit exceeded")
            connection.execute(
                """
                UPDATE agent_run_delegations
                SET status = 'running'
                WHERE id = ?
                """,
                (delegation_id,),
            )
            event = self._insert_event(
                connection,
                run_id,
                event_type="delegation.started",
                stage="tool_calling",
                status=self._status_in_connection(connection, run_id),
                title=f"子 Agent 开始：{row['delegatee_role']}",
                summary=str(row["task"]),
                payload={
                    "delegationId": delegation_id,
                    "delegateeRole": str(row["delegatee_role"]),
                    "inputScope": _json_object(row["input_scope_json"]),
                },
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def finish_delegation(
        self,
        delegation_id: str,
        *,
        status: str,
        output: Mapping[str, object] | None = None,
        stop_reason: str,
    ) -> dict[str, object]:
        if status not in {"completed", "failed", "cancelled"}:
            raise ValueError("delegation status must be completed, failed, or cancelled")
        row = self._delegation_row(delegation_id)
        run_id = str(row["run_id"])
        if str(row["status"]) not in {"pending", "running"}:
            raise ValueError("AgentRun delegation is already terminal")
        safe_output = _sanitize_trace_payload(output or {})
        clean_reason = _required_text(stop_reason, "stopReason")
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE agent_run_delegations
                SET status = ?,
                    output_json = ?,
                    stop_reason = ?,
                    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (status, _json(safe_output), clean_reason, delegation_id),
            )
            event = self._insert_event(
                connection,
                run_id,
                event_type=f"delegation.{status}",
                stage="conflict_audit"
                if str(row["delegatee_role"]) == "Auditor"
                else "evidence_retrieval",
                status=self._status_in_connection(connection, run_id),
                title=f"子 Agent {_delegation_status_label(status)}：{row['delegatee_role']}",
                summary=clean_reason,
                payload={
                    "delegationId": delegation_id,
                    "delegateeRole": str(row["delegatee_role"]),
                    "output": safe_output,
                    "stopReason": clean_reason,
                },
                completed_at="now",
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def save_output(
        self,
        run_id: str,
        *,
        output_type: str,
        title: str,
        content: str,
        payload: Mapping[str, object] | None = None,
        citations: Sequence[Mapping[str, object]] | None = None,
    ) -> dict[str, object]:
        if output_type not in {"draft", "final", "intermediate"}:
            raise ValueError("outputType must be draft, final, or intermediate")
        self._ensure_active_or_failed(run_id)
        run = self._run_row(run_id)
        output_id = f"agent-output-{uuid4().hex}"
        output_payload = dict(payload or {})
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO agent_run_outputs(
                    id, run_id, output_type, title, content, payload_json
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    output_id,
                    run_id,
                    output_type,
                    _required_text(title, "title"),
                    content,
                    _json(output_payload),
                ),
            )
            target_column = "draft_json" if output_type == "draft" else "final_output_json"
            if output_type in {"draft", "final"}:
                connection.execute(
                    f"""
                    UPDATE agent_runs
                    SET {target_column} = ?,
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE id = ?
                    """,
                    (_json({"outputId": output_id, "title": title, "content": content}), run_id),
                )
            for citation in citations or []:
                chunk_id = citation.get("chunkId")
                paragraph_index = citation.get("paragraphIndex", 0)
                if not isinstance(chunk_id, str) or not isinstance(paragraph_index, int):
                    raise ValueError("citation requires chunkId and paragraphIndex")
                self._ensure_citation_chunk_scope(connection, run, chunk_id)
                connection.execute(
                    """
                    INSERT INTO agent_run_citations(
                        id, run_id, output_id, paragraph_index, chunk_id
                    )
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        f"agent-citation-{uuid4().hex}",
                        run_id,
                        output_id,
                        paragraph_index,
                        chunk_id,
                    ),
                )
            event = self._insert_event(
                connection,
                run_id,
                event_type=f"output.{output_type}.saved",
                stage="drafting" if output_type == "draft" else "finalizing",
                status=self._status_in_connection(connection, run_id),
                title=f"{_output_type_label(output_type)}已保存",
                summary=title,
                payload={"outputId": output_id, "citationCount": len(citations or [])},
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def attach_indexed_source(
        self,
        run_id: str,
        *,
        source_id: str,
        index_version_id: str,
        candidate_id: str,
    ) -> dict[str, object]:
        self._ensure_active(run_id)
        run = self._run_row(run_id)
        knowledge_base_id = str(run["knowledge_base_id"])
        self._ensure_index_version(knowledge_base_id, index_version_id)
        with self.storage.database.connect() as connection:
            source = connection.execute(
                """
                SELECT 1
                FROM sources
                WHERE id = ? AND knowledge_base_id = ? AND status = 'ready'
                """,
                (source_id, knowledge_base_id),
            ).fetchone()
            if source is None:
                raise ValueError("外部资料尚未完成索引")
            source_scope = [
                item for item in _json_list(run["source_scope_json"]) if isinstance(item, str)
            ]
            if source_id not in source_scope:
                source_scope.append(source_id)
            connection.execute(
                """
                UPDATE agent_runs
                SET source_scope_json = ?,
                    index_version_id = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (_json(source_scope), index_version_id, run_id),
            )
            event = self._insert_event(
                connection,
                run_id,
                event_type="external_source.indexed",
                stage="conflict_audit",
                status=self._status_in_connection(connection, run_id),
                title="外部资料已进入可引用范围",
                summary=f"已保存快照并切换到索引 {index_version_id}",
                payload={
                    "candidateId": candidate_id,
                    "sourceId": source_id,
                    "indexVersionId": index_version_id,
                    "sourceScope": source_scope,
                },
                completed_at="now",
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def record_external_access(
        self,
        run_id: str,
        *,
        enabled: bool,
        server_ids: Sequence[str],
    ) -> dict[str, object]:
        self._ensure_active(run_id)
        with self.storage.database.connect() as connection:
            event = self._insert_event(
                connection,
                run_id,
                event_type="external_access.enabled" if enabled else "external_access.disabled",
                stage="waiting_confirmation" if enabled else "planning",
                status=self._status_in_connection(connection, run_id),
                title="已启用寻找外部资料" if enabled else "已关闭寻找外部资料",
                summary=(
                    f"本次 AgentRun 仅开放 {len(server_ids)} 个 MCP 服务的本地只读白名单"
                    if enabled
                    else "外部 MCP Tool 已恢复为禁止状态"
                ),
                payload={"enabled": enabled, "serverIds": list(server_ids)},
                completed_at="now",
            )
            connection.commit()
        self._emit_event(event)
        return self.get(run_id)

    def _ensure_knowledge_base(self, knowledge_base_id: str) -> None:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                "SELECT 1 FROM knowledge_bases WHERE id = ?",
                (knowledge_base_id,),
            ).fetchone()
        if row is None:
            raise ValueError("Knowledge base not found")

    def _current_index_version_id(self, knowledge_base_id: str) -> str | None:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                """
                SELECT id
                FROM index_versions
                WHERE knowledge_base_id = ? AND status = 'ready' AND is_current = 1
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (knowledge_base_id,),
            ).fetchone()
        return str(row["id"]) if row is not None else None

    def _ensure_index_version(self, knowledge_base_id: str, index_version_id: str) -> None:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                """
                SELECT 1
                FROM index_versions
                WHERE id = ? AND knowledge_base_id = ? AND status = 'ready'
                """,
                (index_version_id, knowledge_base_id),
            ).fetchone()
        if row is None:
            raise ValueError("AgentRun indexVersionId must reference a ready index")

    def _source_scope(
        self,
        knowledge_base_id: str,
        source_ids: Sequence[str] | None,
    ) -> list[str]:
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                "SELECT id FROM sources WHERE knowledge_base_id = ? ORDER BY created_at ASC",
                (knowledge_base_id,),
            ).fetchall()
        available = [str(row["id"]) for row in rows]
        if source_ids is None:
            return available
        requested = list(dict.fromkeys(source_ids))
        missing = [source_id for source_id in requested if source_id not in available]
        if missing:
            raise ValueError("sourceIds must belong to the AgentRun knowledge base")
        return requested

    def _run_row(self, run_id: str) -> sqlite3.Row:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM agent_runs WHERE id = ?",
                (run_id,),
            ).fetchone()
        if row is None:
            raise ValueError("AgentRun not found")
        return cast(sqlite3.Row, row)

    def _tool_call_row(self, tool_call_id: str) -> sqlite3.Row:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM agent_run_tool_calls WHERE id = ?",
                (tool_call_id,),
            ).fetchone()
        if row is None:
            raise ValueError("AgentRun tool call not found")
        return cast(sqlite3.Row, row)

    def _confirmation_row(self, confirmation_id: str) -> sqlite3.Row:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM agent_run_confirmations WHERE id = ?",
                (confirmation_id,),
            ).fetchone()
        if row is None:
            raise ValueError("AgentRun confirmation not found")
        return cast(sqlite3.Row, row)

    def _delegation_row(self, delegation_id: str) -> sqlite3.Row:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM agent_run_delegations WHERE id = ?",
                (delegation_id,),
            ).fetchone()
        if row is None:
            raise ValueError("AgentRun delegation not found")
        return cast(sqlite3.Row, row)

    def _ensure_citation_chunk_scope(
        self,
        connection: sqlite3.Connection,
        run: sqlite3.Row,
        chunk_id: str,
    ) -> None:
        row = connection.execute(
            """
            SELECT c.knowledge_base_id, c.index_version_id, sv.source_id
            FROM chunks c
            JOIN source_versions sv ON sv.id = c.source_version_id
            WHERE c.id = ?
            """,
            (chunk_id,),
        ).fetchone()
        if row is None:
            raise ValueError("citation chunk not found")
        if str(row["knowledge_base_id"]) != str(run["knowledge_base_id"]):
            raise ValueError("citation chunk must belong to the AgentRun knowledge base")
        if (
            run["index_version_id"] is not None
            and row["index_version_id"] != run["index_version_id"]
        ):
            raise ValueError("citation chunk must belong to the AgentRun index version")
        source_scope = {
            item for item in _json_list(run["source_scope_json"]) if isinstance(item, str)
        }
        if str(row["source_id"]) not in source_scope:
            raise ValueError("citation chunk must belong to the AgentRun source scope")

    def _ensure_mutable(self, run_id: str) -> None:
        status = str(self._run_row(run_id)["status"])
        if status in TERMINAL_STATUSES:
            raise ValueError("AgentRun is already terminal")

    def _ensure_active(self, run_id: str) -> None:
        status = str(self._run_row(run_id)["status"])
        if status not in {"planning", "waiting_confirmation", "executing"}:
            raise ValueError("AgentRun is not active")

    def _ensure_active_or_failed(self, run_id: str) -> None:
        status = str(self._run_row(run_id)["status"])
        if status in TERMINAL_STATUSES:
            raise ValueError("AgentRun is already terminal")

    def _status_in_connection(self, connection: sqlite3.Connection, run_id: str) -> str:
        row = connection.execute("SELECT status FROM agent_runs WHERE id = ?", (run_id,)).fetchone()
        if row is None:
            raise ValueError("AgentRun not found")
        return str(row["status"])

    def _insert_event(
        self,
        connection: sqlite3.Connection,
        run_id: str,
        *,
        event_type: str,
        stage: str | None,
        status: str | None,
        title: str,
        summary: str | None,
        payload: Mapping[str, object],
        started_at: str | None = None,
        completed_at: str | None = None,
        duration_ms: int | None = None,
        tool_call_id: object | None = None,
        step_id: object | None = None,
    ) -> dict[str, object]:
        sequence = int(
            connection.execute(
                "SELECT COALESCE(MAX(sequence), 0) + 1 FROM agent_run_events WHERE run_id = ?",
                (run_id,),
            ).fetchone()[0]
        )
        event_id = f"agent-event-{uuid4().hex}"
        started_at_sql = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" if started_at is None else "?"
        completed_at_sql = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" if completed_at == "now" else "?"
        values: list[object | None] = [
            event_id,
            run_id,
            sequence,
            event_type,
            stage,
            status,
            _safe_trace_text(title, TRACE_SUMMARY_LIMIT) or "Trace Event",
            _safe_trace_text(summary, TRACE_SUMMARY_LIMIT),
            _json(_sanitize_trace_payload(payload)),
        ]
        if started_at is not None:
            values.append(started_at)
        if completed_at != "now":
            values.append(completed_at)
        values.extend(
            [
                duration_ms if duration_ms is None else max(0, duration_ms),
                tool_call_id if isinstance(tool_call_id, str) else None,
                step_id if isinstance(step_id, str) else None,
            ]
        )
        connection.execute(
            f"""
            INSERT INTO agent_run_events(
                id, run_id, sequence, event_type, stage, status,
                title, summary, payload_json, started_at, completed_at,
                duration_ms, tool_call_id, step_id
            )
            VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, {started_at_sql}, {completed_at_sql}, ?, ?, ?
            )
            """,
            values,
        )
        row = connection.execute(
            "SELECT * FROM agent_run_events WHERE id = ?",
            (event_id,),
        ).fetchone()
        if row is None:
            raise ValueError("AgentRun event insert failed")
        event = self._event_record(row)
        self._update_trace_snapshot(connection, run_id, event)
        return event

    def _update_trace_snapshot(
        self,
        connection: sqlite3.Connection,
        run_id: str,
        event: Mapping[str, object],
    ) -> None:
        row = connection.execute(
            "SELECT trace_snapshot_json FROM agent_runs WHERE id = ?",
            (run_id,),
        ).fetchone()
        existing = _json_object(row["trace_snapshot_json"]) if row is not None else {}
        phase_statuses = _phase_statuses(existing.get("phases"))
        phase_id = _phase_id(str(event.get("stage") or ""), str(event.get("eventType") or ""))
        event_type = str(event.get("eventType") or "")
        if event_type in {"run.completed", "run.cancelled", "run.failed"}:
            for phase in phase_statuses:
                if phase["status"] == "active":
                    phase["status"] = "failed" if event_type == "run.failed" else "completed"
            phase_statuses[-1]["status"] = "failed" if event_type == "run.failed" else "completed"
        else:
            for phase in phase_statuses:
                if phase["id"] == phase_id:
                    if event_type.endswith(".completed") or event_type in {
                        "tool_call.completed",
                        "confirmation.confirmed",
                        "confirmation.rejected",
                    }:
                        phase["status"] = "completed"
                    else:
                        phase["status"] = "active"
                elif phase["status"] == "active":
                    phase["status"] = "completed"
        snapshot = {
            "currentStage": phase_id,
            "currentStageLabel": _phase_label(phase_id),
            "currentEventType": event_type,
            "status": event.get("status"),
            "title": event.get("title"),
            "summary": event.get("summary"),
            "toolCallId": event.get("toolCallId"),
            "stepId": event.get("stepId"),
            "lastSequence": event.get("sequence"),
            "lastEventAt": event.get("createdAt"),
            "phases": phase_statuses,
        }
        connection.execute(
            """
            UPDATE agent_runs
            SET trace_snapshot_json = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?
            """,
            (_json(snapshot), run_id),
        )

    def _emit_event(self, event: dict[str, object]) -> None:
        if self._event_sink is not None:
            self._event_sink(event)

    def _run_record(self, row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": str(row["id"]),
            "knowledgeBaseId": str(row["knowledge_base_id"]),
            "title": str(row["title"]),
            "goal": str(row["goal"]),
            "skillId": str(row["skill_id"]),
            "skillVersion": str(row["skill_version"]),
            "status": str(row["status"]),
            "sourceScope": _json_list(row["source_scope_json"]),
            "indexVersionId": row["index_version_id"],
            "models": _json_object(row["models_json"]),
            "budgets": _json_object(row["budgets_json"]),
            "usage": _json_object(row["usage_json"]),
            "plan": _json_object(row["plan_json"]),
            "draft": _json_object(row["draft_json"]),
            "finalOutput": _json_object(row["final_output_json"]),
            "traceSnapshot": _json_object(row["trace_snapshot_json"]),
            "errorMessage": row["error_message"],
            "stopReason": row["stop_reason"],
            "retryCount": int(row["retry_count"]),
            "startedAt": row["started_at"],
            "completedAt": row["completed_at"],
            "createdAt": str(row["created_at"]),
            "updatedAt": str(row["updated_at"]),
        }

    def _event_record(self, row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": str(row["id"]),
            "runId": str(row["run_id"]),
            "sequence": int(row["sequence"]),
            "eventType": str(row["event_type"]),
            "stage": row["stage"],
            "status": row["status"],
            "title": str(row["title"]),
            "summary": row["summary"],
            "payload": _json_object(row["payload_json"]),
            "startedAt": row["started_at"],
            "completedAt": row["completed_at"],
            "durationMs": row["duration_ms"],
            "toolCallId": row["tool_call_id"],
            "stepId": row["step_id"],
            "createdAt": str(row["created_at"]),
        }

    def _tool_call_record(self, row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": str(row["id"]),
            "runId": str(row["run_id"]),
            "stepId": row["step_id"],
            "toolName": str(row["tool_name"]),
            "skillId": row["skill_id"],
            "skillVersion": row["skill_version"],
            "actionSummary": str(row["action_summary"]),
            "workingDirectory": row["working_directory"],
            "sanitizedParams": _json_object(row["sanitized_params_json"]),
            "status": str(row["status"]),
            "startedAt": str(row["started_at"]),
            "completedAt": row["completed_at"],
            "durationMs": row["duration_ms"],
            "exitCode": row["exit_code"],
            "stdoutSummary": row["stdout_summary"],
            "stderrSummary": row["stderr_summary"],
            "errorMessage": row["error_message"],
        }

    def _confirmation_record(self, row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": str(row["id"]),
            "runId": str(row["run_id"]),
            "prompt": str(row["prompt"]),
            "status": str(row["status"]),
            "options": _json_list(row["options_json"]),
            "decision": _json_object(row["decision_json"]),
            "requestedAt": str(row["requested_at"]),
            "resolvedAt": row["resolved_at"],
        }

    def _delegation_record(self, row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": str(row["id"]),
            "runId": str(row["run_id"]),
            "childRunId": row["child_run_id"],
            "delegateeRole": str(row["delegatee_role"]),
            "task": str(row["task"]),
            "inputScope": _json_object(row["input_scope_json"]),
            "status": str(row["status"]),
            "output": _json_object(row["output_json"]),
            "stopReason": row["stop_reason"],
            "createdAt": str(row["created_at"]),
            "completedAt": row["completed_at"],
        }

    def _output_record(self, row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": str(row["id"]),
            "runId": str(row["run_id"]),
            "outputType": str(row["output_type"]),
            "title": str(row["title"]),
            "content": str(row["content"]),
            "payload": _json_object(row["payload_json"]),
            "createdAt": str(row["created_at"]),
            "updatedAt": str(row["updated_at"]),
        }

    def _citation_record(self, row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": str(row["id"]),
            "runId": str(row["run_id"]),
            "outputId": row["output_id"],
            "paragraphIndex": int(row["paragraph_index"]),
            "chunkId": str(row["chunk_id"]),
            "createdAt": str(row["created_at"]),
        }


def _ensure_transition(current: str, next_status: str) -> None:
    if current == next_status:
        return
    if next_status not in ALLOWED_TRANSITIONS.get(current, set()):
        raise ValueError(f"Invalid AgentRun status transition: {current} -> {next_status}")


def _event_type_for_status(status: str) -> str:
    return {
        "planning": "stage.started",
        "waiting_confirmation": "confirmation.requested",
        "executing": "stage.started",
        "paused": "run.paused",
        "completed": "run.completed",
        "cancelled": "run.cancelled",
        "failed": "run.failed",
    }[status]


def _title_for_status(status: str) -> str:
    return {
        "planning": "进入规划阶段",
        "waiting_confirmation": "等待用户确认",
        "executing": "进入执行阶段",
        "paused": "AgentRun 已暂停",
        "completed": "AgentRun 已完成",
        "cancelled": "AgentRun 已取消",
        "failed": "AgentRun 执行失败",
    }[status]


def _normalize_budgets(value: Mapping[str, object] | None) -> dict[str, object]:
    budgets = {**DEFAULT_BUDGETS, **dict(value or {})}
    for key in ("maxSteps", "maxInputTokens", "maxOutputTokens"):
        raw = budgets.get(key)
        if not isinstance(raw, int) or raw <= 0:
            raise ValueError(f"{key} must be a positive integer")
    max_model_calls = budgets.get("maxModelCalls")
    if not isinstance(max_model_calls, int) or max_model_calls < 0:
        raise ValueError("maxModelCalls must be a non-negative integer")
    duration = budgets.get("maxDurationSeconds")
    if not isinstance(duration, int) or duration <= 0:
        raise ValueError("maxDurationSeconds must be a positive integer")
    cost = budgets.get("maxEstimatedCostCny")
    if cost is not None and not isinstance(cost, int | float):
        raise ValueError("maxEstimatedCostCny must be a number or null")
    return budgets


def _required_text(value: str, label: str) -> str:
    clean = " ".join(value.split())
    if not clean:
        raise ValueError(f"{label} must be a non-empty string")
    return clean


def _title(title: str | None, goal: str) -> str:
    if title is not None and title.strip():
        return title.strip()[:80]
    return goal[:80]


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_object(value: object) -> dict[str, object]:
    if not isinstance(value, str) or not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _json_list(value: object) -> list[object]:
    if not isinstance(value, str) or not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def _tool_status_label(status: str) -> str:
    return {"completed": "完成", "failed": "失败", "cancelled": "取消"}[status]


def _delegation_status_label(status: str) -> str:
    return {"completed": "完成", "failed": "失败", "cancelled": "取消"}[status]


def _output_type_label(output_type: str) -> str:
    return {"draft": "草稿", "final": "最终成果", "intermediate": "中间成果"}[output_type]


def _stage_label(stage: str, status: str) -> str:
    label = _phase_label(_phase_id(stage, "stage.started"))
    return f"{label}已完成" if status == "completed" else f"开始{label}"


def _phase_id(stage: str, event_type: str) -> str:
    normalized = stage.lower().replace("-", "_").replace(".", "_")
    if event_type == "run.created" or "plan" in normalized:
        return "planning"
    if "retrieval" in normalized or "search" in normalized or "evidence" in normalized:
        return "evidence_retrieval"
    if "source" in normalized or "read" in normalized:
        return "source_reading"
    if event_type.startswith("tool_call") or "tool" in normalized:
        return "tool_calling"
    if "draft" in normalized or "write" in normalized:
        return "drafting"
    if "citation" in normalized or "validate" in normalized:
        return "citation_validation"
    if "conflict" in normalized or "audit" in normalized:
        return "conflict_audit"
    if "confirmation" in normalized or event_type.startswith("confirmation"):
        return "waiting_confirmation"
    if event_type.startswith("output.final") or "final" in normalized:
        return "finalizing"
    if event_type in {"run.completed", "run.cancelled", "run.failed"}:
        return "finalizing"
    return normalized if normalized in {phase["id"] for phase in TRACE_PHASES} else "planning"


def _phase_label(phase_id: str) -> str:
    for phase in TRACE_PHASES:
        if phase["id"] == phase_id:
            return phase["label"]
    return phase_id


def _phase_statuses(value: object) -> list[dict[str, str]]:
    by_id: dict[str, str] = {}
    if isinstance(value, list):
        for item in value:
            if not isinstance(item, dict):
                continue
            phase_id = item.get("id")
            status = item.get("status")
            if isinstance(phase_id, str) and isinstance(status, str):
                by_id[phase_id] = status
    return [
        {
            "id": phase["id"],
            "label": phase["label"],
            "status": by_id.get(phase["id"], "pending"),
        }
        for phase in TRACE_PHASES
    ]


def _sanitize_trace_payload(payload: Mapping[str, object]) -> dict[str, object]:
    sanitized = _sanitize_trace_value(payload, key=None)
    return sanitized if isinstance(sanitized, dict) else {}


def _sanitize_trace_value(value: object, *, key: str | None) -> object:
    if key is not None and _is_sensitive_trace_key(key):
        return "***"
    if isinstance(value, str):
        return _safe_trace_text(value, TRACE_TEXT_LIMIT) or ""
    if isinstance(value, Mapping):
        return {
            str(item_key): _sanitize_trace_value(item_value, key=str(item_key))
            for item_key, item_value in value.items()
        }
    if isinstance(value, Sequence) and not isinstance(value, bytes | bytearray | str):
        return [_sanitize_trace_value(item, key=key) for item in list(value)[:20]]
    if isinstance(value, bool | int | float) or value is None:
        return value
    return str(value)


def _is_sensitive_trace_key(key: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", key.lower())
    return normalized in TRACE_SENSITIVE_KEYS or any(
        token in normalized
        for token in (
            "apikey",
            "authorization",
            "credential",
            "fullprompt",
            "password",
            "rawcontent",
            "secret",
            "token",
        )
    )


def _safe_trace_text(value: str | None, limit: int) -> str | None:
    if value is None:
        return None
    clean = re.sub(r"(?i)(bearer|api[_-]?key|token|secret)\s*[:=]\s*\S+", r"\1=***", value)
    clean = re.sub(r"(?i)(sk|ak|rk)-[a-z0-9_\-]{12,}", "***", clean)
    clean = " ".join(clean.split())
    if len(clean) <= limit:
        return clean
    return f"{clean[:limit].rstrip()}..."
