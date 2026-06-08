import json
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Protocol

from citemind_worker.ark_gateway import ArkModelGateway
from citemind_worker.model_catalog import DEFAULT_ARK_BASE_URL, DEFAULT_EMBEDDING_MODEL
from citemind_worker.storage import StorageRuntime
from citemind_worker.storage.full_text import FullTextIndex, FullTextResult, tokenize_for_search
from citemind_worker.storage.vector_index import VectorResult

RRF_K = 60
DEFAULT_RESULT_LIMIT = 8
DEFAULT_CANDIDATE_LIMIT = 24
CONTEXT_SNIPPET_CHARS = 700


class Embedder(Protocol):
    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        pass


@dataclass(frozen=True, slots=True)
class CurrentIndex:
    id: str
    embedding_provider: str
    embedding_model: str
    embedding_dimension: int
    chunking_version: str
    parser_version: str
    created_at: str
    chunk_count: int


@dataclass(frozen=True, slots=True)
class ChunkRecord:
    chunk_id: str
    source_id: str
    source_version_id: str
    source_type: str
    display_name: str
    uri: str | None
    page_number: int | None
    bounding_box: dict[str, object] | None
    heading_path: list[str]
    anchor: str | None
    original_text: str
    normalized_text: str
    content_hash: str


@dataclass(slots=True)
class RetrievalAccumulator:
    chunk_id: str
    keyword_rank: int | None = None
    keyword_bm25: float | None = None
    semantic_rank: int | None = None
    semantic_distance: float | None = None
    rrf_score: float = 0.0
    matched_by: set[str] = field(default_factory=set)


