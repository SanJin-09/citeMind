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


def write_text_pdf(path: Path, text: str) -> None:
    stream = f"BT /F1 24 Tf 100 700 Td ({text}) Tj ET".encode("latin-1")
    objects = [
        b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        (
            b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n"
        ),
        (
            b"4 0 obj\n<< /Length "
            + str(len(stream)).encode("ascii")
            + b" >>\nstream\n"
            + stream
            + b"\nendstream\nendobj\n"
        ),
        b"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    ]
    output = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for pdf_object in objects:
        offsets.append(len(output))
        output.extend(pdf_object)
    xref_offset = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        (
            f"trailer\n<< /Root 1 0 R /Size {len(objects) + 1} >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
    )
    path.write_bytes(bytes(output))


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


class VersionedWebParser(FakeParser):
    def __init__(self) -> None:
        super().__init__()
        self.version = 1

    def parse_web(self, url: str, snapshot_path: Path) -> ParsedDocument:
        return self.check_web(url, snapshot_path, etag=None, last_modified=None)

    def check_web(
        self,
        url: str,
        snapshot_path: Path,
        *,
        etag: str | None,
        last_modified: str | None,
    ) -> ParsedDocument:
        del url, etag, last_modified
        texts = ["shared evidence", "old evidence" if self.version == 1 else "new evidence"]
        snapshot_path.write_text("\n".join(texts), encoding="utf-8")
        return ParsedDocument(
            parser="fake-web",
            parser_version="test",
            source_type="web",
            original_text="\n\n".join(texts),
            normalized_text="\n\n".join(texts),
            blocks=[
                ParsedBlock(
                    original_text=text,
                    normalized_text=text,
                    location=ParsedLocation(anchor=f"block-{index + 1}"),
                )
                for index, text in enumerate(texts)
            ],
            snapshot_text=snapshot_path.read_text(encoding="utf-8"),
            etag=f'"v{self.version}"',
            last_modified=f"version-{self.version}",
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
    assert duplicate["duplicateKind"] == "content"
    assert duplicate["duplicateActions"] == ["skip", "keep", "link"]
    assert duplicate["chunkCount"] == 1
    assert duplicate["sourceStatus"] == "duplicate"


def test_duplicate_resolution_preserves_files_and_controls_index_eligibility(
    tmp_path: Path,
) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("重复决策测试")["id"]
    assert isinstance(knowledge_base_id, str)
    service = SourceImportService(storage, parser=FakeParser(normalized_text="same content"))
    source_file = tmp_path / "same.pdf"
    source_file.write_text("identical bytes", encoding="utf-8")
    service.import_file(knowledge_base_id, str(source_file))

    decisions: dict[str, str] = {}
    for action in ("skip", "keep", "link"):
        imported = service.import_file(knowledge_base_id, str(source_file))
        duplicate = imported["parseCheck"]
        assert duplicate["duplicateKind"] == "original"
        original_copy = Path(str(duplicate["originalPath"]))
        artifact = Path(str(duplicate["parseArtifactPath"]))

        resolved = service.resolve_duplicate(str(duplicate["sourceId"]), action)

        decisions[action] = str(resolved["parseCheck"]["sourceStatus"])
        assert resolved["parseCheck"]["duplicateResolution"] == action
        assert original_copy.exists()
        assert artifact.exists()

    assert decisions == {
        "skip": "skipped",
        "keep": "processing",
        "link": "linked",
    }
    with storage.database.connect() as connection:
        eligible = connection.execute(
            """
            SELECT COUNT(*)
            FROM sources s
            JOIN source_versions sv ON sv.source_id = s.id
            WHERE s.knowledge_base_id = ?
              AND s.status IN ('processing', 'ready')
              AND sv.status IN ('parsed', 'ready')
            """,
            (knowledge_base_id,),
        ).fetchone()[0]
    assert eligible == 2


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


def test_pdf_fallback_extracts_text_without_indexing_raw_pdf_bytes(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("PDF 兜底测试")["id"]
    assert isinstance(knowledge_base_id, str)
    source_file = tmp_path / "sample.pdf"
    write_text_pdf(source_file, "PDF alpha searchable text")

    result = SourceImportService(storage).import_file(knowledge_base_id, str(source_file))
    checks = SourceImportService(storage).parse_checks(knowledge_base_id)

    assert result["parseCheck"]["status"] == "success"
    assert checks["items"][0]["preview"] == "PDF alpha searchable text"
    artifact = Path(checks["items"][0]["parseArtifactPath"]).read_text(encoding="utf-8")
    assert '"parser": "pypdf-fallback"' in artifact
    assert '"boundingBox"' in artifact
    assert "%PDF-1." not in artifact


def test_pdf_fallback_failure_is_visible_instead_of_raw_pdf_preview(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("PDF 失败测试")["id"]
    assert isinstance(knowledge_base_id, str)
    source_file = tmp_path / "broken.pdf"
    source_file.write_bytes(b"%PDF-1.7\n3 0 obj\n<< /Broken true >>\n")

    result = SourceImportService(storage).import_file(knowledge_base_id, str(source_file))
    checks = SourceImportService(storage).parse_checks(knowledge_base_id)

    assert result["parseCheck"]["status"] == "failed"
    assert checks["summary"]["failed"] == 1
    assert not checks["items"][0]["preview"].startswith("%PDF-1.")
    assert "PDF 文本提取失败" in str(checks["items"][0]["errorMessage"])


def test_legacy_raw_pdf_duplicate_can_be_reimported(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("PDF 重导测试")["id"]
    assert isinstance(knowledge_base_id, str)
    source_file = tmp_path / "resume.pdf"
    write_text_pdf(source_file, "PDF alpha searchable text")

    legacy = SourceImportService(
        storage,
        parser=FakeParser(normalized_text="%PDF-1.7 raw legacy bytes"),
    ).import_file(knowledge_base_id, str(source_file))
    repaired = SourceImportService(storage).import_file(knowledge_base_id, str(source_file))
    checks = SourceImportService(storage).parse_checks(knowledge_base_id)

    assert legacy["parseCheck"]["status"] == "failed"
    assert repaired["parseCheck"]["status"] == "success"
    assert checks["summary"]["failed"] == 1
    assert checks["summary"]["success"] == 1
    assert not repaired["parseCheck"]["duplicateOfSourceId"]


def test_web_version_maintenance_preserves_current_until_user_accepts(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("网页版本测试")["id"]
    assert isinstance(knowledge_base_id, str)
    parser = VersionedWebParser()
    service = SourceImportService(storage, parser=parser)

    imported = service.import_web(knowledge_base_id, "https://example.com/article")
    source_id = str(imported["source"]["sourceId"])
    initial = service.source_versions(source_id)
    initial_version_id = str(initial["source"]["currentVersionId"])
    assert initial["versions"][0]["etag"] == '"v1"'

    parser.version = 2
    checked = service.check_web_update(source_id)
    pending_version_id = str(checked["pendingVersionId"])
    pending = service.source_versions(source_id)
    diff = service.source_version_diff(source_id, pending_version_id)

    assert checked["status"] == "changed"
    assert pending["source"]["currentVersionId"] == initial_version_id
    assert pending["versions"][0]["reviewStatus"] == "pending_review"
    assert pending["versions"][0]["changeSummary"]["unchangedBlocks"] == 1
    assert "-old evidence" in diff["diff"]
    assert "+new evidence" in diff["diff"]

    checked_again = service.check_web_update(source_id)
    assert checked_again["pendingVersionId"] == pending_version_id
    assert len(service.source_versions(source_id)["versions"]) == 2

    accepted = service.decide_source_version(source_id, pending_version_id, "accept")
    assert accepted["source"]["currentVersionId"] == pending_version_id
    assert accepted["versions"][0]["reviewStatus"] == "current"

    service.update_source_maintenance(
        source_id,
        replacement_source_id=None,
        review_at="2030-01-01T00:00:00.000Z",
        expiry_status="active",
    )
    suggested = service.suggest_source_status(
        source_id,
        suggestion="expired",
        reason="正文日期可能已经过期",
        confidence=0.8,
    )
    assert suggested["source"]["modelSuggestion"]["status"] == "pending_confirmation"
    decided = service.decide_source_suggestion(source_id, "accept")
    assert decided["source"]["expiryStatus"] == "expired"
