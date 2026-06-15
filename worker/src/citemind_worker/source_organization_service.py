import json
import re
import sqlite3
from collections.abc import Callable
from difflib import SequenceMatcher
from pathlib import Path
from typing import Protocol, cast
from urllib.parse import urlparse
from uuid import uuid4

from citemind_worker.ark_gateway import ArkModelGateway
from citemind_worker.storage import StorageRuntime
from citemind_worker.storage.full_text import tokenize_for_search

TAG_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "tags": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "tag": {"type": "string"},
                    "reason": {"type": "string"},
                    "confidence": {"type": "number"},
                },
                "required": ["tag", "reason", "confidence"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["tags"],
    "additionalProperties": False,
}

KEYWORD_CATEGORIES = (
    ("人员与履历", ("简历", "履历", "resume", "curriculum vitae", "cv")),
    ("合同与协议", ("合同", "协议", "contract", "agreement")),
    ("会议记录", ("会议", "纪要", "meeting", "minutes")),
    ("论文与文献", ("论文", "文献", "paper", "thesis", "journal")),
    ("报告与研究", ("报告", "研究", "分析", "report", "research", "analysis")),
    ("方案与设计", ("方案", "设计", "架构", "proposal", "design", "architecture", "spec")),
)
GENERIC_FOLDERS = {"", "/", "desktop", "documents", "downloads", "objects"}
AUTHOR_PATTERN = re.compile(
    r"(?:作者|撰写|编写|author|written\s+by)\s*[:：]\s*([^\n,，;；]{2,80})",
    re.IGNORECASE,
)
DATE_PATTERN = re.compile(
    r"(?<!\d)(20\d{2}|19\d{2})(?:[-/.年](0?[1-9]|1[0-2])"
    r"(?:[-/.月](0?[1-9]|[12]\d|3[01])日?)?)?"
)


class TagGateway(Protocol):
    async def generate_structured(
        self,
        request: dict[str, object],
        schema: dict[str, object],
    ) -> dict[str, object]: ...


