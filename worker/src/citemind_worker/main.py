import asyncio
import os
import sys

from citemind_worker.logging_config import configure_logging
from citemind_worker.rpc import JsonValue, RpcServer, require_object_params


def create_server() -> RpcServer:
    server = RpcServer()

    def health(params: JsonValue) -> JsonValue:
        require_object_params(params)
        return {
            "status": "ok",
            "service": "citemind-worker",
            "protocolVersion": "2.0",
            "pid": os.getpid(),
        }

    def shutdown(params: JsonValue) -> JsonValue:
        require_object_params(params)
        server.stopped = True
        return {"status": "stopping"}

    server.register("system.health", health)
    server.register("system.shutdown", shutdown)
    return server


async def serve() -> None:
    configure_logging()
    server = create_server()
    await server.serve(sys.stdin, sys.stdout)


def run() -> None:
    asyncio.run(serve())
