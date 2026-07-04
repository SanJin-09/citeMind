import json
import math
import re
import sqlite3
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from datetime import UTC, datetime
from time import perf_counter
from typing import Literal, Protocol
from uuid import uuid4

from citemind_worker.agent_run_service import AgentRunService
from citemind_worker.ark_gateway import ArkModelGateway
from citemind_worker.citation_validator import CitationValidator
from citemind_worker.model_catalog import (
    DEFAULT_ARK_BASE_URL,
    DEFAULT_CHAT_MODEL,
    DEFAULT_EMBEDDING_MODEL,
    context_window_for,
)
from citemind_worker.quality_metrics import record_metric
from citemind_worker.retrieval_service import HybridRetrievalService
from citemind_worker.storage import StorageRuntime

DEFAULT_REFUSAL = "当前知识库中没有足够证据回答这个问题。"
DEFAULT_MAX_OUTPUT_TOKENS = 2400
HISTORY_SUMMARY_LINE_CHARS = 240
DENSE_PARAGRAPH_MIN_CHARS = 180
MAX_AUTO_PARAGRAPHS = 6
LOW_RELEVANCE_MAX_QUERY_TERMS = 4
LOW_RELEVANCE_DISTANCE_THRESHOLD = 0.35
PLAIN_CITATION_PATTERN = re.compile(r"\[([A-Za-z0-9_.:-]+)\]")

type QueryIntent = Literal[
    "assistant_identity",
    "system_capability",
    "system_limitation",
    "citation_policy",
    "runtime_tool_question",
    "knowledge_fact_qa",
    "knowledge_summary",
    "knowledge_transform",
    "knowledge_interview",
    "knowledge_review",
]

type EvidenceStatus = Literal[
    "strong_evidence",
    "partial_evidence",
    "weak_evidence",
    "no_evidence",
]

KNOWLEDGE_QUERY_INTENTS = frozenset(
    {
        "knowledge_fact_qa",
        "knowledge_summary",
        "knowledge_transform",
        "knowledge_interview",
        "knowledge_review",
    }
)

SYSTEM_META_PROFILE: dict[str, str | tuple[str, ...]] = {
    "version": "system-meta-profile-v1",
    "productName": "CiteMind",
    "identity": (
        "CiteMind 是一个面向本地知识库的可信问答系统，我是其中负责检索、生成和引用校验的回答模块。"
    ),
    "scope": (
        "我可以回答系统自身能力、引用规则和使用边界等元问题；"
        "这类回答来自内置系统说明，不需要知识库引用。"
    ),
    "modelBoundary": (
        "我不会把底层模型、运行工具或系统说明伪装成知识库事实；"
        "具体回答是否需要引用，取决于问题是否在询问资料内容。"
    ),
    "capabilities": (
        "基于导入的文件和网页资料进行知识库检索",
        "生成带段落级引用的回答",
        "校验引用是否来自当前知识库候选片段",
        "在证据不足或候选弱相关时拒答",
        "支持来源维护、对话历史、研究简报和写作工作流",
    ),
    "citationPolicy": (
        "知识库事实问题必须基于检索候选回答，并附带通过校验的引用",
        "系统身份、能力、使用边界和运行过程说明属于系统元信息，不要求知识库引用",
        "如果候选证据为空、弱相关或引用校验失败，系统会拒答而不是伪造来源",
    ),
    "limitations": (
        "我不能用用户知识库证明系统运行时的内部工具调用",
        "我不能把系统提示或内置说明伪装成知识库引用",
        "我不能在缺少有效证据时替知识库补全事实",
        "如果你明确询问资料、简历、文档或来源内容，我会切回 RAG 流程并按证据回答",
    ),
    "runtimeToolNote": (
        "当前问题是在询问运行过程，而不是询问知识库内容。"
        "知识库资料不能证明我本轮实际调用了哪些内部工具。"
    ),
}

ANSWER_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "evidence_sufficient": {"type": "boolean"},
        "refusal_reason": {"type": ["string", "null"]},
        "paragraphs": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "evidence_chunk_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                },
                "required": ["text", "evidence_chunk_ids"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["evidence_sufficient", "refusal_reason", "paragraphs"],
    "additionalProperties": False,
}


class AnswerGateway(Protocol):
    async def generate_structured(
        self,
        request: dict[str, object],
        schema: dict[str, object],
    ) -> dict[str, object]:
        pass

    def stream_answer(self, request: dict[str, object]) -> AsyncIterator[dict[str, object]]:
        pass


type GatewayFactory = Callable[[str, str, str], AnswerGateway]


