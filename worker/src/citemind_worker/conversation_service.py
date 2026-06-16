import json
import math
import re
import sqlite3
from collections.abc import AsyncIterator, Callable, Sequence
from datetime import UTC, datetime
from time import perf_counter
from typing import Protocol
from uuid import uuid4

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
PLAIN_CITATION_PATTERN = re.compile(r"\[([A-Za-z0-9_.:-]+)\]")

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
    ) -> None:
        self.storage = storage
        self.retrieval = retrieval or HybridRetrievalService(storage)
        self.validator = validator or CitationValidator(storage)
        self.gateway_factory = gateway_factory or _ark_gateway_factory

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
        self._update_message_index(str(user_message["id"]), index_version_id)
        user_message = self._message_record(str(user_message["id"]))
        candidate_chunk_ids = _candidate_chunk_ids(retrieval)
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
            retry_feedback=None,
            history_context=history_context,
        )
        plain_prompt = _plain_answer_prompt(
            query=clean_query,
            retrieval=retrieval,
            retry_feedback=None,
            history_context=history_context,
        )
        attempts: list[dict[str, object]] = []
        retry_count = 0
        final_answer: dict[str, object] | None = None
        final_validation: dict[str, object] | None = None
        yield {"type": "generation.started", "modelId": effective_chat_model}

        for attempt_index in range(2):
            raw_answer, generation_meta = await _generate_answer_candidate(
                gateway,
                model=effective_chat_model,
                structured_prompt=prompt,
                plain_prompt=plain_prompt,
                candidate_chunk_ids=candidate_chunk_ids,
                max_output_tokens=max_output_tokens,
            )
            answer = _normalize_answer(raw_answer)
            validation = self.validator.validate(
                paragraphs=_paragraphs_for_validation(answer),
                candidate_chunk_ids=candidate_chunk_ids,
                index_version_id=index_version_id,
            )
            attempts.append(
                {
                    "attempt": attempt_index + 1,
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
                retry_feedback=validation,
                history_context=history_context,
            )
            plain_prompt = _plain_answer_prompt(
                query=clean_query,
                retrieval=retrieval,
                retry_feedback=validation,
                history_context=history_context,
            )

        assert final_answer is not None
        assert final_validation is not None
        response = self._persist_answer(
            conversation=conversation,
            user_message=user_message,
            retrieval=retrieval,
            answer=final_answer,
            validation=final_validation,
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
        yield {"type": "citation.validated", "validation": response["citationValidation"]}
        for event in _delta_events(str(response["content"])):
            yield event
        yield {"type": "answer.completed", "response": response}

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
        chat_model: str,
        max_output_tokens: int,
        generation_time_ms: int,
        retry_count: int,
        attempts: Sequence[dict[str, object]],
        history_context: dict[str, object],
    ) -> dict[str, object]:
        evidence_sufficient = answer["evidenceSufficient"] is True and validation["valid"] is True
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
                "evidenceSufficient": evidence_sufficient,
                "refusalReason": refusal_reason,
                "candidateChunkIds": _candidate_chunk_ids(retrieval),
                "retrieval": retrieval.get("retrieval"),
                "citationValidation": {
                    "valid": validation["valid"],
                    "invalidCitations": validation["invalidCitations"],
                },
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
        chat_model: str,
        generation_time_ms: int,
        reason: str,
        history_context: dict[str, object],
    ) -> dict[str, object]:
        assistant_message = self._insert_message(
            conversation_id=str(conversation["id"]),
            role="assistant",
            content=DEFAULT_REFUSAL,
            model_id=chat_model,
            model_params={
                "generationTimeMs": generation_time_ms,
                "retryCount": 0,
                "evidenceSufficient": False,
                "refusalReason": reason,
                "candidateChunkIds": [],
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
            "candidateChunkIds": [],
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
    ) -> dict[str, object]:
        message_id = f"message-{uuid4().hex}"
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO messages(
                    id, conversation_id, role, content, model_id,
                    model_params_json, index_version_id
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message_id,
                    conversation_id,
                    role,
                    content,
                    model_id,
                    json.dumps(model_params, ensure_ascii=False),
                    index_version_id,
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
                       model_params_json, index_version_id, created_at
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
                       model_params_json, index_version_id, created_at
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


def _answer_prompt(
    *,
    query: str,
    retrieval: dict[str, object],
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
        "\n每个回答段落都必须给出 evidence_chunk_ids，且只能引用候选证据中的 chunk_id。"
        "\n输出必须符合 JSON Schema，不要输出 Markdown 或额外解释。"
        f"{retry_text}"
        f"\n\n对话历史：\n{_history_prompt(history_context)}"
        f"\n\n用户问题：{query}"
        "\n\n候选证据："
        f"\n{_evidence_context(retrieval)}"
    )


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
        "\n每个事实段落末尾必须使用方括号引用至少一个候选 chunk_id，例如 [chunk-xxx]。"
        "\n引用只能来自候选证据中的 chunk_id。"
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
            paragraphs.append(
                {
                    "text": " ".join(text.split()),
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