class SourceOrganizationService:
    def __init__(
        self,
        storage: StorageRuntime,
        *,
        gateway_factory: Callable[[str, str, str], TagGateway] | None = None,
    ) -> None:
        self.storage = storage
        self.gateway_factory = gateway_factory or (
            lambda api_key, base_url, _chat_model: ArkModelGateway(api_key, base_url=base_url)
        )

    def details(self, source_id: str) -> dict[str, object]:
        source = self._source(source_id)
        self._classify(source_id)
        self._refresh_duplicate_relations(str(source["knowledge_base_id"]))
        return self._details(source_id)

    def classify(self, source_id: str) -> dict[str, object]:
        self._source(source_id)
        self._classify(source_id)
        return self._details(source_id)

    async def suggest_tags(
        self,
        source_id: str,
        *,
        api_key: str,
        base_url: str,
        chat_model: str,
    ) -> dict[str, object]:
        if not api_key.strip():
            raise ValueError("Ark API Key is required")
        source = self._source(source_id)
        classification = self._classify(source_id)
        artifact = _read_json(source["parse_artifact_path"])
        excerpt = _artifact_text(artifact)[:5000]
        prompt = (
            "为以下资料生成 3 到 6 个简短中文主题标签。标签应描述资料主题，不要包含文件格式、"
            "泛化词或重复同义词。每个标签需说明依据和 0 到 1 的置信度。\n"
            f"分类：{classification['category']}\n"
            f"标题：{classification.get('title') or source['display_name']}\n"
            f"作者：{classification.get('author') or '未知'}\n"
            f"正文摘录：{excerpt}"
        )
        result = await self.gateway_factory(api_key, base_url, chat_model).generate_structured(
            {"model": chat_model, "prompt": prompt, "max_output_tokens": 800},
            TAG_SCHEMA,
        )
        candidates = result.get("tags")
        if not isinstance(candidates, list):
            raise ValueError("模型标签建议格式无效")
        self._save_tag_suggestions(
            str(source["knowledge_base_id"]),
            source_id,
            candidates,
        )
        return self._details(source_id)

    def decide_tag(
        self,
        source_id: str,
        tag_id: str,
        decision: str,
        *,
        corrected_tag: str | None = None,
    ) -> dict[str, object]:
        if decision not in {"confirm", "dismiss"}:
            raise ValueError("Tag decision must be confirm or dismiss")
        source = self._source(source_id)
        with self.storage.database.connect() as connection:
            row = connection.execute(
                """
                SELECT id, tag, suggested_tag
                FROM source_tags
                WHERE id = ? AND source_id = ?
                """,
                (tag_id, source_id),
            ).fetchone()
            if row is None:
                raise ValueError("Tag suggestion not found")
            suggested_tag = _clean_tag(str(row["suggested_tag"] or row["tag"]))
            current_tag = _clean_tag(str(row["tag"]))
            next_tag = _clean_tag(corrected_tag or current_tag)
            action = "dismiss"
            correction_value: str | None = None
            if decision == "confirm":
                action = "replace" if next_tag != suggested_tag else "confirm"
                correction_value = next_tag
                connection.execute(
                    "DELETE FROM source_tags WHERE source_id = ? AND tag = ? AND id != ?",
                    (source_id, next_tag, tag_id),
                )
                connection.execute(
                    """
                    UPDATE source_tags
                    SET tag = ?, status = 'confirmed',
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE id = ?
                    """,
                    (next_tag, tag_id),
                )
            else:
                connection.execute(
                    """
                    UPDATE source_tags
                    SET status = 'dismissed',
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE id = ?
                    """,
                    (tag_id,),
                )
            self._upsert_correction(
                connection,
                str(source["knowledge_base_id"]),
                suggested_tag,
                corrected_tag=correction_value,
                action=action,
            )
            connection.commit()
        return self._details(source_id)

    def decide_relation(
        self,
        source_id: str,
        relation_id: str,
        decision: str,
    ) -> dict[str, object]:
        if decision not in {"confirm", "dismiss"}:
            raise ValueError("Relation decision must be confirm or dismiss")
        self._source(source_id)
        status = "confirmed" if decision == "confirm" else "dismissed"
        with self.storage.database.connect() as connection:
            cursor = connection.execute(
                """
                UPDATE source_relations
                SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ? AND (source_id = ? OR related_source_id = ?)
                """,
                (status, relation_id, source_id, source_id),
            )
            connection.commit()
        if cursor.rowcount == 0:
            raise ValueError("Source relation not found")
        return self._details(source_id)

    def _classify(self, source_id: str) -> dict[str, object]:
        source = self._source(source_id)
        artifact = _read_json(source["parse_artifact_path"])
        text = _artifact_text(artifact)
        folder = _source_folder(str(source["source_type"]), source["uri"])
        filename = str(source["display_name"])
        title = _document_title(artifact, filename)
        author = _first_match(AUTHOR_PATTERN, text[:4000])
        document_time = _document_time(f"{filename}\n{title}\n{text[:4000]}")
        searchable = f"{folder} {filename} {title} {author or ''}".lower()
        category = ""
        rules: list[dict[str, str]] = []
        for candidate, keywords in KEYWORD_CATEGORIES:
            matched = next((keyword for keyword in keywords if keyword in searchable), None)
            if matched:
                category = candidate
                rules.append({"field": "keyword", "value": matched, "result": candidate})
                break
        if not category and str(source["source_type"]) == "web":
            hostname = urlparse(str(source["uri"] or "")).hostname or "网页资料"
            category = f"网页 / {hostname}"
            rules.append({"field": "url", "value": hostname, "result": category})
        if not category and folder.lower() not in GENERIC_FOLDERS:
            category = f"文件夹 / {folder}"
            rules.append({"field": "folder", "value": folder, "result": category})
        if not category:
            category = "未分类"
            rules.append({"field": "fallback", "value": filename, "result": category})
        if document_time:
            rules.append({"field": "time", "value": document_time, "result": document_time[:4]})
        if author:
            rules.append({"field": "author", "value": author, "result": author})
        basis = {
            "folder": folder or None,
            "filename": filename,
            "title": title,
            "author": author,
            "documentTime": document_time,
            "rules": rules,
        }
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO source_classifications(
                    source_id, category, title, author, document_time, rule_basis_json
                )
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_id) DO UPDATE SET
                    category = excluded.category,
                    title = excluded.title,
                    author = excluded.author,
                    document_time = excluded.document_time,
                    rule_basis_json = excluded.rule_basis_json,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                """,
                (source_id, category, title, author, document_time, _json(basis)),
            )
            connection.commit()
        return {
            "category": category,
            "title": title,
            "author": author,
            "documentTime": document_time,
            "ruleBasis": basis,
        }

    def _save_tag_suggestions(
        self,
        knowledge_base_id: str,
        source_id: str,
        candidates: list[object],
    ) -> None:
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE source_tags
                SET status = 'dismissed',
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE source_id = ? AND status = 'pending'
                """,
                (source_id,),
            )
            corrections = {
                str(row["suggested_tag"]).casefold(): row
                for row in connection.execute(
                    """
                    SELECT suggested_tag, corrected_tag, action
                    FROM tag_corrections
                    WHERE knowledge_base_id = ?
                    """,
                    (knowledge_base_id,),
                ).fetchall()
            }
            for candidate in candidates[:8]:
                if not isinstance(candidate, dict):
                    continue
                raw_tag = candidate.get("tag")
                if not isinstance(raw_tag, str):
                    continue
                suggested_tag = _clean_tag(raw_tag)
                correction = corrections.get(suggested_tag.casefold())
                if correction is not None and correction["action"] == "dismiss":
                    self._increment_correction_use(
                        connection,
                        knowledge_base_id,
                        str(correction["suggested_tag"]),
                    )
                    continue
                tag = suggested_tag
                origin = "model"
                if correction is not None and correction["corrected_tag"]:
                    tag = _clean_tag(str(correction["corrected_tag"]))
                    origin = "correction"
                    self._increment_correction_use(
                        connection,
                        knowledge_base_id,
                        str(correction["suggested_tag"]),
                    )
                reason = str(candidate.get("reason") or "模型根据正文主题生成")
                confidence = _confidence(candidate.get("confidence"))
                existing = connection.execute(
                    "SELECT status FROM source_tags WHERE source_id = ? AND tag = ?",
                    (source_id, tag),
                ).fetchone()
                if existing is not None and existing["status"] == "confirmed":
                    continue
                connection.execute(
                    """
                    INSERT INTO source_tags(
                        id, source_id, tag, suggested_tag, origin, status, reason, confidence
                    )
                    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
                    ON CONFLICT(source_id, tag) DO UPDATE SET
                        suggested_tag = excluded.suggested_tag,
                        origin = excluded.origin,
                        status = 'pending',
                        reason = excluded.reason,
                        confidence = excluded.confidence,
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    """,
                    (
                        f"tag-{uuid4().hex}",
                        source_id,
                        tag,
                        suggested_tag,
                        origin,
                        reason,
                        confidence,
                    ),
                )
            connection.commit()

    def _refresh_duplicate_relations(self, knowledge_base_id: str) -> None:
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT s.id, s.display_name, sv.content_hash, sv.parse_artifact_path
                FROM sources s
                JOIN source_versions sv ON sv.id = COALESCE(
                    s.current_version_id,
                    (
                        SELECT latest.id FROM source_versions latest
                        WHERE latest.source_id = s.id
                        ORDER BY latest.version_number DESC LIMIT 1
                    )
                )
                WHERE s.knowledge_base_id = ? AND sv.parse_artifact_path IS NOT NULL
                ORDER BY s.id
                """,
                (knowledge_base_id,),
            ).fetchall()
            records = [
                {
                    "id": str(row["id"]),
                    "displayName": str(row["display_name"]),
                    "contentHash": row["content_hash"],
                    "text": _artifact_text(_read_json(row["parse_artifact_path"])),
                }
                for row in rows
            ]
            detected: set[tuple[str, str, str]] = set()
            for index, source in enumerate(records):
                for related in records[index + 1 :]:
                    relation = _duplicate_relation(source, related)
                    if relation is None:
                        continue
                    relation_type, confidence, basis = relation
                    detected.add((str(source["id"]), str(related["id"]), relation_type))
                    existing = connection.execute(
                        """
                        SELECT id, status FROM source_relations
                        WHERE source_id = ? AND related_source_id = ? AND relation_type = ?
                        """,
                        (source["id"], related["id"], relation_type),
                    ).fetchone()
                    if existing is None:
                        connection.execute(
                            """
                            INSERT INTO source_relations(
                                id, knowledge_base_id, source_id, related_source_id,
                                relation_type, basis_json, confidence, status, origin
                            )
                            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'rule')
                            """,
                            (
                                f"relation-{uuid4().hex}",
                                knowledge_base_id,
                                source["id"],
                                related["id"],
                                relation_type,
                                _json(basis),
                                confidence,
                            ),
                        )
                    else:
                        connection.execute(
                            """
                            UPDATE source_relations
                            SET basis_json = ?, confidence = ?,
                                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                            WHERE id = ?
                            """,
                            (_json(basis), confidence, existing["id"]),
                        )
            existing_rules = connection.execute(
                """
                SELECT id, source_id, related_source_id, relation_type
                FROM source_relations
                WHERE knowledge_base_id = ?
                  AND origin = 'rule'
                  AND status = 'pending'
                  AND relation_type IN ('duplicate', 'near_duplicate')
                """,
                (knowledge_base_id,),
            ).fetchall()
            for row in existing_rules:
                key = (
                    str(row["source_id"]),
                    str(row["related_source_id"]),
                    str(row["relation_type"]),
                )
                if key not in detected:
                    connection.execute("DELETE FROM source_relations WHERE id = ?", (row["id"],))
            connection.commit()

    def _details(self, source_id: str) -> dict[str, object]:
        source = self._source(source_id)
        with self.storage.database.connect() as connection:
            classification = connection.execute(
                """
                SELECT category, title, author, document_time, rule_basis_json, updated_at
                FROM source_classifications WHERE source_id = ?
                """,
                (source_id,),
            ).fetchone()
            tags = connection.execute(
                """
                SELECT id, tag, suggested_tag, origin, status, reason, confidence,
                       created_at, updated_at
                FROM source_tags
                WHERE source_id = ?
                ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END,
                         updated_at DESC
                """,
                (source_id,),
            ).fetchall()
            relations = connection.execute(
                """
                SELECT r.id, r.source_id, r.related_source_id, r.relation_type,
                       r.basis_json, r.confidence, r.status, r.origin,
                       r.created_at, r.updated_at,
                       CASE
                           WHEN r.source_id = ? THEN related.display_name
                           ELSE source.display_name
                       END
                           AS related_display_name,
                       CASE WHEN r.source_id = ? THEN r.related_source_id ELSE r.source_id END
                           AS counterpart_id
                FROM source_relations r
                JOIN sources source ON source.id = r.source_id
                JOIN sources related ON related.id = r.related_source_id
                WHERE r.source_id = ? OR r.related_source_id = ?
                ORDER BY r.confidence DESC, r.updated_at DESC
                """,
                (source_id, source_id, source_id, source_id),
            ).fetchall()
        classification_record = (
            {
                "category": str(classification["category"]),
                "title": classification["title"],
                "author": classification["author"],
                "documentTime": classification["document_time"],
                "ruleBasis": _json_object(classification["rule_basis_json"]),
                "updatedAt": str(classification["updated_at"]),
            }
            if classification is not None
            else None
        )
        return {
            "sourceId": source_id,
            "knowledgeBaseId": str(source["knowledge_base_id"]),
            "classification": classification_record,
            "tags": [
                {
                    "id": str(row["id"]),
                    "tag": str(row["tag"]),
                    "suggestedTag": row["suggested_tag"],
                    "origin": str(row["origin"]),
                    "status": str(row["status"]),
                    "reason": row["reason"],
                    "confidence": float(row["confidence"]),
                    "createdAt": str(row["created_at"]),
                    "updatedAt": str(row["updated_at"]),
                }
                for row in tags
            ],
            "relations": [
                {
                    "id": str(row["id"]),
                    "relatedSourceId": str(row["counterpart_id"]),
                    "relatedDisplayName": str(row["related_display_name"]),
                    "relationType": str(row["relation_type"]),
                    "basis": _json_object(row["basis_json"]),
                    "confidence": float(row["confidence"]),
                    "status": str(row["status"]),
                    "origin": str(row["origin"]),
                    "createdAt": str(row["created_at"]),
                    "updatedAt": str(row["updated_at"]),
                }
                for row in relations
            ],
        }

    def _source(self, source_id: str) -> sqlite3.Row:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                """
                SELECT s.id, s.knowledge_base_id, s.source_type, s.display_name, s.uri,
                       s.created_at, sv.parse_artifact_path
                FROM sources s
                LEFT JOIN source_versions sv ON sv.id = COALESCE(
                    s.current_version_id,
                    (
                        SELECT latest.id FROM source_versions latest
                        WHERE latest.source_id = s.id
                        ORDER BY latest.version_number DESC LIMIT 1
                    )
                )
                WHERE s.id = ?
                """,
                (source_id,),
            ).fetchone()
        if row is None:
            raise ValueError("Source not found")
        return cast(sqlite3.Row, row)

    @staticmethod
    def _upsert_correction(
        connection: sqlite3.Connection,
        knowledge_base_id: str,
        suggested_tag: str,
        *,
        corrected_tag: str | None,
        action: str,
    ) -> None:
        connection.execute(
            """
            INSERT INTO tag_corrections(
                id, knowledge_base_id, suggested_tag, corrected_tag, action
            )
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(knowledge_base_id, suggested_tag) DO UPDATE SET
                corrected_tag = excluded.corrected_tag,
                action = excluded.action,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            """,
            (f"correction-{uuid4().hex}", knowledge_base_id, suggested_tag, corrected_tag, action),
        )

    @staticmethod
    def _increment_correction_use(
        connection: sqlite3.Connection,
        knowledge_base_id: str,
        suggested_tag: str,
    ) -> None:
        connection.execute(
            """
            UPDATE tag_corrections
            SET use_count = use_count + 1,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE knowledge_base_id = ? AND suggested_tag = ?
            """,
            (knowledge_base_id, suggested_tag),
        )


def _duplicate_relation(
    source: dict[str, object],
    related: dict[str, object],
) -> tuple[str, float, dict[str, object]] | None:
    if source["contentHash"] and source["contentHash"] == related["contentHash"]:
        return (
            "duplicate",
            1.0,
            {"reason": "标准化正文 Hash 完全一致", "contentHashEqual": True},
        )
    source_text = _normalize(str(source["text"]))[:12000]
    related_text = _normalize(str(related["text"]))[:12000]
    if not source_text or not related_text:
        return None
    text_similarity = SequenceMatcher(a=source_text, b=related_text, autojunk=False).ratio()
    title_similarity = SequenceMatcher(
        a=_normalize(str(source["displayName"])),
        b=_normalize(str(related["displayName"])),
        autojunk=False,
    ).ratio()
    source_tokens = set(tokenize_for_search(source_text).split())
    related_tokens = set(tokenize_for_search(related_text).split())
    shared = source_tokens & related_tokens
    union = source_tokens | related_tokens
    token_similarity = len(shared) / len(union) if union else 0.0
    confidence = max(text_similarity, text_similarity * 0.7 + token_similarity * 0.3)
    if confidence < 0.72 or text_similarity >= 0.995:
        return None
    return (
        "near_duplicate",
        round(confidence, 4),
        {
            "reason": "正文结构与关键词高度相似，但内容并非完全一致",
            "textSimilarity": round(text_similarity, 4),
            "titleSimilarity": round(title_similarity, 4),
            "tokenSimilarity": round(token_similarity, 4),
            "sharedKeywords": sorted(shared, key=len, reverse=True)[:8],
        },
    )


def _source_folder(source_type: str, uri: object) -> str:
    if not isinstance(uri, str) or not uri:
        return ""
    if source_type == "web":
        return urlparse(uri).hostname or ""
    return Path(uri).expanduser().parent.name


def _document_title(artifact: dict[str, object], fallback: str) -> str:
    chunks = artifact.get("chunks")
    if isinstance(chunks, list):
        for chunk in chunks:
            if not isinstance(chunk, dict):
                continue
            heading = chunk.get("headingPath")
            if isinstance(heading, list) and heading and isinstance(heading[-1], str):
                return _short_text(heading[-1])
    text = _artifact_text(artifact)
    first_line = next((line.strip() for line in text.splitlines() if line.strip()), "")
    return _short_text(first_line) or Path(fallback).stem


def _document_time(text: str) -> str | None:
    match = DATE_PATTERN.search(text)
    if match is None:
        return None
    year, month, day = match.groups()
    if not month:
        return year
    return f"{year}-{int(month):02d}-{int(day):02d}" if day else f"{year}-{int(month):02d}"


def _first_match(pattern: re.Pattern[str], text: str) -> str | None:
    match = pattern.search(text)
    return _short_text(match.group(1)) if match else None


def _artifact_text(artifact: dict[str, object]) -> str:
    value = artifact.get("normalizedText")
    return value if isinstance(value, str) else ""


def _read_json(path_value: object) -> dict[str, object]:
    if not isinstance(path_value, str) or not path_value:
        return {}
    try:
        value = json.loads(Path(path_value).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_object(value: object) -> dict[str, object]:
    if not isinstance(value, str) or not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _clean_tag(value: str) -> str:
    clean = re.sub(r"\s+", " ", value).strip(" #,，;；")
    if not clean or len(clean) > 40:
        raise ValueError("Tag must contain 1 to 40 characters")
    return clean


def _confidence(value: object) -> float:
    if isinstance(value, int | float):
        return round(min(1.0, max(0.0, float(value))), 4)
    return 0.5


def _short_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()[:120]


def _normalize(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()
