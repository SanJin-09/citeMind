import json
import re
from collections.abc import Mapping, Sequence
from typing import Any

from citemind_worker.agent_run_service import AgentRunService
from citemind_worker.citation_validator import CitationValidator
from citemind_worker.model_catalog import (
    DEFAULT_ARK_BASE_URL,
    DEFAULT_CHAT_MODEL,
    DEFAULT_EMBEDDING_MODEL,
)
from citemind_worker.retrieval_service import HybridRetrievalService
from citemind_worker.storage import StorageRuntime

NATIVE_TOOLS: dict[str, dict[str, object]] = {
    "hybrid_retrieval.search": {
        "name": "hybrid_retrieval.search",
        "title": "混合检索",
        "description": "在当前知识库与 AgentRun 来源范围内执行 FTS5 + 向量融合检索。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                "candidateLimit": {"type": "integer", "minimum": 1, "maximum": 200},
            },
            "required": ["query"],
            "additionalProperties": True,
        },
    },
    "source.read": {
        "name": "source.read",
        "title": "来源读取",
        "description": "读取当前 AgentRun 来源范围内的来源元数据与证据片段。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "chunkIds": {"type": "array", "items": {"type": "string"}},
                "sourceIds": {"type": "array", "items": {"type": "string"}},
            },
            "additionalProperties": False,
        },
    },
    "source.status_check": {
        "name": "source.status_check",
        "title": "来源状态检查",
        "description": "检查来源、当前版本、索引片段和维护状态是否可用于事实输出。",
        "inputSchema": {
            "type": "object",
            "properties": {"sourceIds": {"type": "array", "items": {"type": "string"}}},
            "additionalProperties": False,
        },
    },
    "citation.validate": {
        "name": "citation.validate",
        "title": "引用校验",
        "description": "校验段落引用是否来自当前检索候选、当前索引和可定位来源。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "paragraphs": {"type": "array", "items": {"type": "object"}},
                "candidateChunkIds": {"type": "array", "items": {"type": "string"}},
                "indexVersionId": {"type": "string"},
            },
            "required": ["paragraphs", "candidateChunkIds"],
            "additionalProperties": False,
        },
    },
    "output.save": {
        "name": "output.save",
        "title": "成果保存",
        "description": "将草稿、过程产物或最终结果保存到 AgentRun，并写入引用关系。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "outputType": {"type": "string", "enum": ["draft", "final", "intermediate"]},
                "title": {"type": "string"},
                "content": {"type": "string"},
                "payload": {"type": "object"},
                "citations": {"type": "array", "items": {"type": "object"}},
            },
            "required": ["outputType", "title", "content"],
            "additionalProperties": False,
        },
    },
}

FACT_CLASSES: tuple[dict[str, str], ...] = (
    {
        "id": "verified_evidence",
        "label": "已验证证据",
        "description": "结论直接来自通过引用校验的来源片段。",
    },
    {
        "id": "source_conflict",
        "label": "来源冲突",
        "description": "多个来源或片段对同一问题存在明确不一致。",
    },
    {
        "id": "model_inference",
        "label": "模型推断",
        "description": "基于证据做出的整理、归纳或判断，不冒充来源原文事实。",
    },
    {
        "id": "insufficient_evidence",
        "label": "证据不足",
        "description": "当前来源范围无法支持该结论。",
    },
)

COMMON_ALLOWED_TOOLS = tuple(NATIVE_TOOLS)
SKILL_DEFINITIONS: dict[str, dict[str, object]] = {
    "research_brief": {
        "id": "research_brief",
        "version": "1.0.0",
        "title": "证据研究简报",
        "description": "规划研究问题、检索证据、识别缺口与冲突，生成经过引用校验的研究简报。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "goal": {"type": "string"},
                "query": {"type": "string"},
                "sourceIds": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["goal"],
            "additionalProperties": True,
        },
        "allowedTools": list(COMMON_ALLOWED_TOOLS),
        "executionConstraints": {
            "mustValidateCitationsBeforeFinal": True,
            "mayUseOnlyAllowedTools": True,
            "mustStayWithinSourceScope": True,
            "mustClassifyEveryFactualClaim": True,
        },
        "budgetPolicy": {
            "maxSteps": 8,
            "maxModelCalls": 0,
            "maxDurationSeconds": 600,
            "toolCallLimits": {
                "hybrid_retrieval.search": 2,
                "source.read": 3,
                "citation.validate": 2,
                "output.save": 2,
            },
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "researchQuestions": {"type": "array", "items": {"type": "string"}},
                "conclusions": {"type": "array", "items": {"type": "object"}},
                "evidence": {"type": "array", "items": {"type": "object"}},
                "conflicts": {"type": "array", "items": {"type": "object"}},
                "gaps": {"type": "array", "items": {"type": "object"}},
            },
            "required": ["researchQuestions", "conclusions", "evidence", "conflicts", "gaps"],
            "additionalProperties": True,
        },
    },
    "multi_source_compare": {
        "id": "multi_source_compare",
        "version": "1.0.0",
        "title": "多来源观点对比",
        "description": "按议题展示多来源共识、分歧、来源依据和证据强弱。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "goal": {"type": "string"},
                "topic": {"type": "string"},
                "sourceIds": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["goal"],
            "additionalProperties": True,
        },
        "allowedTools": list(COMMON_ALLOWED_TOOLS),
        "executionConstraints": {
            "mustValidateCitationsBeforeFinal": True,
            "mayUseOnlyAllowedTools": True,
            "mustStayWithinSourceScope": True,
            "mustClassifyEveryFactualClaim": True,
        },
        "budgetPolicy": {
            "maxSteps": 8,
            "maxModelCalls": 0,
            "maxDurationSeconds": 600,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "topic": {"type": "string"},
                "consensus": {"type": "array", "items": {"type": "object"}},
                "differences": {"type": "array", "items": {"type": "object"}},
                "evidenceStrength": {"type": "array", "items": {"type": "object"}},
            },
            "required": ["topic", "consensus", "differences", "evidenceStrength"],
            "additionalProperties": True,
        },
    },
    "citation_conflict_audit": {
        "id": "citation_conflict_audit",
        "version": "1.0.0",
        "title": "引用与冲突审计",
        "description": "识别无证据结论、无效引用、证据不足和来源冲突。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "goal": {"type": "string"},
                "paragraphs": {"type": "array", "items": {"type": "object"}},
                "candidateChunkIds": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["goal"],
            "additionalProperties": True,
        },
        "allowedTools": list(COMMON_ALLOWED_TOOLS),
        "executionConstraints": {
            "mustValidateCitationsBeforeFinal": True,
            "mayUseOnlyAllowedTools": True,
            "mustStayWithinSourceScope": True,
            "mustClassifyEveryFactualClaim": True,
        },
        "budgetPolicy": {
            "maxSteps": 8,
            "maxModelCalls": 0,
            "maxDurationSeconds": 600,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "invalidCitations": {"type": "array", "items": {"type": "object"}},
                "unsupportedClaims": {"type": "array", "items": {"type": "object"}},
                "conflicts": {"type": "array", "items": {"type": "object"}},
                "insufficientEvidence": {"type": "array", "items": {"type": "object"}},
            },
            "required": [
                "invalidCitations",
                "unsupportedClaims",
                "conflicts",
                "insufficientEvidence",
            ],
            "additionalProperties": True,
        },
    },
}


