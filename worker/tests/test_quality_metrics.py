from pathlib import Path

from citemind_worker.quality_metrics import quality_summary, record_metric
from citemind_worker.storage import StorageRuntime


def test_quality_metrics_aggregate_rates_latencies_and_embedding_usage(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()

    for value in (1, 1, 0):
        record_metric(storage, "parse.success", value, "ratio")
    for value in (100, 300):
        record_metric(storage, "retrieval.latency_ms", value, "ms")
    record_metric(storage, "embedding.calls", 4, "calls")
    record_metric(storage, "embedding.retries", 1, "retries")

    summary = quality_summary(storage)

    assert summary["parseSuccessRate"] == 2 / 3
    assert summary["retrievalLatencyMs"] == 200
    assert summary["embeddingCalls"] == 4
    assert summary["embeddingRetries"] == 1
