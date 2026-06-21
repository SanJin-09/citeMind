import asyncio
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from time import monotonic
from typing import cast

from citemind_worker.agent_run_service import MAX_PARALLEL_DELEGATIONS, AgentRunService
from citemind_worker.storage import StorageRuntime

SubAgentToolExecutor = Callable[
    [str, Mapping[str, object], str, str],
    Awaitable[dict[str, object]],
]


@dataclass(frozen=True, slots=True)
class SubAgentDefinition:
    role: str
    allowed_tools: tuple[str, ...]
    max_steps: int
    max_tool_calls: int
    max_model_calls: int
    max_duration_seconds: int


SUB_AGENT_DEFINITIONS: dict[str, SubAgentDefinition] = {
    "Evidence Scout": SubAgentDefinition(
        role="Evidence Scout",
        allowed_tools=(
            "source.status_check",
            "hybrid_retrieval.search",
            "source.read",
        ),
        max_steps=3,
        max_tool_calls=3,
        max_model_calls=0,
        max_duration_seconds=120,
    ),
    "Auditor": SubAgentDefinition(
        role="Auditor",
        allowed_tools=("source.read", "citation.validate"),
        max_steps=2,
        max_tool_calls=2,
        max_model_calls=0,
        max_duration_seconds=120,
    ),
}


class SubAgentBudgetExceeded(RuntimeError):
    pass


@dataclass(slots=True)
class _ExecutionContext:
    definition: SubAgentDefinition
    delegation_id: str
    executor: SubAgentToolExecutor
    steps: int = 0
    tool_calls: int = 0
    started_at: float = 0

    async def invoke(
        self,
        tool_name: str,
        params: Mapping[str, object],
        *,
        step: str,
        summary: str,
    ) -> dict[str, object]:
        if tool_name not in self.definition.allowed_tools:
            raise PermissionError(f"{self.definition.role} is not allowed to call {tool_name}")
        if self.steps >= self.definition.max_steps:
            raise SubAgentBudgetExceeded("sub_agent_step_budget_exhausted")
        if self.tool_calls >= self.definition.max_tool_calls:
            raise SubAgentBudgetExceeded("sub_agent_tool_budget_exhausted")
        self.steps += 1
        self.tool_calls += 1
        return await self.executor(
            tool_name,
            params,
            f"delegation:{self.delegation_id}:{step}",
            f"{self.definition.role}：{summary}",
        )

    def usage(self) -> dict[str, object]:
        return {
            "steps": self.steps,
            "toolCalls": self.tool_calls,
            "durationMs": max(0, round((monotonic() - self.started_at) * 1000)),
            "limits": {
                "maxSteps": self.definition.max_steps,
                "maxToolCalls": self.definition.max_tool_calls,
                "maxModelCalls": self.definition.max_model_calls,
                "maxDurationSeconds": self.definition.max_duration_seconds,
            },
        }


