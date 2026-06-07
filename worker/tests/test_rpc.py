import asyncio
import json
from io import StringIO
from pathlib import Path

from citemind_worker.main import create_server
from citemind_worker.rpc import JsonValue
from citemind_worker.storage import StorageRuntime


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
        "schemaVersion": 1,
        "fts5Enabled": True,
        "vectorDimension": 3,
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
