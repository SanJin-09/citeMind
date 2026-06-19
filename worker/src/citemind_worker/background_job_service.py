import json
from collections.abc import Callable, Iterable
from typing import Literal, cast
from uuid import uuid4

from citemind_worker.storage import StorageRuntime

JobStatus = Literal[
    "pending",
    "running",
    "completed",
    "paused",
    "cancelled",
    "failed",
    "retrying",
]

JOB_STATUSES: set[str] = {
    "pending",
    "running",
    "completed",
    "paused",
    "cancelled",
    "failed",
    "retrying",
}

JOB_STAGES: tuple[str, ...] = ("parse", "ocr", "embedding", "index")

TERMINAL_STATUSES = {"completed", "cancelled"}
UNFINISHED_STATUSES = {"pending", "running", "paused", "failed", "retrying"}

ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "pending": {"running", "paused", "cancelled", "failed"},
    "running": {"completed", "paused", "cancelled", "failed", "retrying"},
    "completed": set(),
    "paused": {"pending", "running", "cancelled", "failed"},
    "cancelled": set(),
    "failed": {"retrying", "cancelled"},
    "retrying": {"running", "paused", "cancelled", "failed"},
}

JobEventSink = Callable[[dict[str, object]], None]


class BackgroundJobService:
    def __init__(
        self,
        storage: StorageRuntime,
        *,
        event_sink: JobEventSink | None = None,
    ) -> None:
        self.storage = storage
        self._event_sink = event_sink

    def set_event_sink(self, event_sink: JobEventSink | None) -> None:
        self._event_sink = event_sink

    def create(
        self,
        job_type: str,
        target_id: str,
        *,
        checkpoint: dict[str, object] | None = None,
    ) -> dict[str, object]:
        clean_job_type = _required_text(job_type, "jobType")
        clean_target_id = _required_text(target_id, "targetId")
        job_id = f"job-{uuid4().hex}"
        normalized_checkpoint = self._normalize_checkpoint(checkpoint, progress=0.0)
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO background_jobs(
                    id, job_type, target_id, status, progress, checkpoint_json
                )
                VALUES (?, ?, ?, 'pending', 0, ?)
                """,
                (
                    job_id,
                    clean_job_type,
                    clean_target_id,
                    json.dumps(normalized_checkpoint, ensure_ascii=False),
                ),
            )
            connection.commit()
        job = self.get(job_id)
        self._emit_job(job)
        return job

    def list_jobs(
        self,
        *,
        status: str | None = None,
        target_id: str | None = None,
        include_terminal: bool = True,
        limit: int = 50,
    ) -> dict[str, object]:
        if status is not None and status not in JOB_STATUSES:
            raise ValueError("Invalid job status")
        if limit < 1 or limit > 200:
            raise ValueError("limit must be between 1 and 200")

        clauses: list[str] = []
        params: list[object] = []
        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        if target_id is not None:
            clauses.append("target_id = ?")
            params.append(target_id)
        if not include_terminal:
            clauses.append("status NOT IN ('completed', 'cancelled')")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(limit)

        with self.storage.database.connect() as connection:
            rows = connection.execute(
                f"""
                SELECT *
                FROM background_jobs
                {where}
                ORDER BY updated_at DESC, created_at DESC
                LIMIT ?
                """,
                params,
            ).fetchall()
        return {"jobs": [self._record(row) for row in rows]}

    def list_unfinished(self) -> dict[str, object]:
        return self.list_jobs(include_terminal=False, limit=200)

    def get(self, job_id: str) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM background_jobs WHERE id = ?",
                (job_id,),
            ).fetchone()
        if row is None:
            raise ValueError("Background job not found")
        return self._record(row)

    def update_progress(
        self,
        job_id: str,
        *,
        status: str | None = None,
        progress: float | None = None,
        checkpoint: dict[str, object] | None = None,
        error_message: str | None = None,
    ) -> dict[str, object]:
        current = self.get(job_id)
        next_status = status or str(current["status"])
        if next_status not in JOB_STATUSES:
            raise ValueError("Invalid job status")
        _ensure_transition(str(current["status"]), next_status)

        next_progress = (
            cast(float, current["progress"]) if progress is None else _progress(progress)
        )
        if next_status == "completed":
            next_progress = 1.0

        current_checkpoint = _as_dict(current["checkpoint"])
        merged_checkpoint = {
            **current_checkpoint,
            **(checkpoint or {}),
        }
        normalized_checkpoint = self._normalize_checkpoint(
            merged_checkpoint,
            progress=next_progress,
        )
        retry_count = cast(int, current["retryCount"]) + (1 if next_status == "retrying" else 0)
        clean_error = error_message
        if clean_error is None and next_status not in {"failed", "retrying"}:
            clean_error = None

        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE background_jobs
                SET status = ?,
                    progress = ?,
                    checkpoint_json = ?,
                    retry_count = ?,
                    error_message = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (
                    next_status,
                    next_progress,
                    json.dumps(normalized_checkpoint, ensure_ascii=False),
                    retry_count,
                    clean_error,
                    job_id,
                ),
            )
            connection.commit()
        job = self.get(job_id)
        self._emit_job(job)
        return job

    def pause(self, job_id: str) -> dict[str, object]:
        return self.update_progress(job_id, status="paused")

    def resume(self, job_id: str) -> dict[str, object]:
        current = self.get(job_id)
        status = str(current["status"])
        if status == "failed":
            next_status = "retrying"
        elif status in {"pending", "retrying"}:
            next_status = "running"
        else:
            next_status = "pending"
        return self.update_progress(job_id, status=next_status)

    def cancel(self, job_id: str) -> dict[str, object]:
        return self.update_progress(job_id, status="cancelled")

    def retry(self, job_id: str) -> dict[str, object]:
        current = self.get(job_id)
        if current["status"] != "failed":
            raise ValueError("Only failed jobs can be retried")
        return self.update_progress(job_id, status="retrying")

    def recover_unfinished(self) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT id, status
                FROM background_jobs
                WHERE status IN ('pending', 'running', 'paused', 'failed', 'retrying')
                ORDER BY updated_at DESC, created_at DESC
                """
            ).fetchall()
            recovered: list[dict[str, object]] = []
            for row in rows:
                status = str(row["status"])
                next_status = "paused" if status in {"running", "retrying"} else status
                if next_status != status:
                    connection.execute(
                        """
                        UPDATE background_jobs
                        SET status = ?,
                            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                        WHERE id = ?
                        """,
                        (next_status, str(row["id"])),
                    )
                recovered.append({"jobId": str(row["id"]), "status": next_status})
            connection.commit()
        jobs = [self.get(str(item["jobId"])) for item in recovered]
        for job in jobs:
            self._emit_job(job)
        return {"jobs": jobs}

    def _normalize_checkpoint(
        self,
        checkpoint: dict[str, object] | None,
        *,
        progress: float,
    ) -> dict[str, object]:
        values = dict(checkpoint or {})
        values["stages"] = _normalize_stages(values.get("stages"), progress=progress)
        return values

    def _record(self, row: object) -> dict[str, object]:
        checkpoint = _load_checkpoint(row["checkpoint_json"])  # type: ignore[index]
        return {
            "id": str(row["id"]),  # type: ignore[index]
            "jobType": str(row["job_type"]),  # type: ignore[index]
            "targetId": str(row["target_id"]),  # type: ignore[index]
            "status": str(row["status"]),  # type: ignore[index]
            "progress": float(row["progress"]),  # type: ignore[index]
            "checkpoint": checkpoint,
            "retryCount": int(row["retry_count"]),  # type: ignore[index]
            "errorMessage": row["error_message"],  # type: ignore[index]
            "createdAt": str(row["created_at"]),  # type: ignore[index]
            "updatedAt": str(row["updated_at"]),  # type: ignore[index]
        }

    def _emit_job(self, job: dict[str, object]) -> None:
        if self._event_sink is not None:
            self._event_sink(job)