class AgentSkillService:
    def __init__(
        self,
        storage: StorageRuntime,
        *,
        retrieval: HybridRetrievalService | None = None,
        validator: CitationValidator | None = None,
        agent_runs: AgentRunService | None = None,
    ) -> None:
        self.storage = storage
        self.retrieval = retrieval or HybridRetrievalService(storage)
        self.validator = validator or CitationValidator(storage)
        self.agent_runs = agent_runs or AgentRunService(storage)

    def list_skills(self) -> dict[str, object]:
        return {
            "version": "1",
            "nativeTools": list(NATIVE_TOOLS.values()),
            "factClasses": list(FACT_CLASSES),
            "skills": [_skill_descriptor(skill) for skill in SKILL_DEFINITIONS.values()],
        }

    def get_skill(self, skill_id: str, *, version: str | None = None) -> dict[str, object]:
        skill = SKILL_DEFINITIONS.get(_required_text(skill_id, "skillId"))
        if skill is None:
            raise ValueError("Agent Skill not found")
        if version is not None and version != skill["version"]:
            raise ValueError("Agent Skill version not found")
        return _skill_descriptor(skill)

    async def run_skill(
        self,
        *,
        knowledge_base_id: str,
        skill_id: str,
        goal: str,
        source_ids: Sequence[str] | None = None,
        inputs: Mapping[str, object] | None = None,
        api_key: str | None = None,
        base_url: str = DEFAULT_ARK_BASE_URL,
        chat_model: str = DEFAULT_CHAT_MODEL,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
        limit: int = 8,
        candidate_limit: int = 24,
    ) -> dict[str, object]:
        skill = self.get_skill(skill_id)
        clean_goal = _required_text(goal, "goal")
        raw_budget_policy = skill.get("budgetPolicy")
        budget_policy = dict(raw_budget_policy) if isinstance(raw_budget_policy, dict) else None
        run_response = self.agent_runs.create(
            knowledge_base_id,
            goal=clean_goal,
            skill_id=str(skill["id"]),
            skill_version=str(skill["version"]),
            title=str(skill["title"]),
            source_ids=source_ids,
            models={"chat": chat_model, "embedding": embedding_model},
            budgets=budget_policy,
        )
        run_id = _run_id_from_response(run_response)
        normalized_inputs = dict(inputs or {})
        try:
            self.agent_runs.record_skill_loaded(
                run_id,
                skill_id=str(skill["id"]),
                skill_version=str(skill["version"]),
                summary=str(skill["description"]),
            )
            self.agent_runs.update_plan(
                run_id,
                _plan_for_skill(str(skill["id"]), clean_goal),
                summary="已生成受控 Tool 执行计划",
            )
            self.agent_runs.transition(
                run_id,
                "executing",
                stage="planning",
                summary="进入 Skill 执行阶段",
            )
            if skill["id"] == "research_brief":
                await self._run_research_brief(
                    run_id,
                    skill=skill,
                    goal=clean_goal,
                    inputs=normalized_inputs,
                    api_key=api_key,
                    base_url=base_url,
                    embedding_model=embedding_model,
                    limit=limit,
                    candidate_limit=candidate_limit,
                )
            elif skill["id"] == "multi_source_compare":
                await self._run_multi_source_compare(
                    run_id,
                    skill=skill,
                    goal=clean_goal,
                    inputs=normalized_inputs,
                    api_key=api_key,
                    base_url=base_url,
                    embedding_model=embedding_model,
                    limit=limit,
                    candidate_limit=candidate_limit,
                )
            elif skill["id"] == "citation_conflict_audit":
                await self._run_citation_conflict_audit(
                    run_id,
                    skill=skill,
                    goal=clean_goal,
                    inputs=normalized_inputs,
                    api_key=api_key,
                    base_url=base_url,
                    embedding_model=embedding_model,
                    limit=limit,
                    candidate_limit=candidate_limit,
                )
            else:
                raise ValueError("Agent Skill runner not implemented")
            self.agent_runs.transition(
                run_id,
                "completed",
                stage="finalizing",
                summary="Skill 已完成，最终成果已保存",
                stop_reason="done",
            )
            return self.agent_runs.get(run_id)
        except Exception as error:
            self.agent_runs.fail(
                run_id,
                error_message=str(error),
                stage="finalizing",
            )
            raise

    async def invoke_tool(
        self,
        run_id: str,
        *,
        tool_name: str,
        params: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        run = self.agent_runs.get(run_id)["run"]
        if not isinstance(run, dict):
            raise ValueError("AgentRun not found")
        skill = self.get_skill(str(run["skillId"]), version=str(run["skillVersion"]))
        result = await self._invoke_tool_with_trace(
            run_id,
            skill=skill,
            tool_name=tool_name,
            params=dict(params or {}),
            step_id=None,
            action_summary=f"调用原生 Tool：{tool_name}",
        )
        return {
            "toolName": tool_name,
            "result": result,
            "agentRun": self.agent_runs.get(run_id),
        }

    async def _run_research_brief(
        self,
        run_id: str,
        *,
        skill: Mapping[str, object],
        goal: str,
        inputs: Mapping[str, object],
        api_key: str | None,
        base_url: str,
        embedding_model: str,
        limit: int,
        candidate_limit: int,
    ) -> None:
        query = _input_text(inputs, "query", goal)
        retrieval = await self._retrieve_evidence(
            run_id,
            skill,
            query=query,
            api_key=api_key,
            base_url=base_url,
            embedding_model=embedding_model,
            limit=limit,
            candidate_limit=candidate_limit,
        )
        chunk_ids = _candidate_chunk_ids(retrieval)
        self.agent_runs.record_stage(
            run_id,
            stage="source_reading",
            status="started",
            title="读取来源片段",
            step_id="source-read",
        )
        source_read = await self._invoke_tool_with_trace(
            run_id,
            skill=skill,
            tool_name="source.read",
            params={"chunkIds": chunk_ids},
            step_id="source-read",
            action_summary="读取检索候选片段",
        )
        source_chunks = _object_list(source_read.get("chunks"))
        self.agent_runs.record_stage(
            run_id,
            stage="source_reading",
            status="completed",
            summary=f"读取 {len(source_chunks)} 个片段",
            step_id="source-read",
        )
        paragraphs = _evidence_paragraphs(
            source_chunks,
            prefix="已验证证据",
        )
        validation = await self._validate_paragraphs(run_id, skill, retrieval, paragraphs)
        payload = _research_brief_payload(
            goal=goal,
            query=query,
            chunks=source_chunks,
            retrieval=retrieval,
            validation=validation,
        )
        await self._save_skill_output(
            run_id,
            skill=skill,
            title="证据研究简报",
            content=_markdown_research_brief(payload),
            payload=payload,
            validation=validation,
        )

    async def _run_multi_source_compare(
        self,
        run_id: str,
        *,
        skill: Mapping[str, object],
        goal: str,
        inputs: Mapping[str, object],
        api_key: str | None,
        base_url: str,
        embedding_model: str,
        limit: int,
        candidate_limit: int,
    ) -> None:
        topic = _input_text(inputs, "topic", goal)
        retrieval = await self._retrieve_evidence(
            run_id,
            skill,
            query=topic,
            api_key=api_key,
            base_url=base_url,
            embedding_model=embedding_model,
            limit=limit,
            candidate_limit=candidate_limit,
        )
        chunk_ids = _candidate_chunk_ids(retrieval)
        source_read = await self._invoke_tool_with_trace(
            run_id,
            skill=skill,
            tool_name="source.read",
            params={"chunkIds": chunk_ids},
            step_id="source-read",
            action_summary="读取多来源观点片段",
        )
        chunks = _object_list(source_read.get("chunks"))
        paragraphs = _evidence_paragraphs(chunks, prefix="来源观点")
        validation = await self._validate_paragraphs(run_id, skill, retrieval, paragraphs)
        payload = _multi_source_compare_payload(
            topic=topic,
            chunks=chunks,
            retrieval=retrieval,
            validation=validation,
        )
        await self._save_skill_output(
            run_id,
            skill=skill,
            title="多来源观点对比",
            content=_markdown_multi_source_compare(payload),
            payload=payload,
            validation=validation,
        )

    async def _run_citation_conflict_audit(
        self,
        run_id: str,
        *,
        skill: Mapping[str, object],
        goal: str,
        inputs: Mapping[str, object],
        api_key: str | None,
        base_url: str,
        embedding_model: str,
        limit: int,
        candidate_limit: int,
    ) -> None:
        input_paragraphs = _object_list(inputs.get("paragraphs"))
        if input_paragraphs:
            run = self.agent_runs.get(run_id)["run"]
            if not isinstance(run, dict):
                raise ValueError("AgentRun not found")
            candidate_chunk_ids = _string_list(inputs.get("candidateChunkIds"))
            if not candidate_chunk_ids:
                candidate_chunk_ids = _paragraph_chunk_ids(input_paragraphs)
            source_read = await self._invoke_tool_with_trace(
                run_id,
                skill=skill,
                tool_name="source.read",
                params={"chunkIds": candidate_chunk_ids},
                step_id="source-read",
                action_summary="读取待审计引用片段",
            )
            validation = await self._invoke_tool_with_trace(
                run_id,
                skill=skill,
                tool_name="citation.validate",
                params={
                    "paragraphs": input_paragraphs,
                    "candidateChunkIds": candidate_chunk_ids,
                    "indexVersionId": run.get("indexVersionId"),
                },
                step_id="citation-validation",
                action_summary="审计输入段落引用",
            )
            retrieval: dict[str, object] = {
                "query": goal,
                "indexVersion": {"id": run.get("indexVersionId")},
                "results": [],
            }
        else:
            retrieval = await self._retrieve_evidence(
                run_id,
                skill,
                query=goal,
                api_key=api_key,
                base_url=base_url,
                embedding_model=embedding_model,
                limit=limit,
                candidate_limit=candidate_limit,
            )
            chunk_ids = _candidate_chunk_ids(retrieval)
            source_read = await self._invoke_tool_with_trace(
                run_id,
                skill=skill,
                tool_name="source.read",
                params={"chunkIds": chunk_ids},
                step_id="source-read",
                action_summary="读取审计候选片段",
            )
            input_paragraphs = _evidence_paragraphs(
                _object_list(source_read.get("chunks")),
                prefix="审计候选证据",
            )
            validation = await self._validate_paragraphs(run_id, skill, retrieval, input_paragraphs)
        chunks = _object_list(source_read.get("chunks"))
        payload = _citation_conflict_audit_payload(
            goal=goal,
            paragraphs=input_paragraphs,
            chunks=chunks,
            validation=validation,
            retrieval=retrieval,
        )
        await self._save_skill_output(
            run_id,
            skill=skill,
            title="引用与冲突审计",
            content=_markdown_citation_conflict_audit(payload),
            payload=payload,
            validation=validation,
        )

    async def _retrieve_evidence(
        self,
        run_id: str,
        skill: Mapping[str, object],
        *,
        query: str,
        api_key: str | None,
        base_url: str,
        embedding_model: str,
        limit: int,
        candidate_limit: int,
    ) -> dict[str, object]:
        run = self.agent_runs.get(run_id)["run"]
        if not isinstance(run, dict):
            raise ValueError("AgentRun not found")
        await self._invoke_tool_with_trace(
            run_id,
            skill=skill,
            tool_name="source.status_check",
            params={},
            step_id="source-status",
            action_summary="检查来源状态",
        )
        self.agent_runs.record_stage(
            run_id,
            stage="evidence_retrieval",
            status="started",
            title="检索证据",
            step_id="evidence-retrieval",
        )
        retrieval = await self._invoke_tool_with_trace(
            run_id,
            skill=skill,
            tool_name="hybrid_retrieval.search",
            params={
                "knowledgeBaseId": run["knowledgeBaseId"],
                "query": query,
                "apiKey": api_key,
                "baseUrl": base_url,
                "embeddingModel": embedding_model,
                "limit": limit,
                "candidateLimit": candidate_limit,
            },
            step_id="evidence-retrieval",
            action_summary="执行混合检索",
        )
        self.agent_runs.record_stage(
            run_id,
            stage="evidence_retrieval",
            status="completed",
            summary=f"检索到 {len(_candidate_chunk_ids(retrieval))} 个候选片段",
            step_id="evidence-retrieval",
        )
        return retrieval

    async def _validate_paragraphs(
        self,
        run_id: str,
        skill: Mapping[str, object],
        retrieval: Mapping[str, object],
        paragraphs: Sequence[Mapping[str, object]],
    ) -> dict[str, object]:
        self.agent_runs.record_stage(
            run_id,
            stage="citation_validation",
            status="started",
            title="引用校验",
            step_id="citation-validation",
        )
        validation = await self._invoke_tool_with_trace(
            run_id,
            skill=skill,
            tool_name="citation.validate",
            params={
                "paragraphs": list(paragraphs),
                "candidateChunkIds": _candidate_chunk_ids(retrieval),
                "indexVersionId": _index_version_id(retrieval),
            },
            step_id="citation-validation",
            action_summary="校验最终段落引用",
        )
        self.agent_runs.record_stage(
            run_id,
            stage="citation_validation",
            status="completed",
            summary=_validation_summary(validation),
            step_id="citation-validation",
        )
        return validation

    async def _save_skill_output(
        self,
        run_id: str,
        *,
        skill: Mapping[str, object],
        title: str,
        content: str,
        payload: Mapping[str, object],
        validation: Mapping[str, object],
    ) -> None:
        self.agent_runs.record_stage(
            run_id,
            stage="finalizing",
            status="started",
            title="保存最终成果",
            step_id="output-save",
        )
        await self._invoke_tool_with_trace(
            run_id,
            skill=skill,
            tool_name="output.save",
            params={
                "outputType": "final",
                "title": title,
                "content": content,
                "payload": {
                    "skillOutput": dict(payload),
                    "factPolicy": _fact_policy(),
                },
                "citations": _valid_citations(validation),
            },
            step_id="output-save",
            action_summary="保存 Skill 最终成果",
        )
        self.agent_runs.record_stage(
            run_id,
            stage="finalizing",
            status="completed",
            summary="最终成果与引用关系已保存",
            step_id="output-save",
        )

    async def _invoke_tool_with_trace(
        self,
        run_id: str,
        *,
        skill: Mapping[str, object],
        tool_name: str,
        params: Mapping[str, object],
        step_id: str | None,
        action_summary: str,
    ) -> dict[str, object]:
        self._ensure_tool_allowed(skill, tool_name)
        started = self.agent_runs.start_tool_call(
            run_id,
            tool_name=tool_name,
            action_summary=action_summary,
            step_id=step_id,
            skill_id=str(skill["id"]),
            skill_version=str(skill["version"]),
            sanitized_params=_sanitize_tool_params(params),
        )
        tool_call_id = _first_tool_call_id(started)
        try:
            result = await self._execute_tool(run_id, tool_name, params)
        except Exception as error:
            self.agent_runs.finish_tool_call(
                tool_call_id,
                status="failed",
                exit_code=1,
                stderr_summary=str(error),
                error_message=str(error),
            )
            raise
        summary = _tool_result_summary(tool_name, result)
        self.agent_runs.record_tool_output(
            tool_call_id,
            stdout_summary=summary,
            payload={"resultSummary": _tool_result_payload_summary(result)},
        )
        self.agent_runs.finish_tool_call(
            tool_call_id,
            status="completed",
            exit_code=0,
            stdout_summary=summary,
        )
        return result

    async def _execute_tool(
        self,
        run_id: str,
        tool_name: str,
        params: Mapping[str, object],
    ) -> dict[str, object]:
        if tool_name == "hybrid_retrieval.search":
            return await self._tool_hybrid_retrieval(run_id, params)
        if tool_name == "source.read":
            return self._tool_source_read(run_id, params)
        if tool_name == "source.status_check":
            return self._tool_source_status_check(run_id, params)
        if tool_name == "citation.validate":
            return self._tool_citation_validate(run_id, params)
        if tool_name == "output.save":
            return self._tool_output_save(run_id, params)
        raise ValueError("Native Tool not found")

    async def _tool_hybrid_retrieval(
        self,
        run_id: str,
        params: Mapping[str, object],
    ) -> dict[str, object]:
        run = self._run_scope(run_id)
        run_knowledge_base_id = str(run["knowledgeBaseId"])
        knowledge_base_id = _optional_text(params, "knowledgeBaseId", run_knowledge_base_id)
        if knowledge_base_id != run_knowledge_base_id:
            raise ValueError("Tool knowledgeBaseId must match AgentRun")
        result = await self.retrieval.retrieve(
            str(knowledge_base_id),
            _required_mapping_text(params, "query"),
            api_key=_optional_nullable_text(params, "apiKey"),
            base_url=_optional_text(params, "baseUrl", DEFAULT_ARK_BASE_URL),
            embedding_model=_optional_text(params, "embeddingModel", DEFAULT_EMBEDDING_MODEL),
            limit=_optional_int(params, "limit", 8),
            candidate_limit=_optional_int(params, "candidateLimit", 24),
        )
        return _filter_retrieval_to_source_scope(result, _string_list(run.get("sourceScope")))

    def _tool_source_read(
        self,
        run_id: str,
        params: Mapping[str, object],
    ) -> dict[str, object]:
        run = self._run_scope(run_id)
        source_ids = _string_list(params.get("sourceIds"))
        chunk_ids = _string_list(params.get("chunkIds"))
        if source_ids:
            self._ensure_source_ids_in_scope(run, source_ids)
        if chunk_ids:
            self._ensure_chunk_ids_in_scope(run, chunk_ids)
        chunks = self._read_chunks(run, chunk_ids=chunk_ids, source_ids=source_ids)
        sources = _sources_from_chunks(chunks)
        return {
            "knowledgeBaseId": run["knowledgeBaseId"],
            "indexVersionId": run["indexVersionId"],
            "sources": sources,
            "chunks": chunks,
            "chunkCount": len(chunks),
        }

    def _tool_source_status_check(
        self,
        run_id: str,
        params: Mapping[str, object],
    ) -> dict[str, object]:
        run = self._run_scope(run_id)
        source_ids = _string_list(params.get("sourceIds")) or _string_list(run.get("sourceScope"))
        self._ensure_source_ids_in_scope(run, source_ids)
        if not source_ids:
            return {"sources": [], "summary": {"ready": 0, "unavailable": 0}}
        placeholders = ",".join("?" for _ in source_ids)
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                f"""
                SELECT
                    s.id,
                    s.source_type,
                    s.display_name,
                    s.uri,
                    s.status,
                    s.expiry_status,
                    s.review_at,
                    sv.id AS version_id,
                    sv.version_number,
                    sv.status AS version_status,
                    sv.review_status,
                    COUNT(c.id) AS chunk_count
                FROM sources s
                LEFT JOIN source_versions sv
                  ON sv.source_id = s.id AND sv.review_status = 'current'
                LEFT JOIN chunks c
                  ON c.source_version_id = sv.id
                 AND c.index_version_id = ?
                WHERE s.knowledge_base_id = ?
                  AND s.id IN ({placeholders})
                GROUP BY s.id, sv.id
                ORDER BY s.created_at ASC
                """,
                (run["indexVersionId"], run["knowledgeBaseId"], *source_ids),
            ).fetchall()
        sources = [
            {
                "id": str(row["id"]),
                "type": str(row["source_type"]),
                "displayName": str(row["display_name"]),
                "uri": row["uri"],
                "status": str(row["status"]),
                "expiryStatus": str(row["expiry_status"]),
                "reviewAt": row["review_at"],
                "currentVersion": {
                    "id": row["version_id"],
                    "versionNumber": row["version_number"],
                    "status": row["version_status"],
                    "reviewStatus": row["review_status"],
                },
                "currentIndexChunkCount": int(row["chunk_count"]),
                "usable": (
                    row["status"] == "ready"
                    and row["version_status"] == "ready"
                    and row["expiry_status"] == "active"
                    and int(row["chunk_count"]) > 0
                ),
            }
            for row in rows
        ]
        ready = sum(1 for source in sources if source["usable"] is True)
        return {
            "knowledgeBaseId": run["knowledgeBaseId"],
            "indexVersionId": run["indexVersionId"],
            "sources": sources,
            "summary": {"ready": ready, "unavailable": len(sources) - ready},
        }

    def _tool_citation_validate(
        self,
        run_id: str,
        params: Mapping[str, object],
    ) -> dict[str, object]:
        run = self._run_scope(run_id)
        paragraphs = _object_list(params.get("paragraphs"))
        candidate_chunk_ids = _string_list(params.get("candidateChunkIds"))
        index_version_id = _optional_text(params, "indexVersionId", str(run["indexVersionId"]))
        if index_version_id != run["indexVersionId"]:
            raise ValueError("citation indexVersionId must match AgentRun")
        self._ensure_chunk_ids_in_scope(run, candidate_chunk_ids)
        validation = self.validator.validate(
            paragraphs=[dict(paragraph) for paragraph in paragraphs],
            candidate_chunk_ids=candidate_chunk_ids,
            index_version_id=str(index_version_id),
        )
        validation["factClasses"] = list(FACT_CLASSES)
        return validation

    def _tool_output_save(
        self,
        run_id: str,
        params: Mapping[str, object],
    ) -> dict[str, object]:
        output_response = self.agent_runs.save_output(
            run_id,
            output_type=_required_mapping_text(params, "outputType"),
            title=_required_mapping_text(params, "title"),
            content=_required_mapping_text(params, "content"),
            payload=_optional_mapping(params, "payload"),
            citations=_object_list(params.get("citations")),
        )
        outputs = _object_list(output_response.get("outputs"))
        latest = outputs[0] if outputs else {}
        return {
            "saved": True,
            "outputId": latest.get("id"),
            "outputType": latest.get("outputType"),
            "citationCount": len(_object_list(params.get("citations"))),
        }

    def _run_scope(self, run_id: str) -> dict[str, object]:
        run = self.agent_runs.get(run_id)["run"]
        if not isinstance(run, dict):
            raise ValueError("AgentRun not found")
        return {
            "id": run["id"],
            "knowledgeBaseId": run["knowledgeBaseId"],
            "sourceScope": run.get("sourceScope", []),
            "indexVersionId": run["indexVersionId"],
            "skillId": run["skillId"],
            "skillVersion": run["skillVersion"],
        }

    def _ensure_tool_allowed(self, skill: Mapping[str, object], tool_name: str) -> None:
        allowed_tools = _string_list(skill.get("allowedTools"))
        if tool_name not in allowed_tools or tool_name not in NATIVE_TOOLS:
            raise ValueError("Native Tool is not allowed by this Skill")

    def _ensure_source_ids_in_scope(
        self,
        run: Mapping[str, object],
        source_ids: Sequence[str],
    ) -> None:
        scope = set(_string_list(run.get("sourceScope")))
        out_of_scope = [source_id for source_id in source_ids if source_id not in scope]
        if out_of_scope:
            raise ValueError("sourceIds must stay within AgentRun source scope")

    def _ensure_chunk_ids_in_scope(
        self,
        run: Mapping[str, object],
        chunk_ids: Sequence[str],
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
        rows_by_id = {str(row["id"]): row for row in rows}
        scope = set(_string_list(run.get("sourceScope")))
        for chunk_id in chunk_ids:
            row = rows_by_id.get(chunk_id)
            if row is None:
                raise ValueError("chunkId not found")
            if row["knowledge_base_id"] != run["knowledgeBaseId"]:
                raise ValueError("chunkId must belong to AgentRun knowledge base")
            if row["index_version_id"] != run["indexVersionId"]:
                raise ValueError("chunkId must belong to AgentRun index version")
            if str(row["source_id"]) not in scope:
                raise ValueError("chunkId must stay within AgentRun source scope")

    def _read_chunks(
        self,
        run: Mapping[str, object],
        *,
        chunk_ids: Sequence[str],
        source_ids: Sequence[str],
    ) -> list[dict[str, object]]:
        params: list[object] = [run["knowledgeBaseId"], run["indexVersionId"]]
        where = "c.knowledge_base_id = ? AND c.index_version_id = ?"
        if chunk_ids:
            where += f" AND c.id IN ({','.join('?' for _ in chunk_ids)})"
            params.extend(chunk_ids)
        elif source_ids:
            where += f" AND sv.source_id IN ({','.join('?' for _ in source_ids)})"
            params.extend(source_ids)
        else:
            scope = _string_list(run.get("sourceScope"))
            if not scope:
                return []
            where += f" AND sv.source_id IN ({','.join('?' for _ in scope)})"
            params.extend(scope)
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                f"""
                SELECT
                    c.id AS chunk_id,
                    c.source_version_id,
                    c.page_number,
                    c.bounding_box_json,
                    c.heading_path_json,
                    c.anchor,
                    c.original_text,
                    c.normalized_text,
                    c.content_hash,
                    sv.source_id,
                    sv.status AS source_version_status,
                    s.source_type,
                    s.display_name,
                    s.uri,
                    s.status AS source_status
                FROM chunks c
                JOIN source_versions sv ON sv.id = c.source_version_id
                JOIN sources s ON s.id = sv.source_id
                WHERE {where}
                ORDER BY c.created_at ASC
                LIMIT 50
                """,
                params,
            ).fetchall()
        order = {chunk_id: index for index, chunk_id in enumerate(chunk_ids)}
        chunks = [_chunk_payload(row) for row in rows]
        if chunk_ids:
            chunks.sort(key=lambda chunk: order.get(str(chunk["chunkId"]), len(order)))
        return chunks


