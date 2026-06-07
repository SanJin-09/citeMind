from collections import Counter
from uuid import uuid4

from citemind_worker.storage import StorageRuntime

DEFAULT_KNOWLEDGE_BASE_NAME = "产品与架构资料库"


class KnowledgeBaseService:
    def __init__(self, storage: StorageRuntime) -> None:
        self.storage = storage

    def list_knowledge_bases(self, *, ensure_default: bool = True) -> dict[str, object]:
        if ensure_default:
            self.ensure_default()
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT id, name, description, created_at, updated_at
                FROM knowledge_bases
                ORDER BY updated_at DESC, created_at DESC
                """
            ).fetchall()
        return {"knowledgeBases": [self._knowledge_base_record(str(row["id"])) for row in rows]}

    def create(self, name: str, description: str | None = None) -> dict[str, object]:
        clean_name = _clean_name(name)
        knowledge_base_id = f"kb-{uuid4().hex}"
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO knowledge_bases(id, name, description)
                VALUES (?, ?, ?)
                """,
                (knowledge_base_id, clean_name, description),
            )
            connection.commit()
        return self._knowledge_base_record(knowledge_base_id)

    def rename(
        self, knowledge_base_id: str, name: str, description: str | None = None
    ) -> dict[str, object]:
        clean_name = _clean_name(name)
        with self.storage.database.connect() as connection:
            cursor = connection.execute(
                """
                UPDATE knowledge_bases
                SET name = ?,
                    description = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (clean_name, description, knowledge_base_id),
            )
            connection.commit()
        if cursor.rowcount == 0:
            raise ValueError("Knowledge base not found")
        return self._knowledge_base_record(knowledge_base_id)

    def delete(self, knowledge_base_id: str) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM knowledge_bases WHERE id = ?",
                (knowledge_base_id,),
            )
            connection.commit()
        if cursor.rowcount == 0:
            raise ValueError("Knowledge base not found")
        return self.list_knowledge_bases(ensure_default=False)

    def sources(self, knowledge_base_id: str) -> dict[str, object]:
        self._ensure_exists(knowledge_base_id)
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    s.id,
                    s.source_type,
                    s.display_name,
                    s.uri,
                    s.status,
                    s.created_at,
                    s.updated_at,
                    (
                        SELECT sv.status
                        FROM source_versions sv
                        WHERE sv.source_id = s.id
                        ORDER BY sv.version_number DESC
                        LIMIT 1
                    ) AS latest_version_status,
                    (
                        SELECT COUNT(*)
                        FROM source_versions sv
                        JOIN chunks c ON c.source_version_id = sv.id
                        WHERE sv.source_id = s.id
                          AND c.knowledge_base_id = s.knowledge_base_id
                    ) AS chunk_count
                FROM sources s
                WHERE s.knowledge_base_id = ?
                ORDER BY s.updated_at DESC, s.created_at DESC
                """,
                (knowledge_base_id,),
            ).fetchall()
        sources = [
            {
                "id": str(row["id"]),
                "sourceType": str(row["source_type"]),
                "displayName": str(row["display_name"]),
                "uri": row["uri"],
                "status": str(row["status"]),
                "latestVersionStatus": row["latest_version_status"],
                "chunkCount": int(row["chunk_count"]),
                "createdAt": str(row["created_at"]),
                "updatedAt": str(row["updated_at"]),
            }
            for row in rows
        ]
        return {
            "knowledgeBaseId": knowledge_base_id,
            "sources": sources,
            "summary": self._summary(knowledge_base_id),
        }

    def ensure_default(self) -> str:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                """
                SELECT id
                FROM knowledge_bases
                ORDER BY created_at ASC
                LIMIT 1
                """
            ).fetchone()
            if row is not None:
                return str(row["id"])
            knowledge_base_id = f"kb-{uuid4().hex}"
            connection.execute(
                """
                INSERT INTO knowledge_bases(id, name, description)
                VALUES (?, ?, ?)
                """,
                (knowledge_base_id, DEFAULT_KNOWLEDGE_BASE_NAME, "默认知识库"),
            )
            connection.commit()
        return knowledge_base_id

    def _knowledge_base_record(self, knowledge_base_id: str) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                """
                SELECT id, name, description, created_at, updated_at
                FROM knowledge_bases
                WHERE id = ?
                """,
                (knowledge_base_id,),
            ).fetchone()
        if row is None:
            raise ValueError("Knowledge base not found")
        return {
            "id": str(row["id"]),
            "name": str(row["name"]),
            "description": row["description"],
            "createdAt": str(row["created_at"]),
            "updatedAt": str(row["updated_at"]),
            "summary": self._summary(knowledge_base_id),
        }

    def _summary(self, knowledge_base_id: str) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            source_rows = connection.execute(
                """
                SELECT status, COUNT(*) AS count
                FROM sources
                WHERE knowledge_base_id = ?
                GROUP BY status
                """,
                (knowledge_base_id,),
            ).fetchall()
            current_index_count = int(
                connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM index_versions
                    WHERE knowledge_base_id = ?
                      AND is_current = 1
                      AND status = 'ready'
                    """,
                    (knowledge_base_id,),
                ).fetchone()[0]
            )
            conversation_count = int(
                connection.execute(
                    "SELECT COUNT(*) FROM conversations WHERE knowledge_base_id = ?",
                    (knowledge_base_id,),
                ).fetchone()[0]
            )
            chunk_count = int(
                connection.execute(
                    "SELECT COUNT(*) FROM chunks WHERE knowledge_base_id = ?",
                    (knowledge_base_id,),
                ).fetchone()[0]
            )

        sources_by_status = Counter({str(row["status"]): int(row["count"]) for row in source_rows})
        return {
            "sourceCount": sum(sources_by_status.values()),
            "sourcesByStatus": dict(sources_by_status),
            "readyIndexCount": current_index_count,
            "conversationCount": conversation_count,
            "chunkCount": chunk_count,
        }

    def _ensure_exists(self, knowledge_base_id: str) -> None:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                "SELECT 1 FROM knowledge_bases WHERE id = ?",
                (knowledge_base_id,),
            ).fetchone()
        if row is None:
            raise ValueError("Knowledge base not found")


def _clean_name(name: str) -> str:
    clean = " ".join(name.split())
    if not clean:
        raise ValueError("Knowledge base name is required")
    return clean
