import json
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from citemind_worker.ark_gateway import ArkModelGateway
from citemind_worker.background_job_service import BackgroundJobService
from citemind_worker.model_catalog import DEFAULT_ARK_BASE_URL, DEFAULT_EMBEDDING_MODEL
from citemind_worker.source_import_service import artifact_contains_raw_pdf_text
from citemind_worker.storage import StorageRuntime
from citemind_worker.storage.full_text import FullTextIndex

CHUNKING_VERSION = "citemind-structure-v1"
PARSER_VERSION = "citemind-parser-v1"
EMBEDDING_PROVIDER = "ark"
MAX_CHUNK_CHARS = 1200
CHUNK_OVERLAP_CHARS = 160
EMBEDDING_BATCH_SIZE = 16


class Embedder(Protocol):
    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        pass


@dataclass(frozen=True, slots=True)
class SourceVersionCandidate:
    source_id: str
    source_version_id: str
    source_type: str
    display_name: str
    parse_artifact_path: Path


@dataclass(frozen=True, slots=True)
class ChunkCandidate:
    id: str
    source_id: str
    source_version_id: str
    page_number: int | None
    bounding_box: dict[str, object] | None
    heading_path: list[str]
    anchor: str | None
    original_text: str
    normalized_text: str
    content_hash: str


