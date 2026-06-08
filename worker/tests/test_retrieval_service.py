import asyncio
import json
from collections.abc import Sequence
from pathlib import Path

import pytest

from citemind_worker.knowledge_base_service import KnowledgeBaseService
from citemind_worker.retrieval_service import HybridRetrievalService
from citemind_worker.storage import StorageRuntime
from citemind_worker.storage.full_text import FullTextIndex


class QueryEmbedder:
    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for text in texts:
            if "数据库" in text or "semantic" in text.lower():
                vectors.append([0.0, 1.0, 0.0])
            else:
                vectors.append([1.0, 0.0, 0.0])
        return vectors


def test_hybrid_retrieval_merges_keyword_and_semantic_results(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = _seed_retrieval_fixture(storage)

    response = asyncio.run(
        HybridRetrievalService(storage, embedder=QueryEmbedder()).retrieve(
            knowledge_base_id,
            "数据库 alpha",
            limit=3,
            candidate_limit=3,
            rerank_model_version="reserved-rerank-v1",
        )
    )

    assert response["indexVersion"]["id"] == "index-current"
    assert response["retrieval"] == {
        "keywordCandidateCount": 1,
        "semanticCandidateCount": 3,
        "mergedCandidateCount": 3,
        "fusion": "reciprocal_rank_fusion",
        "rrfK": 60,
    }
    assert response["rerank"] == {
        "available": False,
        "applied": False,
        "modelVersion": "reserved-rerank-v1",
    }

    results = response["results"]
    assert [item["chunkId"] for item in results] == [
        "chunk-alpha-current",
        "chunk-semantic-current",
        "chunk-other-current",
    ]
    alpha = results[0]
    semantic = results[1]

    assert alpha["match"]["hasKeywordHit"] is True
    assert alpha["match"]["hasSemanticMatch"] is True
    assert "keyword" in alpha["match"]["matchedBy"]
    assert alpha["ranks"]["keyword"] == 1
    assert alpha["ranks"]["semantic"] == 2
    assert set(alpha["match"]["keywordHits"]) >= {"alpha"}

    assert semantic["match"]["matchedBy"] == ["semantic"]
    assert semantic["ranks"]["keyword"] is None
    assert semantic["ranks"]["semantic"] == 1
    assert semantic["scores"]["semanticScore"] == 1.0

    context = response["context"]
    assert context["chunkCount"] == 3
    assert "chunk-retired" not in context["text"]
    assert "数据库 alpha current evidence" in context["text"]


def test_hybrid_retrieval_requires_current_ready_index(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("空知识库")["id"]
    assert isinstance(knowledge_base_id, str)

    with pytest.raises(ValueError, match="当前知识库没有可检索的索引"):
        asyncio.run(
            HybridRetrievalService(storage, embedder=QueryEmbedder()).retrieve(
                knowledge_base_id,
                "alpha",
            )
        )


def _seed_retrieval_fixture(storage: StorageRuntime) -> str:
    knowledge_base_id = KnowledgeBaseService(storage).create("检索测试")["id"]
    assert isinstance(knowledge_base_id, str)
    with storage.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO index_versions(
                id, knowledge_base_id, embedding_provider, embedding_model,
                embedding_dimension, chunking_version, parser_version, status, is_current
            )
            VALUES
                ('index-retired', ?, 'ark', 'embedding-old', 3, 'chunk-v1', 'parser-v1',
                 'ready', 0),
                ('index-current', ?, 'ark', 'embedding-current', 3, 'chunk-v1', 'parser-v1',
                 'ready', 1)
            """,
            (knowledge_base_id, knowledge_base_id),
        )
        connection.execute(
            """
            INSERT INTO sources(id, knowledge_base_id, source_type, display_name, uri, status)
            VALUES
                ('source-alpha', ?, 'pdf', 'Alpha.pdf', NULL, 'ready'),
                ('source-semantic', ?, 'docx', 'Semantic.docx', NULL, 'ready')
            """,
            (knowledge_base_id, knowledge_base_id),
        )
        connection.execute(
            """
            INSERT INTO source_versions(id, source_id, version_number, status)
            VALUES
                ('version-alpha', 'source-alpha', 1, 'ready'),
                ('version-semantic', 'source-semantic', 1, 'ready')
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
                    "chunk-retired",
                    knowledge_base_id,
                    "version-alpha",
                    "index-retired",
                    1,
                    None,
                    json.dumps(["旧索引"], ensure_ascii=False),
                    "old",
                    "retired only secret",
                    "retired only secret",
                    "hash-retired",
                ),
                (
                    "chunk-alpha-current",
                    knowledge_base_id,
                    "version-alpha",
                    "index-current",
                    2,
                    json.dumps({"x": 1, "y": 2, "width": 3, "height": 4}),
                    json.dumps(["数据库", "Alpha"], ensure_ascii=False),
                    "alpha",
                    "数据库 alpha current evidence",
                    "数据库 alpha current evidence",
                    "hash-alpha",
                ),
                (
                    "chunk-semantic-current",
                    knowledge_base_id,
                    "version-semantic",
                    "index-current",
                    None,
                    None,
                    json.dumps(["语义资料"], ensure_ascii=False),
                    "semantic",
                    "semantic vector current evidence",
                    "semantic vector current evidence",
                    "hash-semantic",
                ),
                (
                    "chunk-other-current",
                    knowledge_base_id,
                    "version-semantic",
                    "index-current",
                    None,
                    None,
                    json.dumps(["其它资料"], ensure_ascii=False),
                    "other",
                    "other current evidence",
                    "other current evidence",
                    "hash-other",
                ),
            ],
        )
        connection.commit()

    full_text = FullTextIndex(storage.database)
    full_text.upsert(
        chunk_id="chunk-retired",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-retired",
        text="retired only secret",
    )
    full_text.upsert(
        chunk_id="chunk-alpha-current",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-current",
        text="数据库 alpha current evidence",
    )
    full_text.upsert(
        chunk_id="chunk-semantic-current",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-current",
        text="semantic vector current evidence",
    )
    full_text.upsert(
        chunk_id="chunk-other-current",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-current",
        text="other current evidence",
    )
    storage.vector_index.add(
        chunk_id="chunk-retired",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-retired",
        vector=[0.0, 1.0, 0.0],
    )
    storage.vector_index.add(
        chunk_id="chunk-alpha-current",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-current",
        vector=[1.0, 0.0, 0.0],
    )
    storage.vector_index.add(
        chunk_id="chunk-semantic-current",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-current",
        vector=[0.0, 1.0, 0.0],
    )
    storage.vector_index.add(
        chunk_id="chunk-other-current",
        knowledge_base_id=knowledge_base_id,
        index_version_id="index-current",
        vector=[0.0, 0.0, 1.0],
    )
    return knowledge_base_id