class AgentSubAgentService:
    def __init__(
        self,
        storage: StorageRuntime,
        *,
        agent_runs: AgentRunService | None = None,
    ) -> None:
        self.storage = storage
        self.agent_runs = agent_runs or AgentRunService(storage)

    def definitions(self) -> list[dict[str, object]]:
        return [
            {
                "role": definition.role,
                "allowedTools": list(definition.allowed_tools),
                "maxSteps": definition.max_steps,
                "maxToolCalls": definition.max_tool_calls,
                "maxModelCalls": definition.max_model_calls,
                "maxDurationSeconds": definition.max_duration_seconds,
                "canDelegate": False,
            }
            for definition in SUB_AGENT_DEFINITIONS.values()
        ]

    async def run(
        self,
        parent_run_id: str,
        *,
        role: str,
        task: str,
        input_scope: Mapping[str, object],
        executor: SubAgentToolExecutor,
        caller_delegation_id: str | None = None,
    ) -> dict[str, object]:
        if caller_delegation_id is not None:
            raise PermissionError("Sub-agent recursive delegation is forbidden")
        definition = SUB_AGENT_DEFINITIONS.get(role)
        if definition is None:
            raise ValueError("Unknown sub-agent role")
        parent_run = self._parent_run(parent_run_id)
        normalized_scope = self._normalize_scope(
            parent_run,
            definition=definition,
            input_scope=input_scope,
        )
        recorded = self.agent_runs.record_delegation(
            parent_run_id,
            delegatee_role=role,
            task=task,
            input_scope={
                **normalized_scope,
                "allowedTools": list(definition.allowed_tools),
                "budgets": {
                    "maxSteps": definition.max_steps,
                    "maxToolCalls": definition.max_tool_calls,
                    "maxModelCalls": definition.max_model_calls,
                    "maxDurationSeconds": definition.max_duration_seconds,
                    "maxParallel": MAX_PARALLEL_DELEGATIONS,
                },
                "canDelegate": False,
            },
        )
        delegation_id = _latest_delegation_id(recorded)
        self.agent_runs.start_delegation(delegation_id)
        context = _ExecutionContext(
            definition=definition,
            delegation_id=delegation_id,
            executor=executor,
            started_at=monotonic(),
        )
        try:
            async with asyncio.timeout(definition.max_duration_seconds):
                if role == "Evidence Scout":
                    output = await self._run_evidence_scout(context, normalized_scope)
                else:
                    output = await self._run_auditor(context, normalized_scope)
            output["budgetUsage"] = context.usage()
            self.agent_runs.finish_delegation(
                delegation_id,
                status="completed",
                output=_audit_output(role, output),
                stop_reason="completed_within_budget",
            )
            return {
                "delegationId": delegation_id,
                "role": role,
                "output": output,
            }
        except TimeoutError as error:
            self.agent_runs.finish_delegation(
                delegation_id,
                status="failed",
                output={"budgetUsage": context.usage()},
                stop_reason="sub_agent_duration_budget_exhausted",
            )
            raise SubAgentBudgetExceeded("sub_agent_duration_budget_exhausted") from error
        except Exception as error:
            stop_reason = (
                str(error)
                if isinstance(error, SubAgentBudgetExceeded)
                else "sub_agent_execution_failed"
            )
            self.agent_runs.finish_delegation(
                delegation_id,
                status="failed",
                output={
                    "error": str(error),
                    "budgetUsage": context.usage(),
                },
                stop_reason=stop_reason,
            )
            raise

    async def run_many(
        self,
        parent_run_id: str,
        requests: Sequence[Mapping[str, object]],
        *,
        executor: SubAgentToolExecutor,
        caller_delegation_id: str | None = None,
    ) -> list[dict[str, object]]:
        if caller_delegation_id is not None:
            raise PermissionError("Sub-agent recursive delegation is forbidden")
        if len(requests) > MAX_PARALLEL_DELEGATIONS:
            raise ValueError("Sub-agent parallel batch limit exceeded")
        return list(
            await asyncio.gather(
                *[
                    self.run(
                        parent_run_id,
                        role=_required_text(request.get("role"), "role"),
                        task=_required_text(request.get("task"), "task"),
                        input_scope=_mapping(request.get("inputScope")),
                        executor=executor,
                    )
                    for request in requests
                ]
            )
        )

    async def _run_evidence_scout(
        self,
        context: _ExecutionContext,
        scope: Mapping[str, object],
    ) -> dict[str, object]:
        question = str(scope["question"])
        source_ids = _string_list(scope.get("sourceIds"))
        status = await context.invoke(
            "source.status_check",
            {"sourceIds": source_ids},
            step="source-status",
            summary="检查限定来源状态",
        )
        retrieval = await context.invoke(
            "hybrid_retrieval.search",
            {
                "query": question,
                "sourceIds": source_ids,
                "limit": scope["limit"],
                "candidateLimit": scope["candidateLimit"],
                **_mapping(scope.get("retrievalOptions")),
            },
            step="search",
            summary="针对单个研究问题检索候选证据",
        )
        candidate_chunk_ids = _candidate_chunk_ids(retrieval)
        source_read = await context.invoke(
            "source.read",
            {"chunkIds": candidate_chunk_ids},
            step="source-read",
            summary="读取候选证据片段",
        )
        chunks = _object_list(source_read.get("chunks"))
        return {
            "researchQuestion": question,
            "sourceIds": source_ids,
            "candidateChunkIds": candidate_chunk_ids,
            "retrieval": retrieval,
            "chunks": chunks,
            "sourceStatus": status.get("summary", {}),
            "gaps": (
                []
                if chunks
                else [
                    {
                        "type": "insufficient_evidence",
                        "summary": "限定来源范围内没有找到候选证据。",
                    }
                ]
            ),
        }

    async def _run_auditor(
        self,
        context: _ExecutionContext,
        scope: Mapping[str, object],
    ) -> dict[str, object]:
        paragraphs = _object_list(scope.get("paragraphs"))
        candidate_chunk_ids = _string_list(scope.get("candidateChunkIds"))
        source_read = await context.invoke(
            "source.read",
            {"chunkIds": candidate_chunk_ids},
            step="source-read",
            summary="独立读取待审计引用片段",
        )
        chunks = _object_list(source_read.get("chunks"))
        validation = await context.invoke(
            "citation.validate",
            {
                "paragraphs": paragraphs,
                "candidateChunkIds": candidate_chunk_ids,
                "indexVersionId": scope["indexVersionId"],
            },
            step="citation-validation",
            summary="独立校验引用和证据范围",
        )
        invalid = _object_list(validation.get("invalidCitations"))
        unsupported = [
            {
                "paragraphIndex": index,
                "text": _paragraph_text(paragraph),
                "reason": "paragraph_missing_evidence",
            }
            for index, paragraph in enumerate(paragraphs)
            if not _paragraph_evidence_ids(paragraph)
        ]
        return {
            "candidateChunkIds": candidate_chunk_ids,
            "chunks": chunks,
            "validation": validation,
            "invalidCitations": invalid,
            "unsupportedClaims": unsupported,
            "conflicts": _detect_conflicts(chunks),
            "auditedParagraphCount": len(paragraphs),
        }

    def _parent_run(self, run_id: str) -> dict[str, object]:
        response = self.agent_runs.get(run_id)
        run = response.get("run")
        if not isinstance(run, dict):
            raise ValueError("AgentRun not found")
        if run.get("status") not in {"planning", "waiting_confirmation", "executing"}:
            raise ValueError("Parent AgentRun is not active")
        return cast(dict[str, object], run)

    def _normalize_scope(
        self,
        parent_run: Mapping[str, object],
        *,
        definition: SubAgentDefinition,
        input_scope: Mapping[str, object],
    ) -> dict[str, object]:
        parent_sources = set(_string_list(parent_run.get("sourceScope")))
        requested_sources = _string_list(input_scope.get("sourceIds")) or list(parent_sources)
        if any(source_id not in parent_sources for source_id in requested_sources):
            raise ValueError("Sub-agent sourceIds must stay within parent source scope")
        base: dict[str, object] = {
            "knowledgeBaseId": parent_run["knowledgeBaseId"],
            "indexVersionId": parent_run["indexVersionId"],
            "sourceIds": requested_sources,
        }
        if definition.role == "Evidence Scout":
            base.update(
                {
                    "question": _required_text(input_scope.get("question"), "question"),
                    "limit": min(8, _positive_int(input_scope.get("limit"), 8)),
                    "candidateLimit": min(
                        24,
                        _positive_int(input_scope.get("candidateLimit"), 24),
                    ),
                    "retrievalOptions": _safe_retrieval_options(input_scope),
                }
            )
            return base
        paragraphs = _object_list(input_scope.get("paragraphs"))
        candidate_chunk_ids = _string_list(input_scope.get("candidateChunkIds"))
        if not candidate_chunk_ids:
            candidate_chunk_ids = list(
                dict.fromkeys(
                    chunk_id
                    for paragraph in paragraphs
                    for chunk_id in _paragraph_evidence_ids(paragraph)
                )
            )
        self._ensure_chunks_in_scope(
            parent_run,
            candidate_chunk_ids,
            requested_sources=requested_sources,
        )
        base.update(
            {
                "paragraphs": paragraphs[:50],
                "candidateChunkIds": candidate_chunk_ids[:100],
            }
        )
        return base

    def _ensure_chunks_in_scope(
        self,
        parent_run: Mapping[str, object],
        chunk_ids: Sequence[str],
        *,
        requested_sources: Sequence[str],
    ) -> None:
        if not chunk_ids:
            return
        placeholders = ",".join("?" for _ in chunk_ids)
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                f"""
                SELECT c.id, c.knowledge_base_id, c.index_version_id, sv.source_id
                FROM chunks c
                JOIN source_versions sv ON sv.id = c.source_version_id
                WHERE c.id IN ({placeholders})
                """,
                tuple(chunk_ids),
            ).fetchall()
        by_id = {str(row["id"]): row for row in rows}
        allowed_sources = set(requested_sources)
        for chunk_id in chunk_ids:
            row = by_id.get(chunk_id)
            if row is None:
                raise ValueError("Sub-agent chunkId not found")
            if row["knowledge_base_id"] != parent_run["knowledgeBaseId"]:
                raise ValueError("Sub-agent chunkId must stay in parent knowledge base")
            if row["index_version_id"] != parent_run["indexVersionId"]:
                raise ValueError("Sub-agent chunkId must stay in parent index version")
            if str(row["source_id"]) not in allowed_sources:
                raise ValueError("Sub-agent chunkId must stay in delegated source scope")


