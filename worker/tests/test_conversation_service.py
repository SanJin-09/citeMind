import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from pathlib import Path

from citemind_worker.agent_run_service import AgentRunService
from citemind_worker.citation_validator import CitationValidator
from citemind_worker.conversation_service import (
    DEFAULT_REFUSAL,
    ConversationService,
    _compact_history,
    _retrieval_query_plan,
)
from citemind_worker.knowledge_base_service import KnowledgeBaseService
from citemind_worker.retrieval_service import HybridRetrievalService
from citemind_worker.storage import StorageRuntime
from citemind_worker.storage.full_text import FullTextIndex


class QueryEmbedder:
    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [[1.0, 0.0, 0.0] for _text in texts]


class FakeAnswerGateway:
    def __init__(
        self,
        outputs: Sequence[dict[str, object] | Exception],
        *,
        stream_chunks: Sequence[str] = (),
    ) -> None:
        self.outputs = list(outputs)
        self.stream_chunks = list(stream_chunks)
        self.prompts: list[str] = []
        self.schemas: list[dict[str, object]] = []
        self.stream_prompts: list[str] = []

    async def generate_structured(
        self,
        request: dict[str, object],
        schema: dict[str, object],
    ) -> dict[str, object]:
        assert schema["type"] == "object"
        self.prompts.append(str(request["prompt"]))
        self.schemas.append(schema)
        output = self.outputs.pop(0)
        if isinstance(output, Exception):
            raise output
        return output

    def stream_answer(self, request: dict[str, object]) -> AsyncIterator[dict[str, object]]:
        async def iterator() -> AsyncIterator[dict[str, object]]:
            messages = request.get("messages")
            if isinstance(messages, list) and messages and isinstance(messages[0], dict):
                self.stream_prompts.append(str(messages[0].get("content", "")))
            for chunk in self.stream_chunks:
                yield {"type": "delta", "text": chunk}

        return iterator()


class EmptyRetrieval:
    def __init__(self) -> None:
        self.queries: list[str] = []

    async def retrieve(
        self,
        knowledge_base_id: str,
        query: str,
        *,
        api_key: str | None = None,
        base_url: str = "",
        embedding_model: str = "",
        limit: int = 8,
        candidate_limit: int = 24,
        rerank_model_version: str | None = None,
    ) -> dict[str, object]:
        self.queries.append(query)
        return {
            "knowledgeBaseId": knowledge_base_id,
            "query": query,
            "indexVersion": {
                "id": "index-current",
                "embeddingProvider": "ark",
                "embeddingModel": embedding_model or "embedding-current",
                "embeddingDimension": 3,
                "chunkingVersion": "chunk-v1",
                "parserVersion": "parser-v1",
                "status": "ready",
                "isCurrent": True,
                "createdAt": "",
                "chunkCount": 0,
            },
            "limits": {
                "resultLimit": limit,
                "candidateLimit": candidate_limit,
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
                "modelVersion": rerank_model_version,
            },
            "results": [],
            "context": {
                "chunkCount": 0,
                "chunks": [],
                "text": "",
            },
        }


class FailingRetrieval:
    async def retrieve(
        self,
        knowledge_base_id: str,
        query: str,
        *,
        api_key: str | None = None,
        base_url: str = "",
        embedding_model: str = "",
        limit: int = 8,
        candidate_limit: int = 24,
        rerank_model_version: str | None = None,
    ) -> dict[str, object]:
        raise AssertionError("meta questions must not call retrieval")


class WeakSemanticRetrieval:
    async def retrieve(
        self,
        knowledge_base_id: str,
        query: str,
        *,
        api_key: str | None = None,
        base_url: str = "",
        embedding_model: str = "",
        limit: int = 8,
        candidate_limit: int = 24,
        rerank_model_version: str | None = None,
    ) -> dict[str, object]:
        return {
            "knowledgeBaseId": knowledge_base_id,
            "query": query,
            "indexVersion": {
                "id": "index-current",
                "embeddingProvider": "ark",
                "embeddingModel": embedding_model or "embedding-current",
                "embeddingDimension": 3,
                "chunkingVersion": "chunk-v1",
                "parserVersion": "parser-v1",
                "status": "ready",
                "isCurrent": True,
                "createdAt": "",
                "chunkCount": 1,
            },
            "limits": {
                "resultLimit": limit,
                "candidateLimit": candidate_limit,
            },
            "retrieval": {
                "keywordCandidateCount": 0,
                "semanticCandidateCount": 1,
                "mergedCandidateCount": 1,
                "fusion": "reciprocal_rank_fusion",
                "rrfK": 60,
            },
            "rerank": {
                "available": False,
                "applied": False,
                "modelVersion": rerank_model_version,
            },
            "results": [
                {
                    "chunkId": "chunk-pdf-valid",
                    "source": {
                        "id": "source-pdf",
                        "versionId": "version-pdf",
                        "type": "pdf",
                        "displayName": "Alpha.pdf",
                        "uri": None,
                    },
                    "location": {
                        "pageNumber": 3,
                        "boundingBox": {"x": 1, "y": 2, "width": 3, "height": 4},
                        "headingPath": ["Alpha"],
                        "anchor": "pdf-block",
                    },
                    "text": {
                        "original": "Alpha evidence for conversation",
                        "normalized": "Alpha evidence for conversation",
                        "preview": "Alpha evidence for conversation",
                        "contentHash": "hash-alpha",
                    },
                    "match": {
                        "matchedBy": ["semantic"],
                        "keywordHits": [],
                        "hasKeywordHit": False,
                        "hasSemanticMatch": True,
                    },
                    "scores": {
                        "keywordBm25": None,
                        "keywordScore": None,
                        "semanticDistance": 0.92,
                        "semanticScore": 0.08,
                        "fusedScore": 0.016,
                    },
                    "ranks": {
                        "keyword": None,
                        "semantic": 1,
                        "fused": 1,
                    },
                    "explanation": {
                        "summary": "向量检索第 1 名，距离 0.920000",
                        "fusion": "reciprocal_rank_fusion",
                        "keyword": {"matched": False, "rank": None, "bm25": None, "hits": []},
                        "semantic": {"matched": True, "rank": 1, "distance": 0.92},
                    },
                }
            ],
            "context": {
                "chunkCount": 1,
                "chunks": [],
                "text": "",
            },
        }