class ConversationService:
    def __init__(
        self,
        storage: StorageRuntime,
        *,
        retrieval: HybridRetrievalService | None = None,
        validator: CitationValidator | None = None,
        gateway_factory: GatewayFactory | None = None,
        agent_runs: AgentRunService | None = None,
    ) -> None:
        self.storage = storage
        self.retrieval = retrieval or HybridRetrievalService(storage)
        self.validator = validator or CitationValidator(storage)
        self.gateway_factory = gateway_factory or _ark_gateway_factory
        self.agent_runs = agent_runs

    def list_conversations(self, knowledge_base_id: str) -> dict[str, object]:
        self._ensure_knowledge_base(knowledge_base_id)
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT id, knowledge_base_id, title, model_id, created_at, updated_at
                FROM conversations
                WHERE knowledge_base_id = ?
                ORDER BY updated_at DESC, created_at DESC
                """,
                (knowledge_base_id,),
            ).fetchall()
        return {
            "knowledgeBaseId": knowledge_base_id,
            "conversations": [_conversation_record_from_row(row) for row in rows],
        }

    def messages(self, conversation_id: str) -> dict[str, object]:
        conversation = self._conversation_record(conversation_id)
        return {
            "conversation": conversation,
            "messages": self._message_records(conversation_id),
        }

    def ensure_conversation(
        self,
        *,
        knowledge_base_id: str,
        conversation_id: str | None,
        title: str,
        model_id: str,
    ) -> dict[str, object]:
        return self._ensure_conversation(
            knowledge_base_id=knowledge_base_id,
            conversation_id=conversation_id,
            title=title,
            model_id=model_id,
        )

    def append_message(
        self,
        *,
        conversation_id: str,
        role: str,
        content: str,
        model_id: str | None = None,
        model_params: Mapping[str, object] | None = None,
        index_version_id: str | None = None,
        artifact: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        if role not in {"system", "user", "assistant"}:
            raise ValueError("Unsupported conversation message role")
        self._conversation_record(conversation_id)
        message = self._insert_message(
            conversation_id=conversation_id,
            role=role,
            content=content,
            model_id=model_id,
            model_params=dict(model_params or {}),
            index_version_id=index_version_id,
            artifact=artifact,
        )
        if model_id is None:
            with self.storage.database.connect() as connection:
                connection.execute(
                    """
                    UPDATE conversations
                    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE id = ?
                    """,
                    (conversation_id,),
                )
                connection.commit()
        else:
            self._touch_conversation(conversation_id, model_id=model_id)
        return message

    def delete(self, conversation_id: str) -> dict[str, object]:
        conversation = self._conversation_record(conversation_id)
        knowledge_base_id = str(conversation["knowledgeBaseId"])
        with self.storage.database.connect() as connection:
            connection.execute(
                "DELETE FROM conversations WHERE id = ?",
                (conversation_id,),
            )
            connection.commit()
        return self.list_conversations(knowledge_base_id)

    def export_markdown(
        self,
        conversation_id: str,
        *,
        message_id: str | None = None,
    ) -> dict[str, object]:
        conversation = self._conversation_record(conversation_id)
        messages = self._message_records(conversation_id)
        if message_id is not None:
            messages = [
                message
                for message in messages
                if message["id"] == message_id and message["role"] == "assistant"
            ]
            if not messages:
                raise ValueError("Assistant message not found in conversation")
        markdown = _conversation_markdown(conversation, messages)
        title = str(conversation["title"])
        suffix = "-answer" if message_id else "-conversation"
        return {
            "conversationId": conversation_id,
            "messageId": message_id,
            "fileName": f"{_safe_file_name(title)}{suffix}.md",
            "markdown": markdown,
        }

    def usage_summary(self, knowledge_base_id: str) -> dict[str, object]:
        self._ensure_knowledge_base(knowledge_base_id)
        with self.storage.database.connect() as connection:
            message_rows = connection.execute(
                """
                SELECT m.role, m.content, m.model_id, m.model_params_json
                FROM messages m
                JOIN conversations c ON c.id = m.conversation_id
                WHERE c.knowledge_base_id = ?
                ORDER BY m.created_at
                """,
                (knowledge_base_id,),
            ).fetchall()
            index_rows = connection.execute(
                """
                SELECT embedding_model,
                       (SELECT COUNT(*) FROM chunks WHERE index_version_id = iv.id) AS chunk_count
                FROM index_versions iv
                WHERE knowledge_base_id = ?
                  AND status IN ('ready', 'retired')
                """,
                (knowledge_base_id,),
            ).fetchall()

        chat_calls = 0
        query_embedding_calls = 0
        estimated_input_tokens = 0
        estimated_output_tokens = 0
        by_model: dict[str, int] = {}
        for row in message_rows:
            role = str(row["role"])
            content = str(row["content"])
            estimated_tokens = _estimated_tokens(content)
            if role == "user":
                query_embedding_calls += 1
                estimated_input_tokens += estimated_tokens
                continue
            if role != "assistant":
                continue
            estimated_output_tokens += estimated_tokens
            params = _json_object(row["model_params_json"])
            calls = _generation_call_count(params.get("attempts"))
            chat_calls += calls
            model_id = str(row["model_id"] or "unknown")
            by_model[model_id] = by_model.get(model_id, 0) + calls

        index_embedding_calls = sum(math.ceil(int(row["chunk_count"]) / 16) for row in index_rows)
        return {
            "knowledgeBaseId": knowledge_base_id,
            "calls": {
                "chat": chat_calls,
                "queryEmbedding": query_embedding_calls,
                "indexEmbedding": index_embedding_calls,
                "total": chat_calls + query_embedding_calls + index_embedding_calls,
            },
            "estimatedTokens": {
                "input": estimated_input_tokens,
                "output": estimated_output_tokens,
                "total": estimated_input_tokens + estimated_output_tokens,
            },
            "byModel": by_model,
            "estimatedCostCny": None,
            "pricingNotice": "调用量与 Token 为本地估算，实际费用以火山方舟账单为准。",
        }

    def set_model(self, conversation_id: str, model_id: str) -> dict[str, object]:
        clean_model_id = model_id.strip()
        if not clean_model_id:
            raise ValueError("modelId must be a non-empty string")
        self._conversation_record(conversation_id)
        self._touch_conversation(conversation_id, model_id=clean_model_id)
        return self._conversation_record(conversation_id)

    async def answer(
        self,
        *,
        knowledge_base_id: str,
        query: str,
        conversation_id: str | None = None,
        api_key: str | None = None,
        base_url: str = DEFAULT_ARK_BASE_URL,
        chat_model: str | None = None,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
        limit: int = 8,
        candidate_limit: int = 24,
        max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS,
    ) -> dict[str, object]:
        events: list[dict[str, object]] = []
        final_response: dict[str, object] | None = None
        async for event in self.stream_answer(
            knowledge_base_id=knowledge_base_id,
            query=query,
            conversation_id=conversation_id,
            api_key=api_key,
            base_url=base_url,
            chat_model=chat_model,
            embedding_model=embedding_model,
            limit=limit,
            candidate_limit=candidate_limit,
            max_output_tokens=max_output_tokens,
        ):
            if event.get("type") == "answer.completed":
                payload = event.get("response")
                if isinstance(payload, dict):
                    final_response = payload
                events.append({"type": "answer.completed"})
            else:
                events.append(event)
        if final_response is None:
            raise ValueError("回答生成未完成")
        final_response["events"] = events
        return final_response

    async def stream_answer(
        self,
        *,
        knowledge_base_id: str,
        query: str,
        conversation_id: str | None = None,
        api_key: str | None = None,
        base_url: str = DEFAULT_ARK_BASE_URL,
        chat_model: str | None = None,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
        limit: int = 8,
        candidate_limit: int = 24,
        max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS,
    ) -> AsyncIterator[dict[str, object]]:
        clean_query = _clean_query(query)
        started = perf_counter()
        trace_run_id: str | None = None
        trace_finished = False
        conversation = self._ensure_conversation(
            knowledge_base_id=knowledge_base_id,
            conversation_id=conversation_id,
            title=clean_query,
            model_id=chat_model or DEFAULT_CHAT_MODEL,
        )
        effective_chat_model = (
            chat_model
            or (str(conversation["modelId"]) if conversation["modelId"] else None)
            or DEFAULT_CHAT_MODEL
        )
        history_context = self._history_context(
            str(conversation["id"]),
            model_id=effective_chat_model,
            max_output_tokens=max_output_tokens,
        )
        trace_run_id = self._start_answer_trace(
            knowledge_base_id=knowledge_base_id,
            query=clean_query,
            conversation_id=str(conversation["id"]),
            chat_model=effective_chat_model,
            embedding_model=embedding_model,
            max_output_tokens=max_output_tokens,
        )
        try:
            user_message = self._insert_message(
                conversation_id=str(conversation["id"]),
                role="user",
                content=clean_query,
                model_id=None,
                model_params={},
                index_version_id=None,
            )
            yield {
                "type": "conversation.ready",
                "conversation": conversation,
                "message": user_message,
            }

            query_intent = _classify_query_intent(clean_query)
            if query_intent not in KNOWLEDGE_QUERY_INTENTS:
                response = self._persist_meta_answer(
                    conversation=conversation,
                    user_message=user_message,
                    query=clean_query,
                    intent=query_intent,
                    chat_model=effective_chat_model,
                    generation_time_ms=_elapsed_ms(started),
                    history_context=history_context,
                )
                self._record_answer_metrics(
                    knowledge_base_id,
                    started=started,
                    citation_failed=False,
                )
                response["agentRunId"] = trace_run_id
                self._save_answer_trace_output(trace_run_id, response)
                self._complete_answer_trace(
                    trace_run_id,
                    summary="已保存系统元问题说明",
                )
                trace_finished = True
                for event in _delta_events(str(response["content"])):
                    yield event
                yield {"type": "answer.completed", "response": response}
                return

            self._record_trace_stage(
                trace_run_id,
                stage="evidence_retrieval",
                status="started",
                title="检索知识库证据",
                step_id="conversation-retrieval",
            )
            retrieval_tool_id = self._start_trace_tool(
                trace_run_id,
                tool_name="hybrid_retrieval.search",
                action_summary="检索当前知识库候选证据",
                step_id="conversation-retrieval",
                sanitized_params={
                    "query": clean_query,
                    "limit": limit,
                    "candidateLimit": candidate_limit,
                    "apiKey": "***" if api_key else None,
                },
            )
            retrieval = await self.retrieval.retrieve(
                knowledge_base_id,
                clean_query,
                api_key=api_key,
                base_url=base_url,
                embedding_model=embedding_model,
                limit=limit,
                candidate_limit=candidate_limit,
            )
            index_version_id = _index_version_id(retrieval)
            self._record_trace_tool_output(
                retrieval_tool_id,
                stdout_summary=f"找到 {len(_candidate_chunk_ids(retrieval))} 个候选片段",
                payload={
                    "indexVersionId": index_version_id,
                    "candidateCount": len(_candidate_chunk_ids(retrieval)),
                },
            )
            self._finish_trace_tool(
                retrieval_tool_id,
                status="completed",
                stdout_summary=f"检索完成：{len(_candidate_chunk_ids(retrieval))} 个候选",
            )
            self._update_message_index(str(user_message["id"]), index_version_id)
            user_message = self._message_record(str(user_message["id"]))
            candidate_chunk_ids = _candidate_chunk_ids(retrieval)
            self._record_trace_stage(
                trace_run_id,
                stage="evidence_retrieval",
                status="completed",
                summary=f"检索到 {len(candidate_chunk_ids)} 个候选片段",
                step_id="conversation-retrieval",
            )
            yield {
                "type": "retrieval.completed",
                "indexVersionId": index_version_id,
                "candidateChunkIds": candidate_chunk_ids,
                "candidateCount": len(candidate_chunk_ids),
            }

            if not candidate_chunk_ids:
                response = self._persist_refusal(
                    conversation=conversation,
                    user_message=user_message,
                    retrieval=retrieval,
                    query_intent=query_intent,
                    evidence_status="no_evidence",
                    chat_model=effective_chat_model,
                    generation_time_ms=_elapsed_ms(started),
                    reason="no_retrieval_candidates",
                    history_context=history_context,
                )
                self._record_answer_metrics(
                    knowledge_base_id,
                    started=started,
                    citation_failed=True,
                )
                response["agentRunId"] = trace_run_id
                self._save_answer_trace_output(trace_run_id, response)
                self._complete_answer_trace(
                    trace_run_id,
                    summary="没有足够证据，已保存拒答结果",
                )
                trace_finished = True
                for event in _delta_events(str(response["content"])):
                    yield event
                yield {"type": "answer.completed", "response": response}
                return

            weak_reason = _low_relevance_reason(clean_query, retrieval)
            retrieval_evidence_status = _retrieval_evidence_status(
                query_intent=query_intent,
                weak_reason=weak_reason,
            )
            if weak_reason is not None and _should_refuse_weak_evidence(query_intent):
                response = self._persist_refusal(
                    conversation=conversation,
                    user_message=user_message,
                    retrieval=retrieval,
                    query_intent=query_intent,
                    evidence_status=retrieval_evidence_status,
                    chat_model=effective_chat_model,
                    generation_time_ms=_elapsed_ms(started),
                    reason=weak_reason,
                    history_context=history_context,
                )
                self._record_answer_metrics(
                    knowledge_base_id,
                    started=started,
                    citation_failed=True,
                )
                response["agentRunId"] = trace_run_id
                self._save_answer_trace_output(trace_run_id, response)
                self._complete_answer_trace(
                    trace_run_id,
                    summary="候选证据相关性过低，已保存拒答结果",
                )
                trace_finished = True
                for event in _delta_events(str(response["content"])):
                    yield event
                yield {"type": "answer.completed", "response": response}
                return

            if api_key is None or not api_key.strip():
                raise ValueError("尚未配置 Ark API Key，无法生成回答")
            gateway = self.gateway_factory(api_key, base_url, embedding_model)
            prompt = _answer_prompt(
                query=clean_query,
                retrieval=retrieval,
                query_intent=query_intent,
                evidence_status=retrieval_evidence_status,
                retry_feedback=None,
                history_context=history_context,
            )
            plain_prompt = _plain_answer_prompt(
                query=clean_query,
                retrieval=retrieval,
                query_intent=query_intent,
                evidence_status=retrieval_evidence_status,
                retry_feedback=None,
                history_context=history_context,
            )
            attempts: list[dict[str, object]] = []
            retry_count = 0
            final_answer: dict[str, object] | None = None
            final_validation: dict[str, object] | None = None
            self._record_trace_stage(
                trace_run_id,
                stage="drafting",
                status="started",
                title="生成回答",
                step_id="conversation-generation",
            )
            yield {"type": "generation.started", "modelId": effective_chat_model}

            for attempt_index in range(2):
                attempt_number = attempt_index + 1
                generation_tool_id = self._start_trace_tool(
                    trace_run_id,
                    tool_name="model.generate_structured_answer",
                    action_summary=f"生成结构化回答候选，第 {attempt_number} 次",
                    step_id="conversation-generation",
                    sanitized_params={
                        "model": effective_chat_model,
                        "candidateCount": len(candidate_chunk_ids),
                        "maxOutputTokens": max_output_tokens,
                    },
                )
                raw_answer, generation_meta = await _generate_answer_candidate(
                    gateway,
                    model=effective_chat_model,
                    structured_prompt=prompt,
                    plain_prompt=plain_prompt,
                    candidate_chunk_ids=candidate_chunk_ids,
                    max_output_tokens=max_output_tokens,
                )
                self._record_trace_tool_output(
                    generation_tool_id,
                    stdout_summary=f"模型返回候选，模式：{generation_meta['mode']}",
                    payload={
                        "attempt": attempt_number,
                        "generationMode": generation_meta["mode"],
                        "structuredError": generation_meta.get("structuredError"),
                        "plainFallbackError": generation_meta.get("plainFallbackError"),
                    },
                )
                self._finish_trace_tool(
                    generation_tool_id,
                    status="completed",
                    stdout_summary=f"生成候选完成：{generation_meta['mode']}",
                )
                answer = _shape_answer_paragraphs(
                    _normalize_answer(raw_answer),
                    retrieval=retrieval,
                )
                self._record_trace_stage(
                    trace_run_id,
                    stage="citation_validation",
                    status="started",
                    title="校验回答引用",
                    step_id="conversation-citation-validation",
                )
                citation_tool_id = self._start_trace_tool(
                    trace_run_id,
                    tool_name="citation.validate",
                    action_summary=f"校验第 {attempt_number} 次候选引用",
                    step_id="conversation-citation-validation",
                    sanitized_params={
                        "candidateChunkIds": candidate_chunk_ids,
                        "indexVersionId": index_version_id,
                    },
                )
                validation = self.validator.validate(
                    paragraphs=_paragraphs_for_validation(answer),
                    candidate_chunk_ids=candidate_chunk_ids,
                    index_version_id=index_version_id,
                )
                self._record_trace_tool_output(
                    citation_tool_id,
                    stdout_summary=_trace_validation_summary(validation),
                    payload={
                        "attempt": attempt_number,
                        "valid": validation["valid"],
                        "invalidCitations": validation["invalidCitations"],
                    },
                )
                self._finish_trace_tool(
                    citation_tool_id,
                    status="completed",
                    stdout_summary=_trace_validation_summary(validation),
                )
                self._record_trace_stage(
                    trace_run_id,
                    stage="citation_validation",
                    status="completed",
                    summary=_trace_validation_summary(validation),
                    step_id="conversation-citation-validation",
                )
                attempts.append(
                    {
                        "attempt": attempt_number,
                        "generationMode": generation_meta["mode"],
                        "modelEvidenceSufficient": answer["evidenceSufficient"],
                        "validationValid": validation["valid"],
                        "invalidCitations": validation["invalidCitations"],
                        "structuredError": generation_meta.get("structuredError"),
                        "plainFallbackError": generation_meta.get("plainFallbackError"),
                    }
                )
                final_answer = answer
                final_validation = validation
                if answer["evidenceSufficient"] is True and validation["valid"] is True:
                    break
                if answer["evidenceSufficient"] is False or attempt_index == 1:
                    break
                retry_count = 1
                prompt = _answer_prompt(
                    query=clean_query,
                    retrieval=retrieval,
                    query_intent=query_intent,
                    evidence_status=retrieval_evidence_status,
                    retry_feedback=validation,
                    history_context=history_context,
                )
                plain_prompt = _plain_answer_prompt(
                    query=clean_query,
                    retrieval=retrieval,
                    query_intent=query_intent,
                    evidence_status=retrieval_evidence_status,
                    retry_feedback=validation,
                    history_context=history_context,
                )

            assert final_answer is not None
            assert final_validation is not None
            self._record_trace_stage(
                trace_run_id,
                stage="drafting",
                status="completed",
                summary=f"生成完成，重试 {retry_count} 次",
                step_id="conversation-generation",
            )
            response = self._persist_answer(
                conversation=conversation,
                user_message=user_message,
                retrieval=retrieval,
                answer=final_answer,
                validation=final_validation,
                query_intent=query_intent,
                retrieval_evidence_status=retrieval_evidence_status,
                chat_model=effective_chat_model,
                max_output_tokens=max_output_tokens,
                generation_time_ms=_elapsed_ms(started),
                retry_count=retry_count,
                attempts=attempts,
                history_context=history_context,
            )
            self._record_answer_metrics(
                knowledge_base_id,
                started=started,
                citation_failed=final_validation["valid"] is not True,
            )
            response["agentRunId"] = trace_run_id
            self._save_answer_trace_output(trace_run_id, response)
            self._complete_answer_trace(
                trace_run_id,
                summary="回答已生成并完成引用校验",
            )
            trace_finished = True
            yield {"type": "citation.validated", "validation": response["citationValidation"]}
            for event in _delta_events(str(response["content"])):
                yield event
            yield {"type": "answer.completed", "response": response}
        except Exception as error:
            if trace_run_id is not None and not trace_finished:
                self._fail_answer_trace(trace_run_id, error)
            raise

    def _start_answer_trace(
        self,
        *,
        knowledge_base_id: str,
        query: str,
        conversation_id: str,
        chat_model: str,
        embedding_model: str,
        max_output_tokens: int,
    ) -> str | None:
        if self.agent_runs is None:
            return None
        created = self.agent_runs.create(
            knowledge_base_id,
            goal=query,
            skill_id="conversation_answer",
            skill_version="1.0.0",
            title="对话回答",
            models={"chat": chat_model, "embedding": embedding_model},
            budgets={
                "maxSteps": 8,
                "maxModelCalls": 2,
                "maxOutputTokens": max_output_tokens,
                "maxDurationSeconds": 300,
            },
        )
        run_id = _agent_run_id(created)
        self.agent_runs.record_skill_loaded(
            run_id,
            skill_id="conversation_answer",
            skill_version="1.0.0",
            summary="普通对话回答 Trace",
        )
        self.agent_runs.update_plan(
            run_id,
            {
                "conversationId": conversation_id,
                "steps": [
                    {"id": "conversation-retrieval", "title": "检索当前知识库证据"},
                    {"id": "conversation-generation", "title": "生成结构化回答"},
                    {"id": "conversation-citation-validation", "title": "校验引用"},
                    {"id": "conversation-output", "title": "保存回答结果"},
                ],
            },
            summary="已建立普通对话回答执行计划",
        )
        self.agent_runs.transition(
            run_id,
            "executing",
            stage="planning",
            summary="开始执行普通对话回答",
        )
        return run_id

    def _record_trace_stage(
        self,
        run_id: str | None,
        *,
        stage: str,
        status: Literal["started", "completed"],
        title: str | None = None,
        summary: str | None = None,
        step_id: str | None = None,
    ) -> None:
        if self.agent_runs is None or run_id is None:
            return
        self.agent_runs.record_stage(
            run_id,
            stage=stage,
            status=status,
            title=title,
            summary=summary,
            step_id=step_id,
        )

    def _start_trace_tool(
        self,
        run_id: str | None,
        *,
        tool_name: str,
        action_summary: str,
        step_id: str,
        sanitized_params: Mapping[str, object],
    ) -> str | None:
        if self.agent_runs is None or run_id is None:
            return None
        response = self.agent_runs.start_tool_call(
            run_id,
            tool_name=tool_name,
            action_summary=action_summary,
            step_id=step_id,
            skill_id="conversation_answer",
            skill_version="1.0.0",
            sanitized_params=sanitized_params,
        )
        return _agent_tool_call_id(response)

    def _record_trace_tool_output(
        self,
        tool_call_id: str | None,
        *,
        stdout_summary: str,
        payload: Mapping[str, object] | None = None,
    ) -> None:
        if self.agent_runs is None or tool_call_id is None:
            return
        self.agent_runs.record_tool_output(
            tool_call_id,
            stdout_summary=stdout_summary,
            payload=payload,
        )

    def _finish_trace_tool(
        self,
        tool_call_id: str | None,
        *,
        status: str,
        stdout_summary: str | None = None,
        stderr_summary: str | None = None,
        error_message: str | None = None,
    ) -> None:
        if self.agent_runs is None or tool_call_id is None:
            return
        self.agent_runs.finish_tool_call(
            tool_call_id,
            status=status,
            exit_code=0 if status == "completed" else 1,
            stdout_summary=stdout_summary,
            stderr_summary=stderr_summary,
            error_message=error_message,
        )

    def _save_answer_trace_output(
        self,
        run_id: str | None,
        response: Mapping[str, object],
    ) -> None:
        if self.agent_runs is None or run_id is None:
            return
        self._record_trace_stage(
            run_id,
            stage="finalizing",
            status="started",
            title="保存对话回答",
            step_id="conversation-output",
        )
        content = str(response.get("content", ""))
        self.agent_runs.save_output(
            run_id,
            output_type="final",
            title="对话回答",
            content=content,
            payload={
                "conversationId": _nested_string(response, "conversation", "id"),
                "assistantMessageId": _nested_string(response, "assistantMessage", "id"),
                "evidenceSufficient": _nested_bool(response, "answer", "evidenceSufficient"),
                "answerMode": _nested_string(response, "answer", "answerMode"),
                "citationPolicy": _nested_string(response, "answer", "citationPolicy"),
                "queryIntent": _nested_string(response, "answer", "queryIntent"),
                "evidenceStatus": _nested_string(response, "answer", "evidenceStatus"),
                "citationValidation": response.get("citationValidation"),
            },
            citations=_trace_response_citations(response.get("citations")),
        )
        self._record_trace_stage(
            run_id,
            stage="finalizing",
            status="completed",
            summary="对话回答已保存",
            step_id="conversation-output",
        )

    def _complete_answer_trace(self, run_id: str | None, *, summary: str) -> None:
        if self.agent_runs is None or run_id is None:
            return
        self.agent_runs.transition(
            run_id,
            "completed",
            stage="finalizing",
            summary=summary,
            stop_reason="done",
        )

    def _fail_answer_trace(self, run_id: str, error: Exception) -> None:
        if self.agent_runs is None:
            return
        self.agent_runs.fail(
            run_id,
            error_message=str(error),
            stage="finalizing",
        )

    def _record_answer_metrics(
        self,
        knowledge_base_id: str,
        *,
        started: float,
        citation_failed: bool,
    ) -> None:
        record_metric(
            self.storage,
            "answer.first_token_latency_ms",
            _elapsed_ms(started),
            "ms",
            knowledge_base_id=knowledge_base_id,
        )
        record_metric(
            self.storage,
            "citation.validation_failure",
            int(citation_failed),
            "ratio",
            knowledge_base_id=knowledge_base_id,
        )

    def _persist_answer(
        self,
        *,
        conversation: dict[str, object],
        user_message: dict[str, object],
        retrieval: dict[str, object],
        answer: dict[str, object],
        validation: dict[str, object],
        query_intent: QueryIntent,
        retrieval_evidence_status: EvidenceStatus,
        chat_model: str,
        max_output_tokens: int,
        generation_time_ms: int,
        retry_count: int,
        attempts: Sequence[dict[str, object]],
        history_context: dict[str, object],
    ) -> dict[str, object]:
        evidence_sufficient = answer["evidenceSufficient"] is True and validation["valid"] is True
        evidence_status = _final_evidence_status(
            answer=answer,
            validation=validation,
            retrieval_evidence_status=retrieval_evidence_status,
        )
        if evidence_sufficient:
            paragraphs = _validated_paragraphs(validation)
            content = "\n\n".join(str(paragraph["text"]) for paragraph in paragraphs)
            refusal_reason = None
            citations = _valid_citations(validation)
        else:
            content = (
                _refusal_text(answer) if answer["evidenceSufficient"] is False else DEFAULT_REFUSAL
            )
            paragraphs = [
                {
                    "index": 0,
                    "text": content,
                    "evidenceChunkIds": [],
                }
            ]
            refusal_reason = _refusal_reason(answer, validation)
            citations = []

        assistant_message = self._insert_message(
            conversation_id=str(conversation["id"]),
            role="assistant",
            content=content,
            model_id=chat_model,
            model_params={
                "maxOutputTokens": max_output_tokens,
                "generationTimeMs": generation_time_ms,
                "retryCount": retry_count,
                "attempts": list(attempts),
                "answerMode": "knowledge_grounded",
                "citationPolicy": "required",
                "queryIntent": query_intent,
                "evidenceStatus": evidence_status,
                "evidenceSufficient": evidence_sufficient,
                "refusalReason": refusal_reason,
                "candidateChunkIds": _candidate_chunk_ids(retrieval),
                "retrieval": retrieval.get("retrieval"),
                "citationValidation": {
                    "valid": validation["valid"],
                    "invalidCitations": validation["invalidCitations"],
                },
                "answerParagraphs": paragraphs,
                "historyContext": history_context,
            },
            index_version_id=_index_version_id(retrieval),
        )
        self._insert_citations(str(assistant_message["id"]), citations)
        assistant_message = self._message_record(str(assistant_message["id"]))
        self._touch_conversation(str(conversation["id"]), model_id=chat_model)
        return {
            "conversation": self._conversation_record(str(conversation["id"])),
            "userMessage": user_message,
            "assistantMessage": assistant_message,
            "content": content,
            "answer": {
                "paragraphs": paragraphs,
                "evidenceSufficient": evidence_sufficient,
                "refusalReason": refusal_reason,
                "answerMode": "knowledge_grounded",
                "citationPolicy": "required",
                "queryIntent": query_intent,
                "evidenceStatus": evidence_status,
            },
            "citations": citations,
            "citationValidation": validation,
            "retrieval": retrieval,
            "model": {
                "id": chat_model,
                "maxOutputTokens": max_output_tokens,
                "generationTimeMs": generation_time_ms,
                "retryCount": retry_count,
            },
        }

    def _persist_refusal(
        self,
        *,
        conversation: dict[str, object],
        user_message: dict[str, object],
        retrieval: dict[str, object],
        query_intent: QueryIntent,
        evidence_status: EvidenceStatus,
        chat_model: str,
        generation_time_ms: int,
        reason: str,
        history_context: dict[str, object],
    ) -> dict[str, object]:
        candidate_chunk_ids = _candidate_chunk_ids(retrieval)
        assistant_message = self._insert_message(
            conversation_id=str(conversation["id"]),
            role="assistant",
            content=DEFAULT_REFUSAL,
            model_id=chat_model,
            model_params={
                "generationTimeMs": generation_time_ms,
                "retryCount": 0,
                "answerMode": "knowledge_grounded",
                "citationPolicy": "required",
                "queryIntent": query_intent,
                "evidenceStatus": evidence_status,
                "evidenceSufficient": False,
                "refusalReason": reason,
                "candidateChunkIds": candidate_chunk_ids,
                "retrieval": retrieval.get("retrieval"),
                "historyContext": history_context,
            },
            index_version_id=_index_version_id(retrieval),
        )
        assistant_message = self._message_record(str(assistant_message["id"]))
        self._touch_conversation(str(conversation["id"]), model_id=chat_model)
        validation = {
            "valid": False,
            "paragraphs": [
                {
                    "index": 0,
                    "text": DEFAULT_REFUSAL,
                    "validEvidenceChunkIds": [],
                    "invalidEvidenceChunkIds": [],
                }
            ],
            "validCitations": [],
            "invalidCitations": [
                {
                    "paragraphIndex": 0,
                    "chunkId": None,
                    "reason": reason,
                }
            ],
            "candidateChunkIds": candidate_chunk_ids,
        }
        return {
            "conversation": self._conversation_record(str(conversation["id"])),
            "userMessage": user_message,
            "assistantMessage": assistant_message,
            "content": DEFAULT_REFUSAL,
            "answer": {
                "paragraphs": [
                    {
                        "index": 0,
                        "text": DEFAULT_REFUSAL,
                        "evidenceChunkIds": [],
                    }
                ],
                "evidenceSufficient": False,
                "refusalReason": reason,
                "answerMode": "knowledge_grounded",
                "citationPolicy": "required",
                "queryIntent": query_intent,
                "evidenceStatus": evidence_status,
            },
            "citations": [],
            "citationValidation": validation,
            "retrieval": retrieval,
            "model": {
                "id": chat_model,
                "generationTimeMs": generation_time_ms,
                "retryCount": 0,
            },
        }

    def _persist_meta_answer(
        self,
        *,
        conversation: dict[str, object],
        user_message: dict[str, object],
        query: str,
        intent: QueryIntent,
        chat_model: str,
        generation_time_ms: int,
        history_context: dict[str, object],
    ) -> dict[str, object]:
        content = _meta_answer_text(intent)
        retrieval = _empty_meta_retrieval(
            knowledge_base_id=str(conversation["knowledgeBaseId"]),
            query=query,
        )
        paragraphs = [
            {
                "index": index,
                "text": paragraph,
                "evidenceChunkIds": [],
            }
            for index, paragraph in enumerate(_meta_answer_paragraphs(content))
        ]
        validation = {
            "valid": True,
            "paragraphs": [
                {
                    "index": paragraph["index"],
                    "text": paragraph["text"],
                    "validEvidenceChunkIds": [],
                    "invalidEvidenceChunkIds": [],
                }
                for paragraph in paragraphs
            ],
            "validCitations": [],
            "invalidCitations": [],
            "candidateChunkIds": [],
        }
        assistant_message = self._insert_message(
            conversation_id=str(conversation["id"]),
            role="assistant",
            content=content,
            model_id=chat_model,
            model_params={
                "generationTimeMs": generation_time_ms,
                "retryCount": 0,
                "answerMode": "system_meta",
                "citationPolicy": "not_required",
                "queryIntent": intent,
                "systemMetaProfileVersion": _profile_text("version"),
                "evidenceSufficient": True,
                "refusalReason": None,
                "candidateChunkIds": [],
                "retrieval": retrieval.get("retrieval"),
                "citationValidation": {
                    "valid": True,
                    "invalidCitations": [],
                },
                "answerParagraphs": paragraphs,
                "historyContext": history_context,
            },
            index_version_id=None,
        )
        assistant_message = self._message_record(str(assistant_message["id"]))
        self._touch_conversation(str(conversation["id"]), model_id=chat_model)
        return {
            "conversation": self._conversation_record(str(conversation["id"])),
            "userMessage": user_message,
            "assistantMessage": assistant_message,
            "content": content,
            "answer": {
                "paragraphs": paragraphs,
                "evidenceSufficient": True,
                "refusalReason": None,
                "answerMode": "system_meta",
                "citationPolicy": "not_required",
                "queryIntent": intent,
            },
            "citations": [],
            "citationValidation": validation,
            "retrieval": retrieval,
            "model": {
                "id": chat_model,
                "generationTimeMs": generation_time_ms,
                "retryCount": 0,
            },
        }

    def _ensure_conversation(
        self,
        *,
        knowledge_base_id: str,
        conversation_id: str | None,
        title: str,
        model_id: str,
    ) -> dict[str, object]:
        self._ensure_knowledge_base(knowledge_base_id)
        if conversation_id:
            conversation = self._conversation_record(conversation_id)
            if conversation["knowledgeBaseId"] != knowledge_base_id:
                raise ValueError("Conversation does not belong to knowledge base")
            return conversation
        new_id = f"conversation-{uuid4().hex}"
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO conversations(id, knowledge_base_id, title, model_id)
                VALUES (?, ?, ?, ?)
                """,
                (new_id, knowledge_base_id, _conversation_title(title), model_id),
            )
            connection.commit()
        return self._conversation_record(new_id)

    def _insert_message(
        self,
        *,
        conversation_id: str,
        role: str,
        content: str,
        model_id: str | None,
        model_params: dict[str, object],
        index_version_id: str | None,
        artifact: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        message_id = f"message-{uuid4().hex}"
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO messages(
                    id, conversation_id, role, content, model_id,
                    model_params_json, index_version_id, artifact_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message_id,
                    conversation_id,
                    role,
                    content,
                    model_id,
                    json.dumps(model_params, ensure_ascii=False),
                    index_version_id,
                    json.dumps(dict(artifact or {}), ensure_ascii=False),
                ),
            )
            connection.commit()
        return self._message_record(message_id)

    def _insert_citations(
        self,
        message_id: str,
        citations: Sequence[dict[str, object]],
    ) -> None:
        if not citations:
            return
        rows: list[tuple[str, str, int, str]] = []
        for citation in citations:
            paragraph_index = citation.get("paragraphIndex")
            chunk_id = citation.get("chunkId")
            if not isinstance(paragraph_index, int) or not isinstance(chunk_id, str):
                continue
            rows.append((f"citation-{uuid4().hex}", message_id, paragraph_index, chunk_id))
        if not rows:
            return
        with self.storage.database.connect() as connection:
            connection.executemany(
                """
                INSERT INTO answer_citations(id, message_id, paragraph_index, chunk_id)
                VALUES (?, ?, ?, ?)
                """,
                rows,
            )
            connection.commit()

    def _update_message_index(self, message_id: str, index_version_id: str) -> None:
        with self.storage.database.connect() as connection:
            connection.execute(
                "UPDATE messages SET index_version_id = ? WHERE id = ?",
                (index_version_id, message_id),
            )
            connection.commit()

    def _touch_conversation(self, conversation_id: str, *, model_id: str) -> None:
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE conversations
                SET model_id = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (model_id, conversation_id),
            )
            connection.commit()

    def _conversation_record(self, conversation_id: str) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                """
                SELECT id, knowledge_base_id, title, model_id, created_at, updated_at
                FROM conversations
                WHERE id = ?
                """,
                (conversation_id,),
            ).fetchone()
        if row is None:
            raise ValueError("Conversation not found")
        return _conversation_record_from_row(row)

    def _message_record(self, message_id: str) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                """
                SELECT id, conversation_id, role, content, model_id,
                       model_params_json, index_version_id, artifact_json, created_at
                FROM messages
                WHERE id = ?
                """,
                (message_id,),
            ).fetchone()
        if row is None:
            raise ValueError("Message not found")
        return _message_record_from_row(row, citations=self._citations_for_message(message_id))

    def _message_records(self, conversation_id: str) -> list[dict[str, object]]:
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT id, conversation_id, role, content, model_id,
                       model_params_json, index_version_id, artifact_json, created_at
                FROM messages
                WHERE conversation_id = ?
                ORDER BY created_at ASC
                """,
                (conversation_id,),
            ).fetchall()
        return [
            _message_record_from_row(row, citations=self._citations_for_message(str(row["id"])))
            for row in rows
        ]

    def _citations_for_message(self, message_id: str) -> list[dict[str, object]]:
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    ac.paragraph_index,
                    ac.chunk_id,
                    c.page_number,
                    c.bounding_box_json,
                    c.heading_path_json,
                    c.anchor,
                    c.normalized_text,
                    sv.id AS source_version_id,
                    s.id AS source_id,
                    s.source_type,
                    s.display_name,
                    s.uri
                FROM answer_citations ac
                JOIN chunks c ON c.id = ac.chunk_id
                JOIN source_versions sv ON sv.id = c.source_version_id
                JOIN sources s ON s.id = sv.source_id
                WHERE ac.message_id = ?
                ORDER BY ac.paragraph_index ASC, ac.created_at ASC
                """,
                (message_id,),
            ).fetchall()
        return [
            {
                "paragraphIndex": int(row["paragraph_index"]),
                "chunkId": str(row["chunk_id"]),
                "source": {
                    "id": str(row["source_id"]),
                    "versionId": str(row["source_version_id"]),
                    "type": str(row["source_type"]),
                    "displayName": str(row["display_name"]),
                    "uri": row["uri"],
                },
                "location": {
                    "pageNumber": row["page_number"],
                    "boundingBox": _json_optional_object(row["bounding_box_json"]),
                    "headingPath": _json_string_list(row["heading_path_json"]),
                    "anchor": row["anchor"],
                },
                "text": {
                    "preview": _preview(str(row["normalized_text"])),
                    "normalized": str(row["normalized_text"]),
                },
            }
            for row in rows
        ]

    def _ensure_knowledge_base(self, knowledge_base_id: str) -> None:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                "SELECT 1 FROM knowledge_bases WHERE id = ?",
                (knowledge_base_id,),
            ).fetchone()
        if row is None:
            raise ValueError("Knowledge base not found")

    def _history_context(
        self,
        conversation_id: str,
        *,
        model_id: str,
        max_output_tokens: int,
    ) -> dict[str, object]:
        messages = self._message_records(conversation_id)
        context_window = context_window_for(model_id)
        budget_chars = max(2_000, (context_window - max_output_tokens - 4_000) * 3)
        return _compact_history(messages, budget_chars=budget_chars)