def _skill_descriptor(skill: Mapping[str, object]) -> dict[str, object]:
    return {
        "id": skill["id"],
        "version": skill["version"],
        "title": skill["title"],
        "description": skill["description"],
        "inputSchema": skill["inputSchema"],
        "allowedTools": skill["allowedTools"],
        "executionConstraints": skill["executionConstraints"],
        "budgetPolicy": skill["budgetPolicy"],
        "outputSchema": skill["outputSchema"],
        "factClasses": list(FACT_CLASSES),
    }


def _run_id_from_response(response: Mapping[str, object]) -> str:
    run = response.get("run")
    if not isinstance(run, dict) or not isinstance(run.get("id"), str):
        raise ValueError("AgentRun response is missing run id")
    return str(run["id"])


def _first_tool_call_id(response: Mapping[str, object]) -> str:
    tool_calls = _object_list(response.get("toolCalls"))
    if not tool_calls or not isinstance(tool_calls[0].get("id"), str):
        raise ValueError("AgentRun response is missing tool call id")
    return str(tool_calls[0]["id"])


def _plan_for_skill(skill_id: str, goal: str) -> dict[str, object]:
    if skill_id == "multi_source_compare":
        steps = [
            {"id": "source-status", "title": "检查来源状态"},
            {"id": "evidence-retrieval", "title": "检索议题证据"},
            {"id": "source-read", "title": "按来源读取观点"},
            {"id": "citation-validation", "title": "校验观点引用"},
            {"id": "output-save", "title": "保存对比结果"},
        ]
    elif skill_id == "citation_conflict_audit":
        steps = [
            {"id": "source-status", "title": "检查来源状态"},
            {"id": "evidence-retrieval", "title": "检索或读取审计证据"},
            {"id": "source-read", "title": "读取引用片段"},
            {"id": "citation-validation", "title": "识别无效引用"},
            {"id": "output-save", "title": "保存审计结果"},
        ]
    else:
        steps = [
            {"id": "source-status", "title": "检查来源状态"},
            {"id": "evidence-retrieval", "title": "检索研究证据"},
            {"id": "source-read", "title": "读取候选片段"},
            {"id": "citation-validation", "title": "校验简报引用"},
            {"id": "output-save", "title": "保存研究简报"},
        ]
    return {
        "goal": goal,
        "steps": steps,
        "toolPolicy": {
            "allowedTools": list(COMMON_ALLOWED_TOOLS),
            "factClasses": list(FACT_CLASSES),
        },
    }