def test_conversation_answer_persists_messages_and_valid_citations(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)
    gateway = FakeAnswerGateway(
        [
            {
                "evidence_sufficient": True,
                "refusal_reason": None,
                "paragraphs": [
                    {
                        "text": "Alpha 结论来自当前 PDF 证据。",
                        "evidence_chunk_ids": ["chunk-pdf-valid"],
                    }
                ],
            }
        ]
    )

    response = asyncio.run(
        ConversationService(
            storage,
            retrieval=HybridRetrievalService(storage, embedder=QueryEmbedder()),
            gateway_factory=lambda _key, _base, _embedding: gateway,
        ).answer(
            knowledge_base_id=knowledge_base_id,
            query="Alpha 怎么解释？",
            api_key="ark-test",
            chat_model="doubao-test-chat",
            embedding_model="doubao-test-embedding",
        )
    )

    assert response["answer"]["evidenceSufficient"] is True
    assert response["answer"]["queryIntent"] == "knowledge_fact_qa"
    assert response["answer"]["evidenceStatus"] == "strong_evidence"
    assert response["content"] == "Alpha 结论来自当前 PDF 证据。"
    assert response["citations"][0]["chunkId"] == "chunk-pdf-valid"
    assert response["assistantMessage"]["modelId"] == "doubao-test-chat"
    assert response["assistantMessage"]["indexVersionId"] == "index-current"
    assert response["assistantMessage"]["modelParams"]["generationTimeMs"] >= 0
    assert response["assistantMessage"]["modelParams"]["retryCount"] == 0
    assert response["assistantMessage"]["modelParams"]["queryIntent"] == "knowledge_fact_qa"
    assert response["assistantMessage"]["modelParams"]["evidenceStatus"] == "strong_evidence"
    assert response["agentRunId"] is None
    assert [event["type"] for event in response["events"]] == [
        "conversation.ready",
        "retrieval.completed",
        "generation.started",
        "citation.validated",
        "answer.delta",
        "answer.completed",
    ]
    assert "不得使用外部知识" in gateway.prompts[0]
    assert "evidence_chunk_ids" in gateway.prompts[0]
    assert "【事实问答任务】" in gateway.prompts[0]
    assert "当前可回答范围 answerableScope" in gateway.prompts[0]
    assert "answerableScope 只作为生成约束" in gateway.prompts[0]

    with storage.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM conversations").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 2
        assert connection.execute("SELECT COUNT(*) FROM answer_citations").fetchone()[0] == 1

    messages = ConversationService(storage).messages(str(response["conversation"]["id"]))
    assert [message["role"] for message in messages["messages"]] == ["user", "assistant"]
    assert messages["messages"][1]["citations"][0]["chunkId"] == "chunk-pdf-valid"


def test_conversation_allows_uncited_transition_but_requires_typed_claim_citation(
    tmp_path: Path,
) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)
    gateway = FakeAnswerGateway(
        [
            {
                "evidence_sufficient": True,
                "refusal_reason": None,
                "paragraphs": [
                    {
                        "type": "transition",
                        "text": "下面按两个方面概括。",
                        "evidence_chunk_ids": [],
                    },
                    {
                        "type": "summary_claim",
                        "text": "Alpha 结论来自当前 PDF 证据。",
                        "evidence_chunk_ids": ["chunk-pdf-valid"],
                    },
                ],
            }
        ]
    )

    response = asyncio.run(
        ConversationService(
            storage,
            retrieval=HybridRetrievalService(storage, embedder=QueryEmbedder()),
            gateway_factory=lambda _key, _base, _embedding: gateway,
        ).answer(
            knowledge_base_id=knowledge_base_id,
            query="总结 Alpha",
            api_key="ark-test",
        )
    )

    assert response["answer"]["evidenceSufficient"] is True
    assert response["model"]["retryCount"] == 0
    assert [paragraph["type"] for paragraph in response["answer"]["paragraphs"]] == [
        "transition",
        "summary_claim",
    ]
    assert response["citationValidation"]["paragraphs"][0]["citationRequired"] is False
    assert response["citationValidation"]["paragraphs"][1]["citationRequired"] is True
    assert response["citations"][0]["paragraphIndex"] == 1
    paragraph_schema = gateway.schemas[0]["properties"]["paragraphs"]["items"]
    assert "type" in paragraph_schema["required"]
    assert "transition、clarification 可以为空" in gateway.prompts[0]


def test_conversation_splits_dense_answer_and_persists_paragraph_citations(
    tmp_path: Path,
) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)
    gateway = FakeAnswerGateway(
        [
            {
                "evidence_sufficient": True,
                "refusal_reason": None,
                "paragraphs": [
                    {
                        "text": (
                            "Alpha 第一项结论来自当前 PDF 证据，说明候选人的核心经历、"
                            "项目职责和可追问方向，回答时应先聚焦最有代表性的项目背景，"
                            "再把问题落到具体技术取舍与结果验证上。"
                            "Alpha 第二项结论同样来自当前 PDF 证据，说明后续追问可以围绕"
                            "性能优化、工程协作、异常处理和业务影响展开，避免把所有问题"
                            "堆在一个难以阅读的密集段落里。"
                        ),
                        "evidence_chunk_ids": ["chunk-pdf-valid", "chunk-pdf-valid-2"],
                    }
                ],
            }
        ]
    )

    response = asyncio.run(
        ConversationService(
            storage,
            retrieval=HybridRetrievalService(storage, embedder=QueryEmbedder()),
            gateway_factory=lambda _key, _base, _embedding: gateway,
        ).answer(
            knowledge_base_id=knowledge_base_id,
            query="Alpha 面试怎么追问？",
            api_key="ark-test",
            chat_model="doubao-test-chat",
            embedding_model="doubao-test-embedding",
        )
    )

    assert response["answer"]["evidenceSufficient"] is True
    assert response["answer"]["queryIntent"] == "knowledge_question_generation"
    assert response["answer"]["evidenceStatus"] == "partial_evidence"
    assert len(response["answer"]["paragraphs"]) == 2
    assert "\n\n" in response["content"]
    assert [citation["paragraphIndex"] for citation in response["citations"]] == [0, 1]
    assert [citation["chunkId"] for citation in response["citations"]] == [
        "chunk-pdf-valid",
        "chunk-pdf-valid-2",
    ]

    messages = ConversationService(storage).messages(str(response["conversation"]["id"]))
    assistant = messages["messages"][1]
    stored_paragraphs = assistant["modelParams"]["answerParagraphs"]
    assert isinstance(stored_paragraphs, list)
    assert len(stored_paragraphs) == 2
    assert assistant["citations"][1]["paragraphIndex"] == 1
    assert assistant["modelParams"]["queryIntent"] == "knowledge_question_generation"
    assert assistant["modelParams"]["evidenceStatus"] == "partial_evidence"


