import asyncio
import json
from io import StringIO
from pathlib import Path

from citemind_worker.main import create_server
from citemind_worker.model_catalog import SEED_MODEL_CATALOG
from citemind_worker.model_service import SeedModelService
from citemind_worker.storage import StorageRuntime


class FakeGateway:
    async def validate_model(self, model_id: str, role: str) -> dict[str, object]:
        capability: dict[str, object] = {"chat": True}
        if role == "embedding":
            capability = {"embedding": True, "vectorDimension": 2048}
        return {
            "modelId": model_id,
            "role": role,
            "status": "callable",
            "message": "模型可调用",
            "capability": capability,
            "checkedAt": "2026-06-08T00:00:00+00:00",
        }


def test_seed_model_service_persists_validation_without_returning_key(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    service = SeedModelService(storage, gateway_factory=lambda _key, _base_url: FakeGateway())

    result = asyncio.run(
        service.validate_defaults(
            api_key="ark-secret-value",
            credential_id="default",
            name="测试 Seed API",
            encrypted_key_ref="safeStorage:seed-api/default",
        )
    )

    payload = json.dumps(result, ensure_ascii=False)
    assert "ark-secret-value" not in payload
    assert result["credential"] == {
        "id": "default",
        "name": "测试 Seed API",
        "encryptedKeyRef": "safeStorage:seed-api/default",
        "defaultChatModel": "doubao-seed-2-0-lite-260428",
        "defaultEmbeddingModel": "doubao-embedding-vision-251215",
        "createdAt": result["credential"]["createdAt"],  # type: ignore[index]
        "updatedAt": result["credential"]["updatedAt"],  # type: ignore[index]
    }
    assert len(result["capabilities"]) == len(SEED_MODEL_CATALOG)


def test_models_rpc_exposes_catalog_and_validation_status(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    service = SeedModelService(storage, gateway_factory=lambda _key, _base_url: FakeGateway())
    server = create_server(storage, service)
    output = StringIO()

    asyncio.run(
        server.serve(
            StringIO(
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": "1",
                        "method": "models.validate_defaults",
                        "params": {
                            "apiKey": "ark-secret-value",
                            "credentialId": "default",
                            "name": "测试 Seed API",
                        },
                    },
                    ensure_ascii=False,
                )
                + "\n"
            ),
            output,
        )
    )

    response = json.loads(output.getvalue())
    payload = json.dumps(response, ensure_ascii=False)
    assert "ark-secret-value" not in payload
    assert response["result"]["models"][0]["id"] == "doubao-seed-2-0-lite-260428"
    assert response["result"]["capabilities"][0]["status"] == "callable"