def _normalize_stages(value: object, *, progress: float) -> list[dict[str, object]]:
    if isinstance(value, list):
        stages = [_normalize_stage(item) for item in value if isinstance(item, dict)]
    else:
        stages = []

    by_id = {str(stage["id"]): stage for stage in stages}
    if not by_id:
        weighted = progress * len(JOB_STAGES)
        for index, stage_id in enumerate(JOB_STAGES):
            stage_progress = min(1.0, max(0.0, weighted - index))
            by_id[stage_id] = {
                "id": stage_id,
                "label": _stage_label(stage_id),
                "status": _stage_status(stage_progress, progress),
                "progress": stage_progress,
            }
    return [by_id.get(stage_id, _default_stage(stage_id)) for stage_id in JOB_STAGES]


def _normalize_stage(value: dict[object, object]) -> dict[str, object]:
    stage_id = str(value.get("id", ""))
    if stage_id not in JOB_STAGES:
        stage_id = "parse"
    progress = _progress(value.get("progress", 0))
    status = value.get("status")
    return {
        "id": stage_id,
        "label": str(value.get("label") or _stage_label(stage_id)),
        "status": str(status) if isinstance(status, str) and status else _stage_status(progress, 0),
        "progress": progress,
    }


def _default_stage(stage_id: str) -> dict[str, object]:
    return {"id": stage_id, "label": _stage_label(stage_id), "status": "pending", "progress": 0}


def _stage_label(stage_id: str) -> str:
    labels = {
        "parse": "解析",
        "ocr": "OCR",
        "embedding": "Embedding",
        "index": "索引",
    }
    return labels[stage_id]


def _stage_status(progress: float, job_progress: float) -> str:
    if progress >= 1:
        return "completed"
    if progress > 0 or job_progress > 0:
        return "running"
    return "pending"


def _load_checkpoint(value: object) -> dict[str, object]:
    if not isinstance(value, str) or not value:
        return {"stages": [_default_stage(stage_id) for stage_id in JOB_STAGES]}
    try:
        loaded = json.loads(value)
    except json.JSONDecodeError:
        return {"stages": [_default_stage(stage_id) for stage_id in JOB_STAGES]}
    return _as_dict(loaded)


def _as_dict(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def _required_text(value: str, label: str) -> str:
    clean = value.strip()
    if not clean:
        raise ValueError(f"{label} is required")
    return clean


def _progress(value: object) -> float:
    if not isinstance(value, int | float):
        raise ValueError("progress must be a number")
    if value < 0 or value > 1:
        raise ValueError("progress must be between 0 and 1")
    return float(value)


def _ensure_transition(current: str, next_status: str) -> None:
    if current == next_status:
        return
    if next_status not in ALLOWED_TRANSITIONS.get(current, set()):
        raise ValueError(f"Invalid job status transition: {current} -> {next_status}")


def active_statuses() -> Iterable[str]:
    return sorted(UNFINISHED_STATUSES)
