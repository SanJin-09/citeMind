import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime
from time import monotonic
from typing import Any

from volcenginesdkarkruntime import Ark  # type: ignore[import-untyped]
from volcenginesdkarkruntime._exceptions import (  # type: ignore[import-untyped]
    ArkAPIConnectionError,
    ArkAPIError,
    ArkAPITimeoutError,
    ArkAuthenticationError,
    ArkBadRequestError,
    ArkNotFoundError,
    ArkPermissionDeniedError,
    ArkRateLimitError,
)

from citemind_worker.model_catalog import DEFAULT_ARK_BASE_URL, DEFAULT_EMBEDDING_MODEL

ARK_DEMO_IMAGE_URL = "https://ark-project.tos-cn-beijing.volces.com/doc_image/ark_demo_img_1.png"


class ArkModelGateway:
    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_ARK_BASE_URL,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
        timeout: int = 45,
        max_retries: int = 1,
        embedding_batch_size: int = 4,
        embedding_min_interval_seconds: float = 0.05,
        embedding_max_attempts: int = 3,
        client: Any | None = None,
    ) -> None:
        if not api_key.strip():
            raise ValueError("Ark API Key is required")
        self.embedding_model = embedding_model
        self.embedding_batch_size = max(1, embedding_batch_size)
        self.embedding_min_interval_seconds = max(0, embedding_min_interval_seconds)
        self.embedding_max_attempts = max(1, embedding_max_attempts)
        self.last_embedding_stats: dict[str, int] = {
            "batches": 0,
            "calls": 0,
            "texts": 0,
            "retries": 0,
        }
        self._embedding_rate_lock = asyncio.Lock()
        self._last_embedding_started_at = 0.0
        self.client = client or Ark(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
        )

    async def validate_model(self, model_id: str, role: str) -> dict[str, object]:
        checked_at = datetime.now(UTC).isoformat()
        try:
            if role in {"default_chat", "quality_chat"}:
                capability = self._probe_chat_model(model_id)
            elif role == "embedding":
                capability = self._probe_embedding_model(model_id)
            else:
                raise ValueError(f"Unsupported model role: {role}")
        except Exception as error:
            return {
                "modelId": model_id,
                "role": role,
                "status": _status_for_error(error),
                "message": _public_error_message(error),
                "capability": {},
                "checkedAt": checked_at,
            }

        return {
            "modelId": model_id,
            "role": role,
            "status": "callable",
            "message": "模型可调用",
            "capability": capability,
            "checkedAt": checked_at,
        }

    def stream_answer(self, request: dict[str, object]) -> AsyncIterator[dict[str, object]]:
        async def iterator() -> AsyncIterator[dict[str, object]]:
            model = _required_str(request, "model")
            messages = request.get("messages")
            if not isinstance(messages, list):
                raise ValueError("messages must be a list")
            max_tokens = _optional_int(request, "max_output_tokens", 0)
            payload: dict[str, object] = {
                "model": model,
                "messages": messages,
                "stream": True,
            }
            if max_tokens > 0:
                payload["max_tokens"] = max_tokens
            stream = self.client.chat.completions.create(**payload)
            for chunk in stream:
                text = _extract_chat_delta(chunk)
                if text:
                    yield {"type": "delta", "text": text}

        return iterator()

    async def generate_structured(
        self, request: dict[str, object], schema: dict[str, object]
    ) -> dict[str, object]:
        model = _required_str(request, "model")
        prompt = _required_str(request, "prompt")
        max_tokens = _optional_int(request, "max_output_tokens", 512)
        native_error: Exception | None = None
        try:
            response = self.client.responses.create(
                model=model,
                input=prompt,
                max_output_tokens=max_tokens,
                text={
                    "format": {
                        "type": "json_schema",
                        "name": "citemind_structured_output",
                        "schema": schema,
                        "strict": True,
                    }
                },
            )
            return _parse_structured_json(response)
        except Exception as error:
            native_error = error

        try:
            response = self.client.responses.create(
                model=model,
                input=(
                    "请严格输出 JSON，不要输出解释。"
                    f"\nSchema: {json.dumps(schema, ensure_ascii=False)}"
                    f"\n任务: {prompt}"
                ),
                max_output_tokens=max_tokens,
            )
            return _parse_structured_json(response)
        except Exception as error:
            if native_error is not None and isinstance(error, ValueError):
                raise ValueError(
                    "Ark 结构化输出无法解析，JSON Schema 与 JSON Prompt 均失败"
                ) from error
            raise

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        clean_texts = [text for text in texts if text]
        if len(clean_texts) != len(texts):
            raise ValueError("Embedding 文本不能为空")
        vectors: list[list[float]] = []
        calls = 0
        retries = 0
        batches = 0
        for start in range(0, len(clean_texts), self.embedding_batch_size):
            batch = clean_texts[start : start + self.embedding_batch_size]
            results = await asyncio.gather(*(self._embed_one(text) for text in batch))
            batches += 1
            for vector, item_calls, item_retries in results:
                vectors.append(vector)
                calls += item_calls
                retries += item_retries
        self.last_embedding_stats = {
            "batches": batches,
            "calls": calls,
            "texts": len(clean_texts),
            "retries": retries,
        }
        return vectors

    async def _embed_one(self, text: str) -> tuple[list[float], int, int]:
        calls = 0
        retries = 0
        for attempt in range(self.embedding_max_attempts):
            await self._wait_for_embedding_slot()
            calls = attempt + 1
            try:
                response = await asyncio.to_thread(
                    self.client.multimodal_embeddings.create,
                    model=self.embedding_model,
                    encoding_format="float",
                    input=[{"type": "text", "text": text}],
                )
                return _extract_embedding(response), calls, retries
            except Exception as error:
                if attempt + 1 >= self.embedding_max_attempts or not _retryable_embedding_error(
                    error
                ):
                    raise
                retries += 1
                await asyncio.sleep(min(2.0, 0.2 * (2**attempt)))
        raise RuntimeError("Embedding 重试次数已耗尽")

    async def _wait_for_embedding_slot(self) -> None:
        async with self._embedding_rate_lock:
            elapsed = monotonic() - self._last_embedding_started_at
            remaining = self.embedding_min_interval_seconds - elapsed
            if remaining > 0:
                await asyncio.sleep(remaining)
            self._last_embedding_started_at = monotonic()

    def _probe_chat_model(self, model_id: str) -> dict[str, object]:
        response = self.client.responses.create(
            model=model_id,
            input="请只回复 OK",
            max_output_tokens=16,
        )
        text = _extract_text(response)
        structured_mode = self._probe_structured_output(model_id)
        vision_mode = self._probe_vision(model_id)
        return {
            "chat": True,
            "sampleText": text[:80],
            "structuredOutput": structured_mode,
            "vision": vision_mode,
            "streaming": True,
        }

    def _probe_structured_output(self, model_id: str) -> str:
        schema = {
            "type": "object",
            "properties": {"ok": {"type": "boolean"}},
            "required": ["ok"],
            "additionalProperties": False,
        }
        try:
            response = self.client.responses.create(
                model=model_id,
                input="输出 ok 为 true 的 JSON。",
                max_output_tokens=64,
                text={
                    "format": {
                        "type": "json_schema",
                        "name": "citemind_probe",
                        "schema": schema,
                        "strict": True,
                    }
                },
            )
            text = _extract_text(response)
            parsed = json.loads(_extract_json_object(text))
            if parsed.get("ok") is True:
                return "json_schema"
        except Exception:
            pass

        try:
            response = self.client.responses.create(
                model=model_id,
                input='只输出 JSON：{"ok": true}',
                max_output_tokens=64,
            )
            text = _extract_text(response)
            parsed = json.loads(_extract_json_object(text))
            if parsed.get("ok") is True:
                return "json_prompt"
        except Exception:
            return "json_prompt"
        return "json_prompt"

    def _probe_vision(self, model_id: str) -> str:
        try:
            self.client.responses.create(
                model=model_id,
                input=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_image", "image_url": ARK_DEMO_IMAGE_URL},
                            {"type": "input_text", "text": "请用一个词描述图片。"},
                        ],
                    }
                ],
                max_output_tokens=24,
            )
        except Exception:
            return "unavailable"
        return "callable"

    def _probe_embedding_model(self, model_id: str) -> dict[str, object]:
        response = self.client.multimodal_embeddings.create(
            model=model_id,
            encoding_format="float",
            input=[{"type": "text", "text": "citeMind 向量化权限验证"}],
        )
        embedding = _extract_embedding(response)
        vision_embedding = self._probe_vision_embedding(model_id)
        return {
            "embedding": True,
            "vectorDimension": len(embedding),
            "visionEmbedding": vision_embedding,
        }

    def _probe_vision_embedding(self, model_id: str) -> str:
        try:
            self.client.multimodal_embeddings.create(
                model=model_id,
                encoding_format="float",
                input=[
                    {
                        "type": "image_url",
                        "image_url": {"url": ARK_DEMO_IMAGE_URL},
                    }
                ],
            )
        except Exception:
            return "unavailable"
        return "callable"


