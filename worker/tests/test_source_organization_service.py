import asyncio
import json
from pathlib import Path

from citemind_worker.knowledge_base_service import KnowledgeBaseService
from citemind_worker.source_organization_service import SourceOrganizationService
from citemind_worker.storage import StorageRuntime


class FakeTagGateway:
    async def generate_structured(
        self,
        request: dict[str, object],
        schema: dict[str, object],
    ) -> dict[str, object]:
        del request, schema
        return {
            "tags": [
                {"tag": "机器学习", "reason": "正文讨论模型训练", "confidence": 0.9},
                {"tag": "旧标签", "reason": "正文包含旧标签主题", "confidence": 0.7},
            ]
        }


def test_rule_classification_extracts_folder_title_author_and_time(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = str(KnowledgeBaseService(storage).create("分类测试")["id"])
    source_id = _seed_source(
        storage,
        knowledge_base_id,
        "source-report",
        tmp_path / "研究报告" / "2025-架构分析.pdf",
        "架构年度分析\n作者：张三\n本文讨论知识库架构。",
        heading="知识库架构报告",
    )

    result = SourceOrganizationService(storage).details(source_id)
    classification = result["classification"]

    assert isinstance(classification, dict)
    assert classification["category"] == "报告与研究"
    assert classification["title"] == "知识库架构报告"
    assert classification["author"] == "张三"
    assert classification["documentTime"] == "2025"
    assert classification["ruleBasis"]["folder"] == "研究报告"


def test_model_tag_decisions_are_saved_and_reused(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = str(KnowledgeBaseService(storage).create("标签测试")["id"])
    first_source_id = _seed_source(
        storage,
        knowledge_base_id,
        "source-first",
        tmp_path / "first.pdf",
        "机器学习与知识库检索。",
    )
    second_source_id = _seed_source(
        storage,
        knowledge_base_id,
        "source-second",
        tmp_path / "second.pdf",
        "机器学习与向量检索。",
    )
    service = SourceOrganizationService(
        storage,
        gateway_factory=lambda _key, _base, _model: FakeTagGateway(),
    )

    suggested = asyncio.run(
        service.suggest_tags(
            first_source_id,
            api_key="test-key",
            base_url="https://example.com",
            chat_model="test-model",
        )
    )
    old_tag = next(tag for tag in suggested["tags"] if tag["tag"] == "旧标签")
    service.decide_tag(
        first_source_id,
        str(old_tag["id"]),
        "confirm",
        corrected_tag="新标签",
    )

    reused = asyncio.run(
        service.suggest_tags(
            second_source_id,
            api_key="test-key",
            base_url="https://example.com",
            chat_model="test-model",
        )
    )

    corrected = next(tag for tag in reused["tags"] if tag["tag"] == "新标签")
    assert corrected["suggestedTag"] == "旧标签"
    assert corrected["origin"] == "correction"
    with storage.database.connect() as connection:
        correction = connection.execute(
            """
            SELECT corrected_tag, action, use_count
            FROM tag_corrections
            WHERE knowledge_base_id = ? AND suggested_tag = '旧标签'
            """,
            (knowledge_base_id,),
        ).fetchone()
    assert correction is not None
    assert tuple(correction) == ("新标签", "replace", 1)


def test_near_duplicate_relation_includes_basis_and_can_be_confirmed(tmp_path: Path) -> None:
    storage = StorageRuntime(tmp_path, vector_dimension=3)
    storage.initialize()
    knowledge_base_id = str(KnowledgeBaseService(storage).create("关联测试")["id"])
    first_source_id = _seed_source(
        storage,
        knowledge_base_id,
        "source-a",
        tmp_path / "方案-A.pdf",
        "产品架构方案包括知识库检索、引用校验和向量索引。第一阶段交付桌面应用。",
    )
    second_source_id = _seed_source(
        storage,
        knowledge_base_id,
        "source-b",
        tmp_path / "方案-B.pdf",
        "产品架构方案包括知识库检索、引用校验和向量索引。第二阶段增加资料维护。",
    )
    service = SourceOrganizationService(storage)

    details = service.details(first_source_id)
    relation = next(
        item for item in details["relations"] if item["relatedSourceId"] == second_source_id
    )

    assert relation["relationType"] == "near_duplicate"
    assert relation["status"] == "pending"
    assert relation["basis"]["textSimilarity"] >= 0.72

    confirmed = service.decide_relation(first_source_id, str(relation["id"]), "confirm")
    assert confirmed["relations"][0]["status"] == "confirmed"


def _seed_source(
    storage: StorageRuntime,
    knowledge_base_id: str,
    source_id: str,
    path: Path,
    text: str,
    *,
    heading: str | None = None,
) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    version_id = f"version-{source_id}"
    artifact_path = storage.paths.artifacts / f"{version_id}.json"
    artifact_path.write_text(
        json.dumps(
            {
                "normalizedText": text,
                "chunks": [
                    {
                        "normalizedText": text,
                        "headingPath": [heading] if heading else [],
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    with storage.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO sources(
                id, knowledge_base_id, source_type, display_name, uri, status, current_version_id
            )
            VALUES (?, ?, 'pdf', ?, ?, 'ready', ?)
            """,
            (source_id, knowledge_base_id, path.name, str(path), version_id),
        )
        connection.execute(
            """
            INSERT INTO source_versions(
                id, source_id, version_number, content_hash, parse_artifact_path, status
            )
            VALUES (?, ?, 1, ?, ?, 'parsed')
            """,
            (version_id, source_id, f"hash-{source_id}", str(artifact_path)),
        )
        connection.commit()
    return source_id
