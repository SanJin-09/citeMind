import json
from collections.abc import Callable
from typing import Protocol

from citemind_worker.ark_gateway import ArkModelGateway
from citemind_worker.model_catalog import (
    DEFAULT_ARK_BASE_URL,
    DEFAULT_CHAT_MODEL,
    DEFAULT_CREDENTIAL_ID,
    DEFAULT_EMBEDDING_MODEL,
    SEED_MODEL_CATALOG,
    seed_model_catalog_records,
)
from citemind_worker.storage import StorageRuntime


class ModelGatewayLike(Protocol):
    async def validate_model(self, model_id: str, role: str) -> dict[str, object]: ...


GatewayFactory = Callable[[str, str], ModelGatewayLike]


class SeedModelService:
    def __init__(
        self,
        storage: StorageRuntime,
        gateway_factory: GatewayFactory | None = None,
    ) -> None:
        self.storage = storage
        self.gateway_factory = gateway_factory or (
            lambda api_key, base_url: ArkModelGateway(api_key, base_url=base_url)
        )

    def status(self, credential_id: str = DEFAULT_CREDENTIAL_ID) -> dict[str, object]:
        credential = self._load_credential(credential_id)
        capabilities = self._load_capabilities(credential_id) if credential else []
        return {
            "baseUrl": DEFAULT_ARK_BASE_URL,
            "models": seed_model_catalog_records(),
            "credential": credential,
            "capabilities": capabilities,
        }

    async def validate_defaults(
        self,
        *,
        api_key: str,
        credential_id: str = DEFAULT_CREDENTIAL_ID,
        name: str = "我的 Seed API",
        encrypted_key_ref: str = "safeStorage:seed-api/default",
        base_url: str = DEFAULT_ARK_BASE_URL,
        default_chat_model: str = DEFAULT_CHAT_MODEL,
        default_embedding_model: str = DEFAULT_EMBEDDING_MODEL,
    ) -> dict[str, object]:
        gateway = self.gateway_factory(api_key, base_url)
        capabilities: list[dict[str, object]] = []

        for model in SEED_MODEL_CATALOG:
            capabilities.append(await gateway.validate_model(model.id, model.role))

        self._upsert_credential(
            credential_id=credential_id,
            name=name,
            encrypted_key_ref=encrypted_key_ref,
            default_chat_model=default_chat_model,
            default_embedding_model=default_embedding_model,
        )
        self._upsert_capabilities(credential_id, capabilities)
        return self.status(credential_id)

    def delete_credential(self, credential_id: str = DEFAULT_CREDENTIAL_ID) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            connection.execute("DELETE FROM seed_api_credentials WHERE id = ?", (credential_id,))
            connection.commit()
        return self.status(credential_id)

    def _load_credential(self, credential_id: str) -> dict[str, object] | None:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                """
                SELECT id, name, encrypted_key_ref, default_chat_model,
                       default_embedding_model, created_at, updated_at
                FROM seed_api_credentials
                WHERE id = ?
                """,
                (credential_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            "id": str(row[0]),
            "name": str(row[1]),
            "encryptedKeyRef": str(row[2]),
            "defaultChatModel": row[3],
            "defaultEmbeddingModel": row[4],
            "createdAt": str(row[5]),
            "updatedAt": str(row[6]),
        }

    def _load_capabilities(self, credential_id: str) -> list[dict[str, object]]:
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT model_id, role, status, capability_json, checked_at
                FROM model_capabilities
                WHERE credential_id = ?
                ORDER BY checked_at DESC, model_id
                """,
                (credential_id,),
            ).fetchall()
        return [
            {
                "modelId": str(row[0]),
                "role": str(row[1]),
                "status": str(row[2]),
                "capability": json.loads(str(row[3])),
                "checkedAt": str(row[4]),
            }
            for row in rows
        ]

    def _upsert_credential(
        self,
        *,
        credential_id: str,
        name: str,
        encrypted_key_ref: str,
        default_chat_model: str,
        default_embedding_model: str,
    ) -> None:
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO seed_api_credentials(
                    id, name, encrypted_key_ref, default_chat_model, default_embedding_model
                )
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    encrypted_key_ref = excluded.encrypted_key_ref,
                    default_chat_model = excluded.default_chat_model,
                    default_embedding_model = excluded.default_embedding_model,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                """,
                (
                    credential_id,
                    name,
                    encrypted_key_ref,
                    default_chat_model,
                    default_embedding_model,
                ),
            )
            connection.commit()

    def _upsert_capabilities(
        self, credential_id: str, capabilities: list[dict[str, object]]
    ) -> None:
        with self.storage.database.connect() as connection:
            for item in capabilities:
                model_id = str(item["modelId"])
                role = str(item["role"])
                connection.execute(
                    """
                    INSERT INTO model_capabilities(
                        id, credential_id, model_id, role, status, capability_json, checked_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(credential_id, model_id, role) DO UPDATE SET
                        status = excluded.status,
                        capability_json = excluded.capability_json,
                        checked_at = excluded.checked_at
                    """,
                    (
                        f"{credential_id}:{role}:{model_id}",
                        credential_id,
                        model_id,
                        role,
                        str(item["status"]),
                        json.dumps(item.get("capability", {}), ensure_ascii=False),
                        str(item["checkedAt"]),
                    ),
                )
            connection.commit()
