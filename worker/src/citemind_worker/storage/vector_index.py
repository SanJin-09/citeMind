from collections.abc import Sequence
from dataclasses import dataclass

import lancedb  # type: ignore[import-untyped]
import pyarrow as pa

from citemind_worker.storage.paths import AppDataPaths

TABLE_NAME = "chunk_vectors"


@dataclass(frozen=True, slots=True)
class VectorResult:
    chunk_id: str
    distance: float


class VectorIndex:
    def __init__(self, paths: AppDataPaths, dimension: int = 2048) -> None:
        if dimension <= 0:
            raise ValueError("Vector dimension must be positive")
        self.paths = paths
        self.dimension = dimension
        self.connection = lancedb.connect(paths.lancedb)

    def initialize(self) -> None:
        if TABLE_NAME in self.connection.list_tables().tables:
            self._validate_existing_dimension()
            return
        schema = pa.schema(
            [
                pa.field("chunk_id", pa.string(), nullable=False),
                pa.field("knowledge_base_id", pa.string(), nullable=False),
                pa.field("index_version_id", pa.string(), nullable=False),
                pa.field("vector", pa.list_(pa.float32(), self.dimension), nullable=False),
            ]
        )
        self.connection.create_table(TABLE_NAME, schema=schema)

    def add(
        self,
        *,
        chunk_id: str,
        knowledge_base_id: str,
        index_version_id: str,
        vector: list[float],
    ) -> None:
        self._validate_vector(vector)
        self.table.add(
            [
                {
                    "chunk_id": chunk_id,
                    "knowledge_base_id": knowledge_base_id,
                    "index_version_id": index_version_id,
                    "vector": vector,
                }
            ]
        )

    def delete_chunk_ids(self, chunk_ids: Sequence[str]) -> None:
        for chunk_id in dict.fromkeys(chunk_ids):
            self.table.delete(f"chunk_id = '{_escape_sql(chunk_id)}'")

    def delete_index_versions(self, index_version_ids: Sequence[str]) -> None:
        for index_version_id in dict.fromkeys(index_version_ids):
            self.table.delete(f"index_version_id = '{_escape_sql(index_version_id)}'")

    def count_index_version(self, index_version_id: str) -> int:
        return int(
            self.table.count_rows(
                f"index_version_id = '{_escape_sql(index_version_id)}'"
            )
        )

    def search(
        self,
        *,
        knowledge_base_id: str,
        index_version_id: str,
        vector: list[float],
        limit: int = 20,
    ) -> list[VectorResult]:
        self._validate_vector(vector)
        where = (
            f"knowledge_base_id = '{_escape_sql(knowledge_base_id)}' "
            f"AND index_version_id = '{_escape_sql(index_version_id)}'"
        )
        rows = (
            self.table.search(vector)
            .where(where, prefilter=True)
            .select(["chunk_id"])
            .limit(limit)
            .to_arrow()
            .to_pylist()
        )
        return [
            VectorResult(chunk_id=str(row["chunk_id"]), distance=float(row["_distance"]))
            for row in rows
        ]

    def status(self) -> dict[str, object]:
        return {
            "path": str(self.paths.lancedb),
            "table": TABLE_NAME,
            "dimension": self.dimension,
            "ready": TABLE_NAME in self.connection.list_tables().tables,
        }

    @property
    def table(self) -> lancedb.table.Table:
        return self.connection.open_table(TABLE_NAME)

    def _validate_vector(self, vector: list[float]) -> None:
        if len(vector) != self.dimension:
            raise ValueError(f"Expected vector dimension {self.dimension}, received {len(vector)}")

    def _validate_existing_dimension(self) -> None:
        vector_type = self.table.schema.field("vector").type
        if not pa.types.is_fixed_size_list(vector_type) or vector_type.list_size != self.dimension:
            raise ValueError(
                "Existing LanceDB vector dimension does not match configured dimension"
            )


def _escape_sql(value: str) -> str:
    return value.replace("'", "''")