def test_conversation_answer_emits_agent_run_trace_events(tmp_path: Path) -> None:
    emitted: list[dict[str, object]] = []
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)
    gateway = FakeAnswerGateway(
        [
            {
                "evidence_sufficient": True,
                "refusal_reason": None,
                "paragraphs": [
                    {
                        "text": "Alpha 结论来自当前 PDF 证据。",
                        "evidence_chunk_ids": ["chunk-pdf-valid"],
                    }
                ],
            }
        ]
    )
    agent_runs = AgentRunService(storage, event_sink=emitted.append)

    response = asyncio.run(
        ConversationService(
            storage,
            retrieval=HybridRetrievalService(storage, embedder=QueryEmbedder()),
            gateway_factory=lambda _key, _base, _embedding: gateway,
            agent_runs=agent_runs,
        ).answer(
            knowledge_base_id=knowledge_base_id,
            query="总结 Alpha",
            api_key="ark-test",
            chat_model="doubao-test-chat",
            embedding_model="doubao-test-embedding",
        )
    )

    runs = agent_runs.list_runs(knowledge_base_id)["runs"]
    run_id = str(runs[0]["id"])
    trace = agent_runs.get(run_id)
    event_types = {event["eventType"] for event in emitted}
    tool_names = {tool["toolName"] for tool in trace["toolCalls"]}
    retrieval_tool = next(
        tool for tool in trace["toolCalls"] if tool["toolName"] == "hybrid_retrieval.search"
    )

    assert runs[0]["skillId"] == "conversation_answer"
    assert response["agentRunId"] == run_id
    assert runs[0]["status"] == "completed"
    assert {
        "run.created",
        "skill.loaded",
        "tool_call.started",
        "tool_call.output",
        "tool_call.completed",
        "output.final.saved",
        "run.completed",
    } <= event_types
    assert {
        "hybrid_retrieval.search",
        "model.generate_structured_answer",
        "citation.validate",
    } <= tool_names
    trace_expansion = retrieval_tool["sanitizedParams"]["queryExpansion"]
    assert trace_expansion["originalQuery"] == "总结 Alpha"
    assert trace_expansion["intent"] == "knowledge_summary"
    assert trace_expansion["applied"] is True
    assert trace["outputs"][0]["content"] == response["content"]
    assert trace["citations"][0]["chunkId"] == "chunk-pdf-valid"


def test_conversation_exports_markdown_with_citations_and_usage(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)
    gateway = FakeAnswerGateway(
        [
            {
                "evidence_sufficient": True,
                "refusal_reason": None,
                "paragraphs": [
                    {
                        "text": "Alpha 结论来自当前 PDF 证据。",
                        "evidence_chunk_ids": ["chunk-pdf-valid"],
                    }
                ],
            }
        ]
    )
    service = ConversationService(
        storage,
        retrieval=HybridRetrievalService(storage, embedder=QueryEmbedder()),
        gateway_factory=lambda _key, _base, _embedding: gateway,
    )
    response = asyncio.run(
        service.answer(
            knowledge_base_id=knowledge_base_id,
            query="Alpha 怎么解释？",
            api_key="ark-test",
            chat_model="doubao-test-chat",
        )
    )

    exported = service.export_markdown(str(response["conversation"]["id"]))
    single = service.export_markdown(
        str(response["conversation"]["id"]),
        message_id=str(response["assistantMessage"]["id"]),
    )
    usage = service.usage_summary(knowledge_base_id)

    assert exported["fileName"] == "Alpha 怎么解释？-conversation.md"
    assert "## 用户" in str(exported["markdown"])
    assert "## citeMind" in str(exported["markdown"])
    assert "Alpha.pdf · 第 3 页 · `chunk-pdf-valid`" in str(exported["markdown"])
    assert "## 用户" not in str(single["markdown"])
    assert usage["calls"] == {
        "chat": 1,
        "queryEmbedding": 1,
        "indexEmbedding": 1,
        "total": 3,
    }
    assert usage["estimatedCostCny"] is None
    assert usage["byModel"] == {"doubao-test-chat": 1}


def test_conversation_delete_cascades_messages_and_citations(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)
    gateway = FakeAnswerGateway(
        [
            {
                "evidence_sufficient": True,
                "refusal_reason": None,
                "paragraphs": [
                    {
                        "text": "Alpha 结论来自当前 PDF 证据。",
                        "evidence_chunk_ids": ["chunk-pdf-valid"],
                    }
                ],
            }
        ]
    )
    service = ConversationService(
        storage,
        retrieval=HybridRetrievalService(storage, embedder=QueryEmbedder()),
        gateway_factory=lambda _key, _base, _embedding: gateway,
    )
    response = asyncio.run(
        service.answer(
            knowledge_base_id=knowledge_base_id,
            query="Alpha 怎么解释？",
            api_key="ark-test",
            chat_model="doubao-test-chat",
        )
    )

    result = service.delete(str(response["conversation"]["id"]))

    assert result == {
        "knowledgeBaseId": knowledge_base_id,
        "conversations": [],
    }
    with storage.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM conversations").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM answer_citations").fetchone()[0] == 0


