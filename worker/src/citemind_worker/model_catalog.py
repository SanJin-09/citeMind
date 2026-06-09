from dataclasses import asdict, dataclass

DEFAULT_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
DEFAULT_CREDENTIAL_ID = "default"
DEFAULT_CHAT_MODEL = "doubao-seed-2-0-lite-260428"
QUALITY_CHAT_MODEL = "doubao-seed-2-0-pro-260215"
DEFAULT_EMBEDDING_MODEL = "doubao-embedding-vision-251215"


@dataclass(frozen=True, slots=True)
class SeedModel:
    id: str
    label: str
    role: str
    api: str
    context_window: int | None
    vector_dimension: int | None
    capabilities: tuple[str, ...]

    def as_record(self) -> dict[str, object]:
        record = asdict(self)
        record["contextWindow"] = record.pop("context_window")
        record["vectorDimension"] = record.pop("vector_dimension")
        record["capabilities"] = list(self.capabilities)
        return record


SEED_MODEL_CATALOG: tuple[SeedModel, ...] = (
    SeedModel(
        id=DEFAULT_CHAT_MODEL,
        label="默认对话",
        role="default_chat",
        api="responses",
        context_window=256_000,
        vector_dimension=None,
        capabilities=("chat", "vision", "structured_output", "streaming"),
    ),
    SeedModel(
        id=QUALITY_CHAT_MODEL,
        label="高质量对话",
        role="quality_chat",
        api="responses",
        context_window=256_000,
        vector_dimension=None,
        capabilities=("chat", "vision", "structured_output", "streaming"),
    ),
    SeedModel(
        id=DEFAULT_EMBEDDING_MODEL,
        label="Embedding",
        role="embedding",
        api="multimodal_embeddings",
        context_window=None,
        vector_dimension=2048,
        capabilities=("embedding", "vision_embedding"),
    ),
)


def seed_model_catalog_records() -> list[dict[str, object]]:
    return [model.as_record() for model in SEED_MODEL_CATALOG]


def context_window_for(model_id: str) -> int:
    for model in SEED_MODEL_CATALOG:
        if model.id == model_id and model.context_window:
            return model.context_window
    return 32_000