def _audit_output(role: str, output: Mapping[str, object]) -> dict[str, object]:
    usage = _mapping(output.get("budgetUsage"))
    if role == "Evidence Scout":
        return {
            "researchQuestion": output.get("researchQuestion"),
            "sourceIds": _string_list(output.get("sourceIds")),
            "candidateChunkIds": _string_list(output.get("candidateChunkIds")),
            "candidateCount": len(_string_list(output.get("candidateChunkIds"))),
            "gaps": _object_list(output.get("gaps")),
            "budgetUsage": usage,
        }
    validation = _mapping(output.get("validation"))
    return {
        "auditedParagraphCount": output.get("auditedParagraphCount"),
        "candidateChunkIds": _string_list(output.get("candidateChunkIds")),
        "valid": validation.get("valid"),
        "invalidCitationCount": len(_object_list(output.get("invalidCitations"))),
        "unsupportedClaimCount": len(_object_list(output.get("unsupportedClaims"))),
        "conflicts": _object_list(output.get("conflicts")),
        "budgetUsage": usage,
    }


def _detect_conflicts(chunks: Sequence[Mapping[str, object]]) -> list[dict[str, object]]:
    explicit = [
        chunk
        for chunk in chunks
        if any(
            marker in _chunk_text(chunk).lower()
            for marker in ("冲突", "矛盾", "相反", "不一致", "conflict", "contradict")
        )
    ]
    if explicit:
        return [
            {
                "claimType": "source_conflict",
                "text": "来源片段中出现明确冲突或不一致表述，需要人工复核。",
                "evidenceChunkIds": [
                    str(chunk["chunkId"])
                    for chunk in explicit[:5]
                    if isinstance(chunk.get("chunkId"), str)
                ],
            }
        ]
    conflicts: list[dict[str, object]] = []
    for left_index, left in enumerate(chunks):
        left_text = _chunk_text(left)
        left_source = _source_id(left)
        left_terms = _terms(left_text)
        for right in chunks[left_index + 1 :]:
            right_text = _chunk_text(right)
            if left_source == _source_id(right):
                continue
            union = left_terms | _terms(right_text)
            overlap = len(left_terms & _terms(right_text)) / len(union) if union else 0
            if overlap < 0.08 or _has_negation(left_text) == _has_negation(right_text):
                continue
            conflicts.append(
                {
                    "claimType": "source_conflict",
                    "text": "不同来源在相近议题上呈现相反表述，需要进一步核验。",
                    "evidenceChunkIds": [
                        str(left.get("chunkId")),
                        str(right.get("chunkId")),
                    ],
                    "sourceIds": [left_source, _source_id(right)],
                }
            )
    return conflicts[:10]