def test_conversation_refuses_without_retrieval_candidates(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)
    gateway = FakeAnswerGateway([])

    response = asyncio.run(
        ConversationService(
            storage,
            retrieval=EmptyRetrieval(),
            gateway_factory=lambda _key, _base, _embedding: gateway,
        ).answer(
            knowledge_base_id=knowledge_base_id,
            query="知识库里没有的问题？",
            api_key="ark-test",
            chat_model="doubao-test-chat",
            embedding_model="doubao-test-embedding",
        )
    )

    assert gateway.prompts == []
    assert response["answer"]["evidenceSufficient"] is False
    assert response["answer"]["refusalReason"] == "no_retrieval_candidates"
    assert response["answer"]["queryIntent"] == "knowledge_ambiguous"
    assert response["answer"]["evidenceStatus"] == "no_evidence"
    assert response["content"] == DEFAULT_REFUSAL
    assert response["citations"] == []
    assert response["retrieval"]["results"] == []
    assert response["citationValidation"]["candidateChunkIds"] == []

    with storage.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM answer_citations").fetchone()[0] == 0
        params = json.loads(
            connection.execute(
                "SELECT model_params_json FROM messages WHERE role = 'assistant'"
            ).fetchone()[0]
        )
    assert params["evidenceSufficient"] is False
    assert params["refusalReason"] == "no_retrieval_candidates"
    assert params["queryIntent"] == "knowledge_ambiguous"
    assert params["evidenceStatus"] == "no_evidence"


def test_conversation_answers_assistant_identity_without_knowledge_citations(
    tmp_path: Path,
) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)
    gateway = FakeAnswerGateway([])

    response = asyncio.run(
        ConversationService(
            storage,
            retrieval=FailingRetrieval(),
            gateway_factory=lambda _key, _base, _embedding: gateway,
        ).answer(
            knowledge_base_id=knowledge_base_id,
            query="你是谁？",
            api_key="ark-test",
            chat_model="doubao-test-chat",
            embedding_model="doubao-test-embedding",
        )
    )

    assert gateway.prompts == []
    assert "CiteMind 是一个面向本地知识库的可信问答系统" in response["content"]
    assert response["answer"]["evidenceSufficient"] is True
    assert response["answer"]["answerMode"] == "system_meta"
    assert response["answer"]["citationPolicy"] == "not_required"
    assert response["answer"]["queryIntent"] == "assistant_identity"
    assert response["citations"] == []
    assert response["citationValidation"]["valid"] is True
    assert response["retrieval"]["retrieval"]["mergedCandidateCount"] == 0
    event_types = [event["type"] for event in response["events"]]
    assert event_types[0] == "conversation.ready"
    assert event_types[-1] == "answer.completed"
    assert event_types.count("answer.delta") == 4
    assert "retrieval.completed" not in event_types
    assert "generation.started" not in event_types

    messages = ConversationService(storage).messages(str(response["conversation"]["id"]))
    assistant = messages["messages"][1]
    assert assistant["citations"] == []
    assert assistant["indexVersionId"] is None
    assert assistant["modelParams"]["answerMode"] == "system_meta"
    assert assistant["modelParams"]["citationPolicy"] == "not_required"
    assert assistant["modelParams"]["systemMetaProfileVersion"] == "system-meta-profile-v1"


def test_conversation_runtime_tool_question_uses_meta_answer_without_fake_citation(
    tmp_path: Path,
) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)

    response = asyncio.run(
        ConversationService(storage, retrieval=FailingRetrieval()).answer(
            knowledge_base_id=knowledge_base_id,
            query="你使用了哪些工具？",
            api_key="ark-test",
            chat_model="doubao-test-chat",
        )
    )

    assert "知识库资料不能证明我本轮实际调用了哪些内部工具" in response["content"]
    assert response["answer"]["answerMode"] == "system_meta"
    assert response["answer"]["queryIntent"] == "runtime_tool_question"
    assert response["citations"] == []
    assert response["assistantMessage"]["modelParams"]["queryIntent"] == "runtime_tool_question"


def test_conversation_system_meta_profile_covers_common_variants(
    tmp_path: Path,
) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)
    cases = [
        ("CiteMind 是什么？", "assistant_identity", "可信问答系统"),
        ("请问你到底是谁呀？", "assistant_identity", "可信问答系统"),
        ("你是什么模型？", "assistant_identity", "不会把底层模型"),
        ("你可以帮我做什么？", "system_capability", "主要能力包括"),
        ("你能帮忙干什么？", "system_capability", "主要能力包括"),
        ("这个软件支持哪些功能？", "system_capability", "带段落级引用"),
        ("你有什么限制？", "system_limitation", "主要边界"),
        ("为什么不能回答？", "system_limitation", "主要边界"),
        ("你怎么保证引用可信？", "citation_policy", "引用规则"),
        ("引用怎么校验？", "citation_policy", "引用规则"),
        ("为什么没有引用？", "citation_policy", "无需知识库引用"),
        ("用了哪些工具？", "runtime_tool_question", "内部工具"),
    ]

    for query, intent, expected_text in cases:
        response = asyncio.run(
            ConversationService(storage, retrieval=FailingRetrieval()).answer(
                knowledge_base_id=knowledge_base_id,
                query=query,
                api_key="ark-test",
                chat_model="doubao-test-chat",
            )
        )

        assert response["answer"]["answerMode"] == "system_meta"
        assert response["answer"]["citationPolicy"] == "not_required"
        assert response["answer"]["queryIntent"] == intent
        assert response["citations"] == []
        assert response["assistantMessage"]["modelParams"]["queryIntent"] == intent
        assert expected_text in response["content"]
        assert response["retrieval"]["retrieval"]["mergedCandidateCount"] == 0