def _ark_gateway_factory(api_key: str, base_url: str, embedding_model: str) -> AnswerGateway:
    return ArkModelGateway(
        api_key,
        base_url=base_url,
        embedding_model=embedding_model,
    )


def _classify_query_intent(query: str) -> QueryIntent:
    compact = re.sub(r"[\s？?！!。,.，、：:；;“”\"'（）()【】\[\]]+", "", query.lower())
    knowledge_markers = (
        "资料",
        "材料",
        "文档",
        "文件",
        "简历",
        "候选人",
        "作者",
        "这份",
        "这篇",
        "pdf",
        "来源",
        "原文",
        "知识库里",
        "知识库中",
        "已导入",
        "上传的",
        "资料里",
        "资料中",
        "文档里",
        "文档中",
        "文件里",
        "文件中",
    )
    knowledge_task_intent = _classify_knowledge_task_intent(compact)
    if any(marker in compact for marker in knowledge_markers):
        return knowledge_task_intent

    subject_markers = ("你", "citemind", "这个软件", "这个应用", "这个系统", "系统")
    asks_system_subject = any(marker in compact for marker in subject_markers)

    identity_exact_markers = {
        "你是谁",
        "你是什么",
        "你是什么模型",
        "你叫什么",
        "你是干嘛的",
        "你是做什么的",
        "你基于什么模型",
        "你用的什么模型",
        "介绍一下你自己",
        "请介绍一下你自己",
        "自我介绍",
        "citemind是什么",
        "citemind是干嘛的",
        "citemind是做什么的",
        "这个软件是什么",
        "这个应用是什么",
        "这个系统是什么",
        "你和普通ai有什么区别",
        "你和普通ai有什么不同",
    }
    identity_phrase_markers = (
        "是谁",
        "是什么",
        "叫什么",
        "叫什么名字",
        "自我介绍",
        "介绍一下你自己",
        "普通ai有什么区别",
        "普通ai有什么不同",
    )
    if compact in identity_exact_markers or (
        asks_system_subject and any(marker in compact for marker in identity_phrase_markers)
    ):
        return "assistant_identity"

    tool_markers = ("工具", "tool", "调用")
    runtime_markers = (
        "你",
        "刚才",
        "本轮",
        "这次",
        "本次",
        "当前回答",
        "本次回答",
        "用了哪些",
        "使用了哪些",
        "用到了哪些",
        "调用了哪些",
        "用过哪些",
    )
    if any(marker in compact for marker in tool_markers) and any(
        marker in compact for marker in runtime_markers
    ):
        return "runtime_tool_question"

    capability_markers = (
        "你能做什么",
        "你会什么",
        "你会做什么",
        "能做什么",
        "可以做什么",
        "能帮我做什么",
        "可以帮我做什么",
        "能帮忙干什么",
        "支持哪些功能",
        "有哪些功能",
        "功能是什么",
        "你的能力",
        "有什么能力",
        "有哪些能力",
        "怎么使用",
        "如何使用",
        "怎么用",
        "如何用",
        "怎么提问",
        "适合做什么",
    )
    if any(marker in compact for marker in capability_markers) and asks_system_subject:
        return "system_capability"
    limitation_markers = (
        "有什么限制",
        "限制是什么",
        "你的限制",
        "你的局限",
        "有什么局限",
        "不能做什么",
        "什么不能做",
        "什么时候拒答",
        "为什么拒答",
        "为什么不能回答",
        "哪些问题不能回答",
        "什么问题不能回答",
        "你会拒答吗",
        "会不会胡编",
        "会胡编吗",
        "会不会编造",
        "会编造吗",
        "边界是什么",
        "边界在哪",
    )
    if any(marker in compact for marker in limitation_markers) and (
        asks_system_subject or "拒答" in compact or "不能回答" in compact
    ):
        return "system_limitation"
    citation_markers = (
        "为什么要引用",
        "为什么需要引用",
        "怎么保证可信",
        "怎么保证引用可信",
        "引用可信",
        "怎么校验引用",
        "引用怎么校验",
        "怎么校验证据",
        "证据怎么校验",
        "引用规则",
        "证据规则",
        "引用从哪里来",
        "证据从哪里来",
        "什么问题需要引用",
        "为什么没有引用",
        "为什么无引用",
        "为什么没引用",
        "rag是什么",
        "rag是啥",
    )
    if any(marker in compact for marker in citation_markers):
        return "citation_policy"
    if knowledge_task_intent != "knowledge_fact_qa":
        return knowledge_task_intent
    return "knowledge_fact_qa"


