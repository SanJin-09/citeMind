import json
import sqlite3
from collections.abc import Mapping
from contextlib import suppress
from uuid import uuid4

from citemind_worker.storage import StorageRuntime


def record_metric(
    storage: StorageRuntime,
    name: str,
    value: int | float,
    unit: str,
    *,
    knowledge_base_id: str | None = None,
    labels: Mapping[str, object] | None = None,
) -> None:
    with suppress(sqlite3.Error), storage.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO quality_metrics(
                id, knowledge_base_id, metric_name, metric_value, unit, labels_json
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                f"metric-{uuid4().hex}",
                knowledge_base_id,
                name,
                float(value),
                unit,
                json.dumps(labels or {}, ensure_ascii=False),
            ),
        )
        connection.commit()


def quality_summary(
    storage: StorageRuntime,
    knowledge_base_id: str | None = None,
) -> dict[str, object]:
    with storage.database.connect() as connection:
        rows = connection.execute(
            """
            SELECT metric_name, COUNT(*) AS sample_count,
                   AVG(metric_value) AS average_value,
                   SUM(metric_value) AS total_value
            FROM quality_metrics
            WHERE ? IS NULL OR knowledge_base_id = ?
            GROUP BY metric_name
            """,
            (knowledge_base_id, knowledge_base_id),
        ).fetchall()
    metrics = {
        str(row["metric_name"]): {
            "samples": int(row["sample_count"]),
            "average": float(row["average_value"]),
            "total": float(row["total_value"]),
        }
        for row in rows
    }
    return {
        "parseSuccessRate": _average(metrics, "parse.success"),
        "indexDurationMs": _average(metrics, "index.duration_ms"),
        "retrievalLatencyMs": _average(metrics, "retrieval.latency_ms"),
        "firstTokenLatencyMs": _average(metrics, "answer.first_token_latency_ms"),
        "citationFailureRate": _average(metrics, "citation.validation_failure"),
        "embeddingCalls": _integer_total(metrics, "embedding.calls"),
        "embeddingTexts": _integer_total(metrics, "embedding.texts"),
        "embeddingRetries": _integer_total(metrics, "embedding.retries"),
        "embeddingInputCharacters": _integer_total(metrics, "embedding.input_characters"),
    }


def _average(metrics: dict[str, dict[str, float | int]], name: str) -> float | None:
    value = metrics.get(name)
    return float(value["average"]) if value else None


def _integer_total(metrics: dict[str, dict[str, float | int]], name: str) -> int:
    value = metrics.get(name)
    return round(float(value["total"])) if value else 0