def test_conversation_explicit_source_question_still_uses_rag_path(
    tmp_path: Path,
) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)

    retrieval = EmptyRetrieval()
    response = asyncio.run(
        ConversationService(storage, retrieval=retrieval).answer(
            knowledge_base_id=knowledge_base_id,
            query="这份简历中的你是谁？",
            api_key="ark-test",
            chat_model="doubao-test-chat",
        )
    )

    assert response["answer"]["answerMode"] == "knowledge_grounded"
    assert response["answer"]["citationPolicy"] == "required"
    assert response["answer"]["queryIntent"] == "knowledge_fact_qa"
    assert response["answer"]["evidenceStatus"] == "no_evidence"
    assert response["answer"]["refusalReason"] == "no_retrieval_candidates"
    assert response["retrieval"]["query"] == "这份简历中的你是谁？"
    expansion = response["retrieval"]["queryExpansion"]
    assert expansion["intent"] == "knowledge_fact_qa"
    assert expansion["documentType"] == "resume_project_material"
    assert expansion["taskTerms"][0] == "实体"
    assert expansion["documentTypeTerms"][0] == "经历"
    assert retrieval.queries == [expansion["expandedQuery"]]


def test_retrieval_query_expansion_is_task_first_and_document_type_auxiliary() -> None:
    cases = [
        (
            "总结这份会议纪要",
            "knowledge_summary",
            "主题",
            "meeting_minutes",
            "决议",
        ),
        (
            "根据接口文档改写成接入指南",
            "knowledge_transform",
            "原始表述",
            "product_api_documentation",
            "参数",
        ),
        (
            "基于这篇论文生成 5 个讨论问题",
            "knowledge_question_generation",
            "背景",
            "paper_report",
            "方法",
        ),
        (
            "从这份合同中提炼主要风险点",
            "knowledge_review",
            "优点",
            "contract_policy",
            "条款",
        ),
        (
            "基于我的简历生成面试追问",
            "knowledge_question_generation",
            "背景",
            "resume_project_material",
            "经历",
        ),
    ]

    for query, intent, task_term, document_type, document_term in cases:
        plan = _retrieval_query_plan(query, intent)

        assert plan["strategy"] == "task_first_document_type_auxiliary_v1"
        assert plan["originalQuery"] == query
        assert plan["applied"] is True
        assert plan["taskTerms"][0] == task_term
        assert plan["documentType"] == document_type
        assert plan["documentTypeTerms"][0] == document_term
        assert plan["terms"] == [*plan["taskTerms"], *plan["documentTypeTerms"]]
        assert plan["expandedQuery"].startswith(f"{query} {task_term}")
        assert plan["expandedQuery"].index(task_term) < plan["expandedQuery"].index(document_term)


def test_retrieval_query_expansion_does_not_guess_unknown_document_type() -> None:
    plan = _retrieval_query_plan("总结一下", "knowledge_summary")

    assert plan["taskTerms"]
    assert plan["documentType"] is None
    assert plan["documentTypeTerms"] == []


def test_retrieval_query_expansion_does_not_broaden_unscoped_fact_question() -> None:
    plan = _retrieval_query_plan("天气？", "knowledge_fact_qa")

    assert plan["applied"] is False
    assert plan["expandedQuery"] == "天气？"
    assert plan["taskTerms"] == []
    assert plan["documentType"] is None


def test_conversation_refuses_low_relevance_semantic_candidates(
    tmp_path: Path,
) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)
    gateway = FakeAnswerGateway([])

    response = asyncio.run(
        ConversationService(
            storage,
            retrieval=WeakSemanticRetrieval(),
            gateway_factory=lambda _key, _base, _embedding: gateway,
        ).answer(
            knowledge_base_id=knowledge_base_id,
            query="天气？",
            api_key="ark-test",
            chat_model="doubao-test-chat",
            embedding_model="doubao-test-embedding",
        )
    )

    assert gateway.prompts == []
    assert response["answer"]["evidenceSufficient"] is False
    assert response["answer"]["refusalReason"] == "low_relevance_candidates"
    assert response["answer"]["queryIntent"] == "knowledge_fact_qa"
    assert response["answer"]["evidenceStatus"] == "weak_evidence"
    assert response["content"] == DEFAULT_REFUSAL
    assert response["citations"] == []
    assert response["citationValidation"]["candidateChunkIds"] == ["chunk-pdf-valid"]
    assert response["retrieval"]["retrieval"]["mergedCandidateCount"] == 1

    with storage.database.connect() as connection:
        params = json.loads(
            connection.execute(
                "SELECT model_params_json FROM messages WHERE role = 'assistant'"
            ).fetchone()[0]
        )
    assert params["refusalReason"] == "low_relevance_candidates"
    assert params["queryIntent"] == "knowledge_fact_qa"
    assert params["evidenceStatus"] == "weak_evidence"


def test_conversation_interview_task_continues_with_partial_evidence_on_weak_candidates(
    tmp_path: Path,
) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)
    gateway = FakeAnswerGateway(
        [
            {
                "evidence_sufficient": True,
                "refusal_reason": None,
                "paragraphs": [
                    {
                        "text": "可以围绕 Alpha 项目经历追问具体职责、技术取舍和结果验证。",
                        "evidence_chunk_ids": ["chunk-pdf-valid"],
                    }
                ],
            }
        ]
    )

    response = asyncio.run(
        ConversationService(
            storage,
            retrieval=WeakSemanticRetrieval(),
            gateway_factory=lambda _key, _base, _embedding: gateway,
        ).answer(
            knowledge_base_id=knowledge_base_id,
            query="面试？",
            api_key="ark-test",
            chat_model="doubao-test-chat",
            embedding_model="doubao-test-embedding",
        )
    )

    assert gateway.prompts
    assert response["answer"]["evidenceSufficient"] is True
    assert response["answer"]["refusalReason"] is None
    assert response["answer"]["queryIntent"] == "knowledge_question_generation"
    assert response["answer"]["evidenceStatus"] == "partial_evidence"
    assert response["content"] == "可以围绕 Alpha 项目经历追问具体职责、技术取舍和结果验证。"
    assert response["citations"][0]["chunkId"] == "chunk-pdf-valid"
    assert "当前知识库任务类型：knowledge_question_generation" in gateway.prompts[0]
    assert "当前检索证据状态：weak_evidence" in gateway.prompts[0]
    assert "【问题生成任务】" in gateway.prompts[0]
    assert "当前可回答范围 answerableScope" in gateway.prompts[0]

    with storage.database.connect() as connection:
        params = json.loads(
            connection.execute(
                "SELECT model_params_json FROM messages WHERE role = 'assistant'"
            ).fetchone()[0]
        )
    assert params["queryIntent"] == "knowledge_question_generation"
    assert params["evidenceStatus"] == "partial_evidence"


