import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager

from citemind_worker.storage.paths import AppDataPaths
from citemind_worker.storage.schema_migrations import MigrationManager


class SqliteDatabase:
    def __init__(self, paths: AppDataPaths) -> None:
        self.paths = paths
        self.migrations = MigrationManager(paths)

    def initialize(self) -> int:
        return self.migrations.migrate()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = self.migrations.connect()
        try:
            yield connection
        finally:
            connection.close()

    def status(self) -> dict[str, object]:
        with self.connect() as connection:
            tables = [
                str(row[0])
                for row in connection.execute(
                    """
                    SELECT name
                    FROM sqlite_master
                    WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
                    ORDER BY name
                    """
                )
            ]
            fts5_enabled = bool(
                connection.execute("SELECT sqlite_compileoption_used('ENABLE_FTS5')").fetchone()[0]
            )
        return {
            "path": str(self.paths.database),
            "schemaVersion": self.migrations.schema_version(),
            "fts5Enabled": fts5_enabled,
            "tables": tables,
        }
