import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from io import StringIO
from pathlib import Path

from citemind_worker.conversation_service import ConversationService
from citemind_worker.indexing_service import IndexingService
from citemind_worker.main import create_server
from citemind_worker.retrieval_service import HybridRetrievalService
from citemind_worker.rpc import JsonValue
from citemind_worker.storage import StorageRuntime


class MiniEmbedder:
    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [[1.0, 0.0, 0.0] for _text in texts]


class MiniAnswerGateway:
    def __init__(self, chunk_id_ref: dict[str, str]) -> None:
        self.chunk_id_ref = chunk_id_ref

    async def generate_structured(
        self,
        request: dict[str, object],
        schema: dict[str, object],
    ) -> dict[str, object]:
        return {
            "evidence_sufficient": True,
            "refusal_reason": None,
            "paragraphs": [
                {
                    "text": "RPC 回答引用了 alpha 证据。",
                    "evidence_chunk_ids": [self.chunk_id_ref["chunkId"]],
                }
            ],
        }

    def stream_answer(self, request: dict[str, object]) -> AsyncIterator[dict[str, object]]:
        async def iterator() -> AsyncIterator[dict[str, object]]:
            yield {"type": "delta", "text": "unused"}

        return iterator()


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


def run_server(payload: str) -> list[dict[str, JsonValue]]:
    output = StringIO()
    asyncio.run(create_server().serve(StringIO(payload), output))
    return [json.loads(line) for line in output.getvalue().splitlines()]


def test_health_request() -> None:
    responses = run_server('{"jsonrpc":"2.0","id":"1","method":"system.health","params":{}}\n')

    assert responses[0]["id"] == "1"
    result = responses[0]["result"]
    assert isinstance(result, dict)
    assert result["status"] == "ok"
    assert result["protocolVersion"] == "2.0"


def test_notification_has_no_response() -> None:
    responses = run_server('{"jsonrpc":"2.0","method":"system.health","params":{}}\n')
    assert responses == []


def test_method_not_found() -> None:
    responses = run_server('{"jsonrpc":"2.0","id":2,"method":"unknown","params":{}}\n')
    error = responses[0]["error"]
    assert isinstance(error, dict)
    assert error["code"] == -32601


def test_invalid_params() -> None:
    responses = run_server('{"jsonrpc":"2.0","id":3,"method":"system.health","params":[]}\n')
    error = responses[0]["error"]
    assert isinstance(error, dict)
    assert error["code"] == -32602


def test_health_reports_initialized_storage(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    server = create_server(storage)
    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO('{"jsonrpc":"2.0","id":"1","method":"system.health","params":{}}\n'),
            output,
        )
    )
    response = json.loads(output.getvalue())

    assert response["result"]["storage"] == {
        "ready": True,
        "schemaVersion": 6,
        "fts5Enabled": True,
        "vectorDimension": 3,
    }


def test_writing_rpc_lists_projects_for_knowledge_base(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    with storage.database.connect() as connection:
        connection.execute(
            "INSERT INTO knowledge_bases(id, name) VALUES ('kb-writing', '写作知识库')"
        )
        connection.commit()
    server = create_server(storage)
    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"1","method":"writing.list",'
                '"params":{"knowledgeBaseId":"kb-writing"}}\n'
            ),
            output,
        )
    )
    response = json.loads(output.getvalue())

    assert response["result"] == {
        "knowledgeBaseId": "kb-writing",
        "projects": [],
    }


def test_knowledge_base_rpc_creates_and_lists_sources(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    server = create_server(storage)
    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"1","method":"knowledge_bases.create",'
                '"params":{"name":"测试知识库"}}\n'
            ),
            output,
        )
    )
    created = json.loads(output.getvalue())["result"]

    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"2","method":"knowledge_bases.sources",'
                f'"params":{{"knowledgeBaseId":"{created["id"]}"}}}}\n'
            ),
            output,
        )
    )
    response = json.loads(output.getvalue())

    assert response["result"]["knowledgeBaseId"] == created["id"]
    assert response["result"]["sources"] == []


def test_background_job_rpc_create_update_and_list(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    server = create_server(storage)
    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"1","method":"jobs.create",'
                '"params":{"jobType":"source.import","targetId":"source-1"}}\n'
            ),
            output,
        )
    )
    created = json.loads(output.getvalue())["result"]

    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"2","method":"jobs.update",'
                f'"params":{{"jobId":"{created["id"]}","status":"running","progress":0.25}}}}\n'
            ),
            output,
        )
    )
    updated = json.loads(output.getvalue())["result"]

    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"3","method":"jobs.list",'
                '"params":{"includeTerminal":false}}\n'
            ),
            output,
        )
    )
    listed = json.loads(output.getvalue())["result"]

    assert updated["status"] == "running"
    assert updated["progress"] == 0.25
    assert [job["id"] for job in listed["jobs"]] == [created["id"]]


