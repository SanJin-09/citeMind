import json
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime
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
        timeout: int = 45,
        max_retries: int = 1,
        client: Any | None = None,
    ) -> None:
        if not api_key.strip():
            raise ValueError("Ark API Key is required")
        self.embedding_model = DEFAULT_EMBEDDING_MODEL
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
            stream = self.client.chat.completions.create(
                model=model,
                messages=messages,
                stream=True,
            )
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
        except Exception:
            response = self.client.responses.create(
                model=model,
                input=(
                    "请严格输出 JSON，不要输出解释。"
                    f"\nSchema: {json.dumps(schema, ensure_ascii=False)}"
                    f"\n任务: {prompt}"
                ),
                max_output_tokens=max_tokens,
            )
        text = _extract_text(response)
        return json.loads(text)

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        result: list[list[float]] = []
        for text in texts:
            response = self.client.multimodal_embeddings.create(
                model=self.embedding_model,
                encoding_format="float",
                input=[{"type": "text", "text": text}],
            )
            result.append(_extract_embedding(response))
        return result

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

    plain = _to_plain(response)
    if isinstance(plain, dict):
        direct_value = plain.get("output_text")
        if isinstance(direct_value, str) and direct_value:
            return direct_value
        choices = plain.get("choices")
        if isinstance(choices, list) and choices:
            first = choices[0]
            if isinstance(first, dict):
                message = first.get("message")
                if isinstance(message, dict) and isinstance(message.get("content"), str):
                    return message["content"]
        found = _find_text_value(plain)
        if found:
            return found
    return str(response)


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
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("No JSON object found in model output")
    return text[start : end + 1]


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
                    return delta["content"]
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