def _classify_knowledge_task_intent(compact_query: str) -> QueryIntent:
    interview_markers = (
        "面试",
        "追问",
        "面试官",
        "模拟",
        "准备问题",
        "提问",
        "问我",
        "问题清单",
    )
    if any(marker in compact_query for marker in interview_markers):
        return "knowledge_interview"

    summary_markers = (
        "总结",
        "概括",
        "提炼",
        "归纳",
        "亮点",
        "优势",
        "不足",
        "核心内容",
        "主要内容",
    )
    if any(marker in compact_query for marker in summary_markers):
        return "knowledge_summary"

    transform_markers = (
        "改写",
        "润色",
        "生成",
        "写一段",
        "写一个",
        "写份",
        "自我介绍",
        "邮件",
        "简历描述",
        "包装",
        "整理成",
    )
    if any(marker in compact_query for marker in transform_markers):
        return "knowledge_transform"

    review_markers = (
        "评价",
        "分析",
        "建议",
        "优化",
        "如何改进",
        "改进方向",
        "风险",
        "短板",
        "可提升",
    )
    if any(marker in compact_query for marker in review_markers):
        return "knowledge_review"

    return "knowledge_fact_qa"


def _meta_answer_text(intent: QueryIntent) -> str:
    if intent == "assistant_identity":
        return (
            f"{_profile_text('identity')}"
            "\n\n"
            f"{_profile_text('scope')}"
            "\n\n"
            f"{_profile_text('modelBoundary')}"
            "\n\n如果你想问这份资料里的“你”是谁，可以改问“这份简历中的候选人是谁？”。"
        )
    if intent == "system_capability":
        return (
            "我可以帮助你围绕本地知识库完成可信问答和资料处理。"
            f"主要能力包括：{_join_profile_items('capabilities')}。"
            "\n\n如果你明确询问资料、简历或文档里的事实，我会切换到知识库检索并要求引用校验。"
        )
    if intent == "system_limitation":
        return (
            "我的主要边界是："
            f"{_join_profile_items('limitations')}。"
            "\n\n因此，当资料证据不足、候选弱相关或引用校验失败时，我会拒答，而不是把无关来源当作证据。"
        )
    if intent == "citation_policy":
        return (
            "我的引用规则是："
            f"{_join_profile_items('citationPolicy')}。"
            "\n\n所以系统说明类问题会标记为“无需知识库引用”；知识库事实问题仍必须提供可点击、可校验的来源引用。"
        )
    if intent == "runtime_tool_question":
        return (
            f"{_profile_text('runtimeToolNote')}"
            "\n\n本次回答走的是系统元问题说明路径，不需要也不会伪造知识库引用。"
            "如果你想问资料或项目中使用了哪些技术工具，可以明确问“资料中提到了哪些技术工具？”。"
        )
    return DEFAULT_REFUSAL


