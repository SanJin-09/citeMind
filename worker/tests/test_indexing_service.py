import asyncio
from collections.abc import Sequence
from pathlib import Path

import pytest

from citemind_worker.indexing_service import CHUNKING_VERSION, IndexingService
from citemind_worker.knowledge_base_service import KnowledgeBaseService
from citemind_worker.source_import_service import (
    ParsedBlock,
    ParsedDocument,
    ParsedLocation,
    SourceImportService,
)
from citemind_worker.storage import StorageRuntime
from citemind_worker.storage.full_text import FullTextIndex


class FakeParser:
    def parse_file(self, path: Path, source_type: str) -> ParsedDocument:
        text = f"{source_type} alpha searchable evidence"
        location = {
            "pdf": ParsedLocation(
                page_number=3,
                bounding_box={"x": 1, "y": 2, "width": 3, "height": 4},
                heading_path=["PDF 标题"],
                anchor="pdf-block",
            ),
            "docx": ParsedLocation(heading_path=["DOCX 标题"], anchor="p-1"),
            "image": ParsedLocation(
                anchor="ocr-1",
                ocr_regions=[
                    {"boundingBox": {"x": 5, "y": 6, "width": 7, "height": 8}},
                ],
            ),
        }[source_type]
        return ParsedDocument(
            parser="fake-docling",
            parser_version="test",
            source_type=source_type,
            original_text=text,
            normalized_text=text,
            blocks=[
                ParsedBlock(
                    original_text=text,
                    normalized_text=text,
                    location=location,
                )
            ],
        )

    def parse_web(self, url: str, snapshot_path: Path) -> ParsedDocument:
        snapshot_path.write_text("<p>web alpha searchable evidence</p>", encoding="utf-8")
        text = "web alpha searchable evidence"
        return ParsedDocument(
            parser="fake-web",
            parser_version="test",
            source_type="web",
            original_text=text,
            normalized_text=text,
            blocks=[
                ParsedBlock(
                    original_text=text,
                    normalized_text=text,
                    location=ParsedLocation(heading_path=["网页"], anchor="block-1"),
                )
            ],
            snapshot_text=snapshot_path.read_text(encoding="utf-8"),
        )


class RawPdfParser:
    def parse_file(self, path: Path, source_type: str) -> ParsedDocument:
        text = "%PDF-1.7 raw legacy bytes"
        return ParsedDocument(
            parser="legacy-text-fallback",
            parser_version="test",
            source_type=source_type,
            original_text=text,
            normalized_text=text,
            blocks=[
                ParsedBlock(
                    original_text=text,
                    normalized_text=text,
                    location=ParsedLocation(
                        page_number=1,
                        bounding_box={"x": 0, "y": 0, "width": 1, "height": 1},
                    ),
                )
            ],
        )

    def parse_web(self, url: str, snapshot_path: Path) -> ParsedDocument:
        raise NotImplementedError


class FakeEmbedder:
    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for text in texts:
            if text.startswith("pdf"):
                vectors.append([1.0, 0.0, 0.0])
            elif text.startswith("docx"):
                vectors.append([0.0, 1.0, 0.0])
            elif text.startswith("image"):
                vectors.append([0.0, 0.0, 1.0])
            else:
                vectors.append([0.5, 0.5, 0.0])
        return vectors


class FailingEmbedder:
    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        raise RuntimeError("embedding failed")