def _fact_policy() -> dict[str, object]:
    return {
        "requiredForAllFactualClaims": True,
        "classes": list(FACT_CLASSES),
        "rule": "事实性结论必须显式标记已验证证据、来源冲突、模型推断或证据不足。",
    }


def _research_brief_payload(
    *,
    goal: str,
    query: str,
    chunks: Sequence[Mapping[str, object]],
    retrieval: Mapping[str, object],
    validation: Mapping[str, object],
) -> dict[str, object]:
    evidence = [_evidence_item(chunk) for chunk in chunks]
    conflicts = _detect_source_conflicts(chunks)
    gaps: list[dict[str, object]] = []
    if not chunks:
        gaps.append(
            {
                "claimType": "insufficient_evidence",
                "text": "当前来源范围没有检索到可引用证据。",
                "evidenceChunkIds": [],
            }
        )
    if validation.get("valid") is not True:
        gaps.append(
            {
                "claimType": "insufficient_evidence",
                "text": "部分段落没有通过引用校验，不能作为已验证事实输出。",
                "invalidCitations": validation.get("invalidCitations", []),
            }
        )
    conclusions: list[dict[str, object]] = [
        {
            "claimType": "verified_evidence",
            "text": str(item["claim"]),
            "evidenceChunkIds": _string_list(item.get("evidenceChunkIds")),
        }
        for item in evidence[:5]
    ]
    conclusions.extend(conflicts)
    conclusions.extend(gaps)
    if not conclusions:
        conclusions = [
            {
                "claimType": "insufficient_evidence",
                "text": "当前资料不足以形成可验证结论。",
                "evidenceChunkIds": [],
            }
        ]
    return {
        "skillId": "research_brief",
        "goal": goal,
        "query": query,
        "researchQuestions": [
            goal,
            "当前来源中有哪些直接证据？",
            "证据之间是否存在缺口或冲突？",
        ],
        "evidence": evidence,
        "conflicts": conflicts,
        "gaps": gaps,
        "conclusions": conclusions,
        "citationValidation": validation,
        "retrievalSummary": _retrieval_summary(retrieval),
        "factPolicy": _fact_policy(),
    }