def _profile_text(key: str) -> str:
    value = SYSTEM_META_PROFILE.get(key)
    return value if isinstance(value, str) else ""


def _join_profile_items(key: str) -> str:
    value = SYSTEM_META_PROFILE.get(key)
    if not isinstance(value, tuple):
        return ""
    return "；".join(value)


def _meta_answer_paragraphs(content: str) -> list[str]:
    paragraphs = [_clean_inline_text(block) for block in re.split(r"\n\s*\n", content)]
    return [paragraph for paragraph in paragraphs if paragraph]


def _empty_meta_retrieval(*, knowledge_base_id: str, query: str) -> dict[str, object]:
    return {
        "knowledgeBaseId": knowledge_base_id,
        "query": query,
        "indexVersion": {
            "id": "system-meta",
            "embeddingProvider": "system",
            "embeddingModel": "not_required",
            "embeddingDimension": 0,
            "chunkingVersion": "not_required",
            "parserVersion": "not_required",
            "status": "ready",
            "isCurrent": True,
            "createdAt": "",
            "activatedAt": None,
            "retainedUntil": None,
            "failureReason": None,
            "reusedChunkCount": 0,
            "embeddedChunkCount": 0,
            "chunkCount": 0,
        },
        "limits": {
            "resultLimit": 0,
            "candidateLimit": 0,
        },
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
        "context": {
            "chunkCount": 0,
            "chunks": [],
            "text": "",
        },
    }