def _required_str(request: dict[str, object], key: str) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} is required")
    return value


def _optional_int(request: dict[str, object], key: str, fallback: int) -> int:
    value = request.get(key)
    if value is None:
        return fallback
    if not isinstance(value, int):
        raise ValueError(f"{key} must be an integer")
    return value


def _to_plain(value: Any) -> object:
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if hasattr(value, "dict"):
        return value.dict()
    if isinstance(value, dict):
        return {str(key): _to_plain(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_to_plain(item) for item in value]
    return value


def _extract_text(response: Any) -> str:
    direct = getattr(response, "output_text", None)
    if isinstance(direct, str) and direct:
        return direct

    output_attr = getattr(response, "output", None)
    output_text = _extract_output_text(output_attr)
    if output_text:
        return output_text

    choices_attr = getattr(response, "choices", None)
    choices_text = _extract_output_text(choices_attr)
    if choices_text:
        return choices_text

    plain = _to_plain(response)
    if isinstance(plain, dict):
        direct_value = plain.get("output_text")
        if isinstance(direct_value, str) and direct_value:
            return direct_value
        output_text = _extract_output_text(plain.get("output"))
        if output_text:
            return output_text
        choices = plain.get("choices")
        choices_text = _extract_output_text(choices)
        if choices_text:
            return choices_text
        found = _find_text_value(plain)
        if found:
            return found
    return str(response)


def _extract_output_text(value: object) -> str | None:
    plain = _to_plain(value)
    if isinstance(plain, str):
        return plain if plain.strip() else None
    if isinstance(plain, list):
        parts = [
            text
            for item in plain
            if (text := _extract_output_text(item)) is not None and text.strip()
        ]
        return "\n".join(parts) if parts else None
    if not isinstance(plain, dict):
        return None

    for key in ("output", "choices", "message", "delta", "content"):
        text = _extract_output_text(plain.get(key))
        if text:
            return text

    text = _text_field_value(plain.get("text"))
    if text:
        return text
    value_text = _text_field_value(plain.get("value"))
    if value_text:
        return value_text
    return None


def _text_field_value(value: object) -> str | None:
    plain = _to_plain(value)
    if isinstance(plain, str):
        return plain if plain.strip() else None
    if isinstance(plain, dict):
        for key in ("value", "text", "content"):
            item = plain.get(key)
            if isinstance(item, str) and item.strip():
                return item
    return None


def _find_text_value(value: object) -> str | None:
    if isinstance(value, dict):
        for key in ("text", "content", "output_text"):
            item = value.get(key)
            if isinstance(item, str) and item:
                return item
        for item in value.values():
            found = _find_text_value(item)
            if found:
                return found
    if isinstance(value, list):
        for item in value:
            found = _find_text_value(item)
            if found:
                return found
    return None


def _extract_json_object(text: str) -> str:
    last_match: str | None = None
    start: int | None = None
    depth = 0
    in_string = False
    escaped = False
    for offset, current in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif current == "\\":
                escaped = True
            elif current == '"':
                in_string = False
            continue
        if current == '"':
            in_string = True
        elif current == "{":
            if depth == 0:
                start = offset
            depth += 1
        elif current == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start is not None:
                last_match = text[start : offset + 1]
                start = None
    if last_match is None:
        raise ValueError("No JSON object found in model output")
    return last_match


def _parse_structured_json(response: Any) -> dict[str, object]:
    text = _extract_text(response).strip()
    if not text:
        raise ValueError("Ark 结构化输出为空")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        try:
            parsed = json.loads(_extract_json_object(text))
        except (ValueError, json.JSONDecodeError) as error:
            raise ValueError("Ark 结构化输出不是有效 JSON，且未找到可解析的 JSON 对象") from error
    if not isinstance(parsed, dict):
        raise ValueError("Ark 结构化输出必须是 JSON object")
    return parsed


def _extract_embedding(response: Any) -> list[float]:
    plain = _to_plain(response)
    if isinstance(plain, dict):
        data = plain.get("data")
        if isinstance(data, dict):
            embedding = data.get("embedding")
            if isinstance(embedding, list):
                return [float(value) for value in embedding]
        if isinstance(data, list) and data:
            first = data[0]
            if isinstance(first, dict):
                embedding = first.get("embedding")
                if isinstance(embedding, list):
                    return [float(value) for value in embedding]
    data_attr = getattr(response, "data", None)
    if isinstance(data_attr, list) and data_attr:
        embedding_attr = getattr(data_attr[0], "embedding", None)
        if isinstance(embedding_attr, list):
            return [float(value) for value in embedding_attr]
    raise ValueError("Ark embedding response does not contain an embedding vector")


def _extract_chat_delta(chunk: Any) -> str:
    plain = _to_plain(chunk)
    if isinstance(plain, dict):
        choices = plain.get("choices")
        if isinstance(choices, list) and choices:
            first = choices[0]
            if isinstance(first, dict):
                delta = first.get("delta")
                if isinstance(delta, dict) and isinstance(delta.get("content"), str):
                    return str(delta["content"])
    return ""


def _status_for_error(error: Exception) -> str:
    if isinstance(error, ArkAuthenticationError):
        return "unauthorized"
    if isinstance(error, (ArkPermissionDeniedError, ArkNotFoundError, ArkBadRequestError)):
        return "not_enabled"
    if isinstance(error, ArkRateLimitError):
        return "rate_limited"
    status_code = getattr(error, "status_code", None)
    if status_code == 401:
        return "unauthorized"
    if status_code in {403, 404}:
        return "not_enabled"
    if status_code == 429:
        return "rate_limited"
    return "failed"


def _retryable_embedding_error(error: Exception) -> bool:
    if isinstance(error, (ArkRateLimitError, ArkAPITimeoutError, ArkAPIConnectionError)):
        return True
    status_code = getattr(error, "status_code", None)
    return status_code == 429 or isinstance(status_code, int) and status_code >= 500


def _public_error_message(error: Exception) -> str:
    if isinstance(error, ArkAuthenticationError):
        return "Ark API Key 无效或鉴权失败"
    if isinstance(error, ArkPermissionDeniedError):
        return "当前 Key 无权限调用该模型"
    if isinstance(error, ArkNotFoundError):
        return "模型未开通、模型 ID 不存在或当前区域不可用"
    if isinstance(error, ArkBadRequestError):
        return "模型请求参数不被支持"
    if isinstance(error, ArkRateLimitError):
        return "Ark API 限流"
    if isinstance(error, ArkAPITimeoutError):
        return "Ark API 调用超时"
    if isinstance(error, ArkAPIConnectionError):
        return "Ark API 网络连接失败"
    if isinstance(error, ArkAPIError):
        return "Ark API 调用失败"
    return str(error)[:240] or "模型验证失败"