def _multi_source_compare_payload(
    *,
    topic: str,
    chunks: Sequence[Mapping[str, object]],
    retrieval: Mapping[str, object],
    validation: Mapping[str, object],
) -> dict[str, object]:
    by_source: dict[str, list[Mapping[str, object]]] = {}
    for chunk in chunks:
        source = chunk.get("source")
        source_id = str(source.get("id")) if isinstance(source, dict) else "unknown"
        by_source.setdefault(source_id, []).append(chunk)
    differences = []
    evidence_strength = []
    for source_chunks in by_source.values():
        first = source_chunks[0]
        source = first.get("source")
        source_name = str(source.get("displayName")) if isinstance(source, dict) else "未知来源"
        chunk_ids = [
            str(chunk["chunkId"])
            for chunk in source_chunks
            if isinstance(chunk.get("chunkId"), str)
        ]
        differences.append(
            {
                "claimType": "verified_evidence",
                "source": source_name,
                "text": f"{source_name} 的可验证观点：{_snippet(_chunk_text(first))}",
                "evidenceChunkIds": chunk_ids[:3],
            }
        )
        evidence_strength.append(
            {
                "source": source_name,
                "chunkCount": len(source_chunks),
                "strength": _evidence_strength_label(len(source_chunks)),
                "evidenceChunkIds": chunk_ids[:3],
            }
        )
    consensus: list[dict[str, object]] = []
    if len(by_source) >= 2:
        consensus.append(
            {
                "claimType": "verified_evidence",
                "text": f"{len(by_source)} 个来源都提供了与“{topic}”相关的证据。",
                "evidenceChunkIds": [str(chunk["chunkId"]) for chunk in chunks[:5]],
            }
        )
    else:
        consensus.append(
            {
                "claimType": "insufficient_evidence",
                "text": "当前来源数量不足，不能判断跨来源共识。",
                "evidenceChunkIds": [],
            }
        )
    conflicts = _detect_source_conflicts(chunks)
    return {
        "skillId": "multi_source_compare",
        "topic": topic,
        "consensus": consensus,
        "differences": differences,
        "conflicts": conflicts,
        "evidenceStrength": evidence_strength,
        "citationValidation": validation,
        "retrievalSummary": _retrieval_summary(retrieval),
        "factPolicy": _fact_policy(),
    }


