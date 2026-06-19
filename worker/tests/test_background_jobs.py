from pathlib import Path

import pytest

from citemind_worker.background_job_service import BackgroundJobService
from citemind_worker.storage import StorageRuntime


def test_background_job_persists_progress_checkpoint_retries_and_error(
    tmp_path: Path,
) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    emitted: list[dict[str, object]] = []
    service = BackgroundJobService(storage, event_sink=emitted.append)

    created = service.create("source.import", "source-1")

    assert created["status"] == "pending"
    assert created["progress"] == 0
    assert created["retryCount"] == 0
    assert created["errorMessage"] is None
    assert len(created["checkpoint"]["stages"]) == 4

    running = service.update_progress(
        str(created["id"]),
        status="running",
        progress=0.5,
        checkpoint={
            "cursor": "page-4",
            "stages": [
                {"id": "parse", "label": "解析", "status": "completed", "progress": 1},
                {"id": "ocr", "label": "OCR", "status": "running", "progress": 0.4},
            ],
        },
    )

    assert running["status"] == "running"
    assert running["progress"] == 0.5
    assert running["checkpoint"]["cursor"] == "page-4"
    assert running["checkpoint"]["stages"][0]["status"] == "completed"

    failed = service.update_progress(
        str(created["id"]),
        status="failed",
        error_message="Docling parse failed",
    )
    retrying = service.retry(str(created["id"]))

    assert failed["errorMessage"] == "Docling parse failed"
    assert retrying["status"] == "retrying"
    assert retrying["retryCount"] == 1
    assert [job["status"] for job in emitted] == [
        "pending",
        "running",
        "failed",
        "retrying",
    ]


def test_background_job_recovery_pauses_orphaned_running_jobs(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    emitted: list[dict[str, object]] = []
    service = BackgroundJobService(storage, event_sink=emitted.append)
    job = service.create("index.rebuild", "kb-1")
    service.update_progress(str(job["id"]), status="running", progress=0.2)

    recovered = service.recover_unfinished()

    assert recovered["jobs"][0]["id"] == job["id"]
    assert recovered["jobs"][0]["status"] == "paused"
    assert service.list_unfinished()["jobs"][0]["status"] == "paused"
    assert emitted[-1]["status"] == "paused"


def test_background_job_rejects_invalid_transitions(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    service = BackgroundJobService(storage)
    job = service.create("embedding", "source-version-1")
    service.update_progress(str(job["id"]), status="running")
    service.update_progress(str(job["id"]), status="completed")

    with pytest.raises(ValueError, match="Invalid job status transition"):
        service.cancel(str(job["id"]))