def test_conversation_document_scoped_query_bypasses_direct_low_relevance_refusal(
    tmp_path: Path,
) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)
    gateway = FakeAnswerGateway(
        [
            {
                "evidence_sufficient": True,
                "refusal_reason": None,
                "paragraphs": [
                    {
                        "text": "候选人的说明只能基于当前检索到的 Alpha 片段展开。",
                        "evidence_chunk_ids": ["chunk-pdf-valid"],
                    }
                ],
            }
        ]
    )

    response = asyncio.run(
        ConversationService(
            storage,
            retrieval=WeakSemanticRetrieval(),
            gateway_factory=lambda _key, _base, _embedding: gateway,
        ).answer(
            knowledge_base_id=knowledge_base_id,
            query="基于简历",
            api_key="ark-test",
            chat_model="doubao-test-chat",
            embedding_model="doubao-test-embedding",
        )
    )

    assert gateway.prompts
    assert response["answer"]["evidenceSufficient"] is True
    assert response["answer"]["refusalReason"] is None
    assert response["answer"]["queryIntent"] == "knowledge_ambiguous"
    assert response["answer"]["evidenceStatus"] == "partial_evidence"
    assert response["citations"][0]["chunkId"] == "chunk-pdf-valid"
    assert "当前知识库任务类型：knowledge_ambiguous" in gateway.prompts[0]
    assert "当前检索证据状态：weak_evidence" in gateway.prompts[0]
    assert "候选证据相关性较弱" in gateway.prompts[0]
    assert "【意图不明确】" in gateway.prompts[0]
    assert "当前可回答范围 answerableScope" in gateway.prompts[0]


def test_conversation_generic_document_references_bypass_direct_low_relevance_refusal(
    tmp_path: Path,
) -> None:
    cases = [
        "这篇论文",
        "这份合同",
        "会议纪要",
        "接口文档",
        "项目材料",
    ]

    for index, query in enumerate(cases):
        storage = StorageRuntime(tmp_path / f"case-{index}", vector_dimension=3)
        storage.initialize()
        knowledge_base_id = _seed_answer_fixture(storage)
        gateway = FakeAnswerGateway(
            [
                {
                    "evidence_sufficient": True,
                    "refusal_reason": None,
                    "paragraphs": [
                        {
                            "text": f"{query} 只能基于当前检索到的片段谨慎处理。",
                            "evidence_chunk_ids": ["chunk-pdf-valid"],
                        }
                    ],
                }
            ]
        )

        response = asyncio.run(
            ConversationService(
                storage,
                retrieval=WeakSemanticRetrieval(),
                gateway_factory=lambda _key, _base, _embedding, gateway=gateway: gateway,
            ).answer(
                knowledge_base_id=knowledge_base_id,
                query=query,
                api_key="ark-test",
                chat_model="doubao-test-chat",
                embedding_model="doubao-test-embedding",
            )
        )

        assert gateway.prompts
        assert response["answer"]["evidenceSufficient"] is True
        assert response["answer"]["refusalReason"] is None
        assert response["answer"]["queryIntent"] == "knowledge_ambiguous"
        assert response["answer"]["evidenceStatus"] == "partial_evidence"
        assert response["citations"][0]["chunkId"] == "chunk-pdf-valid"
        assert "当前知识库任务类型：knowledge_ambiguous" in gateway.prompts[0]
        assert "当前检索证据状态：weak_evidence" in gateway.prompts[0]
        assert "请求用户明确资料范围或补充相关资料" in gateway.prompts[0]


def test_conversation_generic_task_markers_bypass_direct_low_relevance_refusal(
    tmp_path: Path,
) -> None:
    cases = [
        ("审查清单", "knowledge_question_generation", "【问题生成任务】"),
        ("提炼风险", "knowledge_review", "【评价建议任务】"),
        ("改写", "knowledge_transform", "【转换改写任务】"),
        ("总结一下", "knowledge_summary", "【总结提炼任务】"),
    ]

    for index, (query, expected_intent, expected_prompt_label) in enumerate(cases):
        storage = StorageRuntime(tmp_path / f"task-{index}", vector_dimension=3)
        storage.initialize()
        knowledge_base_id = _seed_answer_fixture(storage)
        gateway = FakeAnswerGateway(
            [
                {
                    "evidence_sufficient": True,
                    "refusal_reason": None,
                    "paragraphs": [
                        {
                            "text": f"{query} 的输出仅基于当前候选片段。",
                            "evidence_chunk_ids": ["chunk-pdf-valid"],
                        }
                    ],
                }
            ]
        )

        response = asyncio.run(
            ConversationService(
                storage,
                retrieval=WeakSemanticRetrieval(),
                gateway_factory=lambda _key, _base, _embedding, gateway=gateway: gateway,
            ).answer(
                knowledge_base_id=knowledge_base_id,
                query=query,
                api_key="ark-test",
                chat_model="doubao-test-chat",
                embedding_model="doubao-test-embedding",
            )
        )

        assert gateway.prompts
        assert response["answer"]["evidenceSufficient"] is True
        assert response["answer"]["refusalReason"] is None
        assert response["answer"]["queryIntent"] == expected_intent
        assert response["answer"]["evidenceStatus"] == "partial_evidence"
        assert response["citations"][0]["chunkId"] == "chunk-pdf-valid"
        assert "当前检索证据状态：weak_evidence" in gateway.prompts[0]
        assert expected_prompt_label in gateway.prompts[0]
        assert "当前可回答范围 answerableScope" in gateway.prompts[0]


