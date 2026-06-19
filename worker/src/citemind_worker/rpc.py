import inspect
import json
import logging
import threading
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import TextIO

type JsonValue = None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]
type RpcId = None | int | str
type RpcMethod = Callable[[JsonValue], JsonValue | Awaitable[JsonValue]]

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class RpcError(Exception):
    code: int
    message: str
    data: JsonValue = None


def require_object_params(params: JsonValue) -> dict[str, JsonValue]:
    if not isinstance(params, dict):
        raise RpcError(-32602, "Params must be an object")
    return params


class RpcServer:
    def __init__(self) -> None:
        self._methods: dict[str, RpcMethod] = {}
        self._output_stream: TextIO | None = None
        self._output_lock = threading.Lock()
        self.stopped = False

    def register(self, method: str, handler: RpcMethod) -> None:
        if method in self._methods:
            raise ValueError(f"RPC method is already registered: {method}")
        self._methods[method] = handler

    def notify(self, method: str, params: JsonValue) -> None:
        self._write_message({"jsonrpc": "2.0", "method": method, "params": params})

    async def serve(self, input_stream: TextIO, output_stream: TextIO) -> None:
        self._output_stream = output_stream
        for line in input_stream:
            response = await self.handle_line(line)
            if response is not None:
                self._write_message(response)
            if self.stopped:
                break
        self._output_stream = None

    def _write_message(self, payload: dict[str, JsonValue]) -> None:
        with self._output_lock:
            output_stream = self._output_stream
            if output_stream is None:
                return
            output_stream.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
            output_stream.write("\n")
            output_stream.flush()

    async def handle_line(self, line: str) -> dict[str, JsonValue] | None:
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            return self._error_response(None, RpcError(-32700, "Parse error"))

        if not isinstance(request, dict):
            return self._error_response(None, RpcError(-32600, "Invalid Request"))

        request_id = request.get("id")
        is_notification = "id" not in request

        try:
            self._validate_request(request)
            method = request["method"]
            params = request.get("params", {})
            result = await self._dispatch(method, params)
        except RpcError as error:
            if is_notification:
                logger.warning(
                    "RPC notification failed method=%s code=%s", request.get("method"), error.code
                )
                return None
            return self._error_response(self._valid_id(request_id), error)
        except Exception:
            logger.exception("Unhandled RPC method failure method=%s", request.get("method"))
            if is_notification:
                return None
            return self._error_response(
                self._valid_id(request_id), RpcError(-32603, "Internal error")
            )

        if is_notification:
            return None
        return {"jsonrpc": "2.0", "id": self._valid_id(request_id), "result": result}

    async def _dispatch(self, method: str, params: JsonValue) -> JsonValue:
        handler = self._methods.get(method)
        if handler is None:
            raise RpcError(-32601, "Method not found")

        result = handler(params)
        if inspect.isawaitable(result):
            result = await result
        return result

    @staticmethod
    def _validate_request(request: Mapping[str, object]) -> None:
        if request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
            raise RpcError(-32600, "Invalid Request")
        if "params" in request and not isinstance(request["params"], (dict, list)):
            raise RpcError(-32602, "Invalid params")
        if "id" in request and not isinstance(request["id"], (type(None), int, str)):
            raise RpcError(-32600, "Invalid Request")

    @staticmethod
    def _valid_id(value: object) -> RpcId:
        return value if isinstance(value, (type(None), int, str)) else None

    @staticmethod
    def _error_response(request_id: RpcId, error: RpcError) -> dict[str, JsonValue]:
        payload: dict[str, JsonValue] = {"code": error.code, "message": error.message}
        if error.data is not None:
            payload["data"] = error.data
        return {"jsonrpc": "2.0", "id": request_id, "error": payload}
