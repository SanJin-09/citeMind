import asyncio
import os
import sys
from pathlib import Path

from citemind_worker.logging_config import configure_logging
from citemind_worker.model_catalog import (
    DEFAULT_ARK_BASE_URL,
    DEFAULT_CHAT_MODEL,
    DEFAULT_CREDENTIAL_ID,
    DEFAULT_EMBEDDING_MODEL,
)
from citemind_worker.model_service import SeedModelService
from citemind_worker.rpc import JsonValue, RpcError, RpcServer, require_object_params
from citemind_worker.storage import StorageRuntime


def create_server(
    storage: StorageRuntime | None = None,
    model_service: SeedModelService | None = None,
) -> RpcServer:
    server = RpcServer()
    seed_models = model_service or (SeedModelService(storage) if storage is not None else None)

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

    def models_status(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_model_service(seed_models)
        credential_id = _optional_str(values, "credentialId", DEFAULT_CREDENTIAL_ID)
        return service.status(credential_id)  # type: ignore[return-value]

    async def validate_models(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_model_service(seed_models)
        api_key = _required_str(values, "apiKey")
        credential_id = _optional_str(values, "credentialId", DEFAULT_CREDENTIAL_ID)
        name = _optional_str(values, "name", "我的 Seed API")
        encrypted_key_ref = _optional_str(values, "encryptedKeyRef", "safeStorage:seed-api/default")
        base_url = _optional_str(values, "baseUrl", DEFAULT_ARK_BASE_URL)
        default_chat_model = _optional_str(values, "defaultChatModel", DEFAULT_CHAT_MODEL)
        default_embedding_model = _optional_str(
            values, "defaultEmbeddingModel", DEFAULT_EMBEDDING_MODEL
        )
        return await service.validate_defaults(
            api_key=api_key,
            credential_id=credential_id,
            name=name,
            encrypted_key_ref=encrypted_key_ref,
            base_url=base_url,
            default_chat_model=default_chat_model,
            default_embedding_model=default_embedding_model,
        )  # type: ignore[return-value]

    def delete_credential(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_model_service(seed_models)
        credential_id = _optional_str(values, "credentialId", DEFAULT_CREDENTIAL_ID)
        return service.delete_credential(credential_id)  # type: ignore[return-value]

    server.register("system.health", health)
    server.register("system.storage_status", storage_status)
    server.register("system.shutdown", shutdown)
    server.register("models.status", models_status)
    server.register("models.validate_defaults", validate_models)
    server.register("models.delete_credential", delete_credential)
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


def _require_model_service(service: SeedModelService | None) -> SeedModelService:
    if service is None:
        raise RpcError(-32010, "Model service is not available")
    return service


def _required_str(values: dict[str, JsonValue], key: str) -> str:
    value = values.get(key)
    if not isinstance(value, str) or not value:
        raise RpcError(-32602, f"{key} must be a non-empty string")
    return value


def _optional_str(values: dict[str, JsonValue], key: str, fallback: str) -> str:
    value = values.get(key)
    if value is None:
        return fallback
    if not isinstance(value, str) or not value:
        raise RpcError(-32602, f"{key} must be a non-empty string")
    return value