def test_conversation_model_switch_applies_to_next_message_and_history_is_compacted(
    tmp_path: Path,
) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)
    service = ConversationService(storage, retrieval=EmptyRetrieval())
    first = asyncio.run(
        service.answer(
            knowledge_base_id=knowledge_base_id,
            query="第一条问题",
            chat_model="model-a",
        )
    )
    conversation_id = str(first["conversation"]["id"])

    switched = service.set_model(conversation_id, "model-b")
    second = asyncio.run(
        service.answer(
            knowledge_base_id=knowledge_base_id,
            conversation_id=conversation_id,
            query="第二条问题",
        )
    )
    messages = service.messages(conversation_id)["messages"]
    compacted = _compact_history(
        [
            {"role": "user", "content": "a" * 5000},
            {"role": "assistant", "content": "b" * 5000},
            {"role": "user", "content": "recent"},
        ],
        budget_chars=100,
    )

    assert switched["modelId"] == "model-b"
    assert second["assistantMessage"]["modelId"] == "model-b"
    assert [message["modelId"] for message in messages if message["role"] == "assistant"] == [
        "model-a",
        "model-b",
    ]
    assert compacted["strategy"] == "summary_and_recent"
    assert compacted["summarizedMessageCount"] == 2
    assert compacted["recentMessageCount"] == 1
    assert len(messages) == 4


def test_conversation_retries_once_then_refuses_invalid_citations(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)
    gateway = FakeAnswerGateway(
        [
            {
                "evidence_sufficient": True,
                "refusal_reason": None,
                "paragraphs": [
                    {
                        "text": "第一次引用了不存在的证据。",
                        "evidence_chunk_ids": ["chunk-missing"],
                    }
                ],
            },
            {
                "evidence_sufficient": True,
                "refusal_reason": None,
                "paragraphs": [
                    {
                        "text": "第二次仍然引用了非候选证据。",
                        "evidence_chunk_ids": ["chunk-noncandidate"],
                    }
                ],
            },
        ]
    )

    response = asyncio.run(
        ConversationService(
            storage,
            retrieval=HybridRetrievalService(storage, embedder=QueryEmbedder()),
            gateway_factory=lambda _key, _base, _embedding: gateway,
        ).answer(
            knowledge_base_id=knowledge_base_id,
            query="Alpha 怎么解释？",
            api_key="ark-test",
        )
    )

    assert len(gateway.prompts) == 2
    assert "上一次输出包含无效引用" in gateway.prompts[1]
    assert response["answer"]["evidenceSufficient"] is False
    assert response["content"] == DEFAULT_REFUSAL
    assert response["citations"] == []
    assert response["model"]["retryCount"] == 1
    assert response["citationValidation"]["invalidCitations"][0]["reason"] in {
        "chunk_not_found",
        "not_in_retrieval_candidates",
    }

    with storage.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM answer_citations").fetchone()[0] == 0
        params = json.loads(
            connection.execute(
                "SELECT model_params_json FROM messages WHERE role = 'assistant'"
            ).fetchone()[0]
        )
    assert params["evidenceSufficient"] is False
    assert params["retryCount"] == 1


def test_conversation_falls_back_to_plain_cited_answer_when_structured_parse_fails(
    tmp_path: Path,
) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)
    gateway = FakeAnswerGateway(
        [ValueError("Ark 结构化输出无法解析，JSON Schema 与 JSON Prompt 均失败")],
        stream_chunks=["Alpha 结论来自当前 PDF 证据。[chunk-pdf-valid]"],
    )

    response = asyncio.run(
        ConversationService(
            storage,
            retrieval=HybridRetrievalService(storage, embedder=QueryEmbedder()),
            gateway_factory=lambda _key, _base, _embedding: gateway,
        ).answer(
            knowledge_base_id=knowledge_base_id,
            query="Alpha 怎么解释？",
            api_key="ark-test",
        )
    )

    assert response["answer"]["evidenceSufficient"] is True
    assert response["content"] == "Alpha 结论来自当前 PDF 证据。"
    assert response["citations"][0]["chunkId"] == "chunk-pdf-valid"
    assert "不要输出 JSON" in gateway.stream_prompts[0]
    assert response["assistantMessage"]["modelParams"]["attempts"][0]["generationMode"] == (
        "plain_text"
    )


