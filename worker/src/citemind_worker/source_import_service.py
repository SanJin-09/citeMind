import hashlib
import html
import importlib
import json
import re
import shutil
import sqlite3
import urllib.error
import urllib.request
import zipfile
from collections.abc import Iterable
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from difflib import SequenceMatcher, unified_diff
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Protocol, cast
from uuid import uuid4

from citemind_worker.background_job_service import BackgroundJobService
from citemind_worker.source_organization_service import SourceOrganizationService
from citemind_worker.storage import StorageRuntime

PARSER_VERSION = "citemind-parser-v1"
SUPPORTED_FILE_TYPES = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
    ".bmp": "image",
    ".tif": "image",
    ".tiff": "image",
}


@dataclass(frozen=True, slots=True)
class ParsedLocation:
    page_number: int | None = None
    bounding_box: dict[str, float] | None = None
    heading_path: list[str] = field(default_factory=list)
    anchor: str | None = None
    ocr_regions: list[dict[str, object]] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class ParsedBlock:
    original_text: str
    normalized_text: str
    location: ParsedLocation = field(default_factory=ParsedLocation)


@dataclass(frozen=True, slots=True)
class ParsedDocument:
    parser: str
    parser_version: str
    source_type: str
    original_text: str
    normalized_text: str
    blocks: list[ParsedBlock]
    needs_ocr: bool = False
    warnings: list[str] = field(default_factory=list)
    snapshot_text: str | None = None
    etag: str | None = None
    last_modified: str | None = None
    not_modified: bool = False


class ParseFailure(Exception):
    pass


class DocumentParser(Protocol):
    def parse_file(self, path: Path, source_type: str) -> ParsedDocument:
        pass

    def parse_web(self, url: str, snapshot_path: Path) -> ParsedDocument:
        pass


