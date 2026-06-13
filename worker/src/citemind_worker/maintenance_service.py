from contextlib import suppress
from pathlib import Path

from citemind_worker.storage import StorageRuntime


class MaintenanceService:
    def __init__(self, storage: StorageRuntime) -> None:
        self.storage = storage

    def status(self) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            retired = int(
                connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM index_versions
                    WHERE is_current = 0
                      AND (
                          status = 'failed'
                          OR (
                              status = 'retired'
                              AND retained_until IS NOT NULL
                              AND retained_until <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                          )
                      )
                    """
                ).fetchone()[0]
            )
            sources = int(connection.execute("SELECT COUNT(*) FROM sources").fetchone()[0])
            chunks = int(connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0])
        return {
            "rootPath": str(self.storage.paths.root),
            "totalBytes": _directory_size(self.storage.paths.root),
            "sourceCount": sources,
            "chunkCount": chunks,
            "recyclableIndexCount": retired,
        }

    def cleanup(self) -> dict[str, object]:
        recycled_indexes = self._recycle_indexes()
        referenced_files = self._referenced_files()
        removed_files = 0
        reclaimed_bytes = 0
        for root in (
            self.storage.paths.objects,
            self.storage.paths.web_snapshots,
            self.storage.paths.artifacts,
        ):
            for path in root.rglob("*"):
                if not path.is_file() or path.resolve() in referenced_files:
                    continue
                with suppress(OSError):
                    reclaimed_bytes += path.stat().st_size
                    path.unlink()
                    removed_files += 1
            _remove_empty_directories(root)

        with self.storage.database.connect() as connection:
            valid_chunk_ids = {
                str(row["id"]) for row in connection.execute("SELECT id FROM chunks").fetchall()
            }
        removed_vectors = self.storage.vector_index.delete_orphan_chunks(valid_chunk_ids)
        return {
            **self.status(),
            "recycledIndexCount": recycled_indexes,
            "removedFileCount": removed_files,
            "removedVectorCount": removed_vectors,
            "reclaimedBytes": reclaimed_bytes,
        }

    def _recycle_indexes(self) -> int:
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT id
                FROM index_versions
                WHERE is_current = 0
                  AND (
                      status = 'failed'
                      OR (
                          status = 'retired'
                          AND retained_until IS NOT NULL
                          AND retained_until <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                      )
                  )
                """
            ).fetchall()
            index_ids = [str(row["id"]) for row in rows]
            for index_id in index_ids:
                chunk_rows = connection.execute(
                    "SELECT id FROM chunks WHERE index_version_id = ?",
                    (index_id,),
                ).fetchall()
                chunk_ids = [str(row["id"]) for row in chunk_rows]
                if chunk_ids:
                    placeholders = ",".join("?" for _ in chunk_ids)
                    connection.execute(
                        f"DELETE FROM chunks_fts WHERE chunk_id IN ({placeholders})",
                        tuple(chunk_ids),
                    )
                    connection.execute(
                        f"""
                        DELETE FROM chunks
                        WHERE id IN ({placeholders})
                          AND id NOT IN (SELECT chunk_id FROM answer_citations)
                        """,
                        tuple(chunk_ids),
                    )
                    connection.execute(
                        "UPDATE chunks SET index_version_id = NULL WHERE index_version_id = ?",
                        (index_id,),
                    )
                connection.execute("DELETE FROM index_versions WHERE id = ?", (index_id,))
            connection.commit()
        self.storage.vector_index.delete_index_versions(index_ids)
        return len(index_ids)

    def _referenced_files(self) -> set[Path]:
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                "SELECT original_path, snapshot_path, parse_artifact_path FROM source_versions"
            ).fetchall()
        return {Path(str(value)).resolve() for row in rows for value in row if value}


def _directory_size(root: Path) -> int:
    total = 0
    if not root.exists():
        return total
    for path in root.rglob("*"):
        if path.is_file():
            with suppress(OSError):
                total += path.stat().st_size
    return total


def _remove_empty_directories(root: Path) -> None:
    if not root.exists():
        return
    for path in sorted(root.rglob("*"), reverse=True):
        if path.is_dir():
            with suppress(OSError):
                path.rmdir()