def test_source_import_rpc_imports_file_and_lists_parse_checks(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    server = create_server(storage)
    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"1","method":"knowledge_bases.create",'
                '"params":{"name":"导入 RPC"}}\n'
            ),
            output,
        )
    )
    knowledge_base_id = json.loads(output.getvalue())["result"]["id"]
    sample = tmp_path / "sample.pdf"
    write_text_pdf(sample, "PDF fallback text")

    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"2","method":"sources.import_file",'
                f'"params":{{"knowledgeBaseId":"{knowledge_base_id}","filePath":"{sample}"}}}}\n'
            ),
            output,
        )
    )
    imported = json.loads(output.getvalue())["result"]

    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"3","method":"sources.parse_checks",'
                f'"params":{{"knowledgeBaseId":"{knowledge_base_id}"}}}}\n'
            ),
            output,
        )
    )
    checks = json.loads(output.getvalue())["result"]

    assert imported["parseCheck"]["status"] == "success"
    assert checks["summary"]["success"] == 1
    assert checks["items"][0]["preview"].startswith("PDF fallback text")

    source_id = imported["source"]["sourceId"]
    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"4","method":"sources.update_maintenance",'
                f'"params":{{"sourceId":"{source_id}","expiryStatus":"expired",'
                '"reviewAt":"2030-01-01T00:00:00.000Z"}}\n'
            ),
            output,
        )
    )
    maintained = json.loads(output.getvalue())["result"]

    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"5","method":"sources.versions",'
                f'"params":{{"sourceId":"{source_id}"}}}}\n'
            ),
            output,
        )
    )
    versions = json.loads(output.getvalue())["result"]

    assert maintained["source"]["expiryStatus"] == "expired"
    assert versions["source"]["currentVersionNumber"] == 1
    assert versions["versions"][0]["reviewStatus"] == "current"

    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"6","method":"sources.organization",'
                f'"params":{{"sourceId":"{source_id}"}}}}\n'
            ),
            output,
        )
    )
    organization = json.loads(output.getvalue())["result"]

    assert organization["sourceId"] == source_id
    assert organization["classification"]["category"]
    assert organization["tags"] == []


def test_index_build_rpc_marks_chunks_ready(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    retrieval = HybridRetrievalService(storage, embedder=MiniEmbedder())
    chunk_id_ref: dict[str, str] = {}
    server = create_server(
        storage,
        indexing_service=IndexingService(storage, embedder=MiniEmbedder()),
        retrieval_service=retrieval,
        conversation_service=ConversationService(
            storage,
            retrieval=retrieval,
            gateway_factory=lambda _key, _base, _embedding: MiniAnswerGateway(chunk_id_ref),
        ),
    )
    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"1","method":"knowledge_bases.create",'
                '"params":{"name":"索引 RPC"}}\n'
            ),
            output,
        )
    )
    knowledge_base_id = json.loads(output.getvalue())["result"]["id"]
    sample = tmp_path / "sample.pdf"
    write_text_pdf(sample, "PDF alpha searchable text")

    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"2","method":"sources.import_file",'
                f'"params":{{"knowledgeBaseId":"{knowledge_base_id}","filePath":"{sample}"}}}}\n'
            ),
            output,
        )
    )
    imported = json.loads(output.getvalue())["result"]
    source_id = imported["source"]["sourceId"]

    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"3","method":"indexes.build",'
                f'"params":{{"knowledgeBaseId":"{knowledge_base_id}"}}}}\n'
            ),
            output,
        )
    )
    built = json.loads(output.getvalue())["result"]

    assert built["ready"] is True
    assert built["indexVersion"]["chunkCount"] == 1

    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"4","method":"retrieval.hybrid_search",'
                f'"params":{{"knowledgeBaseId":"{knowledge_base_id}","query":"alpha",'
                '"limit":1,"candidateLimit":4}}\n'
            ),
            output,
        )
    )
    retrieved = json.loads(output.getvalue())["result"]

    assert retrieved["indexVersion"]["id"] == built["indexVersion"]["id"]
    assert retrieved["results"][0]["text"]["normalized"] == "PDF alpha searchable text"
    assert retrieved["results"][0]["ranks"]["keyword"] == 1

    chunk_id = retrieved["results"][0]["chunkId"]
    chunk_id_ref["chunkId"] = chunk_id
    with storage.database.connect() as connection:
        connection.execute(
            """
            UPDATE chunks
            SET page_number = 1,
                bounding_box_json = ?
            WHERE id = ?
            """,
            (json.dumps({"x": 1, "y": 2, "width": 3, "height": 4}), chunk_id),
        )
        connection.commit()

    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"5","method":"conversations.answer",'
                f'"params":{{"knowledgeBaseId":"{knowledge_base_id}",'
                '"query":"alpha","apiKey":"ark-test","chatModel":"doubao-test",'
                '"limit":1,"candidateLimit":4}}\n'
            ),
            output,
        )
    )
    answered = json.loads(output.getvalue())["result"]

    assert answered["answer"]["evidenceSufficient"] is True
    assert answered["assistantMessage"]["role"] == "assistant"
    assert answered["citations"][0]["chunkId"] == chunk_id

    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"6","method":"indexes.delete",'
                f'"params":{{"knowledgeBaseId":"{knowledge_base_id}"}}}}\n'
            ),
            output,
        )
    )
    deleted_index = json.loads(output.getvalue())["result"]
    assert deleted_index["ready"] is False
    assert deleted_index["deletedChunkCount"] == 1

    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"7","method":"indexes.rebuild",'
                f'"params":{{"knowledgeBaseId":"{knowledge_base_id}"}}}}\n'
            ),
            output,
        )
    )
    rebuilt = json.loads(output.getvalue())["result"]
    assert rebuilt["ready"] is True
    assert rebuilt["indexVersion"]["chunkCount"] == 1

    output = StringIO()
    asyncio.run(
        server.serve(
            StringIO(
                '{"jsonrpc":"2.0","id":"8","method":"sources.delete",'
                f'"params":{{"sourceId":"{source_id}"}}}}\n'
            ),
            output,
        )
    )
    deleted_source = json.loads(output.getvalue())["result"]
    assert deleted_source["deleted"] is True
    assert deleted_source["deletedChunkCount"] == 1
