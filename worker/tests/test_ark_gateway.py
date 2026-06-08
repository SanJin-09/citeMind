import asyncio

import pytest

from citemind_worker.ark_gateway import ArkModelGateway


class FakeResponses:
    def __init__(self, responses: list[object]) -> None:
        self.responses = responses
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs: object) -> object:
        self.calls.append(kwargs)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class FakeClient:
    def __init__(self, responses: list[object]) -> None:
        self.responses = FakeResponses(responses)


def test_generate_structured_extracts_json_from_markdown() -> None:
    client = FakeClient(
        [
            {
                "output_text": (
                    "```json\n"
                    '{"evidence_sufficient": false, "refusal_reason": "no evidence", '
                    '"paragraphs": []}\n'
                    "```"
                )
            }
        ]
    )

    result = asyncio.run(
        ArkModelGateway("ark-test", client=client).generate_structured(
            {"model": "doubao-test", "prompt": "answer"},
            {"type": "object"},
        )
    )

    assert result["evidence_sufficient"] is False
    assert len(client.responses.calls) == 1


def test_generate_structured_extracts_responses_output_text() -> None:
    client = FakeClient(
        [
            {
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {
                                "type": "output_text",
                                "text": {
                                    "value": (
                                        '{"evidence_sufficient": true, '
                                        '"refusal_reason": null, "paragraphs": []}'
                                    )
                                },
                            }
                        ],
                    }
                ]
            }
        ]
    )

    result = asyncio.run(
        ArkModelGateway("ark-test", client=client).generate_structured(
            {"model": "doubao-test", "prompt": "answer"},
            {"type": "object"},
        )
    )

    assert result["evidence_sufficient"] is True
    assert len(client.responses.calls) == 1


def test_generate_structured_extracts_last_balanced_json_object() -> None:
    client = FakeClient(
        [
            {
                "output_text": (
                    '示例 {"ignore": true}\n'
                    '{"evidence_sufficient": true, "refusal_reason": null, '
                    '"paragraphs": [{"text": "A {nested} quote", "evidence_chunk_ids": []}]}'
                )
            }
        ]
    )

    result = asyncio.run(
        ArkModelGateway("ark-test", client=client).generate_structured(
            {"model": "doubao-test", "prompt": "answer"},
            {"type": "object"},
        )
    )

    assert result["evidence_sufficient"] is True
    assert result["paragraphs"][0]["text"] == "A {nested} quote"


def test_generate_structured_falls_back_when_schema_output_is_not_json() -> None:
    client = FakeClient(
        [
            {"output_text": "not json"},
            {"output_text": '{"evidence_sufficient": true, "paragraphs": []}'},
        ]
    )

    result = asyncio.run(
        ArkModelGateway("ark-test", client=client).generate_structured(
            {"model": "doubao-test", "prompt": "answer"},
            {"type": "object"},
        )
    )

    assert result["evidence_sufficient"] is True
    assert len(client.responses.calls) == 2
    assert "text" in client.responses.calls[0]
    assert "text" not in client.responses.calls[1]


def test_generate_structured_raises_clear_error_when_fallback_is_not_json() -> None:
    client = FakeClient(
        [
            {"output_text": "not json"},
            {"output_text": "still not json"},
        ]
    )

    with pytest.raises(ValueError, match="Ark 结构化输出无法解析"):
        asyncio.run(
            ArkModelGateway("ark-test", client=client).generate_structured(
                {"model": "doubao-test", "prompt": "answer"},
                {"type": "object"},
            )
        )
