import asyncio
from collections.abc import Sequence
from pathlib import Path

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