def _retrieval_evidence_status(
    *,
    query_intent: QueryIntent,
    weak_reason: str | None,
) -> EvidenceStatus:
    if weak_reason is not None:
        return "weak_evidence"
    if query_intent in {
        "knowledge_summary",
        "knowledge_transform",
        "knowledge_interview",
        "knowledge_review",
    }:
        return "partial_evidence"
    return "strong_evidence"


def _should_refuse_weak_evidence(query_intent: QueryIntent) -> bool:
    return query_intent == "knowledge_fact_qa"


def _final_evidence_status(
    *,
    answer: Mapping[str, object],
    validation: Mapping[str, object],
    retrieval_evidence_status: EvidenceStatus,
) -> EvidenceStatus:
    if retrieval_evidence_status == "weak_evidence":
        return "partial_evidence" if validation.get("valid") is True else "weak_evidence"
    if answer.get("evidenceSufficient") is True and validation.get("valid") is True:
        return retrieval_evidence_status
    return "partial_evidence"


def _low_relevance_reason(query: str, retrieval: dict[str, object]) -> str | None:
    results = retrieval.get("results")
    retrieval_meta = retrieval.get("retrieval")
    if not isinstance(results, list) or not results:
        return None
    if not isinstance(retrieval_meta, dict):
        return None
    keyword_count = retrieval_meta.get("keywordCandidateCount")
    if isinstance(keyword_count, int) and keyword_count > 0:
        return None

    query_terms = _text_terms(query)
    if not query_terms or len(query_terms) > LOW_RELEVANCE_MAX_QUERY_TERMS:
        return None
    if _has_query_chunk_overlap(query_terms, results):
        return None
    if not _all_results_semantic_only(results):
        return None

    top_distance = _top_semantic_distance(results)
    if top_distance is not None and top_distance < LOW_RELEVANCE_DISTANCE_THRESHOLD:
        return None
    return "low_relevance_candidates"


def _has_query_chunk_overlap(
    query_terms: set[str],
    results: Sequence[object],
) -> bool:
    for result in results:
        if not isinstance(result, dict):
            continue
        text = result.get("text")
        text_record = text if isinstance(text, dict) else {}
        chunk_text = " ".join(
            str(text_record.get(key) or "") for key in ("normalized", "original", "preview")
        )
        if query_terms & _text_terms(chunk_text):
            return True
        match = result.get("match")
        if isinstance(match, dict) and match.get("hasKeywordHit") is True:
            return True
    return False


def _all_results_semantic_only(results: Sequence[object]) -> bool:
    for result in results:
        if not isinstance(result, dict):
            continue
        match = result.get("match")
        if not isinstance(match, dict):
            return False
        matched_by = match.get("matchedBy")
        if not isinstance(matched_by, list):
            return False
        if "keyword" in matched_by or "semantic" not in matched_by:
            return False
    return True


def _top_semantic_distance(results: Sequence[object]) -> float | None:
    for result in results:
        if not isinstance(result, dict):
            continue
        scores = result.get("scores")
        if not isinstance(scores, dict):
            continue
        distance = scores.get("semanticDistance")
        if isinstance(distance, int | float):
            return float(distance)
    return None


def _answer_prompt(
    *,
    query: str,
    retrieval: dict[str, object],
    query_intent: QueryIntent,
    evidence_status: EvidenceStatus,
    retry_feedback: dict[str, object] | None,
    history_context: dict[str, object],
) -> str:
    retry_text = ""
    if retry_feedback is not None:
        retry_text = (
            "\n上一次输出包含无效引用，必须修正。"
            f"\n无效引用：{json.dumps(retry_feedback['invalidCitations'], ensure_ascii=False)}"
            "\n只能使用下方候选证据中的 chunk_id。"
        )
    return (
        "你是 citeMind 的可信知识库回答模块。"
        "\n只允许使用候选证据回答用户问题，不得使用外部知识或自行补全事实。"
        "\n如果候选证据不足，必须将 evidence_sufficient 设为 false，"
        "并用一句话说明当前知识库没有足够证据。"
        "\n必须把不同要点拆成多个 paragraphs 数组项；"
        "不要把多条事实、多个追问或多个建议塞进同一个段落。"
        "\n每个段落建议 1-3 句，按自然阅读顺序组织。"
        "\n每个回答段落都必须给出支撑该段内容的 evidence_chunk_ids，"
        "且只能引用候选证据中的 chunk_id。"
        "\n输出必须符合 JSON Schema，不要输出 Markdown 或额外解释。"
        f"\n当前知识库任务类型：{query_intent}。"
        f"\n当前检索证据状态：{evidence_status}。"
        f"\n{_knowledge_task_instruction(query_intent)}"
        f"{retry_text}"
        f"\n\n对话历史：\n{_history_prompt(history_context)}"
        f"\n\n用户问题：{query}"
        "\n\n候选证据："
        f"\n{_evidence_context(retrieval)}"
    )


def _knowledge_task_instruction(query_intent: QueryIntent) -> str:
    if query_intent == "knowledge_summary":
        return "任务要求：总结和归纳候选证据；事实性结论必须引用，组织性表达不得引入新事实。"
    if query_intent == "knowledge_transform":
        return "任务要求：基于候选证据改写或生成内容；不得添加候选证据外的新经历、新数据或新结论。"
    if query_intent == "knowledge_interview":
        return "任务要求：基于候选证据生成面试追问；每个问题应能追溯到至少一个候选 chunk。"
    if query_intent == "knowledge_review":
        return "任务要求：基于候选证据做评价和建议；必须区分资料事实与基于事实的建议。"
    return "任务要求：回答候选证据直接支持的事实；证据不足时必须拒答。"


def _evidence_context(retrieval: dict[str, object]) -> str:
    results = retrieval.get("results")
    if not isinstance(results, list):
        return "[]"
    evidence: list[dict[str, object]] = []
    for item in results:
        if not isinstance(item, dict):
            continue
        evidence.append(
            {
                "chunk_id": item.get("chunkId"),
                "source": item.get("source"),
                "location": item.get("location"),
                "text": item.get("text", {}),
                "ranks": item.get("ranks"),
                "scores": item.get("scores"),
            }
        )
    return json.dumps(evidence, ensure_ascii=False)


def _compact_history(
    messages: Sequence[dict[str, object]],
    *,
    budget_chars: int,
) -> dict[str, object]:
    recent: list[dict[str, str]] = []
    used = 0
    split_at = len(messages)
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        content = str(message.get("content", ""))
        cost = len(content) + 32
        if recent and used + cost > budget_chars:
            split_at = index + 1
            break
        recent.append({"role": str(message.get("role", "")), "content": content})
        used += cost
        split_at = index
    recent.reverse()
    older = messages[:split_at]
    summary_lines = [
        (
            f"{message.get('role', '')}: "
            f"{_preview(str(message.get('content', '')))[:HISTORY_SUMMARY_LINE_CHARS]}"
        )
        for message in older
    ]
    return {
        "strategy": "summary_and_recent" if older else "recent_only",
        "originalMessageCount": len(messages),
        "summarizedMessageCount": len(older),
        "recentMessageCount": len(recent),
        "summary": "\n".join(summary_lines),
        "recentMessages": recent,
    }


def _history_prompt(history_context: dict[str, object]) -> str:
    summary = history_context.get("summary")
    recent = history_context.get("recentMessages")
    payload = {
        "summary": summary if isinstance(summary, str) else "",
        "recent_messages": recent if isinstance(recent, list) else [],
    }
    return json.dumps(payload, ensure_ascii=False)


async def _generate_answer_candidate(
    gateway: AnswerGateway,
    *,
    model: str,
    structured_prompt: str,
    plain_prompt: str,
    candidate_chunk_ids: Sequence[str],
    max_output_tokens: int,
) -> tuple[dict[str, object], dict[str, object]]:
    try:
        raw_answer = await gateway.generate_structured(
            {
                "model": model,
                "prompt": structured_prompt,
                "max_output_tokens": max_output_tokens,
            },
            ANSWER_SCHEMA,
        )
        return raw_answer, {"mode": "structured_json"}
    except ValueError as structured_error:
        try:
            plain_text = await _collect_plain_answer(
                gateway,
                model=model,
                prompt=plain_prompt,
                max_output_tokens=max_output_tokens,
            )
        except Exception as plain_error:
            return (
                _fallback_refusal_answer("plain_answer_failed"),
                {
                    "mode": "plain_text_failed",
                    "structuredError": str(structured_error),
                    "plainFallbackError": str(plain_error),
                },
            )

        return (
            _plain_text_to_answer(plain_text, candidate_chunk_ids),
            {
                "mode": "plain_text",
                "structuredError": str(structured_error),
            },
        )


async def _collect_plain_answer(
    gateway: AnswerGateway,
    *,
    model: str,
    prompt: str,
    max_output_tokens: int,
) -> str:
    parts: list[str] = []
    async for event in gateway.stream_answer(
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_output_tokens": max_output_tokens,
        }
    ):
        if event.get("type") == "delta" and isinstance(event.get("text"), str):
            parts.append(str(event["text"]))
    return "".join(parts).strip()


def _plain_text_to_answer(text: str, candidate_chunk_ids: Sequence[str]) -> dict[str, object]:
    candidate_set = set(candidate_chunk_ids)
    paragraphs: list[dict[str, object]] = []
    for block in _plain_paragraphs(text):
        evidence_ids = _plain_citation_ids(block, candidate_set)
        if not evidence_ids:
            continue
        paragraphs.append(
            {
                "text": _strip_plain_citations(block, candidate_set),
                "evidence_chunk_ids": evidence_ids,
            }
        )

    if not paragraphs:
        return _fallback_refusal_answer("plain_answer_missing_valid_citations")

    return {
        "evidence_sufficient": True,
        "refusal_reason": None,
        "paragraphs": paragraphs,
    }


def _fallback_refusal_answer(reason: str) -> dict[str, object]:
    return {
        "evidence_sufficient": False,
        "refusal_reason": reason,
        "paragraphs": [
            {
                "text": DEFAULT_REFUSAL,
                "evidence_chunk_ids": [],
            }
        ],
    }


def _plain_paragraphs(text: str) -> list[str]:
    blocks = re.split(r"\n\s*\n", text.strip())
    return [" ".join(block.split()) for block in blocks if block.strip()]


