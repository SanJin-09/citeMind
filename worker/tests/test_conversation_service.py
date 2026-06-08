import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from pathlib import Path

from citemind_worker.citation_validator import CitationValidator
from citemind_worker.conversation_service import DEFAULT_REFUSAL, ConversationService
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
        self.stream_prompts: list[str] = []

    async def generate_structured(
        self,
        request: dict[str, object],
        schema: dict[str, object],
    ) -> dict[str, object]:
        assert schema["type"] == "object"
        self.prompts.append(str(request["prompt"]))
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
    assert response["content"] == "Alpha 结论来自当前 PDF 证据。"
    assert response["citations"][0]["chunkId"] == "chunk-pdf-valid"
    assert response["assistantMessage"]["modelId"] == "doubao-test-chat"
    assert response["assistantMessage"]["indexVersionId"] == "index-current"
    assert response["assistantMessage"]["modelParams"]["generationTimeMs"] >= 0
    assert response["assistantMessage"]["modelParams"]["retryCount"] == 0
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

    with storage.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM conversations").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 2
        assert connection.execute("SELECT COUNT(*) FROM answer_citations").fetchone()[0] == 1

    messages = ConversationService(storage).messages(str(response["conversation"]["id"]))
    assert [message["role"] for message in messages["messages"]] == ["user", "assistant"]
    assert messages["messages"][1]["citations"][0]["chunkId"] == "chunk-pdf-valid"


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
    storage.vector_index.add(
        chunk_id="chunk-pdf-valid",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-current",
        vector=[1.0, 0.0, 0.0],
    )
    return knowledge_base_id