class SourceImportService:
    def __init__(
        self,
        storage: StorageRuntime,
        *,
        parser: DocumentParser | None = None,
        jobs: BackgroundJobService | None = None,
        organizer: SourceOrganizationService | None = None,
    ) -> None:
        self.storage = storage
        self.parser = parser or DoclingFirstParser()
        self.jobs = jobs or BackgroundJobService(storage)
        self.organizer = organizer or SourceOrganizationService(storage)

    def import_file(
        self,
        knowledge_base_id: str,
        file_path: str,
        *,
        display_name: str | None = None,
        duplicate_action: str = "ask",
    ) -> dict[str, object]:
        duplicate_action = _duplicate_action(duplicate_action)
        path = Path(file_path).expanduser().resolve()
        if not path.is_file():
            raise ValueError("File does not exist")
        source_type = _source_type_for_path(path)
        source_id = f"source-{uuid4().hex}"
        source_version_id = f"source-version-{uuid4().hex}"
        file_hash = _sha256(path)
        object_path = _object_path(self.storage, knowledge_base_id, source_id, path.name)
        artifact_path = _artifact_path(self.storage, source_version_id)
        object_path.parent.mkdir(parents=True, exist_ok=True)
        artifact_path.parent.mkdir(parents=True, exist_ok=True)

        duplicate_source_id = self._find_duplicate_original(knowledge_base_id, file_hash)
        if duplicate_source_id and self._duplicate_needs_reparse(
            duplicate_source_id,
            source_type,
        ):
            duplicate_source_id = None
        self._insert_source(
            source_id=source_id,
            knowledge_base_id=knowledge_base_id,
            source_type=source_type,
            display_name=display_name or path.name,
            uri=str(path),
            original_hash=file_hash,
            status="processing",
        )
        shutil.copy2(path, object_path)
        self._insert_source_version(
            source_version_id=source_version_id,
            source_id=source_id,
            original_path=object_path,
            snapshot_path=None,
            parse_artifact_path=artifact_path,
            status="processing",
        )
        job = self.jobs.create("source.import", source_id)
        self.jobs.update_progress(str(job["id"]), status="running", progress=0.1)

        try:
            parsed = self.parser.parse_file(object_path, source_type)
            return self._complete_parsed_import(
                job_id=str(job["id"]),
                knowledge_base_id=knowledge_base_id,
                source_id=source_id,
                source_version_id=source_version_id,
                artifact_path=artifact_path,
                original_hash=file_hash,
                parsed=parsed,
                snapshot_path=None,
                duplicate_source_id=duplicate_source_id,
                duplicate_kind="original" if duplicate_source_id else None,
                duplicate_action=duplicate_action,
            )
        except Exception as error:
            return self._fail_import(
                job_id=str(job["id"]),
                source_id=source_id,
                source_version_id=source_version_id,
                artifact_path=artifact_path,
                source_type=source_type,
                message=_public_error(error),
            )

    def import_web(
        self,
        knowledge_base_id: str,
        url: str,
        *,
        display_name: str | None = None,
        duplicate_action: str = "ask",
    ) -> dict[str, object]:
        duplicate_action = _duplicate_action(duplicate_action)
        clean_url = _clean_url(url)
        source_id = f"source-{uuid4().hex}"
        source_version_id = f"source-version-{uuid4().hex}"
        snapshot_path = self.storage.paths.web_snapshots / f"{source_id}.html"
        artifact_path = _artifact_path(self.storage, source_version_id)
        snapshot_path.parent.mkdir(parents=True, exist_ok=True)
        artifact_path.parent.mkdir(parents=True, exist_ok=True)

        self._insert_source(
            source_id=source_id,
            knowledge_base_id=knowledge_base_id,
            source_type="web",
            display_name=display_name or clean_url,
            uri=clean_url,
            original_hash=None,
            status="processing",
        )
        self._insert_source_version(
            source_version_id=source_version_id,
            source_id=source_id,
            original_path=None,
            snapshot_path=snapshot_path,
            parse_artifact_path=artifact_path,
            status="processing",
            etag=None,
            last_modified=None,
            previous_version_id=None,
            review_status="current",
        )
        job = self.jobs.create("source.import", source_id)
        self.jobs.update_progress(str(job["id"]), status="running", progress=0.1)

        try:
            parsed = self.parser.parse_web(clean_url, snapshot_path)
            snapshot_hash = _text_hash(parsed.snapshot_text or clean_url)
            self._update_source_hash(source_id, snapshot_hash)
            duplicate_source_id = self._find_duplicate_original(
                knowledge_base_id, snapshot_hash, excluding_source_id=source_id
            )
            return self._complete_parsed_import(
                job_id=str(job["id"]),
                knowledge_base_id=knowledge_base_id,
                source_id=source_id,
                source_version_id=source_version_id,
                artifact_path=artifact_path,
                original_hash=snapshot_hash,
                parsed=parsed,
                snapshot_path=snapshot_path,
                duplicate_source_id=duplicate_source_id,
                duplicate_kind="original" if duplicate_source_id else None,
                duplicate_action=duplicate_action,
            )
        except Exception as error:
            return self._fail_import(
                job_id=str(job["id"]),
                source_id=source_id,
                source_version_id=source_version_id,
                artifact_path=artifact_path,
                source_type="web",
                message=_public_error(error),
            )

    def check_web_updates(
        self,
        knowledge_base_id: str,
        *,
        due_only: bool = False,
    ) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT id
                FROM sources
                WHERE knowledge_base_id = ?
                  AND source_type = 'web'
                  AND (
                      ? = 0
                      OR review_at IS NULL
                      OR review_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  )
                ORDER BY updated_at DESC
                """,
                (knowledge_base_id, int(due_only)),
            ).fetchall()
        results = [self.check_web_update(str(row["id"])) for row in rows]
        return {
            "knowledgeBaseId": knowledge_base_id,
            "checked": len(results),
            "changed": sum(1 for item in results if item["status"] == "changed"),
            "items": results,
        }

    def check_web_update(self, source_id: str) -> dict[str, object]:
        source = self._source_with_current_version(source_id)
        if str(source["source_type"]) != "web":
            raise ValueError("只有网页来源支持在线更新检查")
        url = str(source["uri"] or "")
        if not url:
            raise ValueError("网页来源缺少 URL")
        current_version_id = str(source["source_version_id"])
        snapshot_path = self.storage.paths.web_snapshots / f"{source_id}-{uuid4().hex}.html"
        artifact_path = _artifact_path(self.storage, f"source-version-{uuid4().hex}")
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        job = self.jobs.create("web.refresh", source_id)
        self.jobs.update_progress(str(job["id"]), status="running", progress=0.15)
        try:
            checker = getattr(self.parser, "check_web", None)
            parsed = (
                checker(
                    url,
                    snapshot_path,
                    etag=_optional_string(source["etag"]),
                    last_modified=_optional_string(source["last_modified"]),
                )
                if callable(checker)
                else self.parser.parse_web(url, snapshot_path)
            )
            checked_at = _now()
            if parsed.not_modified:
                self._mark_web_checked(
                    source_id,
                    current_version_id,
                    checked_at=checked_at,
                    etag=parsed.etag,
                    last_modified=parsed.last_modified,
                )
                self.jobs.update_progress(str(job["id"]), status="completed", progress=1)
                return {"sourceId": source_id, "status": "unchanged", "checkedAt": checked_at}

            content_hash = _text_hash(parsed.normalized_text)
            if content_hash == source["content_hash"]:
                with suppress(OSError):
                    snapshot_path.unlink()
                self._mark_web_checked(
                    source_id,
                    current_version_id,
                    checked_at=checked_at,
                    etag=parsed.etag,
                    last_modified=parsed.last_modified,
                )
                self.jobs.update_progress(str(job["id"]), status="completed", progress=1)
                return {"sourceId": source_id, "status": "unchanged", "checkedAt": checked_at}

            with self.storage.database.connect() as connection:
                pending = connection.execute(
                    """
                    SELECT id, change_summary_json
                    FROM source_versions
                    WHERE source_id = ?
                      AND review_status = 'pending_review'
                      AND content_hash = ?
                    ORDER BY version_number DESC
                    LIMIT 1
                    """,
                    (source_id, content_hash),
                ).fetchone()
            if pending is not None:
                with suppress(OSError):
                    snapshot_path.unlink()
                self._mark_web_checked(
                    source_id,
                    str(pending["id"]),
                    checked_at=checked_at,
                    etag=parsed.etag,
                    last_modified=parsed.last_modified,
                )
                self.jobs.update_progress(str(job["id"]), status="completed", progress=1)
                return {
                    "sourceId": source_id,
                    "status": "changed",
                    "checkedAt": checked_at,
                    "pendingVersionId": str(pending["id"]),
                    "changeSummary": _json_object(pending["change_summary_json"]),
                }

            source_version_id = artifact_path.stem
            self._insert_source_version(
                source_version_id=source_version_id,
                source_id=source_id,
                original_path=None,
                snapshot_path=snapshot_path,
                parse_artifact_path=artifact_path,
                status="parsed",
                etag=parsed.etag,
                last_modified=parsed.last_modified,
                previous_version_id=current_version_id,
                review_status="pending_review",
            )
            artifact = _artifact_from_parsed(
                source_id=source_id,
                source_version_id=source_version_id,
                parsed=parsed,
                original_hash=_text_hash(parsed.snapshot_text or url),
                content_hash=content_hash,
                snapshot_path=snapshot_path,
            )
            _write_json(artifact_path, artifact)
            summary = _version_change_summary(
                _read_artifact(source["parse_artifact_path"]),
                artifact,
            )
            with self.storage.database.connect() as connection:
                connection.execute(
                    """
                    UPDATE source_versions
                    SET content_hash = ?,
                        change_summary_json = ?
                    WHERE id = ?
                    """,
                    (content_hash, json.dumps(summary, ensure_ascii=False), source_version_id),
                )
                connection.execute(
                    """
                    UPDATE sources
                    SET last_checked_at = ?,
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE id = ?
                    """,
                    (checked_at, source_id),
                )
                connection.commit()
            self.jobs.update_progress(str(job["id"]), status="completed", progress=1)
            return {
                "sourceId": source_id,
                "status": "changed",
                "checkedAt": checked_at,
                "pendingVersionId": source_version_id,
                "changeSummary": summary,
            }
        except Exception as error:
            self.jobs.update_progress(
                str(job["id"]),
                status="failed",
                error_message=_public_error(error),
            )
            with suppress(OSError):
                snapshot_path.unlink()
            raise ValueError(_public_error(error)) from error

    def source_versions(self, source_id: str) -> dict[str, object]:
        source = self._source_with_current_version(source_id)
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT id, version_number, content_hash, original_path, snapshot_path,
                       parse_artifact_path, status, etag, last_modified, checked_at,
                       previous_version_id, review_status, change_summary_json, created_at
                FROM source_versions
                WHERE source_id = ?
                ORDER BY version_number DESC
                """,
                (source_id,),
            ).fetchall()
        return {
            "source": _source_maintenance_record(source),
            "versions": [_source_version_record(row) for row in rows],
        }

    def source_version_diff(self, source_id: str, version_id: str) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            version = connection.execute(
                """
                SELECT id, previous_version_id, parse_artifact_path, change_summary_json
                FROM source_versions
                WHERE id = ? AND source_id = ?
                """,
                (version_id, source_id),
            ).fetchone()
            if version is None:
                raise ValueError("来源版本不存在")
            previous = connection.execute(
                """
                SELECT parse_artifact_path
                FROM source_versions
                WHERE id = ?
                """,
                (version["previous_version_id"],),
            ).fetchone()
        if previous is None:
            raise ValueError("来源版本没有可比较的上一版本")
        before = _artifact_text(_read_artifact(previous["parse_artifact_path"]))
        after = _artifact_text(_read_artifact(version["parse_artifact_path"]))
        lines = list(
            unified_diff(
                before.splitlines(),
                after.splitlines(),
                fromfile="上一版本",
                tofile="待确认版本",
                lineterm="",
            )
        )
        return {
            "sourceId": source_id,
            "versionId": version_id,
            "summary": _json_object(version["change_summary_json"]),
            "diff": "\n".join(lines[:240]),
            "truncated": len(lines) > 240,
        }

    def decide_source_version(
        self,
        source_id: str,
        version_id: str,
        decision: str,
    ) -> dict[str, object]:
        if decision not in {"accept", "reject"}:
            raise ValueError("版本处理方式无效")
        with self.storage.database.connect() as connection:
            row = connection.execute(
                """
                SELECT status, review_status
                FROM source_versions
                WHERE id = ? AND source_id = ?
                """,
                (version_id, source_id),
            ).fetchone()
            if row is None or str(row["review_status"]) != "pending_review":
                raise ValueError("来源版本不处于待确认状态")
            if decision == "accept":
                connection.execute(
                    """
                    UPDATE source_versions
                    SET review_status = CASE WHEN id = ? THEN 'current' ELSE review_status END
                    WHERE source_id = ?
                    """,
                    (version_id, source_id),
                )
                connection.execute(
                    """
                    UPDATE source_versions
                    SET review_status = 'superseded'
                    WHERE source_id = ? AND id != ? AND review_status = 'current'
                    """,
                    (source_id, version_id),
                )
                connection.execute(
                    """
                    UPDATE sources
                    SET current_version_id = ?,
                        status = 'processing',
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE id = ?
                    """,
                    (version_id, source_id),
                )
            else:
                connection.execute(
                    "UPDATE source_versions SET review_status = 'rejected' WHERE id = ?",
                    (version_id,),
                )
            connection.commit()
        if decision == "accept":
            self._refresh_organization(source_id)
        return self.source_versions(source_id)

    def update_source_maintenance(
        self,
        source_id: str,
        *,
        replacement_source_id: str | None,
        review_at: str | None,
        expiry_status: str,
    ) -> dict[str, object]:
        if expiry_status not in {"active", "expired", "replaced"}:
            raise ValueError("来源时效状态无效")
        if replacement_source_id == source_id:
            raise ValueError("替代文档不能指向自身")
        with self.storage.database.connect() as connection:
            if replacement_source_id is not None:
                replacement = connection.execute(
                    "SELECT 1 FROM sources WHERE id = ?",
                    (replacement_source_id,),
                ).fetchone()
                if replacement is None:
                    raise ValueError("替代文档不存在")
            cursor = connection.execute(
                """
                UPDATE sources
                SET replacement_source_id = ?,
                    review_at = ?,
                    expiry_status = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (replacement_source_id, review_at, expiry_status, source_id),
            )
            connection.commit()
        if cursor.rowcount == 0:
            raise ValueError("Source not found")
        return self.source_versions(source_id)

    def suggest_source_status(
        self,
        source_id: str,
        *,
        suggestion: str,
        reason: str,
        confidence: float,
    ) -> dict[str, object]:
        if suggestion not in {"expired", "conflict"}:
            raise ValueError("模型建议类型无效")
        if confidence < 0 or confidence > 1:
            raise ValueError("模型建议置信度无效")
        payload = {
            "status": "pending_confirmation",
            "suggestion": suggestion,
            "reason": reason,
            "confidence": confidence,
            "createdAt": _now(),
        }
        with self.storage.database.connect() as connection:
            cursor = connection.execute(
                "UPDATE sources SET model_suggestion_json = ? WHERE id = ?",
                (json.dumps(payload, ensure_ascii=False), source_id),
            )
            connection.commit()
        if cursor.rowcount == 0:
            raise ValueError("Source not found")
        return self.source_versions(source_id)

    def decide_source_suggestion(self, source_id: str, decision: str) -> dict[str, object]:
        if decision not in {"accept", "dismiss"}:
            raise ValueError("模型建议处理方式无效")
        with self.storage.database.connect() as connection:
            row = connection.execute(
                "SELECT model_suggestion_json FROM sources WHERE id = ?",
                (source_id,),
            ).fetchone()
            if row is None:
                raise ValueError("Source not found")
            suggestion = _json_object(row["model_suggestion_json"])
            if suggestion.get("status") != "pending_confirmation":
                raise ValueError("来源没有待确认的模型建议")
            expiry_status = (
                "expired"
                if decision == "accept" and suggestion.get("suggestion") == "expired"
                else None
            )
            suggestion["status"] = "accepted" if decision == "accept" else "dismissed"
            suggestion["decidedAt"] = _now()
            connection.execute(
                """
                UPDATE sources
                SET expiry_status = COALESCE(?, expiry_status),
                    model_suggestion_json = ?
                WHERE id = ?
                """,
                (expiry_status, json.dumps(suggestion, ensure_ascii=False), source_id),
            )
            connection.commit()
        return self.source_versions(source_id)

    def parse_checks(self, knowledge_base_id: str) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    s.id AS source_id,
                    s.source_type,
                    s.display_name,
                    s.uri,
                    s.original_hash,
                    s.status AS source_status,
                    s.created_at,
                    s.updated_at,
                    sv.id AS source_version_id,
                    sv.content_hash,
                    sv.original_path,
                    sv.snapshot_path,
                    sv.parse_artifact_path,
                    sv.status AS version_status,
                    (
                        SELECT bj.status
                        FROM background_jobs bj
                        WHERE bj.target_id = s.id
                        ORDER BY bj.updated_at DESC
                        LIMIT 1
                    ) AS job_status,
                    (
                        SELECT bj.error_message
                        FROM background_jobs bj
                        WHERE bj.target_id = s.id
                        ORDER BY bj.updated_at DESC
                        LIMIT 1
                    ) AS job_error
                FROM sources s
                LEFT JOIN source_versions sv ON sv.id = COALESCE(
                    s.current_version_id,
                    (
                        SELECT latest.id
                        FROM source_versions latest
                        WHERE latest.source_id = s.id
                        ORDER BY latest.version_number DESC
                        LIMIT 1
                    )
                )
                WHERE s.knowledge_base_id = ?
                ORDER BY s.updated_at DESC, s.created_at DESC
                """,
                (knowledge_base_id,),
            ).fetchall()

        items = [self._check_record(row) for row in rows]
        summary = {
            "total": len(items),
            "success": sum(1 for item in items if item["status"] == "success"),
            "needsOcr": sum(1 for item in items if item["status"] == "needs_ocr"),
            "failed": sum(1 for item in items if item["status"] == "failed"),
            "duplicate": sum(1 for item in items if item["status"] == "duplicate"),
            "processing": sum(1 for item in items if item["status"] == "processing"),
        }
        return {"knowledgeBaseId": knowledge_base_id, "summary": summary, "items": items}

    def delete_source(self, source_id: str) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            source = connection.execute(
                """
                SELECT knowledge_base_id, display_name
                FROM sources
                WHERE id = ?
                """,
                (source_id,),
            ).fetchone()
            if source is None:
                raise ValueError("Source not found")

            version_rows = connection.execute(
                """
                SELECT id, original_path, snapshot_path, parse_artifact_path
                FROM source_versions
                WHERE source_id = ?
                """,
                (source_id,),
            ).fetchall()
            source_version_ids = [str(row["id"]) for row in version_rows]
            chunk_rows = (
                connection.execute(
                    """
                    SELECT id, index_version_id
                    FROM chunks
                    WHERE source_version_id IN ({placeholders})
                    """.format(placeholders=",".join("?" for _ in source_version_ids)),
                    tuple(source_version_ids),
                ).fetchall()
                if source_version_ids
                else []
            )
            chunk_ids = [str(row["id"]) for row in chunk_rows]
            index_version_ids = list(
                dict.fromkeys(
                    str(row["index_version_id"])
                    for row in chunk_rows
                    if row["index_version_id"] is not None
                )
            )

            if chunk_ids:
                placeholders = ",".join("?" for _ in chunk_ids)
                connection.execute(
                    f"DELETE FROM answer_citations WHERE chunk_id IN ({placeholders})",
                    tuple(chunk_ids),
                )
                connection.execute(
                    f"DELETE FROM chunks_fts WHERE chunk_id IN ({placeholders})",
                    tuple(chunk_ids),
                )
                connection.execute(
                    f"DELETE FROM chunks WHERE id IN ({placeholders})",
                    tuple(chunk_ids),
                )
            connection.execute("DELETE FROM background_jobs WHERE target_id = ?", (source_id,))
            connection.execute("DELETE FROM sources WHERE id = ?", (source_id,))
            if index_version_ids:
                placeholders = ",".join("?" for _ in index_version_ids)
                connection.execute(
                    f"""
                    UPDATE index_versions
                    SET status = CASE WHEN status = 'ready' THEN 'retired' ELSE status END,
                        is_current = 0
                    WHERE id IN ({placeholders})
                      AND NOT EXISTS (
                          SELECT 1
                          FROM chunks
                          WHERE chunks.index_version_id = index_versions.id
                      )
                    """,
                    tuple(index_version_ids),
                )
            connection.execute(
                """
                UPDATE knowledge_bases
                SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (str(source["knowledge_base_id"]),),
            )
            connection.commit()

        self.storage.vector_index.delete_chunk_ids(chunk_ids)
        _remove_source_files(self.storage, version_rows)
        return {
            "knowledgeBaseId": str(source["knowledge_base_id"]),
            "sourceId": source_id,
            "displayName": str(source["display_name"]),
            "deleted": True,
            "deletedChunkCount": len(chunk_ids),
        }

    def resolve_duplicate(self, source_id: str, action: str) -> dict[str, object]:
        clean_action = _duplicate_resolution(action)
        check = self._check_by_source(source_id)
        if check["status"] != "duplicate":
            raise ValueError("Source is not waiting for a duplicate decision")
        artifact_path = check.get("parseArtifactPath")
        if not isinstance(artifact_path, str) or not artifact_path:
            raise ValueError("Duplicate parse artifact is missing")
        artifact = _read_artifact(artifact_path)
        if not artifact.get("duplicateOfSourceId"):
            raise ValueError("Duplicate source reference is missing")

        original_status = artifact.get("duplicateOriginalStatus")
        version_status = original_status if original_status in {"parsed", "needs_ocr"} else "parsed"
        source_status = "processing"
        if clean_action == "skip":
            version_status = source_status = "skipped"
        elif clean_action == "link":
            version_status = source_status = "linked"
        artifact["duplicateResolution"] = clean_action
        artifact["status"] = version_status
        _write_json(Path(artifact_path), artifact)

        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE sources
                SET status = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (source_status, source_id),
            )
            connection.execute(
                "UPDATE source_versions SET status = ? WHERE source_id = ?",
                (version_status, source_id),
            )
            connection.commit()
        return self._import_result(source_id)

    def _complete_parsed_import(
        self,
        *,
        job_id: str,
        knowledge_base_id: str,
        source_id: str,
        source_version_id: str,
        artifact_path: Path,
        original_hash: str,
        parsed: ParsedDocument,
        snapshot_path: Path | None,
        duplicate_source_id: str | None,
        duplicate_kind: str | None,
        duplicate_action: str,
    ) -> dict[str, object]:
        if not parsed.normalized_text:
            raise ParseFailure("解析结果为空")
        content_hash = _text_hash(parsed.normalized_text)
        if duplicate_source_id is None:
            duplicate_source_id = self._find_duplicate_content(
                knowledge_base_id,
                content_hash,
                excluding_source_id=source_id,
            )
            duplicate_kind = "content" if duplicate_source_id else None

        artifact = _artifact_from_parsed(
            source_id=source_id,
            source_version_id=source_version_id,
            parsed=parsed,
            original_hash=original_hash,
            content_hash=content_hash,
            snapshot_path=snapshot_path,
        )
        if duplicate_source_id:
            original_status = artifact.get("status")
            artifact.update(
                {
                    "status": "duplicate",
                    "duplicateOfSourceId": duplicate_source_id,
                    "duplicateKind": duplicate_kind,
                    "duplicateResolution": None,
                    "duplicateOriginalStatus": original_status,
                }
            )
        _write_json(artifact_path, artifact)
        version_status = "needs_ocr" if parsed.needs_ocr else "parsed"
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE source_versions
                SET content_hash = ?,
                    status = ?,
                    etag = COALESCE(?, etag),
                    last_modified = COALESCE(?, last_modified),
                    checked_at = CASE
                        WHEN ? = 'web' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                        ELSE checked_at
                    END
                WHERE id = ?
                """,
                (
                    content_hash,
                    version_status,
                    parsed.etag,
                    parsed.last_modified,
                    parsed.source_type,
                    source_version_id,
                ),
            )
            connection.execute(
                """
                UPDATE sources
                SET status = 'processing',
                    current_version_id = COALESCE(current_version_id, ?),
                    last_checked_at = CASE
                        WHEN ? = 'web' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                        ELSE last_checked_at
                    END,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (source_version_id, parsed.source_type, source_id),
            )
            connection.commit()

        self.jobs.update_progress(
            job_id,
            status="completed",
            checkpoint=_stage_checkpoint(
                parse=1,
                ocr=0.7 if parsed.needs_ocr else 1,
                embedding=0,
                index=0,
            ),
        )
        self._refresh_organization(source_id)
        if duplicate_source_id:
            self._mark_duplicate(source_id, source_version_id, content_hash=content_hash)
            if duplicate_action != "ask":
                return self.resolve_duplicate(source_id, duplicate_action)
        return self._import_result(source_id)

    def _refresh_organization(self, source_id: str) -> None:
        with suppress(OSError, ValueError, sqlite3.Error):
            self.organizer.details(source_id)

    def _fail_import(
        self,
        *,
        job_id: str,
        source_id: str,
        source_version_id: str,
        artifact_path: Path,
        source_type: str,
        message: str,
    ) -> dict[str, object]:
        artifact: dict[str, object] = {
            "status": "failed",
            "sourceType": source_type,
            "errorMessage": message,
            "chunks": [],
            "originalText": "",
            "normalizedText": "",
        }
        _write_json(artifact_path, artifact)
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE sources
                SET status = 'failed',
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (source_id,),
            )
            connection.execute(
                "UPDATE source_versions SET status = 'failed' WHERE id = ?",
                (source_version_id,),
            )
            connection.commit()
        self.jobs.update_progress(job_id, status="failed", error_message=message)
        return self._import_result(source_id)

    def _import_result(self, source_id: str) -> dict[str, object]:
        check = self._check_by_source(source_id)
        return {"source": check, "parseCheck": check}

    def _check_by_source(self, source_id: str) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                """
                SELECT knowledge_base_id
                FROM sources
                WHERE id = ?
                """,
                (source_id,),
            ).fetchone()
        if row is None:
            raise ValueError("Source not found")
        checks = self.parse_checks(str(row["knowledge_base_id"]))
        items = checks.get("items")
        if isinstance(items, list):
            for item in items:
                if isinstance(item, dict) and item.get("sourceId") == source_id:
                    return item
        raise ValueError("Source not found")

    def _source_with_current_version(self, source_id: str) -> sqlite3.Row:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                """
                SELECT
                    s.id, s.knowledge_base_id, s.source_type, s.display_name, s.uri,
                    s.status, s.current_version_id, s.replacement_source_id,
                    s.review_at, s.expiry_status, s.model_suggestion_json,
                    s.last_checked_at, s.created_at, s.updated_at,
                    sv.id AS source_version_id, sv.version_number, sv.content_hash,
                    sv.parse_artifact_path, sv.etag, sv.last_modified, sv.checked_at
                FROM sources s
                JOIN source_versions sv ON sv.id = COALESCE(
                    s.current_version_id,
                    (
                        SELECT latest.id
                        FROM source_versions latest
                        WHERE latest.source_id = s.id
                        ORDER BY latest.version_number DESC
                        LIMIT 1
                    )
                )
                WHERE s.id = ?
                """,
                (source_id,),
            ).fetchone()
        if row is None:
            raise ValueError("Source not found")
        return cast(sqlite3.Row, row)

    def _mark_web_checked(
        self,
        source_id: str,
        source_version_id: str,
        *,
        checked_at: str,
        etag: str | None,
        last_modified: str | None,
    ) -> None:
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE source_versions
                SET checked_at = ?,
                    etag = COALESCE(?, etag),
                    last_modified = COALESCE(?, last_modified)
                WHERE id = ?
                """,
                (checked_at, etag, last_modified, source_version_id),
            )
            connection.execute(
                "UPDATE sources SET last_checked_at = ? WHERE id = ?",
                (checked_at, source_id),
            )
            connection.commit()

    def _insert_source(
        self,
        *,
        source_id: str,
        knowledge_base_id: str,
        source_type: str,
        display_name: str,
        uri: str | None,
        original_hash: str | None,
        status: str,
    ) -> None:
        with self.storage.database.connect() as connection:
            exists = connection.execute(
                "SELECT 1 FROM knowledge_bases WHERE id = ?",
                (knowledge_base_id,),
            ).fetchone()
            if exists is None:
                raise ValueError("Knowledge base not found")
            connection.execute(
                """
                INSERT INTO sources(
                    id, knowledge_base_id, source_type, display_name, uri, original_hash, status
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    source_id,
                    knowledge_base_id,
                    source_type,
                    display_name,
                    uri,
                    original_hash,
                    status,
                ),
            )
            connection.commit()

    def _insert_source_version(
        self,
        *,
        source_version_id: str,
        source_id: str,
        original_path: Path | None,
        snapshot_path: Path | None,
        parse_artifact_path: Path,
        status: str,
        etag: str | None = None,
        last_modified: str | None = None,
        previous_version_id: str | None = None,
        review_status: str = "current",
    ) -> None:
        with self.storage.database.connect() as connection:
            version = int(
                connection.execute(
                    """
                    SELECT COALESCE(MAX(version_number), 0) + 1
                    FROM source_versions
                    WHERE source_id = ?
                    """,
                    (source_id,),
                ).fetchone()[0]
            )
            connection.execute(
                """
                INSERT INTO source_versions(
                    id, source_id, version_number, original_path, snapshot_path,
                    parse_artifact_path, status, etag, last_modified, checked_at,
                    previous_version_id, review_status
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
                        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)
                """,
                (
                    source_version_id,
                    source_id,
                    version,
                    str(original_path) if original_path else None,
                    str(snapshot_path) if snapshot_path else None,
                    str(parse_artifact_path),
                    status,
                    etag,
                    last_modified,
                    previous_version_id,
                    review_status,
                ),
            )
            connection.commit()

    def _update_source_hash(self, source_id: str, original_hash: str) -> None:
        with self.storage.database.connect() as connection:
            connection.execute(
                "UPDATE sources SET original_hash = ? WHERE id = ?",
                (original_hash, source_id),
            )
            connection.commit()

    def _mark_duplicate(
        self,
        source_id: str,
        source_version_id: str,
        *,
        content_hash: str | None = None,
    ) -> None:
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE sources
                SET status = 'duplicate',
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (source_id,),
            )
            connection.execute(
                """
                UPDATE source_versions
                SET status = 'duplicate',
                    content_hash = COALESCE(?, content_hash)
                WHERE id = ?
                """,
                (content_hash, source_version_id),
            )
            connection.commit()

    def _find_duplicate_original(
        self,
        knowledge_base_id: str,
        original_hash: str,
        *,
        excluding_source_id: str | None = None,
    ) -> str | None:
        return self._find_duplicate(
            """
            SELECT id
            FROM sources
            WHERE knowledge_base_id = ?
              AND original_hash = ?
              AND (? IS NULL OR id != ?)
            ORDER BY created_at ASC
            LIMIT 1
            """,
            (knowledge_base_id, original_hash, excluding_source_id, excluding_source_id),
        )

    def _find_duplicate_content(
        self,
        knowledge_base_id: str,
        content_hash: str,
        *,
        excluding_source_id: str,
    ) -> str | None:
        return self._find_duplicate(
            """
            SELECT s.id
            FROM source_versions sv
            JOIN sources s ON s.id = sv.source_id
            WHERE s.knowledge_base_id = ?
              AND sv.content_hash = ?
              AND s.id != ?
            ORDER BY s.created_at ASC
            LIMIT 1
            """,
            (knowledge_base_id, content_hash, excluding_source_id),
        )

    def _find_duplicate(self, query: str, params: tuple[object, ...]) -> str | None:
        with self.storage.database.connect() as connection:
            row = connection.execute(query, params).fetchone()
        return str(row["id"]) if row is not None else None

    def _duplicate_needs_reparse(self, source_id: str, source_type: str) -> bool:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                """
                SELECT parse_artifact_path
                FROM source_versions
                WHERE source_id = ?
                ORDER BY version_number DESC
                LIMIT 1
                """,
                (source_id,),
            ).fetchone()
        if row is None:
            return False
        artifact = _read_artifact(row["parse_artifact_path"])
        return artifact_contains_raw_pdf_text(source_type, artifact)

    def _duplicate_artifact(
        self,
        *,
        source_type: str,
        duplicate_of_source_id: str,
        original_hash: str,
        content_hash: str | None = None,
    ) -> dict[str, object]:
        return {
            "status": "duplicate",
            "sourceType": source_type,
            "duplicateOfSourceId": duplicate_of_source_id,
            "originalHash": original_hash,
            "contentHash": content_hash,
            "chunks": [],
            "originalText": "",
            "normalizedText": "",
            "errorMessage": "检测到重复来源，未进入索引流程",
        }

    def _check_record(self, row: object) -> dict[str, object]:
        artifact = _read_artifact(row["parse_artifact_path"])  # type: ignore[index]
        version_status = row["version_status"]  # type: ignore[index]
        source_type = str(row["source_type"])  # type: ignore[index]
        source_status = str(row["source_status"])  # type: ignore[index]
        raw_pdf_error = _raw_pdf_artifact_error(source_type, artifact)
        status = (
            "failed"
            if raw_pdf_error
            else _check_status(source_status, str(version_status), artifact)
        )
        raw_chunks = artifact.get("chunks")
        chunks = raw_chunks if isinstance(raw_chunks, list) else []
        preview = "" if raw_pdf_error else _preview_text(artifact)
        return {
            "sourceId": str(row["source_id"]),  # type: ignore[index]
            "sourceVersionId": row["source_version_id"],  # type: ignore[index]
            "sourceType": source_type,
            "displayName": str(row["display_name"]),  # type: ignore[index]
            "uri": row["uri"],  # type: ignore[index]
            "status": status,
            "sourceStatus": source_status,
            "versionStatus": version_status,
            "jobStatus": row["job_status"],  # type: ignore[index]
            "errorMessage": raw_pdf_error or artifact.get("errorMessage") or row["job_error"],  # type: ignore[index]
            "duplicateOfSourceId": artifact.get("duplicateOfSourceId"),
            "duplicateKind": artifact.get("duplicateKind"),
            "duplicateResolution": artifact.get("duplicateResolution"),
            "duplicateActions": ["skip", "keep", "link"] if status == "duplicate" else [],
            "originalHash": row["original_hash"],  # type: ignore[index]
            "contentHash": row["content_hash"],  # type: ignore[index]
            "originalPath": row["original_path"],  # type: ignore[index]
            "snapshotPath": row["snapshot_path"],  # type: ignore[index]
            "parseArtifactPath": row["parse_artifact_path"],  # type: ignore[index]
            "preview": preview,
            "chunkCount": len(chunks),
            "createdAt": str(row["created_at"]),  # type: ignore[index]
            "updatedAt": str(row["updated_at"]),  # type: ignore[index]
        }


class DoclingFirstParser:
    def parse_file(self, path: Path, source_type: str) -> ParsedDocument:
        try:
            return self._parse_with_docling(path, source_type)
        except Exception as error:
            fallback = self._parse_file_fallback(path, source_type, _public_error(error))
            if fallback is not None:
                return fallback
            if isinstance(error, ParseFailure):
                raise
            raise ParseFailure(_public_error(error)) from error

    def parse_web(self, url: str, snapshot_path: Path) -> ParsedDocument:
        extractor = WebTextExtractor()
        try:
            return extractor.parse(url, snapshot_path)
        except ParseFailure:
            raise
        except Exception as error:
            raise ParseFailure(_public_error(error)) from error

    def check_web(
        self,
        url: str,
        snapshot_path: Path,
        *,
        etag: str | None,
        last_modified: str | None,
    ) -> ParsedDocument:
        try:
            return WebTextExtractor().check(
                url,
                snapshot_path,
                etag=etag,
                last_modified=last_modified,
            )
        except ParseFailure:
            raise
        except Exception as error:
            raise ParseFailure(_public_error(error)) from error

    def _parse_with_docling(self, path: Path, source_type: str) -> ParsedDocument:
        try:
            module = importlib.import_module("docling.document_converter")
            converter = module.DocumentConverter()
        except Exception as error:
            raise ParseFailure("Docling 运行时不可用，无法解析 PDF、DOCX 或图片") from error

        result = converter.convert(str(path))
        document = getattr(result, "document", None)
        if document is None:
            raise ParseFailure("Docling 未返回文档对象")
        markdown = _docling_text(document)
        blocks = _docling_blocks(document, source_type)
        if not blocks:
            blocks = [_block(markdown, ParsedLocation(anchor="docling-document"))]
        normalized_text = _normalize_text("\n\n".join(block.normalized_text for block in blocks))
        needs_ocr = source_type == "image" or not normalized_text
        return ParsedDocument(
            parser="docling",
            parser_version=PARSER_VERSION,
            source_type=source_type,
            original_text=markdown,
            normalized_text=normalized_text,
            blocks=blocks,
            needs_ocr=needs_ocr and not normalized_text,
        )

    def _parse_file_fallback(
        self,
        path: Path,
        source_type: str,
        reason: str,
    ) -> ParsedDocument | None:
        warnings = [f"Docling 不可用或解析失败，已使用有限降级解析：{reason}"]
        if source_type == "pdf":
            blocks = _extract_pdf_blocks(path)
            if blocks:
                text = "\n\n".join(block.original_text for block in blocks)
                return ParsedDocument(
                    parser="pypdf-fallback",
                    parser_version=PARSER_VERSION,
                    source_type=source_type,
                    original_text=text,
                    normalized_text=_normalize_text(text),
                    blocks=blocks,
                    warnings=warnings,
                )
            raise ParseFailure(f"Docling 不可用或解析失败：{reason}；PDF 文本提取失败或结果为空")
        if source_type == "docx":
            text = _extract_docx_text(path)
            if text:
                blocks = [
                    _block(paragraph, ParsedLocation(anchor=f"p-{index + 1}"))
                    for index, paragraph in enumerate(_paragraphs(text))
                ]
                return ParsedDocument(
                    parser="docx-xml-fallback",
                    parser_version=PARSER_VERSION,
                    source_type=source_type,
                    original_text=text,
                    normalized_text=_normalize_text(text),
                    blocks=blocks,
                    warnings=warnings,
                )
        if source_type == "docx":
            text = _decode_text_file(path)
            if text:
                blocks = [
                    _block(
                        paragraph,
                        ParsedLocation(
                            page_number=None,
                            heading_path=[],
                            anchor=f"p-{index + 1}",
                        ),
                    )
                    for index, paragraph in enumerate(_paragraphs(text))
                ]
                return ParsedDocument(
                    parser="text-fallback",
                    parser_version=PARSER_VERSION,
                    source_type=source_type,
                    original_text=text,
                    normalized_text=_normalize_text(text),
                    blocks=blocks,
                    warnings=warnings,
                )
        return None


@dataclass(frozen=True, slots=True)
class WebFetch:
    html_text: str | None
    etag: str | None
    last_modified: str | None
    not_modified: bool = False


class WebTextExtractor:
    def parse(self, url: str, snapshot_path: Path) -> ParsedDocument:
        return self.check(url, snapshot_path, etag=None, last_modified=None)

    def check(
        self,
        url: str,
        snapshot_path: Path,
        *,
        etag: str | None,
        last_modified: str | None,
    ) -> ParsedDocument:
        fetched = self._fetch_static(url, etag=etag, last_modified=last_modified)
        if fetched.not_modified:
            return ParsedDocument(
                parser="conditional-http",
                parser_version=PARSER_VERSION,
                source_type="web",
                original_text="",
                normalized_text="",
                blocks=[],
                etag=fetched.etag or etag,
                last_modified=fetched.last_modified or last_modified,
                not_modified=True,
            )
        html_text = fetched.html_text or ""
        snapshot_path.write_text(html_text, encoding="utf-8")
        extracted = _extract_html_text(html_text)
        if len(extracted.normalized_text) < 120 and _looks_dynamic(html_text):
            html_text = self._fetch_with_playwright(url)
            snapshot_path.write_text(html_text, encoding="utf-8")
            extracted = _extract_html_text(html_text)
        if not extracted.normalized_text:
            raise ParseFailure("网页正文提取失败，解析结果为空")
        return ParsedDocument(
            parser=extracted.parser,
            parser_version=PARSER_VERSION,
            source_type="web",
            original_text=extracted.original_text,
            normalized_text=extracted.normalized_text,
            blocks=extracted.blocks,
            snapshot_text=html_text,
            etag=fetched.etag,
            last_modified=fetched.last_modified,
        )

    def _fetch_static(
        self,
        url: str,
        *,
        etag: str | None,
        last_modified: str | None,
    ) -> WebFetch:
        headers = {
            "User-Agent": "citeMind/0.1 document extractor",
            "Accept": "text/html,application/xhtml+xml",
        }
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified
        request = urllib.request.Request(
            url,
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                content_type = response.headers.get("content-type", "")
                if "html" not in content_type and "text" not in content_type:
                    raise ParseFailure(f"网页返回非文本内容：{content_type}")
                body = response.read(5_000_000)
                return WebFetch(
                    html_text=bytes(body).decode("utf-8", errors="replace"),
                    etag=response.headers.get("etag"),
                    last_modified=response.headers.get("last-modified"),
                )
        except urllib.error.HTTPError as error:
            if error.code == 304:
                return WebFetch(
                    html_text=None,
                    etag=error.headers.get("etag"),
                    last_modified=error.headers.get("last-modified"),
                    not_modified=True,
                )
            raise ParseFailure(f"网页抓取失败：HTTP {error.code}") from error
        except urllib.error.URLError as error:
            raise ParseFailure(f"网页抓取失败：{error.reason}") from error

    def _fetch_with_playwright(self, url: str) -> str:
        try:
            module = importlib.import_module("playwright.sync_api")
            sync_playwright = module.sync_playwright
        except Exception as error:
            raise ParseFailure(
                "静态网页正文不足，需要 Playwright 兜底，但 Playwright 运行时不可用"
            ) from error
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                page = browser.new_page()
                page.goto(url, wait_until="networkidle", timeout=20_000)
                content = str(page.content())
                browser.close()
                return content
        except Exception as error:
            raise ParseFailure(f"Playwright 动态网页兜底失败：{_public_error(error)}") from error


@dataclass(frozen=True, slots=True)
class HtmlExtraction:
    parser: str
    original_text: str
    normalized_text: str
    blocks: list[ParsedBlock]


class _ReadableHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._skip_depth = 0
        self._current_tag: str | None = None
        self._buffer: list[str] = []
        self.title = ""
        self.blocks: list[ParsedBlock] = []
        self.heading_path: list[str] = []
        self._block_index = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag in {"title", "h1", "h2", "h3", "h4", "p", "li", "blockquote", "article"}:
            self._flush()
            self._current_tag = tag
            self._buffer = []

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth:
            return
        if tag == self._current_tag:
            self._flush()

    def handle_data(self, data: str) -> None:
        if not self._skip_depth and self._current_tag:
            self._buffer.append(data)

    def _flush(self) -> None:
        if not self._current_tag:
            return
        text = _normalize_text(" ".join(self._buffer))
        tag = self._current_tag
        self._current_tag = None
        self._buffer = []
        if not text:
            return
        if tag == "title" and not self.title:
            self.title = text
            return
        if tag.startswith("h"):
            level = int(tag[1])
            self.heading_path = self.heading_path[: max(level - 1, 0)] + [text]
            return
        self._block_index += 1
        self.blocks.append(
            _block(
                text,
                ParsedLocation(
                    heading_path=list(self.heading_path),
                    anchor=f"block-{self._block_index}",
                ),
            )
        )


def _extract_html_text(html_text: str) -> HtmlExtraction:
    parser = _ReadableHtmlParser()
    parser.feed(html_text)
    parser.close()
    blocks = parser.blocks
    original_text = "\n\n".join(block.original_text for block in blocks)
    normalized_text = _normalize_text(original_text)
    return HtmlExtraction(
        parser="html-body-extractor",
        original_text=original_text,
        normalized_text=normalized_text,
        blocks=blocks,
    )


def _artifact_from_parsed(
    *,
    source_id: str,
    source_version_id: str,
    parsed: ParsedDocument,
    original_hash: str,
    content_hash: str,
    snapshot_path: Path | None,
) -> dict[str, object]:
    return {
        "status": "needs_ocr" if parsed.needs_ocr else "parsed",
        "sourceId": source_id,
        "sourceVersionId": source_version_id,
        "sourceType": parsed.source_type,
        "parser": parsed.parser,
        "parserVersion": parsed.parser_version,
        "originalHash": original_hash,
        "contentHash": content_hash,
        "originalText": parsed.original_text,
        "normalizedText": parsed.normalized_text,
        "snapshotPath": str(snapshot_path) if snapshot_path else None,
        "warnings": parsed.warnings,
        "chunks": [
            {
                "order": index,
                "originalText": block.original_text,
                "normalizedText": block.normalized_text,
                "pageNumber": block.location.page_number,
                "boundingBox": block.location.bounding_box,
                "headingPath": block.location.heading_path,
                "anchor": block.location.anchor,
                "ocrRegions": block.location.ocr_regions,
            }
            for index, block in enumerate(parsed.blocks)
        ],
    }


def _docling_text(document: Any) -> str:
    for method_name in ("export_to_markdown", "export_to_text"):
        method = getattr(document, method_name, None)
        if callable(method):
            value = method()
            if isinstance(value, str):
                return value
    return str(document)


def _docling_blocks(document: Any, source_type: str) -> list[ParsedBlock]:
    iterate_items = getattr(document, "iterate_items", None)
    if not callable(iterate_items):
        return []

    blocks: list[ParsedBlock] = []
    heading_path: list[str] = []
    for index, item_entry in enumerate(iterate_items()):
        item = item_entry[0] if isinstance(item_entry, tuple) and item_entry else item_entry
        text = getattr(item, "text", None)
        if not isinstance(text, str) or not text.strip():
            continue
        label = str(getattr(item, "label", "")).lower()
        if "section_header" in label or label.endswith("title"):
            heading_path = [*heading_path[:2], _normalize_text(text)]
            continue
        page_number, bounding_box = _docling_location(item)
        blocks.append(
            _block(
                text,
                ParsedLocation(
                    page_number=page_number,
                    bounding_box=bounding_box,
                    heading_path=list(heading_path),
                    anchor=f"docling-{index + 1}",
                    ocr_regions=[{"boundingBox": bounding_box}]
                    if source_type == "image" and bounding_box
                    else [],
                ),
            )
        )
    return blocks


def _docling_location(item: Any) -> tuple[int | None, dict[str, float] | None]:
    prov = getattr(item, "prov", None)
    if not isinstance(prov, list) or not prov:
        return None, None
    first = prov[0]
    page_number = getattr(first, "page_no", None)
    bbox = getattr(first, "bbox", None)
    return (
        int(page_number) if isinstance(page_number, int) else None,
        _bbox_dict(bbox),
    )


def _bbox_dict(value: Any) -> dict[str, float] | None:
    if value is None:
        return None
    if all(hasattr(value, key) for key in ("l", "t", "r", "b")):
        left = float(value.l)
        top = float(value.t)
        right = float(value.r)
        bottom = float(value.b)
        return {"x": left, "y": top, "width": right - left, "height": bottom - top}
    if isinstance(value, dict):
        return {
            "x": _floatish(value.get("x", value.get("left", 0))),
            "y": _floatish(value.get("y", value.get("top", 0))),
            "width": _floatish(value.get("width", 0)),
            "height": _floatish(value.get("height", 0)),
        }
    return None


def _floatish(value: object) -> float:
    if isinstance(value, int | float | str):
        return float(value)
    return 0.0


def _read_artifact(path_value: object) -> dict[str, object]:
    if not isinstance(path_value, str) or not path_value:
        return {}
    path = Path(path_value)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_json(path: Path, value: dict[str, object]) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def _block(text: str, location: ParsedLocation) -> ParsedBlock:
    normalized = _normalize_text(text)
    return ParsedBlock(original_text=text.strip(), normalized_text=normalized, location=location)


def _paragraphs(text: str) -> list[str]:
    return [part for part in re.split(r"\n{2,}", _normalize_text(text)) if part]


def _normalize_text(text: str) -> str:
    text = html.unescape(text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _text_hash(text: str) -> str:
    return hashlib.sha256(_normalize_text(text).encode("utf-8")).hexdigest()


def _version_change_summary(
    before: dict[str, object],
    after: dict[str, object],
) -> dict[str, object]:
    before_blocks = _artifact_blocks(before)
    after_blocks = _artifact_blocks(after)
    matcher = SequenceMatcher(a=before_blocks, b=after_blocks, autojunk=False)
    added = removed = unchanged = changed = 0
    for tag, before_start, before_end, after_start, after_end in matcher.get_opcodes():
        if tag == "equal":
            unchanged += before_end - before_start
        elif tag == "insert":
            added += after_end - after_start
        elif tag == "delete":
            removed += before_end - before_start
        else:
            changed += max(before_end - before_start, after_end - after_start)
            removed += before_end - before_start
            added += after_end - after_start
    return {
        "addedBlocks": added,
        "removedBlocks": removed,
        "changedBlocks": changed,
        "unchangedBlocks": unchanged,
        "beforeBlockCount": len(before_blocks),
        "afterBlockCount": len(after_blocks),
    }


def _artifact_blocks(artifact: dict[str, object]) -> list[str]:
    raw_blocks = artifact.get("chunks")
    if not isinstance(raw_blocks, list):
        return []
    return [
        _normalize_text(str(block.get("normalizedText", "")))
        for block in raw_blocks
        if isinstance(block, dict) and block.get("normalizedText")
    ]


def _artifact_text(artifact: dict[str, object]) -> str:
    return "\n\n".join(_artifact_blocks(artifact))


def _source_maintenance_record(row: object) -> dict[str, object]:
    return {
        "id": str(row["id"]),  # type: ignore[index]
        "knowledgeBaseId": str(row["knowledge_base_id"]),  # type: ignore[index]
        "sourceType": str(row["source_type"]),  # type: ignore[index]
        "displayName": str(row["display_name"]),  # type: ignore[index]
        "uri": row["uri"],  # type: ignore[index]
        "status": str(row["status"]),  # type: ignore[index]
        "currentVersionId": row["current_version_id"],  # type: ignore[index]
        "currentVersionNumber": int(row["version_number"]),  # type: ignore[index]
        "replacementSourceId": row["replacement_source_id"],  # type: ignore[index]
        "reviewAt": row["review_at"],  # type: ignore[index]
        "expiryStatus": str(row["expiry_status"]),  # type: ignore[index]
        "modelSuggestion": _json_object(row["model_suggestion_json"]) or None,  # type: ignore[index]
        "lastCheckedAt": row["last_checked_at"],  # type: ignore[index]
        "createdAt": str(row["created_at"]),  # type: ignore[index]
        "updatedAt": str(row["updated_at"]),  # type: ignore[index]
    }


def _source_version_record(row: object) -> dict[str, object]:
    return {
        "id": str(row["id"]),  # type: ignore[index]
        "versionNumber": int(row["version_number"]),  # type: ignore[index]
        "contentHash": row["content_hash"],  # type: ignore[index]
        "originalPath": row["original_path"],  # type: ignore[index]
        "snapshotPath": row["snapshot_path"],  # type: ignore[index]
        "parseArtifactPath": row["parse_artifact_path"],  # type: ignore[index]
        "status": str(row["status"]),  # type: ignore[index]
        "etag": row["etag"],  # type: ignore[index]
        "lastModified": row["last_modified"],  # type: ignore[index]
        "checkedAt": row["checked_at"],  # type: ignore[index]
        "previousVersionId": row["previous_version_id"],  # type: ignore[index]
        "reviewStatus": str(row["review_status"]),  # type: ignore[index]
        "changeSummary": _json_object(row["change_summary_json"]),  # type: ignore[index]
        "createdAt": str(row["created_at"]),  # type: ignore[index]
    }


def _json_object(value: object) -> dict[str, object]:
    if not isinstance(value, str) or not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _optional_string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _source_type_for_path(path: Path) -> str:
    source_type = SUPPORTED_FILE_TYPES.get(path.suffix.lower())
    if source_type is None:
        raise ValueError("Unsupported source type")
    return source_type


def _object_path(
    storage: StorageRuntime,
    knowledge_base_id: str,
    source_id: str,
    filename: str,
) -> Path:
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", filename).strip("_") or "source"
    return storage.paths.objects / knowledge_base_id / source_id / safe_name


def _artifact_path(storage: StorageRuntime, source_version_id: str) -> Path:
    return storage.paths.artifacts / f"{source_version_id}.json"


def _remove_source_files(storage: StorageRuntime, version_rows: Iterable[Any]) -> None:
    object_directories: set[Path] = set()
    for row in version_rows:
        original_path = row["original_path"]
        for key in ("original_path", "snapshot_path", "parse_artifact_path"):
            value = row[key]
            if value:
                with suppress(OSError):
                    Path(str(value)).unlink(missing_ok=True)
        if original_path:
            parent = Path(str(original_path)).parent
            if parent.is_relative_to(storage.paths.objects):
                object_directories.add(parent)
    for directory in object_directories:
        shutil.rmtree(directory, ignore_errors=True)


def _clean_url(url: str) -> str:
    clean = url.strip()
    if not clean.startswith(("http://", "https://")):
        raise ValueError("网页链接必须以 http:// 或 https:// 开头")
    return clean


def _decode_text_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="ignore")


def _extract_pdf_blocks(path: Path) -> list[ParsedBlock]:
    try:
        module = importlib.import_module("pypdf")
        reader = module.PdfReader(str(path))
    except Exception:
        return []

    blocks: list[ParsedBlock] = []
    for page_index, page in enumerate(reader.pages):
        try:
            page_text = page.extract_text() or ""
        except Exception:
            page_text = ""
        bounding_box = _pdf_page_bounding_box(page)
        for paragraph_index, paragraph in enumerate(_paragraphs(page_text)):
            blocks.append(
                _block(
                    paragraph,
                    ParsedLocation(
                        page_number=page_index + 1,
                        bounding_box=bounding_box,
                        anchor=f"page-{page_index + 1}-p-{paragraph_index + 1}",
                    ),
                )
            )
    return blocks


def _pdf_page_bounding_box(page: Any) -> dict[str, float] | None:
    media_box = getattr(page, "mediabox", None)
    width = getattr(media_box, "width", None)
    height = getattr(media_box, "height", None)
    if width is None or height is None:
        return None
    try:
        return {
            "x": 0.0,
            "y": 0.0,
            "width": float(str(width)),
            "height": float(str(height)),
        }
    except (TypeError, ValueError):
        return None


def _extract_docx_text(path: Path) -> str:
    try:
        with zipfile.ZipFile(path) as archive:
            xml = archive.read("word/document.xml").decode("utf-8", errors="replace")
    except (KeyError, OSError, zipfile.BadZipFile):
        return ""
    text = re.sub(r"</w:p>", "\n\n", xml)
    text = re.sub(r"<[^>]+>", "", text)
    return _normalize_text(text)


def _looks_dynamic(html_text: str) -> bool:
    script_count = html_text.lower().count("<script")
    visible_text = _extract_html_text(html_text).normalized_text
    return script_count >= 3 or len(visible_text) < 80


def _check_status(
    source_status: str,
    version_status: str,
    artifact: dict[str, object],
) -> str:
    artifact_status = artifact.get("status")
    if artifact_status == "duplicate" or source_status == "duplicate":
        return "duplicate"
    if source_status in {"skipped", "linked"}:
        return source_status
    if artifact_status == "failed" or source_status == "failed" or version_status == "failed":
        return "failed"
    if artifact_status == "needs_ocr" or version_status == "needs_ocr":
        return "needs_ocr"
    if artifact_status == "parsed" or version_status == "parsed":
        return "success"
    return "processing"


def _preview_text(artifact: dict[str, object]) -> str:
    chunks = artifact.get("chunks")
    if isinstance(chunks, list) and chunks:
        first = chunks[0]
        if isinstance(first, dict) and isinstance(first.get("normalizedText"), str):
            return str(first["normalizedText"])[:240]
    normalized_text = artifact.get("normalizedText")
    if isinstance(normalized_text, str):
        return normalized_text[:240]
    return ""


def _raw_pdf_artifact_error(source_type: str, artifact: dict[str, object]) -> str | None:
    if not artifact_contains_raw_pdf_text(source_type, artifact):
        return None
    return "PDF 解析结果疑似原始文件内容，请重新导入该 PDF"


def artifact_contains_raw_pdf_text(source_type: str, artifact: dict[str, object]) -> bool:
    if source_type != "pdf":
        return False
    return any(_looks_like_raw_pdf_text(text) for text in _artifact_text_values(artifact))


def _artifact_text_values(artifact: dict[str, object]) -> list[str]:
    values: list[str] = []
    for key in ("normalizedText", "originalText"):
        value = artifact.get(key)
        if isinstance(value, str):
            values.append(value)
    chunks = artifact.get("chunks")
    if isinstance(chunks, list):
        for chunk in chunks:
            if not isinstance(chunk, dict):
                continue
            for key in ("normalizedText", "originalText"):
                value = chunk.get(key)
                if isinstance(value, str):
                    values.append(value)
    return values


def _looks_like_raw_pdf_text(text: str) -> bool:
    sample = text[:2000].lstrip()
    if sample.startswith("%PDF-"):
        return True
    control_count = sum(
        1 for character in sample if ord(character) < 32 and character not in "\n\r\t"
    )
    return control_count > max(8, len(sample) // 20)


def _stage_checkpoint(
    *,
    parse: float,
    ocr: float,
    embedding: float,
    index: float,
) -> dict[str, object]:
    values = {
        "parse": ("解析", parse),
        "ocr": ("OCR", ocr),
        "embedding": ("Embedding", embedding),
        "index": ("索引", index),
    }
    return {
        "stages": [
            {
                "id": stage_id,
                "label": label,
                "status": "completed"
                if progress >= 1
                else "running"
                if progress > 0
                else "pending",
                "progress": progress,
            }
            for stage_id, (label, progress) in values.items()
        ]
    }


def _public_error(error: Exception) -> str:
    message = str(error).strip()
    return message or error.__class__.__name__


def _duplicate_action(value: str) -> str:
    if value not in {"ask", "skip", "keep", "link"}:
        raise ValueError("duplicateAction must be ask, skip, keep, or link")
    return value


def _duplicate_resolution(value: str) -> str:
    if value not in {"skip", "keep", "link"}:
        raise ValueError("Duplicate resolution must be skip, keep, or link")
    return value


def supported_file_extensions() -> Iterable[str]:
    return sorted(SUPPORTED_FILE_TYPES)
