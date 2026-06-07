from pathlib import Path

from citemind_worker.storage.database import SqliteDatabase
from citemind_worker.storage.paths import AppDataPaths
from citemind_worker.storage.vector_index import VectorIndex


class StorageRuntime:
    def __init__(self, root: Path, vector_dimension: int = 2048) -> None:
        self.paths = AppDataPaths(root.expanduser().resolve())
        self.database = SqliteDatabase(self.paths)
        self.vector_index = VectorIndex(self.paths, vector_dimension)

    def initialize(self) -> None:
        self.paths.ensure()
        self.database.initialize()
        self.vector_index.initialize()

    def status(self) -> dict[str, object]:
        return {
            "ready": True,
            "paths": self.paths.as_dict(),
            "sqlite": self.database.status(),
            "lancedb": self.vector_index.status(),
        }

    def health_summary(self) -> dict[str, object]:
        database_status = self.database.status()
        return {
            "ready": True,
            "schemaVersion": database_status["schemaVersion"],
            "fts5Enabled": database_status["fts5Enabled"],
            "vectorDimension": self.vector_index.dimension,
        }