def _plain_citation_ids(text: str, candidate_chunk_ids: set[str]) -> list[str]:
    ids: list[str] = []
    for match in PLAIN_CITATION_PATTERN.finditer(text):
        chunk_id = match.group(1)
        if chunk_id in candidate_chunk_ids and chunk_id not in ids:
            ids.append(chunk_id)
    return ids


def _strip_plain_citations(text: str, candidate_chunk_ids: set[str]) -> str:
    def replace(match: re.Match[str]) -> str:
        return "" if match.group(1) in candidate_chunk_ids else match.group(0)

    return " ".join(PLAIN_CITATION_PATTERN.sub(replace, text).split())


def _plain_answer_prompt(
    *,
    query: str,
    retrieval: dict[str, object],
    query_intent: QueryIntent,
    evidence_status: EvidenceStatus,
    retry_feedback: dict[str, object] | None,
    history_context: dict[str, object],
) -> str:
    retry_text = ""
    if retry_feedback is not None:
        retry_text = (
            "\n上一次回答包含无效引用，必须修正。"
            f"\n无效引用：{json.dumps(retry_feedback['invalidCitations'], ensure_ascii=False)}"
            "\n只能使用下方候选证据中的 chunk_id。"
        )
    return (
        "你是 citeMind 的可信知识库回答模块。"
        "\n只允许使用候选证据回答用户问题，不得使用外部知识或自行补全事实。"
        "\n如果候选证据不足，只输出："
        f"{DEFAULT_REFUSAL}"
        "\n如果可以回答，请输出自然语言段落，不要输出 JSON、Markdown 表格或额外说明。"
        "\n不同要点之间必须空一行分段；不要输出一整段密集长文本。"
        "\n每个事实段落末尾必须使用方括号引用至少一个候选 chunk_id，例如 [chunk-xxx]。"
        "\n引用只能来自候选证据中的 chunk_id。"
        f"\n当前知识库任务类型：{query_intent}。"
        f"\n当前检索证据状态：{evidence_status}。"
        f"\n{_knowledge_task_instruction(query_intent)}"
        f"{retry_text}"
        f"\n\n对话历史：\n{_history_prompt(history_context)}"
        f"\n\n用户问题：{query}"
        "\n\n候选证据："
        f"\n{_evidence_context(retrieval)}"
    )


def _normalize_answer(raw: dict[str, object]) -> dict[str, object]:
    paragraphs_raw = raw.get("paragraphs")
    paragraphs: list[dict[str, object]] = []
    if isinstance(paragraphs_raw, list):
        for item in paragraphs_raw:
            if not isinstance(item, dict):
                continue
            text = item.get("text")
            evidence = item.get("evidence_chunk_ids", item.get("evidenceChunkIds"))
            if not isinstance(text, str):
                continue
            evidence_ids = evidence if isinstance(evidence, list) else []
            clean_text = _clean_model_text(text)
            if not clean_text:
                continue
            paragraphs.append(
                {
                    "text": clean_text,
                    "evidenceChunkIds": [
                        chunk_id
                        for chunk_id in evidence_ids
                        if isinstance(chunk_id, str) and chunk_id
                    ],
                }
            )

    evidence_sufficient = raw.get("evidence_sufficient", raw.get("evidenceSufficient"))
    refusal_reason = raw.get("refusal_reason", raw.get("refusalReason"))
    return {
        "evidenceSufficient": evidence_sufficient is True,
        "refusalReason": refusal_reason if isinstance(refusal_reason, str) else None,
        "paragraphs": paragraphs,
    }


def _shape_answer_paragraphs(
    answer: dict[str, object],
    *,
    retrieval: dict[str, object],
) -> dict[str, object]:
    raw_paragraphs = answer.get("paragraphs")
    if not isinstance(raw_paragraphs, list):
        return answer
    chunk_texts = _retrieval_text_by_chunk_id(retrieval)
    shaped: list[dict[str, object]] = []
    for paragraph in raw_paragraphs:
        if not isinstance(paragraph, dict):
            continue
        text = paragraph.get("text")
        raw_evidence_ids = paragraph.get("evidenceChunkIds")
        if not isinstance(text, str):
            continue
        evidence_ids = (
            [item for item in raw_evidence_ids if isinstance(item, str) and item]
            if isinstance(raw_evidence_ids, list)
            else []
        )
        shaped.extend(_shape_single_answer_paragraph(text, evidence_ids, chunk_texts))
    return {
        **answer,
        "paragraphs": shaped,
    }


def _shape_single_answer_paragraph(
    text: str,
    evidence_ids: Sequence[str],
    chunk_texts: Mapping[str, str],
) -> list[dict[str, object]]:
    clean_text = _clean_inline_text(text)
    if not clean_text:
        return []

    explicit_blocks = _explicit_text_blocks(text)
    if len(explicit_blocks) > 1:
        return _assign_evidence_to_segments(explicit_blocks, evidence_ids, chunk_texts)

    sentences = _sentence_units(clean_text)
    unique_evidence_ids = list(dict.fromkeys(evidence_ids))
    should_split = len(clean_text) >= DENSE_PARAGRAPH_MIN_CHARS or (
        len(unique_evidence_ids) > 1 and len(sentences) >= len(unique_evidence_ids)
    )
    if len(sentences) < 2 or not should_split:
        return [{"text": clean_text, "evidenceChunkIds": list(dict.fromkeys(evidence_ids))}]

    target_count = _auto_paragraph_count(clean_text, sentences, evidence_ids)
    if target_count < 2:
        return [{"text": clean_text, "evidenceChunkIds": list(dict.fromkeys(evidence_ids))}]
    segments = _group_sentence_units(sentences, target_count)
    return _assign_evidence_to_segments(segments, evidence_ids, chunk_texts)