def _candidate_chunk_ids(retrieval: Mapping[str, object]) -> list[str]:
    return list(
        dict.fromkeys(
            str(item["chunkId"])
            for item in _object_list(retrieval.get("results"))
            if isinstance(item.get("chunkId"), str)
        )
    )


def _latest_delegation_id(response: Mapping[str, object]) -> str:
    delegations = _object_list(response.get("delegations"))
    if not delegations or not isinstance(delegations[0].get("id"), str):
        raise ValueError("AgentRun response is missing delegation id")
    return str(delegations[0]["id"])


def _safe_retrieval_options(scope: Mapping[str, object]) -> dict[str, object]:
    options: dict[str, object] = {}
    for key in ("apiKey", "baseUrl", "embeddingModel"):
        value = scope.get(key)
        if isinstance(value, str) and value:
            options[key] = value
    return options


def _positive_int(value: object, fallback: int) -> int:
    return value if isinstance(value, int) and value > 0 else fallback


def _required_text(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a non-empty string")
    clean = " ".join(value.split())
    if not clean:
        raise ValueError(f"{label} must be a non-empty string")
    return clean


def _mapping(value: object) -> dict[str, object]:
    return cast(dict[str, object], value) if isinstance(value, dict) else {}


def _object_list(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    return [cast(dict[str, object], item) for item in value if isinstance(item, dict)]


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]


def _paragraph_text(paragraph: Mapping[str, object]) -> str:
    value = paragraph.get("text")
    return " ".join(value.split()) if isinstance(value, str) else ""


def _paragraph_evidence_ids(paragraph: Mapping[str, object]) -> list[str]:
    raw = paragraph.get("evidenceChunkIds", paragraph.get("evidence_chunk_ids"))
    return _string_list(raw)


def _chunk_text(chunk: Mapping[str, object]) -> str:
    text = chunk.get("text")
    if isinstance(text, dict):
        return str(text.get("normalized", text.get("original", "")))
    return str(chunk.get("normalizedText", chunk.get("originalText", "")))


def _source_id(chunk: Mapping[str, object]) -> str:
    source = chunk.get("source")
    return str(source.get("id")) if isinstance(source, dict) else ""


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
