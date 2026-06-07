from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class AppDataPaths:
    root: Path

    @property
    def database(self) -> Path:
        return self.root / "metadata.sqlite3"

    @property
    def objects(self) -> Path:
        return self.root / "objects"

    @property
    def web_snapshots(self) -> Path:
        return self.root / "web-snapshots"

    @property
    def artifacts(self) -> Path:
        return self.root / "artifacts"

    @property
    def indexes(self) -> Path:
        return self.root / "indexes"

    @property
    def lancedb(self) -> Path:
        return self.indexes / "lancedb"

    @property
    def backups(self) -> Path:
        return self.root / "backups"

    def ensure(self) -> None:
        for directory in (
            self.root,
            self.objects,
            self.web_snapshots,
            self.artifacts,
            self.indexes,
            self.lancedb,
            self.backups,
        ):
            directory.mkdir(parents=True, exist_ok=True)

    def as_dict(self) -> dict[str, str]:
        return {
            "root": str(self.root),
            "database": str(self.database),
            "objects": str(self.objects),
            "webSnapshots": str(self.web_snapshots),
            "artifacts": str(self.artifacts),
            "indexes": str(self.indexes),
            "lancedb": str(self.lancedb),
            "backups": str(self.backups),
        }