def _citation_conflict_audit_payload(
    *,
    goal: str,
    paragraphs: Sequence[Mapping[str, object]],
    chunks: Sequence[Mapping[str, object]],
    validation: Mapping[str, object],
    retrieval: Mapping[str, object],
) -> dict[str, object]:
    invalid = _object_list(validation.get("invalidCitations"))
    unsupported = [
        {
            "claimType": "insufficient_evidence",
            "paragraphIndex": index,
            "text": _paragraph_text(paragraph),
            "reason": "paragraph_missing_evidence",
        }
        for index, paragraph in enumerate(paragraphs)
        if not _paragraph_evidence_ids(paragraph)
    ]
    insufficient: list[dict[str, object]] = []
    if not _candidate_chunk_ids(retrieval) and not chunks:
        insufficient.append(
            {
                "claimType": "insufficient_evidence",
                "text": "当前范围没有可校验候选片段。",
                "evidenceChunkIds": [],
            }
        )
    if invalid:
        insufficient.append(
            {
                "claimType": "insufficient_evidence",
                "text": "存在未通过引用校验的段落，不能作为已验证事实。",
                "invalidCitationCount": len(invalid),
            }
        )
    conflicts = _detect_source_conflicts(chunks)
    return {
        "skillId": "citation_conflict_audit",
        "goal": goal,
        "invalidCitations": invalid,
        "unsupportedClaims": unsupported,
        "conflicts": conflicts,
        "insufficientEvidence": insufficient,
        "citationValidation": validation,
        "retrievalSummary": _retrieval_summary(retrieval),
        "factPolicy": _fact_policy(),
    }


def _markdown_research_brief(payload: Mapping[str, object]) -> str:
    lines = ["# 证据研究简报", "", "## 研究问题"]
    lines.extend(f"- {question}" for question in _string_list(payload.get("researchQuestions")))
    lines.extend(["", "## 已验证证据"])
    evidence = _object_list(payload.get("evidence"))
    lines.extend(_claim_lines(evidence, empty="当前范围没有已验证证据。"))
    lines.extend(["", "## 来源冲突"])
    lines.extend(
        _claim_lines(_object_list(payload.get("conflicts")), empty="未识别到明确来源冲突。")
    )
    lines.extend(["", "## 证据缺口"])
    lines.extend(_claim_lines(_object_list(payload.get("gaps")), empty="未识别到额外证据缺口。"))
    lines.extend(["", "## 结论标记"])
    lines.extend(_claim_lines(_object_list(payload.get("conclusions")), empty="无可输出结论。"))
    return "\n".join(lines)


def _markdown_multi_source_compare(payload: Mapping[str, object]) -> str:
    lines = ["# 多来源观点对比", "", f"议题：{payload.get('topic', '')}", "", "## 共识"]
    lines.extend(
        _claim_lines(_object_list(payload.get("consensus")), empty="证据不足，无法判断共识。")
    )
    lines.extend(["", "## 分歧"])
    lines.extend(
        _claim_lines(_object_list(payload.get("differences")), empty="未识别到可验证分歧。")
    )
    lines.extend(["", "## 来源冲突"])
    lines.extend(
        _claim_lines(_object_list(payload.get("conflicts")), empty="未识别到明确来源冲突。")
    )
    lines.extend(["", "## 证据强弱"])
    for item in _object_list(payload.get("evidenceStrength")):
        lines.append(
            f"- {item.get('source', '未知来源')}：{item.get('strength', '未知')}，"
            f"{item.get('chunkCount', 0)} 个片段。"
        )
    if not _object_list(payload.get("evidenceStrength")):
        lines.append("- 证据不足。")
    return "\n".join(lines)


