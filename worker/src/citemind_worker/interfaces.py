from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Protocol

Record = Mapping[str, object]


class DocumentRepository(Protocol):
    async def get_source(self, source_id: str) -> Record | None: ...

    async def save_chunks(self, chunks: Sequence[Record]) -> None: ...


class IngestionPipeline(Protocol):
    async def ingest(self, source_id: str) -> str: ...


class IndexVersionManager(Protocol):
    async def current(self, knowledge_base_id: str) -> Record | None: ...

    async def publish(self, index_version_id: str) -> None: ...


class HybridRetriever(Protocol):
    async def retrieve(self, knowledge_base_id: str, query: str) -> Sequence[Record]: ...


class CitationValidator(Protocol):
    async def validate(self, answer: Record, candidate_chunk_ids: Sequence[str]) -> Record: ...


class BackgroundJobManager(Protocol):
    async def enqueue(self, job_type: str, target_id: str) -> str: ...


class ModelGateway(Protocol):
    async def validate_model(self, model_id: str, role: str) -> Record: ...

    def stream_answer(self, request: Record) -> AsyncIterator[Record]: ...

    async def generate_structured(self, request: Record, schema: Record) -> Record: ...

    async def embed(self, texts: Sequence[str]) -> Sequence[Sequence[float]]: ...