class IndexingService:
    def __init__(
        self,
        storage: StorageRuntime,
        *,
        jobs: BackgroundJobService | None = None,
        full_text: FullTextIndex | None = None,
        embedder: Embedder | None = None,
    ) -> None:
        self.storage = storage
        self.jobs = jobs or BackgroundJobService(storage)
        self.full_text = full_text or FullTextIndex(storage.database)
        self.embedder = embedder

    async def build_index(
        self,
        knowledge_base_id: str,
        *,
        api_key: str | None = None,
        base_url: str = DEFAULT_ARK_BASE_URL,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
    ) -> dict[str, object]:
        self._ensure_knowledge_base(knowledge_base_id)
        candidates = self._source_version_candidates(knowledge_base_id)
        if not candidates:
            raise ValueError("当前知识库没有可索引的解析结果")

        job = self.jobs.create("index.build", knowledge_base_id)
        job_id = str(job["id"])
        index_version_id = f"index-{uuid4().hex}"
        self._create_building_index(
            index_version_id=index_version_id,
            knowledge_base_id=knowledge_base_id,
            embedding_model=embedding_model,
        )
        self.jobs.update_progress(
            job_id,
            status="running",
            progress=0.05,
            checkpoint=_stage_checkpoint(parse=1, ocr=1, embedding=0, index=0),
        )

        try:
            chunks = self._load_chunks(candidates)
            if not chunks:
                raise ValueError("解析结果中没有可索引文本块")
            vectors = await self._embed_chunks(
                chunks,
                api_key=api_key,
                base_url=base_url,
                embedding_model=embedding_model,
                job_id=job_id,
            )
            self._write_chunk_metadata(
                knowledge_base_id=knowledge_base_id,
                index_version_id=index_version_id,
                chunks=chunks,
            )
            self.jobs.update_progress(
                job_id,
                progress=0.82,
                checkpoint=_stage_checkpoint(parse=1, ocr=1, embedding=1, index=0.35),
            )
            self._write_vectors(
                knowledge_base_id=knowledge_base_id,
                index_version_id=index_version_id,
                chunks=chunks,
                vectors=vectors,
            )
            self._mark_ready(
                knowledge_base_id=knowledge_base_id,
                index_version_id=index_version_id,
                source_version_ids=[candidate.source_version_id for candidate in candidates],
            )
            self.jobs.update_progress(
                job_id,
                status="completed",
                checkpoint=_stage_checkpoint(parse=1, ocr=1, embedding=1, index=1),
            )
        except Exception as error:
            self._mark_failed(index_version_id)
            self.jobs.update_progress(job_id, status="failed", error_message=_public_error(error))
            raise

        return self.index_status(knowledge_base_id, index_version_id=index_version_id)

    def delete_indexes(self, knowledge_base_id: str) -> dict[str, object]:
        self._ensure_knowledge_base(knowledge_base_id)
        with self.storage.database.connect() as connection:
            index_version_ids = [
                str(row["id"])
                for row in connection.execute(
                    "SELECT id FROM index_versions WHERE knowledge_base_id = ?",
                    (knowledge_base_id,),
                ).fetchall()
            ]
            chunk_ids = [
                str(row["id"])
                for row in connection.execute(
                    "SELECT id FROM chunks WHERE knowledge_base_id = ?",
                    (knowledge_base_id,),
                ).fetchall()
            ]
            if chunk_ids:
                placeholders = ",".join("?" for _ in chunk_ids)
                connection.execute(
                    f"DELETE FROM answer_citations WHERE chunk_id IN ({placeholders})",
                    tuple(chunk_ids),
                )
                connection.execute(
                    f"DELETE FROM chunks_fts WHERE chunk_id IN ({placeholders})",
                    tuple(chunk_ids),
                )
                connection.execute(
                    f"DELETE FROM chunks WHERE id IN ({placeholders})",
                    tuple(chunk_ids),
                )
            connection.execute(
                """
                UPDATE source_versions
                SET status = 'parsed'
                WHERE status = 'ready'
                  AND source_id IN (
                      SELECT id FROM sources WHERE knowledge_base_id = ?
                  )
                """,
                (knowledge_base_id,),
            )
            connection.execute(
                """
                UPDATE sources
                SET status = 'processing',
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE knowledge_base_id = ?
                  AND status = 'ready'
                """,
                (knowledge_base_id,),
            )
            connection.execute(
                "DELETE FROM index_versions WHERE knowledge_base_id = ?",
                (knowledge_base_id,),
            )
            connection.execute(
                """
                UPDATE knowledge_bases
                SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (knowledge_base_id,),
            )
            connection.commit()

        self.storage.vector_index.delete_index_versions(index_version_ids)
        return {
            **self.index_status(knowledge_base_id),
            "deletedIndexCount": len(index_version_ids),
            "deletedChunkCount": len(chunk_ids),
        }

    async def rebuild_index(
        self,
        knowledge_base_id: str,
        *,
        api_key: str | None = None,
        base_url: str = DEFAULT_ARK_BASE_URL,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
    ) -> dict[str, object]:
        return await self.build_index(
            knowledge_base_id,
            api_key=api_key,
            base_url=base_url,
            embedding_model=embedding_model,
        )

    def index_status(
        self, knowledge_base_id: str, *, index_version_id: str | None = None
    ) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                """
                SELECT id, embedding_provider, embedding_model, embedding_dimension,
                       chunking_version, parser_version, status, is_current, created_at
                FROM index_versions
                WHERE knowledge_base_id = ?
                  AND (? IS NULL OR id = ?)
                ORDER BY is_current DESC, created_at DESC
                LIMIT 1
                """,
                (knowledge_base_id, index_version_id, index_version_id),
            ).fetchone()
            chunk_count = 0
            if row is not None:
                chunk_count = int(
                    connection.execute(
                        "SELECT COUNT(*) FROM chunks WHERE index_version_id = ?",
                        (str(row["id"]),),
                    ).fetchone()[0]
                )

        if row is None:
            return {"knowledgeBaseId": knowledge_base_id, "ready": False}
        return {
            "knowledgeBaseId": knowledge_base_id,
            "ready": str(row["status"]) == "ready",
            "indexVersion": {
                "id": str(row["id"]),
                "embeddingProvider": str(row["embedding_provider"]),
                "embeddingModel": str(row["embedding_model"]),
                "embeddingDimension": int(row["embedding_dimension"]),
                "chunkingVersion": str(row["chunking_version"]),
                "parserVersion": str(row["parser_version"]),
                "status": str(row["status"]),
                "isCurrent": bool(row["is_current"]),
                "createdAt": str(row["created_at"]),
                "chunkCount": chunk_count,
            },
        }

    def _source_version_candidates(self, knowledge_base_id: str) -> list[SourceVersionCandidate]:
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    s.id AS source_id,
                    s.source_type,
                    s.display_name,
                    sv.id AS source_version_id,
                    sv.parse_artifact_path
                FROM sources s
                JOIN source_versions sv ON sv.id = (
                    SELECT latest.id
                    FROM source_versions latest
                    WHERE latest.source_id = s.id
                    ORDER BY latest.version_number DESC
                    LIMIT 1
                )
                WHERE s.knowledge_base_id = ?
                  AND s.status IN ('processing', 'ready')
                  AND sv.status IN ('parsed', 'ready')
                  AND sv.parse_artifact_path IS NOT NULL
                ORDER BY s.created_at ASC
                """,
                (knowledge_base_id,),
            ).fetchall()
        return [
            SourceVersionCandidate(
                source_id=str(row["source_id"]),
                source_version_id=str(row["source_version_id"]),
                source_type=str(row["source_type"]),
                display_name=str(row["display_name"]),
                parse_artifact_path=Path(str(row["parse_artifact_path"])),
            )
            for row in rows
        ]

    def _load_chunks(self, candidates: Sequence[SourceVersionCandidate]) -> list[ChunkCandidate]:
        chunks: list[ChunkCandidate] = []
        for candidate in candidates:
            artifact = _read_artifact(candidate.parse_artifact_path)
            if artifact_contains_raw_pdf_text(candidate.source_type, artifact):
                continue
            raw_chunks = artifact.get("chunks")
            if not isinstance(raw_chunks, list):
                continue
            for block_index, raw_chunk in enumerate(raw_chunks):
                if not isinstance(raw_chunk, dict):
                    continue
                chunks.extend(_chunk_from_artifact(candidate, raw_chunk, block_index))
        return chunks

    async def _embed_chunks(
        self,
        chunks: Sequence[ChunkCandidate],
        *,
        api_key: str | None,
        base_url: str,
        embedding_model: str,
        job_id: str,
    ) -> list[list[float]]:
        embedder = self.embedder
        if embedder is None:
            if not api_key:
                raise ValueError("尚未配置 Ark API Key，无法调用 Embedding")
            embedder = ArkModelGateway(
                api_key,
                base_url=base_url,
                embedding_model=embedding_model,
            )

        vectors: list[list[float]] = []
        total = len(chunks)
        for start in range(0, total, EMBEDDING_BATCH_SIZE):
            batch = chunks[start : start + EMBEDDING_BATCH_SIZE]
            vectors.extend(await embedder.embed([chunk.normalized_text for chunk in batch]))
            embedding_progress = min(1.0, len(vectors) / total)
            self.jobs.update_progress(
                job_id,
                progress=0.2 + embedding_progress * 0.55,
                checkpoint=_stage_checkpoint(
                    parse=1,
                    ocr=1,
                    embedding=embedding_progress,
                    index=0,
                ),
            )
        return vectors

    def _write_chunk_metadata(
        self,
        *,
        knowledge_base_id: str,
        index_version_id: str,
        chunks: Sequence[ChunkCandidate],
    ) -> None:
        with self.storage.database.connect() as connection:
            for chunk in chunks:
                connection.execute(
                    """
                    INSERT INTO chunks(
                        id, knowledge_base_id, source_version_id, index_version_id,
                        page_number, bounding_box_json, heading_path_json, anchor,
                        original_text, normalized_text, content_hash
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        chunk.id,
                        knowledge_base_id,
                        chunk.source_version_id,
                        index_version_id,
                        chunk.page_number,
                        json.dumps(chunk.bounding_box, ensure_ascii=False)
                        if chunk.bounding_box
                        else None,
                        json.dumps(chunk.heading_path, ensure_ascii=False),
                        chunk.anchor,
                        chunk.original_text,
                        chunk.normalized_text,
                        chunk.content_hash,
                    ),
                )
            connection.commit()

        for chunk in chunks:
            self.full_text.upsert(
                chunk_id=chunk.id,
                knowledge_base_id=knowledge_base_id,
                index_version_id=index_version_id,
                text=chunk.normalized_text,
            )

    def _write_vectors(
        self,
        *,
        knowledge_base_id: str,
        index_version_id: str,
        chunks: Sequence[ChunkCandidate],
        vectors: Sequence[list[float]],
    ) -> None:
        if len(chunks) != len(vectors):
            raise ValueError("Embedding 返回数量与文本块数量不一致")
        for chunk, vector in zip(chunks, vectors, strict=True):
            self.storage.vector_index.add(
                chunk_id=chunk.id,
                knowledge_base_id=knowledge_base_id,
                index_version_id=index_version_id,
                vector=vector,
            )

    def _create_building_index(
        self,
        *,
        index_version_id: str,
        knowledge_base_id: str,
        embedding_model: str,
    ) -> None:
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO index_versions(
                    id, knowledge_base_id, embedding_provider, embedding_model,
                    embedding_dimension, chunking_version, parser_version, status, is_current
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 'building', 0)
                """,
                (
                    index_version_id,
                    knowledge_base_id,
                    EMBEDDING_PROVIDER,
                    embedding_model,
                    self.storage.vector_index.dimension,
                    CHUNKING_VERSION,
                    PARSER_VERSION,
                ),
            )
            connection.commit()

    def _mark_ready(
        self,
        *,
        knowledge_base_id: str,
        index_version_id: str,
        source_version_ids: Sequence[str],
    ) -> None:
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE index_versions
                SET is_current = 0,
                    status = CASE WHEN status = 'ready' THEN 'retired' ELSE status END
                WHERE knowledge_base_id = ?
                  AND id != ?
                  AND is_current = 1
                """,
                (knowledge_base_id, index_version_id),
            )
            connection.execute(
                """
                UPDATE index_versions
                SET status = 'ready',
                    is_current = 1
                WHERE id = ?
                """,
                (index_version_id,),
            )
            connection.executemany(
                """
                UPDATE source_versions
                SET status = 'ready'
                WHERE id = ?
                """,
                [(source_version_id,) for source_version_id in source_version_ids],
            )
            connection.execute(
                """
                UPDATE sources
                SET status = 'ready',
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id IN (
                    SELECT source_id
                    FROM source_versions
                    WHERE id IN ({placeholders})
                )
                """.format(placeholders=",".join("?" for _ in source_version_ids)),
                tuple(source_version_ids),
            )
            connection.commit()

    def _mark_failed(self, index_version_id: str) -> None:
        with self.storage.database.connect() as connection:
            connection.execute(
                "UPDATE index_versions SET status = 'failed', is_current = 0 WHERE id = ?",
                (index_version_id,),
            )
            connection.commit()

    def _ensure_knowledge_base(self, knowledge_base_id: str) -> None:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                "SELECT 1 FROM knowledge_bases WHERE id = ?",
                (knowledge_base_id,),
            ).fetchone()
        if row is None:
            raise ValueError("Knowledge base not found")


def _chunk_from_artifact(
    candidate: SourceVersionCandidate,
    raw_chunk: dict[object, object],
    block_index: int,
) -> list[ChunkCandidate]:
    original_text = _string(raw_chunk.get("originalText"))
    normalized_text = _normalize_text(_string(raw_chunk.get("normalizedText")) or original_text)
    if not normalized_text:
        return []
    parts = _split_text(normalized_text)
    original_parts = _split_text(original_text) if original_text else parts
    result: list[ChunkCandidate] = []
    for part_index, part in enumerate(parts):
        original = original_parts[min(part_index, len(original_parts) - 1)]
        anchor = _string(raw_chunk.get("anchor")) or f"block-{block_index + 1}"
        if len(parts) > 1:
            anchor = f"{anchor}#part-{part_index + 1}"
        result.append(
            ChunkCandidate(
                id=f"chunk-{uuid4().hex}",
                source_id=candidate.source_id,
                source_version_id=candidate.source_version_id,
                page_number=_optional_int(raw_chunk.get("pageNumber")),
                bounding_box=_optional_dict(raw_chunk.get("boundingBox"))
                or _ocr_region_bounding_box(raw_chunk.get("ocrRegions")),
                heading_path=_string_list(raw_chunk.get("headingPath")),
                anchor=anchor,
                original_text=original,
                normalized_text=part,
                content_hash=_content_hash(
                    candidate.source_version_id,
                    block_index,
                    part_index,
                    part,
                ),
            )
        )
    return result


def _split_text(text: str) -> list[str]:
    if len(text) <= MAX_CHUNK_CHARS:
        return [text]
    parts: list[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + MAX_CHUNK_CHARS)
        parts.append(text[start:end].strip())
        if end == len(text):
            break
        start = max(0, end - CHUNK_OVERLAP_CHARS)
    return [part for part in parts if part]


def _read_artifact(path: Path) -> dict[str, object]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"解析产物不可读取：{path}") from error
    if not isinstance(data, dict):
        raise ValueError(f"解析产物格式无效：{path}")
    return data


def _string(value: object) -> str:
    return value if isinstance(value, str) else ""


def _normalize_text(text: str) -> str:
    return " ".join(text.split())


def _optional_int(value: object) -> int | None:
    return value if isinstance(value, int) and value > 0 else None


def _optional_dict(value: object) -> dict[str, object] | None:
    return value if isinstance(value, dict) else None


def _ocr_region_bounding_box(value: object) -> dict[str, object] | None:
    if not isinstance(value, list) or not value:
        return None
    first = value[0]
    if not isinstance(first, dict):
        return None
    bounding_box = first.get("boundingBox")
    return bounding_box if isinstance(bounding_box, dict) else None


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _content_hash(
    source_version_id: str,
    block_index: int,
    part_index: int,
    text: str,
) -> str:
    import hashlib

    payload = f"{source_version_id}:{block_index}:{part_index}:{text}".encode()
    return hashlib.sha256(payload).hexdigest()


def _stage_checkpoint(
    *,
    parse: float,
    ocr: float,
    embedding: float,
    index: float,
) -> dict[str, object]:
    values = {
        "parse": ("解析", parse),
        "ocr": ("OCR", ocr),
        "embedding": ("Embedding", embedding),
        "index": ("索引", index),
    }
    return {
        "stages": [
            {
                "id": stage_id,
                "label": label,
                "status": "completed"
                if progress >= 1
                else "running"
                if progress > 0
                else "pending",
                "progress": progress,
            }
            for stage_id, (label, progress) in values.items()
        ]
    }


def _public_error(error: Exception) -> str:
    message = str(error).strip()
    return message or error.__class__.__name__
