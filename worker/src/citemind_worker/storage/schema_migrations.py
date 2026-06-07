import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib.resources import files
from pathlib import Path

from citemind_worker.storage.paths import AppDataPaths


@dataclass(frozen=True, slots=True)
class Migration:
    version: int
    name: str
    sql: str


class MigrationManager:
    def __init__(self, paths: AppDataPaths) -> None:
        self.paths = paths

    def migrate(self) -> int:
        self.paths.ensure()
        existed_before_migration = (
            self.paths.database.exists() and self.paths.database.stat().st_size > 0
        )
        migrations = self._load_migrations()

        with self.connect() as connection:
            self._ensure_migration_table(connection)
            applied = {
                int(row[0]) for row in connection.execute("SELECT version FROM schema_migrations")
            }
            pending = [migration for migration in migrations if migration.version not in applied]

        if pending and existed_before_migration:
            self._create_snapshot()

        for migration in pending:
            self._apply(migration)

        return self.schema_version()

    def schema_version(self) -> int:
        if not self.paths.database.exists():
            return 0
        with self.connect() as connection:
            self._ensure_migration_table(connection)
            row = connection.execute(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations"
            ).fetchone()
        return int(row[0]) if row else 0

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.paths.database)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = NORMAL")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def _apply(self, migration: Migration) -> None:
        escaped_name = migration.name.replace("'", "''")
        script = (
            "BEGIN IMMEDIATE;\n"
            f"{migration.sql}\n"
            "INSERT INTO schema_migrations(version, name) "
            f"VALUES ({migration.version}, '{escaped_name}');\n"
            "COMMIT;\n"
        )
        with self.connect() as connection:
            try:
                connection.executescript(script)
            except Exception:
                connection.rollback()
                raise

    def _create_snapshot(self) -> Path:
        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        snapshot = self.paths.backups / f"metadata-before-migration-{timestamp}.sqlite3"
        with self.connect() as source, sqlite3.connect(snapshot) as destination:
            source.backup(destination)
        return snapshot

    @staticmethod
    def _ensure_migration_table(connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            )
            """
        )
        connection.commit()

    @staticmethod
    def _load_migrations() -> list[Migration]:
        migration_root = files("citemind_worker.storage.migrations")
        migrations: list[Migration] = []
        for resource in migration_root.iterdir():
            if not resource.name.endswith(".sql"):
                continue
            version_text, _, name = resource.name.partition("_")
            migrations.append(
                Migration(
                    version=int(version_text),
                    name=name.removesuffix(".sql"),
                    sql=resource.read_text(encoding="utf-8"),
                )
            )
        return sorted(migrations, key=lambda migration: migration.version)
