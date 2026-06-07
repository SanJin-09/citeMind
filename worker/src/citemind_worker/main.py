import asyncio
import os
import sys
from pathlib import Path

from citemind_worker.logging_config import configure_logging
from citemind_worker.rpc import JsonValue, RpcServer, require_object_params
from citemind_worker.storage import StorageRuntime


def create_server(storage: StorageRuntime | None = None) -> RpcServer:
    server = RpcServer()

    def health(params: JsonValue) -> JsonValue:
        require_object_params(params)
        result: dict[str, JsonValue] = {
            "status": "ok",
            "service": "citemind-worker",
            "protocolVersion": "2.0",
            "pid": os.getpid(),
        }
        if storage is not None:
            result["storage"] = storage.health_summary()  # type: ignore[assignment]
        return result

    def storage_status(params: JsonValue) -> JsonValue:
        require_object_params(params)
        if storage is None:
            return {"ready": False}
        return storage.status()  # type: ignore[return-value]

    def shutdown(params: JsonValue) -> JsonValue:
        require_object_params(params)
        server.stopped = True
        return {"status": "stopping"}

    server.register("system.health", health)
    server.register("system.storage_status", storage_status)
    server.register("system.shutdown", shutdown)
    return server


async def serve() -> None:
    configure_logging()
    storage = StorageRuntime(_resolve_data_root())
    storage.initialize()
    server = create_server(storage)
    await server.serve(sys.stdin, sys.stdout)


def run() -> None:
    asyncio.run(serve())


def _resolve_data_root() -> Path:
    configured = os.environ.get("CITEMIND_DATA_DIR")
    if configured:
        return Path(configured)
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "citeMind"
    return Path.home() / ".citemind"