def _markdown_citation_conflict_audit(payload: Mapping[str, object]) -> str:
    lines = ["# 引用与冲突审计", "", "## 无效引用"]
    lines.extend(_audit_lines(_object_list(payload.get("invalidCitations")), "未发现无效引用。"))
    lines.extend(["", "## 无证据结论"])
    lines.extend(
        _claim_lines(_object_list(payload.get("unsupportedClaims")), empty="未发现无证据结论。")
    )
    lines.extend(["", "## 来源冲突"])
    lines.extend(
        _claim_lines(_object_list(payload.get("conflicts")), empty="未识别到明确来源冲突。")
    )
    lines.extend(["", "## 证据不足"])
    lines.extend(
        _claim_lines(
            _object_list(payload.get("insufficientEvidence")), empty="未发现额外证据不足项。"
        )
    )
    return "\n".join(lines)


def _claim_lines(items: Sequence[Mapping[str, object]], *, empty: str) -> list[str]:
    if not items:
        return [f"- [证据不足] {empty}"]
    lines = []
    for item in items:
        claim_type = str(item.get("claimType") or "model_inference")
        label = _fact_label(claim_type)
        chunk_ids = _string_list(item.get("evidenceChunkIds"))
        suffix = f"（证据：{', '.join(chunk_ids)}）" if chunk_ids else ""
        lines.append(f"- [{label}] {item.get('text', item.get('claim', ''))}{suffix}")
    return lines


def _audit_lines(items: Sequence[Mapping[str, object]], empty: str) -> list[str]:
    if not items:
        return [f"- [已验证证据] {empty}"]
    return [
        "- [证据不足] "
        f"段落 {item.get('paragraphIndex')} 引用 {item.get('chunkId')} 无效：{item.get('reason')}"
        for item in items
    ]


def _fact_label(claim_type: str) -> str:
    for fact_class in FACT_CLASSES:
        if fact_class["id"] == claim_type:
            return fact_class["label"]
    return "模型推断"


def _evidence_item(chunk: Mapping[str, object]) -> dict[str, object]:
    source = chunk.get("source")
    text = chunk.get("text")
    source_name = str(source.get("displayName")) if isinstance(source, dict) else "未知来源"
    normalized = str(text.get("normalized")) if isinstance(text, dict) else ""
    return {
        "claimType": "verified_evidence",
        "claim": f"{source_name} 记录了：{_snippet(normalized)}",
        "source": source,
        "location": chunk.get("location"),
        "evidenceChunkIds": [chunk["chunkId"]],
    }


def _evidence_paragraphs(
    chunks: Sequence[Mapping[str, object]],
    *,
    prefix: str,
) -> list[dict[str, object]]:
    return [
        {
            "text": f"{prefix}：{_evidence_item(chunk)['claim']}",
            "evidenceChunkIds": [str(chunk["chunkId"])],
        }
        for chunk in chunks[:5]
        if isinstance(chunk.get("chunkId"), str)
    ]


def _detect_source_conflicts(chunks: Sequence[Mapping[str, object]]) -> list[dict[str, object]]:
    if len(chunks) < 2:
        return []
    explicit = [
        chunk
        for chunk in chunks
        if _text_has_any(
            _chunk_text(chunk), ("冲突", "矛盾", "相反", "不一致", "conflict", "contradict")
        )
    ]
    if explicit:
        return [
            {
                "claimType": "source_conflict",
                "text": "来源片段中出现明确冲突或不一致表述，需要人工复核。",
                "evidenceChunkIds": [str(chunk["chunkId"]) for chunk in explicit[:5]],
            }
        ]
    positive: list[Mapping[str, object]] = []
    negative: list[Mapping[str, object]] = []
    for chunk in chunks:
        text = _chunk_text(chunk).lower()
        if re.search(r"(不支持|不是|不能|禁止|无|not|no|never|cannot)", text):
            negative.append(chunk)
        if re.search(r"(支持|是|可以|允许|有|yes|can|support)", text):
            positive.append(chunk)
    if positive and negative and _different_sources(positive[0], negative[0]):
        return [
            {
                "claimType": "source_conflict",
                "text": "不同来源对同一议题呈现正反表述，需要进一步核验。",
                "evidenceChunkIds": [
                    str(positive[0]["chunkId"]),
                    str(negative[0]["chunkId"]),
                ],
            }
        ]
    return []


def _different_sources(left: Mapping[str, object], right: Mapping[str, object]) -> bool:
    left_source = left.get("source")
    right_source = right.get("source")
    left_id = left_source.get("id") if isinstance(left_source, dict) else None
    right_id = right_source.get("id") if isinstance(right_source, dict) else None
    return left_id != right_id


def _chunk_text(chunk: Mapping[str, object]) -> str:
    text = chunk.get("text")
    return str(text.get("normalized")) if isinstance(text, dict) else ""


def _text_has_any(text: str, needles: Sequence[str]) -> bool:
    lower = text.lower()
    return any(needle.lower() in lower for needle in needles)


def _filter_retrieval_to_source_scope(
    retrieval: Mapping[str, object],
    source_scope: Sequence[str],
) -> dict[str, object]:
    if not source_scope:
        return dict(retrieval)
    scope = set(source_scope)
    results: list[dict[str, object]] = []
    for result in _object_list(retrieval.get("results")):
        source = result.get("source")
        if isinstance(source, dict) and source.get("id") in scope:
            results.append(result)
    filtered = dict(retrieval)
    filtered["results"] = results
    filtered["context"] = _context_from_results(results)
    raw_retrieval_meta = retrieval.get("retrieval")
    retrieval_meta = dict(raw_retrieval_meta) if isinstance(raw_retrieval_meta, dict) else {}
    retrieval_meta["sourceScopeFilteredCount"] = len(results)
    filtered["retrieval"] = retrieval_meta
    return filtered


def _context_from_results(results: Sequence[Mapping[str, object]]) -> dict[str, object]:
    chunks = []
    text_blocks = []
    for index, result in enumerate(results, start=1):
        source = result.get("source")
        text = result.get("text")
        location = result.get("location")
        if (
            not isinstance(source, dict)
            or not isinstance(text, dict)
            or not isinstance(location, dict)
        ):
            continue
        context_text = _snippet(str(text.get("normalized") or ""), limit=700)
        chunks.append(
            {
                "chunkId": result.get("chunkId"),
                "label": f"[{index}] {source.get('displayName')}",
                "text": context_text,
                "source": source,
                "location": location,
            }
        )
        text_blocks.append(f"[{index}] {source.get('displayName')}\n{context_text}")
    return {"chunkCount": len(chunks), "chunks": chunks, "text": "\n\n".join(text_blocks)}


