import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import cast

from citemind_worker.background_job_service import BackgroundJobService
from citemind_worker.conversation_service import ConversationService
from citemind_worker.indexing_service import IndexingService
from citemind_worker.knowledge_base_service import KnowledgeBaseService
from citemind_worker.quality_metrics import quality_summary
from citemind_worker.retrieval_service import HybridRetrievalService
from citemind_worker.source_import_service import (
    ParsedBlock,
    ParsedDocument,
    ParsedLocation,
    SourceImportService,
)
from citemind_worker.storage import StorageRuntime

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "quality_regression.json"


class RegressionParser:
    def __init__(self) -> None:
        self.fixtures = cast(
            dict[str, dict[str, object]],
            json.loads(FIXTURE_PATH.read_text(encoding="utf-8")),
        )

    def parse_file(self, path: Path, source_type: str) -> ParsedDocument:
        return self._document(path.name, source_type)

    def parse_web(self, url: str, snapshot_path: Path) -> ParsedDocument:
        snapshot_path.write_text(
            f"<html><body><p>{url}</p></body></html>",
            encoding="utf-8",
        )
        return self._document(
            "web",
            "web",
            snapshot_text=snapshot_path.read_text(encoding="utf-8"),
        )

    def _document(
        self,
        name: str,
        source_type: str,
        *,
        snapshot_text: str | None = None,
    ) -> ParsedDocument:
        fixture = self.fixtures[name]
        assert fixture["sourceType"] == source_type
        raw_blocks = cast(list[dict[str, object]], fixture["blocks"])
        blocks = [self._block(raw) for raw in raw_blocks]
        text = "\n\n".join(block.normalized_text for block in blocks)
        return ParsedDocument(
            parser="fixed-regression-parser",
            parser_version="quality-v1",
            source_type=source_type,
            original_text=text,
            normalized_text=text,
            blocks=blocks,
            snapshot_text=snapshot_text,
        )

    def _block(self, raw: dict[str, object]) -> ParsedBlock:
        text = str(raw["text"])
        location = cast(dict[str, object], raw["location"])
        return ParsedBlock(
            original_text=text,
            normalized_text=text,
            location=ParsedLocation(
                page_number=cast(int | None, location.get("pageNumber")),
                bounding_box=cast(dict[str, float] | None, location.get("boundingBox")),
                heading_path=cast(list[str], location.get("headingPath", [])),
                anchor=cast(str | None, location.get("anchor")),
                ocr_regions=cast(list[dict[str, object]], location.get("ocrRegions", [])),
            ),
        )


class RegressionEmbedder:
    def __init__(self) -> None:
        self.last_embedding_stats: dict[str, int] = {}

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        self.last_embedding_stats = {
            "batches": 1,
            "calls": 1,
            "texts": len(texts),
            "retries": 0,
        }
        return [[1.0, 0.0, 0.0] if "数据库" in text else [0.0, 1.0, 0.0] for text in texts]


class RegressionAnswerGateway:
    def __init__(self, chunk_id: str) -> None:
        self.chunk_id = chunk_id

    async def generate_structured(
        self,
        request: dict[str, object],
        schema: dict[str, object],
    ) -> dict[str, object]:
        del request, schema
        return {
            "evidence_sufficient": True,
            "refusal_reason": None,
            "paragraphs": [
                {
                    "text": "数据库使用事务日志支持关键业务数据恢复。",
                    "evidence_chunk_ids": [self.chunk_id],
                }
            ],
        }

    def stream_answer(self, request: dict[str, object]) -> AsyncIterator[dict[str, object]]:
        del request

        async def iterator() -> AsyncIterator[dict[str, object]]:
            if False:
                yield {}

        return iterator()


def test_fixed_quality_regression_workflow(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path / "runtime", vector_dimension=3)
    storage.initialize()
    knowledge_base_id = KnowledgeBaseService(storage).create("固定质量回归")["id"]
    assert isinstance(knowledge_base_id, str)
    importer = SourceImportService(storage, parser=RegressionParser())

    for file_name in (
        "regression-page.pdf",
        "regression-table.docx",
        "regression-ocr.png",
        "regression-duplicate.pdf",
    ):
        path = tmp_path / file_name
        path.write_text(f"fixed raw input: {file_name}", encoding="utf-8")
        importer.import_file(knowledge_base_id, str(path))
    importer.import_web(knowledge_base_id, "https://example.com/quality-regression")

    checks = importer.parse_checks(knowledge_base_id)
    assert checks["summary"]["success"] == 4
    assert checks["summary"]["duplicate"] == 1
    artifacts = {
        str(item["sourceType"]): json.loads(
            Path(str(item["parseArtifactPath"])).read_text(encoding="utf-8")
        )
        for item in cast(list[dict[str, object]], checks["items"])
        if item["status"] != "duplicate"
    }
    assert artifacts["pdf"]["chunks"][0]["pageNumber"] == 7
    assert "组件 | 目标延迟" in artifacts["docx"]["normalizedText"]
    assert artifacts["image"]["chunks"][0]["ocrRegions"]
    assert "中文网页资料" in artifacts["web"]["normalizedText"]

    embedder = RegressionEmbedder()
    indexer = IndexingService(storage, embedder=embedder)
    built = asyncio.run(indexer.build_index(knowledge_base_id, embedding_model="fixed-embedding"))
    assert built["ready"] is True

    retrieval = HybridRetrievalService(storage, embedder=embedder)
    retrieved = asyncio.run(retrieval.retrieve(knowledge_base_id, "数据库如何恢复数据？"))
    results = cast(list[dict[str, object]], retrieved["results"])
    assert results
    evidence_chunk_id = str(results[0]["chunkId"])

    answered = asyncio.run(
        ConversationService(
            storage,
            retrieval=retrieval,
            gateway_factory=lambda _key, _base, _embedding: RegressionAnswerGateway(
                evidence_chunk_id
            ),
        ).answer(
            knowledge_base_id=knowledge_base_id,
            query="数据库如何恢复数据？",
            api_key="fixed-test-key",
            chat_model="fixed-chat",
            embedding_model="fixed-embedding",
        )
    )
    assert answered["answer"]["evidenceSufficient"] is True
    assert answered["citations"][0]["chunkId"] == evidence_chunk_id

    rebuilt = asyncio.run(
        indexer.rebuild_index(knowledge_base_id, embedding_model="fixed-embedding")
    )
    assert rebuilt["ready"] is True
    assert rebuilt["indexVersion"]["id"] != built["indexVersion"]["id"]

    jobs = BackgroundJobService(storage)
    orphaned = jobs.create("index.rebuild", knowledge_base_id)
    jobs.update_progress(str(orphaned["id"]), status="running", progress=0.25)
    recovered = jobs.recover_unfinished()
    recovered_job = next(
        item
        for item in cast(list[dict[str, object]], recovered["jobs"])
        if item["id"] == orphaned["id"]
    )
    assert recovered_job["status"] == "paused"

    metrics = quality_summary(storage, knowledge_base_id)
    assert metrics["parseSuccessRate"] == 1.0
    assert metrics["indexDurationMs"] is not None
    assert metrics["retrievalLatencyMs"] is not None
    assert metrics["firstTokenLatencyMs"] is not None
    assert metrics["citationFailureRate"] == 0.0
    assert cast(int, metrics["embeddingCalls"]) >= 3