def _clean_model_text(text: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    normalized = re.sub(r"[ \t\f\v]+", " ", normalized)
    normalized = re.sub(r" *\n{2,} *", "\n\n", normalized)
    normalized = re.sub(r" *\n *", "\n", normalized)
    return normalized


def _clean_inline_text(text: str) -> str:
    normalized = " ".join(text.replace("\n", " ").split())
    normalized = re.sub(r"([。！？!?；;])\s+([\u4e00-\u9fff])", r"\1\2", normalized)
    return normalized


def _explicit_text_blocks(text: str) -> list[str]:
    clean_text = _clean_model_text(text)
    if "\n" not in clean_text:
        return []
    blocks = re.split(r"\n+", clean_text)
    return [_clean_inline_text(block) for block in blocks if block.strip()]


def _sentence_units(text: str) -> list[str]:
    units = re.findall(r"[^。！？!?；;]+[。！？!?；;]?", text)
    return [_clean_inline_text(unit) for unit in units if unit.strip()]


def _auto_paragraph_count(
    text: str,
    sentences: Sequence[str],
    evidence_ids: Sequence[str],
) -> int:
    length_target = max(2, math.ceil(len(text) / DENSE_PARAGRAPH_MIN_CHARS))
    citation_target = len(list(dict.fromkeys(evidence_ids))) if evidence_ids else 1
    return min(
        len(sentences),
        MAX_AUTO_PARAGRAPHS,
        max(length_target, citation_target),
    )


def _group_sentence_units(sentences: Sequence[str], target_count: int) -> list[str]:
    if target_count <= 1 or len(sentences) <= 1:
        return [_clean_inline_text(" ".join(sentences))]
    groups: list[str] = []
    total = len(sentences)
    for group_index in range(target_count):
        start = math.floor(group_index * total / target_count)
        end = math.floor((group_index + 1) * total / target_count)
        if group_index == target_count - 1:
            end = total
        if end <= start:
            end = start + 1
        group = _clean_inline_text(" ".join(sentences[start:end]))
        if group:
            groups.append(group)
    return groups


def _assign_evidence_to_segments(
    segments: Sequence[str],
    evidence_ids: Sequence[str],
    chunk_texts: Mapping[str, str],
) -> list[dict[str, object]]:
    clean_segments = [_clean_inline_text(segment) for segment in segments if segment.strip()]
    unique_evidence_ids = list(dict.fromkeys(evidence_ids))
    if not clean_segments:
        return []
    if not unique_evidence_ids:
        return [{"text": segment, "evidenceChunkIds": []} for segment in clean_segments]

    assigned: list[list[str]] = [[] for _segment in clean_segments]
    for evidence_index, chunk_id in enumerate(unique_evidence_ids):
        segment_index = _best_evidence_segment(chunk_id, clean_segments, chunk_texts)
        if segment_index is None:
            segment_index = _proportional_index(
                evidence_index,
                len(unique_evidence_ids),
                len(clean_segments),
            )
        if chunk_id not in assigned[segment_index]:
            assigned[segment_index].append(chunk_id)

    for segment_index, segment_evidence_ids in enumerate(assigned):
        if segment_evidence_ids:
            continue
        donor_index = _donor_segment_index(assigned, segment_index)
        if donor_index is not None:
            segment_evidence_ids.append(assigned[donor_index].pop())
            continue
        fallback_index = _proportional_index(
            segment_index,
            len(clean_segments),
            len(unique_evidence_ids),
        )
        segment_evidence_ids.append(unique_evidence_ids[fallback_index])

    return [
        {
            "text": segment,
            "evidenceChunkIds": segment_evidence_ids,
        }
        for segment, segment_evidence_ids in zip(clean_segments, assigned, strict=True)
    ]


def _best_evidence_segment(
    chunk_id: str,
    segments: Sequence[str],
    chunk_texts: Mapping[str, str],
) -> int | None:
    evidence_text = chunk_texts.get(chunk_id, "")
    if not evidence_text:
        return None
    scores = [_text_overlap_score(segment, evidence_text) for segment in segments]
    best_score = max(scores, default=0.0)
    if best_score <= 0:
        return None
    return scores.index(best_score)


def _donor_segment_index(assigned: Sequence[Sequence[str]], target_index: int) -> int | None:
    donors = [
        (abs(index - target_index), index)
        for index, evidence_ids in enumerate(assigned)
        if len(evidence_ids) > 1
    ]
    if not donors:
        return None
    return min(donors)[1]


def _text_overlap_score(left: str, right: str) -> float:
    left_terms = _text_terms(left)
    right_terms = _text_terms(right)
    if not left_terms or not right_terms:
        return 0.0
    return len(left_terms & right_terms) / max(1, min(len(left_terms), len(right_terms)))


def _text_terms(text: str) -> set[str]:
    normalized = text.lower()
    terms = {
        token
        for token in re.findall(r"[a-z0-9_+-]{2,}|[\u4e00-\u9fff]", normalized)
        if token not in _CJK_STOP_TERMS
    }
    return terms


_CJK_STOP_TERMS = set("的一是在了和与及或并把将为以于中上下面这那其从等到")


def _proportional_index(index: int, source_count: int, target_count: int) -> int:
    if target_count <= 1 or source_count <= 1:
        return 0
    return min(target_count - 1, math.floor(index * target_count / source_count))


def _retrieval_text_by_chunk_id(retrieval: dict[str, object]) -> dict[str, str]:
    results = retrieval.get("results")
    if not isinstance(results, list):
        return {}
    chunk_texts: dict[str, str] = {}
    for item in results:
        if not isinstance(item, dict) or not isinstance(item.get("chunkId"), str):
            continue
        text = item.get("text")
        text_record = text if isinstance(text, dict) else {}
        value = (
            text_record.get("normalized")
            or text_record.get("original")
            or text_record.get("preview")
            or ""
        )
        if isinstance(value, str) and value.strip():
            chunk_texts[str(item["chunkId"])] = value
    return chunk_texts


def _paragraphs_for_validation(answer: dict[str, object]) -> list[dict[str, object]]:
    paragraphs = answer.get("paragraphs")
    if not isinstance(paragraphs, list):
        return []
    return [item for item in paragraphs if isinstance(item, dict)]


def _validated_paragraphs(validation: dict[str, object]) -> list[dict[str, object]]:
    raw_paragraphs = validation.get("paragraphs")
    if not isinstance(raw_paragraphs, list):
        return []
    result: list[dict[str, object]] = []
    for item in raw_paragraphs:
        if not isinstance(item, dict):
            continue
        evidence_ids = item.get("validEvidenceChunkIds")
        result.append(
            {
                "index": item.get("index"),
                "text": item.get("text"),
                "evidenceChunkIds": evidence_ids if isinstance(evidence_ids, list) else [],
            }
        )
    return result


def _agent_run_id(response: Mapping[str, object]) -> str:
    run = response.get("run")
    if not isinstance(run, dict) or not isinstance(run.get("id"), str):
        raise ValueError("AgentRun response is missing run id")
    return str(run["id"])


def _agent_tool_call_id(response: Mapping[str, object]) -> str:
    tool_calls = response.get("toolCalls")
    if not isinstance(tool_calls, list):
        raise ValueError("AgentRun response is missing tool call id")
    for tool_call in tool_calls:
        if isinstance(tool_call, dict) and isinstance(tool_call.get("id"), str):
            return str(tool_call["id"])
    raise ValueError("AgentRun response is missing tool call id")


def _trace_validation_summary(validation: Mapping[str, object]) -> str:
    valid_count = len(_valid_citations(dict(validation)))
    invalid = validation.get("invalidCitations")
    invalid_count = len(invalid) if isinstance(invalid, list) else 0
    return f"有效引用 {valid_count}，无效引用 {invalid_count}"


def _trace_response_citations(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    citations: list[dict[str, object]] = []
    for citation in value:
        if not isinstance(citation, dict):
            continue
        paragraph_index = citation.get("paragraphIndex")
        chunk_id = citation.get("chunkId")
        if isinstance(paragraph_index, int) and isinstance(chunk_id, str):
            citations.append({"paragraphIndex": paragraph_index, "chunkId": chunk_id})
    return citations


def _nested_string(
    payload: Mapping[str, object],
    object_key: str,
    value_key: str,
) -> str | None:
    nested = payload.get(object_key)
    if isinstance(nested, dict) and isinstance(nested.get(value_key), str):
        return str(nested[value_key])
    return None


def _nested_bool(
    payload: Mapping[str, object],
    object_key: str,
    value_key: str,
) -> bool | None:
    nested = payload.get(object_key)
    if isinstance(nested, dict) and isinstance(nested.get(value_key), bool):
        return bool(nested[value_key])
    return None


def _valid_citations(validation: dict[str, object]) -> list[dict[str, object]]:
    citations = validation.get("validCitations")
    if not isinstance(citations, list):
        return []
    return [item for item in citations if isinstance(item, dict)]


def _candidate_chunk_ids(retrieval: dict[str, object]) -> list[str]:
    results = retrieval.get("results")
    if not isinstance(results, list):
        return []
    chunk_ids: list[str] = []
    for item in results:
        if isinstance(item, dict) and isinstance(item.get("chunkId"), str):
            chunk_ids.append(str(item["chunkId"]))
    return chunk_ids


def _index_version_id(retrieval: dict[str, object]) -> str:
    index_version = retrieval.get("indexVersion")
    if not isinstance(index_version, dict) or not isinstance(index_version.get("id"), str):
        raise ValueError("检索结果缺少索引版本")
    return str(index_version["id"])


def _conversation_record_from_row(row: sqlite3.Row) -> dict[str, object]:
    return {
        "id": str(row["id"]),
        "knowledgeBaseId": str(row["knowledge_base_id"]),
        "title": str(row["title"]),
        "modelId": row["model_id"],
        "createdAt": str(row["created_at"]),
        "updatedAt": str(row["updated_at"]),
    }


def _message_record_from_row(
    row: sqlite3.Row,
    *,
    citations: Sequence[dict[str, object]],
) -> dict[str, object]:
    return {
        "id": str(row["id"]),
        "conversationId": str(row["conversation_id"]),
        "role": str(row["role"]),
        "content": str(row["content"]),
        "modelId": row["model_id"],
        "modelParams": _json_object(row["model_params_json"]),
        "indexVersionId": row["index_version_id"],
        "artifact": _json_object(row["artifact_json"]),
        "createdAt": str(row["created_at"]),
        "citations": list(citations),
    }


def _refusal_text(answer: dict[str, object]) -> str:
    paragraphs = answer.get("paragraphs")
    if isinstance(paragraphs, list) and paragraphs:
        first = paragraphs[0]
        if isinstance(first, dict) and isinstance(first.get("text"), str) and first["text"]:
            return str(first["text"])
    return DEFAULT_REFUSAL


def _refusal_reason(answer: dict[str, object], validation: dict[str, object]) -> str:
    reason = answer.get("refusalReason")
    if isinstance(reason, str) and reason:
        return reason
    invalid = validation.get("invalidCitations")
    if isinstance(invalid, list) and invalid:
        first = invalid[0]
        if isinstance(first, dict) and isinstance(first.get("reason"), str):
            return str(first["reason"])
    return "insufficient_valid_evidence"


def _clean_query(query: str) -> str:
    clean = " ".join(query.split())
    if not clean:
        raise ValueError("问题不能为空")
    return clean


def _conversation_title(text: str) -> str:
    clean = " ".join(text.split())
    if len(clean) <= 48:
        return clean
    return f"{clean[:47]}…"


def _delta_events(content: str) -> list[dict[str, object]]:
    if not content:
        return []
    return [{"type": "answer.delta", "text": paragraph} for paragraph in content.split("\n\n")]


def _elapsed_ms(started: float) -> int:
    return max(0, int((perf_counter() - started) * 1000))


def _json_object(value: object) -> dict[str, object]:
    if not isinstance(value, str) or not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _json_optional_object(value: object) -> dict[str, object] | None:
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
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, str)]


def _preview(text: str) -> str:
    normalized = " ".join(text.split())
    if len(normalized) <= 240:
        return normalized
    return f"{normalized[:239]}…"


def _conversation_markdown(
    conversation: dict[str, object],
    messages: Sequence[dict[str, object]],
) -> str:
    lines = [
        f"# {conversation['title']}",
        "",
        f"- 对话模型：{conversation.get('modelId') or '未指定'}",
        f"- 创建时间：{conversation['createdAt']}",
        f"- 导出时间：{datetime.now(UTC).isoformat()}",
        "",
    ]
    footnotes: list[str] = []
    for message_index, message in enumerate(messages, start=1):
        role = str(message["role"])
        heading = "用户" if role == "user" else "citeMind" if role == "assistant" else "系统"
        lines.extend([f"## {heading}", ""])
        paragraphs = [item for item in re.split(r"\n{2,}", str(message["content"])) if item]
        citations = message.get("citations")
        citation_items = citations if isinstance(citations, list) else []
        for paragraph_index, paragraph in enumerate(paragraphs):
            refs: list[str] = []
            for citation_index, citation in enumerate(citation_items, start=1):
                if isinstance(citation, dict) and citation.get("paragraphIndex") == paragraph_index:
                    ref = f"m{message_index}-c{citation_index}"
                    refs.append(f"[^{ref}]")
                    footnotes.append(_citation_footnote(ref, citation))
            lines.extend([f"{paragraph}{''.join(refs)}", ""])
        if role == "assistant":
            lines.extend(
                [
                    f"> 模型：{message.get('modelId') or '未记录'} · "
                    f"索引版本：{message.get('indexVersionId') or '未记录'}",
                    "",
                ]
            )
    if footnotes:
        lines.extend(["---", "", "## 引用", "", *footnotes])
    return "\n".join(lines).rstrip() + "\n"


def _citation_footnote(ref: str, citation: dict[str, object]) -> str:
    source = citation.get("source")
    location = citation.get("location")
    text = citation.get("text")
    source_record = source if isinstance(source, dict) else {}
    location_record = location if isinstance(location, dict) else {}
    text_record = text if isinstance(text, dict) else {}
    location_text = _markdown_location(location_record)
    preview = str(text_record.get("preview") or text_record.get("normalized") or "").strip()
    return (
        f"[^{ref}]: {source_record.get('displayName') or '未知来源'}"
        f"{f' · {location_text}' if location_text else ''}"
        f" · `{citation.get('chunkId') or 'unknown'}`"
        f"{f' — {preview}' if preview else ''}"
    )


def _markdown_location(location: dict[str, object]) -> str:
    page = location.get("pageNumber")
    if isinstance(page, int):
        return f"第 {page} 页"
    headings = location.get("headingPath")
    if isinstance(headings, list):
        values = [str(item) for item in headings if isinstance(item, str) and item]
        if values:
            return " / ".join(values)
    anchor = location.get("anchor")
    return str(anchor) if isinstance(anchor, str) else ""


def _safe_file_name(value: str) -> str:
    clean = re.sub(r'[\\/:*?"<>|]+', "-", value).strip(" .-")
    return clean[:80] or "citemind"


def _estimated_tokens(text: str) -> int:
    return max(1, math.ceil(len(text) / 4)) if text else 0


def _generation_call_count(value: object) -> int:
    if not isinstance(value, list):
        return 0
    calls = 0
    for attempt in value:
        if not isinstance(attempt, dict):
            continue
        mode = attempt.get("generationMode")
        calls += 2 if mode in {"plain_text", "plain_text_failed"} else 1
    return calls