def _chunk_payload(row: Any) -> dict[str, object]:
    return {
        "chunkId": str(row["chunk_id"]),
        "sourceVersionId": str(row["source_version_id"]),
        "sourceVersionStatus": str(row["source_version_status"]),
        "source": {
            "id": str(row["source_id"]),
            "type": str(row["source_type"]),
            "displayName": str(row["display_name"]),
            "uri": row["uri"],
            "status": str(row["source_status"]),
        },
        "location": {
            "pageNumber": row["page_number"],
            "boundingBox": _json_object(row["bounding_box_json"]),
            "headingPath": _json_string_list(row["heading_path_json"]),
            "anchor": row["anchor"],
        },
        "text": {
            "original": str(row["original_text"]),
            "normalized": str(row["normalized_text"]),
            "preview": _snippet(str(row["normalized_text"])),
            "contentHash": str(row["content_hash"]),
        },
    }


def _sources_from_chunks(chunks: Sequence[Mapping[str, object]]) -> list[dict[str, object]]:
    sources: dict[str, dict[str, object]] = {}
    for chunk in chunks:
        source = chunk.get("source")
        if not isinstance(source, dict) or not isinstance(source.get("id"), str):
            continue
        source_id = str(source["id"])
        sources.setdefault(source_id, {**source, "chunkCount": 0})
        current_count = sources[source_id].get("chunkCount", 0)
        sources[source_id]["chunkCount"] = (
            current_count + 1 if isinstance(current_count, int) else 1
        )
    return list(sources.values())


def _candidate_chunk_ids(retrieval: Mapping[str, object]) -> list[str]:
    return [
        str(result["chunkId"])
        for result in _object_list(retrieval.get("results"))
        if isinstance(result.get("chunkId"), str)
    ]


def _index_version_id(retrieval: Mapping[str, object]) -> str:
    index = retrieval.get("indexVersion")
    if isinstance(index, dict) and isinstance(index.get("id"), str):
        return str(index["id"])
    raise ValueError("retrieval indexVersion is missing")


def _retrieval_summary(retrieval: Mapping[str, object]) -> dict[str, object]:
    meta = retrieval.get("retrieval")
    return {
        "query": retrieval.get("query"),
        "candidateChunkIds": _candidate_chunk_ids(retrieval),
        "candidateCount": len(_candidate_chunk_ids(retrieval)),
        "retrieval": dict(meta) if isinstance(meta, dict) else {},
    }


def _valid_citations(validation: Mapping[str, object]) -> list[dict[str, object]]:
    citations: list[dict[str, object]] = []
    for citation in _object_list(validation.get("validCitations")):
        chunk_id = citation.get("chunkId")
        paragraph_index = citation.get("paragraphIndex", 0)
        if isinstance(chunk_id, str) and isinstance(paragraph_index, int):
            citations.append({"paragraphIndex": paragraph_index, "chunkId": chunk_id})
    return citations


def _validation_summary(validation: Mapping[str, object]) -> str:
    valid_count = len(_object_list(validation.get("validCitations")))
    invalid_count = len(_object_list(validation.get("invalidCitations")))
    return f"有效引用 {valid_count}，无效引用 {invalid_count}"


def _tool_result_summary(tool_name: str, result: Mapping[str, object]) -> str:
    if tool_name == "hybrid_retrieval.search":
        return f"检索候选 {len(_candidate_chunk_ids(result))} 个"
    if tool_name == "source.read":
        return f"读取片段 {result.get('chunkCount', 0)} 个"
    if tool_name == "source.status_check":
        summary = result.get("summary")
        if isinstance(summary, dict):
            return f"可用来源 {summary.get('ready', 0)}，不可用 {summary.get('unavailable', 0)}"
    if tool_name == "citation.validate":
        return _validation_summary(result)
    if tool_name == "output.save":
        return f"已保存成果，引用 {result.get('citationCount', 0)} 条"
    return "Tool 执行完成"


def _tool_result_payload_summary(result: Mapping[str, object]) -> dict[str, object]:
    summary: dict[str, object] = {}
    for key in ("chunkCount", "candidateCount", "summary", "saved", "citationCount"):
        if key in result:
            summary[key] = result[key]
    if "results" in result:
        summary["resultCount"] = len(_object_list(result.get("results")))
    if "validCitations" in result:
        summary["validCitationCount"] = len(_object_list(result.get("validCitations")))
    if "invalidCitations" in result:
        summary["invalidCitationCount"] = len(_object_list(result.get("invalidCitations")))
    return summary


def _sanitize_tool_params(params: Mapping[str, object]) -> dict[str, object]:
    sanitized: dict[str, object] = {}
    for key, value in params.items():
        lowered = key.lower()
        if "key" in lowered or "token" in lowered or "secret" in lowered:
            sanitized[key] = "***"
        elif isinstance(value, dict):
            sanitized[key] = _sanitize_tool_params(value)
        elif isinstance(value, list):
            sanitized[key] = [
                _sanitize_tool_params(item) if isinstance(item, dict) else item for item in value
            ]
        else:
            sanitized[key] = value
    return sanitized


def _input_text(inputs: Mapping[str, object], key: str, fallback: str) -> str:
    value = inputs.get(key)
    if isinstance(value, str) and value.strip():
        return " ".join(value.split())
    return fallback


def _required_text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return " ".join(value.split())


def _required_mapping_text(values: Mapping[str, object], key: str) -> str:
    return _required_text(values.get(key), key)


def _optional_text(values: Mapping[str, object], key: str, fallback: str) -> str:
    value = values.get(key)
    if value is None:
        return fallback
    return _required_text(value, key)


def _optional_nullable_text(values: Mapping[str, object], key: str) -> str | None:
    value = values.get(key)
    if value is None:
        return None
    return _required_text(value, key)


def _optional_int(values: Mapping[str, object], key: str, fallback: int) -> int:
    value = values.get(key)
    if value is None:
        return fallback
    if not isinstance(value, int):
        raise ValueError(f"{key} must be an integer")
    return value


def _optional_mapping(values: Mapping[str, object], key: str) -> dict[str, object] | None:
    value = values.get(key)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"{key} must be an object")
    return dict(value)


def _object_list(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    return [dict(item) for item in value if isinstance(item, dict)]


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(item for item in value if isinstance(item, str) and item))


def _paragraph_chunk_ids(paragraphs: Sequence[Mapping[str, object]]) -> list[str]:
    chunk_ids: list[str] = []
    for paragraph in paragraphs:
        chunk_ids.extend(_paragraph_evidence_ids(paragraph))
    return list(dict.fromkeys(chunk_ids))


def _paragraph_evidence_ids(paragraph: Mapping[str, object]) -> list[str]:
    raw = paragraph.get("evidenceChunkIds", paragraph.get("evidence_chunk_ids"))
    return _string_list(raw)


def _paragraph_text(paragraph: Mapping[str, object]) -> str:
    value = paragraph.get("text")
    return " ".join(value.split()) if isinstance(value, str) else ""


def _snippet(text: str, limit: int = 160) -> str:
    normalized = " ".join(text.split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[: limit - 1]}…"


def _evidence_strength_label(chunk_count: int) -> str:
    if chunk_count >= 3:
        return "强"
    if chunk_count >= 1:
        return "中"
    return "弱"


def _json_object(value: object) -> dict[str, object] | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _json_string_list(value: object) -> list[str]:
    if not isinstance(value, str) or not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    return [item for item in parsed if isinstance(item, str)] if isinstance(parsed, list) else []
