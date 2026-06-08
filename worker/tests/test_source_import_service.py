from pathlib import Path

from citemind_worker.knowledge_base_service import KnowledgeBaseService
from citemind_worker.source_import_service import (
    ParsedBlock,
    ParsedDocument,
    ParsedLocation,
    ParseFailure,
    SourceImportService,
)
from citemind_worker.storage import StorageRuntime


class FakeParser:
    def __init__(self, *, fail: bool = False, normalized_text: str | None = None) -> None:
        self.fail = fail
        self.normalized_text = normalized_text

    def parse_file(self, path: Path, source_type: str) -> ParsedDocument:
        if self.fail:
            raise ParseFailure("fake parser failed")
        base_text = self.normalized_text or f"{source_type} parsed text"
        locations = {
            "pdf": ParsedLocation(
                page_number=2,
                bounding_box={"x": 10, "y": 20, "width": 100, "height": 30},
                heading_path=["第一章", "PDF"],
            ),
            "docx": ParsedLocation(heading_path=["标题", "段落"], anchor="p-1"),
            "image": ParsedLocation(
                anchor="ocr-1",
                ocr_regions=[
                    {"boundingBox": {"x": 1, "y": 2, "width": 3, "height": 4}},
                ],
            ),
        }
        return ParsedDocument(
            parser="fake-docling",
            parser_version="test",
            source_type=source_type,
            original_text=base_text,
            normalized_text=base_text,
            blocks=[
                ParsedBlock(
                    original_text=base_text,
                    normalized_text=base_text,
                    location=locations[source_type],
                )
            ],
        )

    def parse_web(self, url: str, snapshot_path: Path) -> ParsedDocument:
        snapshot_path.write_text(
            "<html><body><p>web parsed text</p></body></html>", encoding="utf-8"
        )
        return ParsedDocument(
            parser="fake-web",
            parser_version="test",
            source_type="web",
            original_text="web parsed text",
            normalized_text="web parsed text",
            blocks=[
                ParsedBlock(
                    original_text="web parsed text",
                    normalized_text="web parsed text",
                    location=ParsedLocation(heading_path=["网页标题"], anchor="block-1"),
                )
            ],
            snapshot_text=snapshot_path.read_text(encoding="utf-8"),
        )


def test_imports_pdf_docx_image_and_web_with_parse_artifacts(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("导入测试")["id"]
    assert isinstance(knowledge_base_id, str)
    service = SourceImportService(storage, parser=FakeParser())
    files = {
        "pdf": tmp_path / "sample.pdf",
        "docx": tmp_path / "sample.docx",
        "image": tmp_path / "sample.png",
    }
    for source_type, path in files.items():
        path.write_text(f"{source_type} raw", encoding="utf-8")
        service.import_file(knowledge_base_id, str(path))
    service.import_web(knowledge_base_id, "https://example.com/article")

    checks = service.parse_checks(knowledge_base_id)
    items = checks["items"]
    assert checks["summary"]["success"] == 4
    assert len(items) == 4

    by_type = {item["sourceType"]: item for item in items}
    pdf_artifact = Path(by_type["pdf"]["parseArtifactPath"]).read_text(encoding="utf-8")
    docx_artifact = Path(by_type["docx"]["parseArtifactPath"]).read_text(encoding="utf-8")
    image_artifact = Path(by_type["image"]["parseArtifactPath"]).read_text(encoding="utf-8")
    web_item = by_type["web"]

    assert '"pageNumber": 2' in pdf_artifact
    assert '"boundingBox"' in pdf_artifact
    assert '"anchor": "p-1"' in docx_artifact
    assert '"ocrRegions"' in image_artifact
    assert Path(web_item["snapshotPath"]).exists()

    with storage.database.connect() as connection:
        rows = connection.execute("SELECT status FROM sources").fetchall()
    assert {str(row["status"]) for row in rows} == {"processing"}


def test_import_marks_duplicate_content_without_indexing(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("重复测试")["id"]
    assert isinstance(knowledge_base_id, str)
    service = SourceImportService(storage, parser=FakeParser(normalized_text="same content"))
    first = tmp_path / "first.pdf"
    second = tmp_path / "second.pdf"
    first.write_text("raw one", encoding="utf-8")
    second.write_text("raw two", encoding="utf-8")

    service.import_file(knowledge_base_id, str(first))
    service.import_file(knowledge_base_id, str(second))
    checks = service.parse_checks(knowledge_base_id)

    assert checks["summary"]["duplicate"] == 1
    duplicate = next(item for item in checks["items"] if item["status"] == "duplicate")
    assert duplicate["duplicateOfSourceId"] is not None
    assert duplicate["sourceStatus"] == "duplicate"


def test_import_failure_is_visible_in_parse_checks(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("失败测试")["id"]
    assert isinstance(knowledge_base_id, str)
    service = SourceImportService(storage, parser=FakeParser(fail=True))
    source_file = tmp_path / "broken.pdf"
    source_file.write_text("raw", encoding="utf-8")

    result = service.import_file(knowledge_base_id, str(source_file))
    checks = service.parse_checks(knowledge_base_id)

    assert result["parseCheck"]["status"] == "failed"
    assert checks["summary"]["failed"] == 1
    assert checks["items"][0]["errorMessage"] == "fake parser failed"