def test_conversation_refuses_when_structured_and_plain_citations_fail(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_answer_fixture(storage)
    gateway = FakeAnswerGateway(
        [ValueError("Ark 结构化输出无法解析，JSON Schema 与 JSON Prompt 均失败")],
        stream_chunks=["Alpha 结论来自当前 PDF 证据，但没有引用。"],
    )

    response = asyncio.run(
        ConversationService(
            storage,
            retrieval=HybridRetrievalService(storage, embedder=QueryEmbedder()),
            gateway_factory=lambda _key, _base, _embedding: gateway,
        ).answer(
            knowledge_base_id=knowledge_base_id,
            query="Alpha 怎么解释？",
            api_key="ark-test",
        )
    )

    assert response["answer"]["evidenceSufficient"] is False
    assert response["content"] == DEFAULT_REFUSAL
    assert response["citations"] == []
    assert response["answer"]["refusalReason"] == "plain_answer_missing_valid_citations"
    assert response["assistantMessage"]["modelParams"]["attempts"][0]["generationMode"] == (
        "plain_text"
    )


def test_citation_validator_checks_candidate_validity_and_location(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    _seed_answer_fixture(storage)

    validation = CitationValidator(storage).validate(
        paragraphs=[
            {
                "text": "有效 PDF 引用。",
                "evidence_chunk_ids": ["chunk-pdf-valid"],
            },
            {
                "text": "混合无效引用。",
                "evidence_chunk_ids": [
                    "chunk-missing",
                    "chunk-noncandidate",
                    "chunk-pdf-unlocatable",
                    "chunk-docx-invalid-version",
                ],
            },
        ],
        candidate_chunk_ids=[
            "chunk-pdf-valid",
            "chunk-pdf-unlocatable",
            "chunk-docx-invalid-version",
        ],
        index_version_id="index-current",
    )

    assert validation["valid"] is False
    reasons = {item["reason"] for item in validation["invalidCitations"]}
    assert reasons >= {
        "chunk_not_found",
        "not_in_retrieval_candidates",
        "location_not_valid",
        "source_version_not_valid",
        "paragraph_missing_valid_evidence",
    }
    assert validation["validCitations"][0]["chunkId"] == "chunk-pdf-valid"


def test_citation_validator_applies_requirement_by_paragraph_type(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    _seed_answer_fixture(storage)

    optional = CitationValidator(storage).validate(
        paragraphs=[
            {"type": "transition", "text": "下面分点说明。", "evidence_chunk_ids": []},
            {"type": "clarification", "text": "请明确资料范围。", "evidence_chunk_ids": []},
        ],
        candidate_chunk_ids=["chunk-pdf-valid"],
        index_version_id="index-current",
    )
    required = CitationValidator(storage).validate(
        paragraphs=[
            {"type": paragraph_type, "text": "需要依据。", "evidence_chunk_ids": []}
            for paragraph_type in (
                "fact",
                "summary_claim",
                "generated_question",
                "recommendation",
                "transformed_text",
            )
        ],
        candidate_chunk_ids=["chunk-pdf-valid"],
        index_version_id="index-current",
    )
    invalid_optional_citation = CitationValidator(storage).validate(
        paragraphs=[
            {
                "type": "transition",
                "text": "带了引用的过渡句。",
                "evidence_chunk_ids": ["chunk-missing"],
            }
        ],
        candidate_chunk_ids=["chunk-pdf-valid"],
        index_version_id="index-current",
    )
    unsupported = CitationValidator(storage).validate(
        paragraphs=[
            {"type": "opinion", "text": "未知类型。", "evidence_chunk_ids": []},
        ],
        candidate_chunk_ids=["chunk-pdf-valid"],
        index_version_id="index-current",
    )

    assert optional["valid"] is True
    assert [item["citationRequired"] for item in optional["paragraphs"]] == [False, False]
    assert required["valid"] is False
    assert [item["reason"] for item in required["invalidCitations"]] == [
        "paragraph_missing_valid_evidence"
    ] * 5
    assert invalid_optional_citation["valid"] is False
    assert invalid_optional_citation["invalidCitations"][0]["reason"] == "chunk_not_found"
    assert unsupported["valid"] is False
    assert {item["reason"] for item in unsupported["invalidCitations"]} == {
        "paragraph_type_not_supported",
        "paragraph_missing_valid_evidence",
    }


def _seed_answer_fixture(storage: StorageRuntime) -> str:
    knowledge_base_id = KnowledgeBaseService(storage).create("对话测试")["id"]
    assert isinstance(knowledge_base_id, str)
    with storage.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO index_versions(
                id, knowledge_base_id, embedding_provider, embedding_model,
                embedding_dimension, chunking_version, parser_version, status, is_current
            )
            VALUES ('index-current', ?, 'ark', 'embedding-current', 3, 'chunk-v1',
                    'parser-v1', 'ready', 1)
            """,
            (knowledge_base_id,),
        )
        connection.execute(
            """
            INSERT INTO sources(id, knowledge_base_id, source_type, display_name, uri, status)
            VALUES
                ('source-pdf', ?, 'pdf', 'Alpha.pdf', NULL, 'ready'),
                ('source-docx', ?, 'docx', 'Invalid.docx', NULL, 'ready')
            """,
            (knowledge_base_id, knowledge_base_id),
        )
        connection.execute(
            """
            INSERT INTO source_versions(id, source_id, version_number, status)
            VALUES
                ('version-pdf', 'source-pdf', 1, 'ready'),
                ('version-docx-invalid', 'source-docx', 1, 'parsed')
            """
        )
        connection.executemany(
            """
            INSERT INTO chunks(
                id, knowledge_base_id, source_version_id, index_version_id,
                page_number, bounding_box_json, heading_path_json, anchor,
                original_text, normalized_text, content_hash
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "chunk-pdf-valid",
                    knowledge_base_id,
                    "version-pdf",
                    "index-current",
                    3,
                    json.dumps({"x": 1, "y": 2, "width": 3, "height": 4}),
                    json.dumps(["Alpha"]),
                    "pdf-block",
                    "Alpha evidence for conversation",
                    "Alpha evidence for conversation",
                    "hash-alpha",
                ),
                (
                    "chunk-pdf-valid-2",
                    knowledge_base_id,
                    "version-pdf",
                    "index-current",
                    6,
                    json.dumps({"x": 3, "y": 4, "width": 5, "height": 6}),
                    json.dumps(["Alpha", "Follow up"]),
                    "pdf-follow-up",
                    "Alpha follow up evidence for conversation",
                    "Alpha follow up evidence for conversation",
                    "hash-alpha-follow-up",
                ),
                (
                    "chunk-noncandidate",
                    knowledge_base_id,
                    "version-pdf",
                    "index-current",
                    4,
                    json.dumps({"x": 2, "y": 3, "width": 4, "height": 5}),
                    json.dumps(["Noncandidate"]),
                    "noncandidate",
                    "Noncandidate evidence",
                    "Noncandidate evidence",
                    "hash-noncandidate",
                ),
                (
                    "chunk-pdf-unlocatable",
                    knowledge_base_id,
                    "version-pdf",
                    "index-current",
                    5,
                    None,
                    json.dumps(["Broken"]),
                    "broken",
                    "Broken evidence",
                    "Broken evidence",
                    "hash-broken",
                ),
                (
                    "chunk-docx-invalid-version",
                    knowledge_base_id,
                    "version-docx-invalid",
                    "index-current",
                    None,
                    None,
                    json.dumps(["Invalid"]),
                    "p-1",
                    "Invalid version evidence",
                    "Invalid version evidence",
                    "hash-invalid-version",
                ),
            ],
        )
        connection.commit()

    FullTextIndex(storage.database).upsert(
        chunk_id="chunk-pdf-valid",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-current",
        text="Alpha evidence for conversation",
    )
    FullTextIndex(storage.database).upsert(
        chunk_id="chunk-pdf-valid-2",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-current",
        text="Alpha follow up evidence for conversation",
    )
    storage.vector_index.add(
        chunk_id="chunk-pdf-valid",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-current",
        vector=[1.0, 0.0, 0.0],
    )
    storage.vector_index.add(
        chunk_id="chunk-pdf-valid-2",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-current",
        vector=[1.0, 0.0, 0.0],
    )
    return knowledge_base_id