class HybridRetrievalService:
    def __init__(
        self,
        storage: StorageRuntime,
        *,
        full_text: FullTextIndex | None = None,
        embedder: Embedder | None = None,
    ) -> None:
        self.storage = storage
        self.full_text = full_text or FullTextIndex(storage.database)
        self.embedder = embedder

    async def retrieve(
        self,
        knowledge_base_id: str,
        query: str,
        *,
        api_key: str | None = None,
        base_url: str = DEFAULT_ARK_BASE_URL,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
        limit: int = DEFAULT_RESULT_LIMIT,
        candidate_limit: int = DEFAULT_CANDIDATE_LIMIT,
        rerank_model_version: str | None = None,
    ) -> dict[str, object]:
        normalized_query = _normalize_query(query)
        if limit <= 0 or limit > 50:
            raise ValueError("limit 必须在 1 到 50 之间")
        if candidate_limit <= 0 or candidate_limit > 200:
            raise ValueError("candidateLimit 必须在 1 到 200 之间")

        current_index = self._current_index(knowledge_base_id)
        keyword_results = self.full_text.search(
            knowledge_base_id=knowledge_base_id,
            index_version_id=current_index.id,
            query=normalized_query,
            limit=candidate_limit,
        )
        vector_results = await self._semantic_search(
            knowledge_base_id=knowledge_base_id,
            index_version_id=current_index.id,
            query=normalized_query,
            api_key=api_key,
            base_url=base_url,
            embedding_model=embedding_model,
            limit=candidate_limit,
        )
        accumulators = _merge_results(keyword_results, vector_results)
        ranked = sorted(
            accumulators.values(),
            key=lambda item: (
                -item.rrf_score,
                item.semantic_rank if item.semantic_rank is not None else candidate_limit + 1,
                item.keyword_rank if item.keyword_rank is not None else candidate_limit + 1,
            ),
        )[:limit]
        chunks = self._chunks_by_id(
            knowledge_base_id=knowledge_base_id,
            index_version_id=current_index.id,
            chunk_ids=[item.chunk_id for item in ranked],
        )
        query_tokens = _query_tokens(normalized_query)
        results = [
            _result_payload(
                chunk=chunks[item.chunk_id],
                accumulator=item,
                fused_rank=rank,
                query_tokens=query_tokens,
            )
            for rank, item in enumerate(ranked, start=1)
            if item.chunk_id in chunks
        ]

        return {
            "knowledgeBaseId": knowledge_base_id,
            "query": normalized_query,
            "indexVersion": _index_payload(current_index),
            "limits": {
                "resultLimit": limit,
                "candidateLimit": candidate_limit,
            },
            "retrieval": {
                "keywordCandidateCount": len(keyword_results),
                "semanticCandidateCount": len(vector_results),
                "mergedCandidateCount": len(accumulators),
                "fusion": "reciprocal_rank_fusion",
                "rrfK": RRF_K,
            },
            "rerank": {
                "available": False,
                "applied": False,
                "modelVersion": rerank_model_version,
            },
            "results": results,
            "context": _context_payload(results),
        }

    def _current_index(self, knowledge_base_id: str) -> CurrentIndex:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                """
                SELECT
                    iv.id,
                    iv.embedding_provider,
                    iv.embedding_model,
                    iv.embedding_dimension,
                    iv.chunking_version,
                    iv.parser_version,
                    iv.created_at,
                    (
                        SELECT COUNT(*)
                        FROM chunks c
                        WHERE c.index_version_id = iv.id
                    ) AS chunk_count
                FROM index_versions iv
                WHERE iv.knowledge_base_id = ?
                  AND iv.status = 'ready'
                  AND iv.is_current = 1
                ORDER BY iv.created_at DESC
                LIMIT 1
                """,
                (knowledge_base_id,),
            ).fetchone()
        if row is None:
            raise ValueError("当前知识库没有可检索的索引")
        return CurrentIndex(
            id=str(row["id"]),
            embedding_provider=str(row["embedding_provider"]),
            embedding_model=str(row["embedding_model"]),
            embedding_dimension=int(row["embedding_dimension"]),
            chunking_version=str(row["chunking_version"]),
            parser_version=str(row["parser_version"]),
            created_at=str(row["created_at"]),
            chunk_count=int(row["chunk_count"]),
        )

    async def _semantic_search(
        self,
        *,
        knowledge_base_id: str,
        index_version_id: str,
        query: str,
        api_key: str | None,
        base_url: str,
        embedding_model: str,
        limit: int,
    ) -> list[VectorResult]:
        embedder = self.embedder
        if embedder is None:
            if not api_key:
                raise ValueError("尚未配置 Ark API Key，无法执行向量检索")
            embedder = ArkModelGateway(
                api_key,
                base_url=base_url,
                embedding_model=embedding_model,
            )
        vectors = await embedder.embed([query])
        if len(vectors) != 1:
            raise ValueError("Embedding 返回数量与查询数量不一致")
        return self.storage.vector_index.search(
            knowledge_base_id=knowledge_base_id,
            index_version_id=index_version_id,
            vector=vectors[0],
            limit=limit,
        )

    def _chunks_by_id(
        self,
        *,
        knowledge_base_id: str,
        index_version_id: str,
        chunk_ids: Sequence[str],
    ) -> dict[str, ChunkRecord]:
        if not chunk_ids:
            return {}
        placeholders = ",".join("?" for _ in chunk_ids)
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
                    s.source_type,
                    s.display_name,
                    s.uri
                FROM chunks c
                JOIN source_versions sv ON sv.id = c.source_version_id
                JOIN sources s ON s.id = sv.source_id
                WHERE c.knowledge_base_id = ?
                  AND c.index_version_id = ?
                  AND c.id IN ({placeholders})
                """,
                (knowledge_base_id, index_version_id, *chunk_ids),
            ).fetchall()
        return {
            str(row["chunk_id"]): ChunkRecord(
                chunk_id=str(row["chunk_id"]),
                source_id=str(row["source_id"]),
                source_version_id=str(row["source_version_id"]),
                source_type=str(row["source_type"]),
                display_name=str(row["display_name"]),
                uri=str(row["uri"]) if row["uri"] is not None else None,
                page_number=int(row["page_number"]) if row["page_number"] is not None else None,
                bounding_box=_json_object(row["bounding_box_json"]),
                heading_path=_json_string_list(row["heading_path_json"]),
                anchor=str(row["anchor"]) if row["anchor"] is not None else None,
                original_text=str(row["original_text"]),
                normalized_text=str(row["normalized_text"]),
                content_hash=str(row["content_hash"]),
            )
            for row in rows
        }


def _merge_results(
    keyword_results: Sequence[FullTextResult],
    vector_results: Sequence[VectorResult],
) -> dict[str, RetrievalAccumulator]:
    merged: dict[str, RetrievalAccumulator] = {}
    for rank, keyword_result in enumerate(keyword_results, start=1):
        item = merged.setdefault(
            keyword_result.chunk_id,
            RetrievalAccumulator(keyword_result.chunk_id),
        )
        item.keyword_rank = rank
        item.keyword_bm25 = keyword_result.rank
        item.rrf_score += _rrf(rank)
        item.matched_by.add("keyword")
    for rank, vector_result in enumerate(vector_results, start=1):
        item = merged.setdefault(
            vector_result.chunk_id,
            RetrievalAccumulator(vector_result.chunk_id),
        )
        item.semantic_rank = rank
        item.semantic_distance = vector_result.distance
        item.rrf_score += _rrf(rank)
        item.matched_by.add("semantic")
    return merged


def _result_payload(
    *,
    chunk: ChunkRecord,
    accumulator: RetrievalAccumulator,
    fused_rank: int,
    query_tokens: Sequence[str],
) -> dict[str, object]:
    keyword_hits = _keyword_hits(chunk.normalized_text, query_tokens)
    semantic_score = _semantic_score(accumulator.semantic_distance)
    keyword_score = _keyword_score(accumulator.keyword_bm25)
    return {
        "chunkId": chunk.chunk_id,
        "source": {
            "id": chunk.source_id,
            "versionId": chunk.source_version_id,
            "type": chunk.source_type,
            "displayName": chunk.display_name,
            "uri": chunk.uri,
        },
        "location": {
            "pageNumber": chunk.page_number,
            "boundingBox": chunk.bounding_box,
            "headingPath": chunk.heading_path,
            "anchor": chunk.anchor,
        },
        "text": {
            "original": chunk.original_text,
            "normalized": chunk.normalized_text,
            "preview": _preview(chunk.normalized_text),
            "contentHash": chunk.content_hash,
        },
        "match": {
            "matchedBy": sorted(accumulator.matched_by),
            "keywordHits": keyword_hits,
            "hasKeywordHit": bool(keyword_hits) or accumulator.keyword_rank is not None,
            "hasSemanticMatch": accumulator.semantic_rank is not None,
        },
        "scores": {
            "keywordBm25": accumulator.keyword_bm25,
            "keywordScore": keyword_score,
            "semanticDistance": accumulator.semantic_distance,
            "semanticScore": semantic_score,
            "fusedScore": accumulator.rrf_score,
        },
        "ranks": {
            "keyword": accumulator.keyword_rank,
            "semantic": accumulator.semantic_rank,
            "fused": fused_rank,
        },
        "explanation": _explanation(accumulator, keyword_hits),
    }


def _context_payload(results: Sequence[dict[str, object]]) -> dict[str, object]:
    chunks: list[dict[str, object]] = []
    text_blocks: list[str] = []
    for index, result in enumerate(results, start=1):
        chunk_id = str(result["chunkId"])
        text = result["text"]
        source = result["source"]
        location = result["location"]
        if (
            not isinstance(text, dict)
            or not isinstance(source, dict)
            or not isinstance(location, dict)
        ):
            continue
        context_text = _truncate(str(text["normalized"]), CONTEXT_SNIPPET_CHARS)
        label = f"[{index}] {source['displayName']}"
        chunks.append(
            {
                "chunkId": chunk_id,
                "label": label,
                "text": context_text,
                "source": source,
                "location": location,
            }
        )
        text_blocks.append(f"{label}\n定位：{_location_label(location)}\n{context_text}")
    return {
        "chunkCount": len(chunks),
        "chunks": chunks,
        "text": "\n\n".join(text_blocks),
    }


def _index_payload(index: CurrentIndex) -> dict[str, object]:
    return {
        "id": index.id,
        "embeddingProvider": index.embedding_provider,
        "embeddingModel": index.embedding_model,
        "embeddingDimension": index.embedding_dimension,
        "chunkingVersion": index.chunking_version,
        "parserVersion": index.parser_version,
        "status": "ready",
        "isCurrent": True,
        "createdAt": index.created_at,
        "chunkCount": index.chunk_count,
    }


def _explanation(
    accumulator: RetrievalAccumulator,
    keyword_hits: Sequence[str],
) -> dict[str, object]:
    parts: list[str] = []
    if accumulator.keyword_rank is not None:
        hit_text = "、".join(keyword_hits) if keyword_hits else "FTS5 命中"
        parts.append(f"关键词检索第 {accumulator.keyword_rank} 名，命中：{hit_text}")
    if accumulator.semantic_rank is not None:
        parts.append(
            f"向量检索第 {accumulator.semantic_rank} 名，距离 {accumulator.semantic_distance:.6f}"
            if accumulator.semantic_distance is not None
            else f"向量检索第 {accumulator.semantic_rank} 名"
        )
    parts.append(f"RRF 融合分 {accumulator.rrf_score:.6f}")
    return {
        "summary": "；".join(parts),
        "fusion": "reciprocal_rank_fusion",
        "keyword": {
            "matched": accumulator.keyword_rank is not None,
            "rank": accumulator.keyword_rank,
            "bm25": accumulator.keyword_bm25,
            "hits": list(keyword_hits),
        },
        "semantic": {
            "matched": accumulator.semantic_rank is not None,
            "rank": accumulator.semantic_rank,
            "distance": accumulator.semantic_distance,
            "relevance": _semantic_score(accumulator.semantic_distance),
        },
    }


def _location_label(location: dict[str, object]) -> str:
    parts: list[str] = []
    page_number = location.get("pageNumber")
    if isinstance(page_number, int):
        parts.append(f"第 {page_number} 页")
    heading_path = location.get("headingPath")
    if isinstance(heading_path, list) and heading_path:
        parts.append(" > ".join(str(item) for item in heading_path))
    anchor = location.get("anchor")
    if isinstance(anchor, str) and anchor:
        parts.append(anchor)
    return " / ".join(parts) if parts else "无结构定位"


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
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, str)]


def _keyword_hits(text: str, query_tokens: Sequence[str]) -> list[str]:
    text_tokens = set(tokenize_for_search(text).split())
    lower_text = text.lower()
    hits: list[str] = []
    for token in query_tokens:
        if token in text_tokens or token.lower() in lower_text:
            hits.append(token)
    return list(dict.fromkeys(hits))


def _query_tokens(query: str) -> list[str]:
    return tokenize_for_search(query).split()


def _normalize_query(query: str) -> str:
    normalized = " ".join(query.split())
    if not normalized:
        raise ValueError("检索查询不能为空")
    return normalized


def _preview(text: str) -> str:
    return _truncate(text, 240)


def _truncate(text: str, limit: int) -> str:
    normalized = " ".join(text.split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[: limit - 1]}…"


def _semantic_score(distance: float | None) -> float | None:
    if distance is None:
        return None
    return 1.0 / (1.0 + max(0.0, distance))


def _keyword_score(bm25: float | None) -> float | None:
    if bm25 is None:
        return None
    return 1.0 / (1.0 + abs(bm25))


def _rrf(rank: int) -> float:
    return 1.0 / (RRF_K + rank)
