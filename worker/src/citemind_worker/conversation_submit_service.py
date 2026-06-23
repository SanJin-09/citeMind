import asyncio
import json
from collections.abc import Callable, Mapping, Sequence
from typing import Protocol

from citemind_worker.ark_gateway import ArkModelGateway
from citemind_worker.conversation_service import ConversationService
from citemind_worker.model_catalog import (
    DEFAULT_ARK_BASE_URL,
    DEFAULT_CHAT_MODEL,
    DEFAULT_EMBEDDING_MODEL,
)
from citemind_worker.research_brief_service import ResearchBriefService

ROUTE_HINTS = {"auto", "answer", "research_brief"}
ROUTE_CONFIDENCE_THRESHOLD = 0.8
ROUTE_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "route": {
            "type": "string",
            "enum": ["answer", "create_research_brief", "update_research_brief"],
        },
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "reason": {"type": "string"},
    },
    "required": ["route", "confidence", "reason"],
    "additionalProperties": False,
}


class SubmitGateway(Protocol):
    async def generate_structured(
        self,
        request: dict[str, object],
        schema: dict[str, object],
    ) -> dict[str, object]: ...


type SubmitGatewayFactory = Callable[[str, str, str], SubmitGateway]


class ConversationSubmitService:
    def __init__(
        self,
        conversations: ConversationService,
        research_briefs: ResearchBriefService,
        *,
        gateway_factory: SubmitGatewayFactory | None = None,
    ) -> None:
        self.conversations = conversations
        self.research_briefs = research_briefs
        self.gateway_factory = gateway_factory or _gateway_factory

    async def submit(
        self,
        *,
        knowledge_base_id: str,
        query: str,
        conversation_id: str | None = None,
        route_hint: str = "auto",
        current_brief_run_id: str | None = None,
        source_ids: Sequence[str] | None = None,
        api_key: str | None = None,
        base_url: str = DEFAULT_ARK_BASE_URL,
        chat_model: str = DEFAULT_CHAT_MODEL,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
        limit: int = 8,
        candidate_limit: int = 24,
        max_output_tokens: int = 1200,
    ) -> dict[str, object]:
        clean_query = query.strip()
        if not clean_query:
            raise ValueError("query must be a non-empty string")
        if route_hint not in ROUTE_HINTS:
            raise ValueError("routeHint must be auto, answer, or research_brief")

        current_brief: dict[str, object] | None = None
        if current_brief_run_id:
            current_brief = self.research_briefs.get(current_brief_run_id)
            summary = _mapping(current_brief.get("brief"))
            brief_conversation_id = _optional_text(summary.get("conversationId"))
            if conversation_id is None:
                conversation_id = brief_conversation_id
            if conversation_id is None:
                raise ValueError("Current research brief is not attached to a conversation")
            self.research_briefs.ensure_conversation_scope(
                current_brief_run_id,
                knowledge_base_id=knowledge_base_id,
                conversation_id=conversation_id,
            )

        route = (
            "create_research_brief"
            if route_hint == "research_brief"
            else "answer"
            if route_hint == "answer"
            else await self._classify(
                query=clean_query,
                conversation_id=conversation_id,
                current_brief=current_brief,
                api_key=api_key,
                base_url=base_url,
                chat_model=chat_model,
            )
        )

        if route == "answer":
            answer = await self.conversations.answer(
                knowledge_base_id=knowledge_base_id,
                query=clean_query,
                conversation_id=conversation_id,
                api_key=api_key,
                base_url=base_url,
                chat_model=chat_model,
                embedding_model=embedding_model,
                limit=limit,
                candidate_limit=candidate_limit,
                max_output_tokens=max_output_tokens,
            )
            return {"kind": "answer", "answer": answer}

        if route == "update_research_brief" and current_brief is None:
            return self._clarification(
                knowledge_base_id=knowledge_base_id,
                query=clean_query,
                conversation_id=conversation_id,
                chat_model=chat_model,
            )

        conversation = self.conversations.ensure_conversation(
            knowledge_base_id=knowledge_base_id,
            conversation_id=conversation_id,
            title=clean_query,
            model_id=chat_model,
        )
        resolved_conversation_id = str(conversation["id"])
        user_message = self.conversations.append_message(
            conversation_id=resolved_conversation_id,
            role="user",
            content=clean_query,
        )

        if route == "create_research_brief":
            brief = await self.research_briefs.create(
                knowledge_base_id,
                goal=clean_query,
                source_ids=source_ids,
                api_key=api_key,
                base_url=base_url,
                chat_model=chat_model,
                embedding_model=embedding_model,
                conversation_id=resolved_conversation_id,
            )
            summary = _mapping(brief.get("brief"))
            assistant_message = self.conversations.append_message(
                conversation_id=resolved_conversation_id,
                role="assistant",
                content=f"已根据当前知识库生成研究简报：{summary.get('title', '研究简报')}",
                model_id=chat_model,
                artifact={
                    "type": "research_brief",
                    "runId": summary.get("runId"),
                    "display": "full",
                },
            )
            brief = self.research_briefs.bind_to_message(
                str(summary["runId"]),
                conversation_id=resolved_conversation_id,
                assistant_message_id=str(assistant_message["id"]),
            )
            return {
                "kind": "research_brief_created",
                "conversation": self.conversations.messages(resolved_conversation_id)[
                    "conversation"
                ],
                "userMessage": user_message,
                "assistantMessage": assistant_message,
                "agentRunId": _latest_run_id(brief),
                "brief": brief,
            }

        assert current_brief_run_id is not None
        summary = _mapping(current_brief.get("brief")) if current_brief else {}
        brief = await self.research_briefs.operate(
            current_brief_run_id,
            action="revise_document",
            expected_revision=_integer(summary.get("userRevision")),
            selection_text=clean_query,
            api_key=api_key,
            base_url=base_url,
            chat_model=chat_model,
            embedding_model=embedding_model,
        )
        updated_summary = _mapping(brief.get("brief"))
        assistant_message = self.conversations.append_message(
            conversation_id=resolved_conversation_id,
            role="assistant",
            content=f"研究简报已更新：{updated_summary.get('title', '研究简报')}",
            model_id=chat_model,
            artifact={
                "type": "research_brief",
                "runId": current_brief_run_id,
                "display": "reference",
            },
        )
        return {
            "kind": "research_brief_updated",
            "conversation": self.conversations.messages(resolved_conversation_id)["conversation"],
            "userMessage": user_message,
            "assistantMessage": assistant_message,
            "agentRunId": _latest_run_id(brief),
            "brief": brief,
        }

    async def _classify(
        self,
        *,
        query: str,
        conversation_id: str | None,
        current_brief: Mapping[str, object] | None,
        api_key: str | None,
        base_url: str,
        chat_model: str,
    ) -> str:
        if api_key is None or not api_key.strip():
            return "answer"
        history: list[dict[str, object]] = []
        if conversation_id:
            messages = self.conversations.messages(conversation_id)["messages"]
            if isinstance(messages, list):
                history = [
                    {
                        "role": item.get("role"),
                        "content": str(item.get("content") or "")[:500],
                    }
                    for item in messages[-6:]
                    if isinstance(item, dict)
                ]
        brief_summary = _mapping(_mapping(current_brief or {}).get("brief"))
        try:
            async with asyncio.timeout(8):
                result = await self.gateway_factory(
                    api_key, base_url, chat_model
                ).generate_structured(
                    {
                        "model": chat_model,
                        "prompt": (
                            "判断用户本次请求应走哪条 citeMind 路由。"
                            "\nanswer：普通知识库问答、解释、总结。"
                            "\ncreate_research_brief：明确要求形成可持续编辑的研究、报告、论文、"
                            "简报或长文成果。"
                            "\nupdate_research_brief：要求修改、扩写、补证或审计当前简报。"
                            "\n不确定时必须选择 answer，并降低 confidence。"
                            f"\n当前简报：{json.dumps(brief_summary, ensure_ascii=False)}"
                            f"\n最近对话：{json.dumps(history, ensure_ascii=False)}"
                            f"\n用户请求：{query}"
                        ),
                        "max_output_tokens": 220,
                    },
                    ROUTE_SCHEMA,
                )
        except Exception:
            return "answer"
        route = str(result.get("route") or "answer")
        confidence = result.get("confidence")
        if (
            not isinstance(confidence, int | float)
            or float(confidence) < ROUTE_CONFIDENCE_THRESHOLD
        ):
            return "answer"
        if route == "update_research_brief" and not brief_summary:
            return "update_research_brief"
        return (
            route
            if route
            in {
                "answer",
                "create_research_brief",
                "update_research_brief",
            }
            else "answer"
        )

    def _clarification(
        self,
        *,
        knowledge_base_id: str,
        query: str,
        conversation_id: str | None,
        chat_model: str,
    ) -> dict[str, object]:
        conversation = self.conversations.ensure_conversation(
            knowledge_base_id=knowledge_base_id,
            conversation_id=conversation_id,
            title=query,
            model_id=chat_model,
        )
        resolved_id = str(conversation["id"])
        user_message = self.conversations.append_message(
            conversation_id=resolved_id,
            role="user",
            content=query,
        )
        assistant_message = self.conversations.append_message(
            conversation_id=resolved_id,
            role="assistant",
            content="请先生成或选择一份研究简报，再继续要求修改。",
            model_id=chat_model,
        )
        return {
            "kind": "clarification",
            "conversation": self.conversations.messages(resolved_id)["conversation"],
            "userMessage": user_message,
            "assistantMessage": assistant_message,
        }


def _gateway_factory(api_key: str, base_url: str, _chat_model: str) -> SubmitGateway:
    return ArkModelGateway(api_key, base_url=base_url)


def _mapping(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _latest_run_id(brief: Mapping[str, object]) -> str | None:
    latest = _mapping(brief.get("latestRun"))
    run = _mapping(latest.get("run"))
    value = run.get("id")
    return value if isinstance(value, str) else None


def _integer(value: object) -> int:
    return value if isinstance(value, int) else 0