def test_build_index_for_pdf_docx_image_and_web(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("索引测试")["id"]
    assert isinstance(knowledge_base_id, str)
    importer = SourceImportService(storage, parser=FakeParser())

    for suffix in ("pdf", "docx", "png"):
        source_file = tmp_path / f"sample.{suffix}"
        source_file.write_text(f"{suffix} raw", encoding="utf-8")
        importer.import_file(knowledge_base_id, str(source_file))
    importer.import_web(knowledge_base_id, "https://example.com/article")

    result = asyncio.run(
        IndexingService(storage, embedder=FakeEmbedder()).build_index(knowledge_base_id)
    )

    assert result["ready"] is True
    index_version = result["indexVersion"]
    assert index_version["chunkingVersion"] == CHUNKING_VERSION
    assert index_version["chunkCount"] == 4

    with storage.database.connect() as connection:
        rows = connection.execute(
            """
            SELECT page_number, bounding_box_json, heading_path_json, anchor
            FROM chunks
            WHERE index_version_id = ?
            ORDER BY created_at
            """,
            (index_version["id"],),
        ).fetchall()
        source_statuses = {
            str(row["status"]) for row in connection.execute("SELECT status FROM sources")
        }
        version_statuses = {
            str(row["status"]) for row in connection.execute("SELECT status FROM source_versions")
        }

    assert len(rows) == 4
    assert any(row["page_number"] == 3 and row["bounding_box_json"] for row in rows)
    assert sum(1 for row in rows if row["bounding_box_json"]) >= 2
    assert any("DOCX 标题" in str(row["heading_path_json"]) for row in rows)
    assert any(row["anchor"] == "block-1" for row in rows)
    assert source_statuses == {"ready"}
    assert version_statuses == {"ready"}

    fts_results = FullTextIndex(storage.database).search(
        knowledge_base_id=knowledge_base_id,
        index_version_id=str(index_version["id"]),
        query="alpha searchable",
    )
    vector_results = storage.vector_index.search(
        knowledge_base_id=knowledge_base_id,
        index_version_id=str(index_version["id"]),
        vector=[1.0, 0.0, 0.0],
        limit=1,
    )

    assert fts_results
    assert vector_results


def test_completed_index_survives_storage_restart(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("重启测试")["id"]
    assert isinstance(knowledge_base_id, str)
    source_file = tmp_path / "sample.pdf"
    source_file.write_text("pdf raw", encoding="utf-8")
    SourceImportService(storage, parser=FakeParser()).import_file(
        knowledge_base_id,
        str(source_file),
    )
    result = asyncio.run(
        IndexingService(storage, embedder=FakeEmbedder()).build_index(knowledge_base_id)
    )
    index_version_id = str(result["indexVersion"]["id"])

    reopened = StorageRuntime(tmp_path, vector_dimension=3)
    reopened.initialize()

    assert FullTextIndex(reopened.database).search(
        knowledge_base_id=knowledge_base_id,
        index_version_id=index_version_id,
        query="pdf alpha",
    )
    assert reopened.vector_index.search(
        knowledge_base_id=knowledge_base_id,
        index_version_id=index_version_id,
        vector=[1.0, 0.0, 0.0],
        limit=1,
    )


def test_build_index_skips_legacy_raw_pdf_artifacts(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("坏 PDF 跳过测试")["id"]
    assert isinstance(knowledge_base_id, str)

    raw_file = tmp_path / "legacy.pdf"
    raw_file.write_text("legacy raw", encoding="utf-8")
    SourceImportService(storage, parser=RawPdfParser()).import_file(
        knowledge_base_id,
        str(raw_file),
    )
    good_file = tmp_path / "good.pdf"
    good_file.write_text("pdf raw", encoding="utf-8")
    SourceImportService(storage, parser=FakeParser()).import_file(
        knowledge_base_id,
        str(good_file),
    )

    result = asyncio.run(
        IndexingService(storage, embedder=FakeEmbedder()).build_index(knowledge_base_id)
    )

    assert result["indexVersion"]["chunkCount"] == 1
    with storage.database.connect() as connection:
        rows = connection.execute("SELECT normalized_text FROM chunks").fetchall()
    assert [str(row["normalized_text"]) for row in rows] == ["pdf alpha searchable evidence"]


def test_delete_and_rebuild_index_preserves_sources_and_parse_artifacts(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("索引重构测试")["id"]
    assert isinstance(knowledge_base_id, str)
    source_file = tmp_path / "sample.pdf"
    source_file.write_text("pdf raw", encoding="utf-8")
    importer = SourceImportService(storage, parser=FakeParser())
    imported = importer.import_file(knowledge_base_id, str(source_file))
    artifact_path = Path(str(imported["parseCheck"]["parseArtifactPath"]))
    indexer = IndexingService(storage, embedder=FakeEmbedder())

    built = asyncio.run(indexer.build_index(knowledge_base_id))
    old_index_id = str(built["indexVersion"]["id"])
    deleted = indexer.delete_indexes(knowledge_base_id)

    assert deleted["ready"] is False
    assert deleted["deletedIndexCount"] == 1
    assert deleted["deletedChunkCount"] == 1
    assert artifact_path.exists()
    with storage.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM sources").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0] == 0
        assert connection.execute("SELECT status FROM sources").fetchone()[0] == "processing"
        assert connection.execute("SELECT status FROM source_versions").fetchone()[0] == "parsed"
    assert (
        storage.vector_index.search(
            knowledge_base_id=knowledge_base_id,
            index_version_id=old_index_id,
            vector=[1.0, 0.0, 0.0],
            limit=1,
        )
        == []
    )

    rebuilt = asyncio.run(indexer.rebuild_index(knowledge_base_id))

    assert rebuilt["ready"] is True
    assert rebuilt["indexVersion"]["chunkCount"] == 1
    assert rebuilt["indexVersion"]["id"] != old_index_id


def test_delete_source_cleans_files_chunks_fts_and_vectors(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("来源删除测试")["id"]
    assert isinstance(knowledge_base_id, str)
    source_file = tmp_path / "sample.pdf"
    source_file.write_text("pdf raw", encoding="utf-8")
    importer = SourceImportService(storage, parser=FakeParser())
    imported = importer.import_file(knowledge_base_id, str(source_file))
    source_id = str(imported["source"]["sourceId"])
    original_path = Path(str(imported["parseCheck"]["originalPath"]))
    artifact_path = Path(str(imported["parseCheck"]["parseArtifactPath"]))
    remaining_file = tmp_path / "remaining.docx"
    remaining_file.write_text("docx raw", encoding="utf-8")
    importer.import_file(knowledge_base_id, str(remaining_file))
    indexer = IndexingService(storage, embedder=FakeEmbedder())
    built = asyncio.run(indexer.build_index(knowledge_base_id))
    with storage.database.connect() as connection:
        deleted_chunk_id = str(
            connection.execute(
                """
                SELECT chunks.id
                FROM chunks
                JOIN source_versions ON source_versions.id = chunks.source_version_id
                WHERE source_versions.source_id = ?
                """,
                (source_id,),
            ).fetchone()[0]
        )
    index_version_id = str(built["indexVersion"]["id"])

    deleted = importer.delete_source(source_id)

    assert deleted["deleted"] is True
    assert deleted["deletedChunkCount"] == 1
    assert not original_path.exists()
    assert not artifact_path.exists()
    with storage.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM sources").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0] == 1
    status = indexer.index_status(knowledge_base_id)
    assert status["ready"] is True
    assert status["indexVersion"]["chunkCount"] == 1
    vector_results = storage.vector_index.search(
        knowledge_base_id=knowledge_base_id,
        index_version_id=index_version_id,
        vector=[1.0, 0.0, 0.0],
        limit=2,
    )
    assert vector_results
    assert all(result.chunk_id != deleted_chunk_id for result in vector_results)


def test_failed_rebuild_keeps_previous_index_available(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("安全重构测试")["id"]
    assert isinstance(knowledge_base_id, str)
    source_file = tmp_path / "sample.pdf"
    source_file.write_text("pdf raw", encoding="utf-8")
    SourceImportService(storage, parser=FakeParser()).import_file(
        knowledge_base_id,
        str(source_file),
    )
    built = asyncio.run(
        IndexingService(storage, embedder=FakeEmbedder()).build_index(knowledge_base_id)
    )

    with pytest.raises(RuntimeError, match="embedding failed"):
        asyncio.run(
            IndexingService(storage, embedder=FailingEmbedder()).rebuild_index(knowledge_base_id)
        )

    status = IndexingService(storage, embedder=FakeEmbedder()).index_status(knowledge_base_id)
    assert status["ready"] is True
    assert status["indexVersion"]["id"] == built["indexVersion"]["id"]
