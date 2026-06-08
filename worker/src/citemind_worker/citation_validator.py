import json
import sqlite3
from collections.abc import Sequence

from citemind_worker.storage import StorageRuntime


class CitationValidator:
    def __init__(self, storage: StorageRuntime) -> None:
        self.storage = storage

    def validate(
        self,
        *,
        paragraphs: Sequence[dict[str, object]],
        candidate_chunk_ids: Sequence[str],
        index_version_id: str,
    ) -> dict[str, object]:
        candidate_set = set(candidate_chunk_ids)
        requested_chunk_ids = _requested_chunk_ids(paragraphs)
        chunk_rows = self._chunk_rows(requested_chunk_ids)
        invalid: list[dict[str, object]] = []
        validated_paragraphs: list[dict[str, object]] = []
        valid_citations: list[dict[str, object]] = []

        for paragraph_index, paragraph in enumerate(paragraphs):
            text = _paragraph_text(paragraph)
            evidence_ids = _paragraph_evidence_ids(paragraph)
            valid_ids: list[str] = []
            invalid_ids: list[str] = []

            for chunk_id in evidence_ids:
                reason = _invalid_reason(
                    chunk_id=chunk_id,
                    candidate_chunk_ids=candidate_set,
                    chunk_rows=chunk_rows,
                    index_version_id=index_version_id,
                )
                if reason is None:
                    valid_ids.append(chunk_id)
                    valid_citations.append(
                        _citation_payload(
                            paragraph_index=paragraph_index,
                            row=chunk_rows[chunk_id],
                        )
                    )
                else:
                    invalid_ids.append(chunk_id)
                    invalid.append(
                        {
                            "paragraphIndex": paragraph_index,
                            "chunkId": chunk_id,
                            "reason": reason,
                        }
                    )

            if not valid_ids:
                invalid.append(
                    {
                        "paragraphIndex": paragraph_index,
                        "chunkId": None,
                        "reason": "paragraph_missing_valid_evidence",
                    }
                )

            validated_paragraphs.append(
                {
                    "index": paragraph_index,
                    "text": text,
                    "validEvidenceChunkIds": valid_ids,
                    "invalidEvidenceChunkIds": invalid_ids,
                }
            )

        return {
            "valid": len(invalid) == 0,
            "paragraphs": validated_paragraphs,
            "validCitations": valid_citations,
            "invalidCitations": invalid,
            "candidateChunkIds": list(candidate_chunk_ids),
        }

    def _chunk_rows(self, chunk_ids: Sequence[str]) -> dict[str, dict[str, object]]:
        unique_ids = list(dict.fromkeys(chunk_ids))
        if not unique_ids:
            return {}
        placeholders = ",".join("?" for _ in unique_ids)
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                f"""
                SELECT
                    c.id AS chunk_id,
                    c.index_version_id,
                    c.source_version_id,
                    c.page_number,
                    c.bounding_box_json,
                    c.heading_path_json,
                    c.anchor,
                    c.original_text,
                    c.normalized_text,
                    sv.status AS source_version_status,
                    s.id AS source_id,
                    s.source_type,
                    s.display_name,
                    s.uri,
                    s.status AS source_status,
                    iv.status AS index_status,
                    iv.is_current
                FROM chunks c
                JOIN source_versions sv ON sv.id = c.source_version_id
                JOIN sources s ON s.id = sv.source_id
                LEFT JOIN index_versions iv ON iv.id = c.index_version_id
                WHERE c.id IN ({placeholders})
                """,
                tuple(unique_ids),
            ).fetchall()
        return {str(row["chunk_id"]): _chunk_payload(row) for row in rows}


def _invalid_reason(
    *,
    chunk_id: str,
    candidate_chunk_ids: set[str],
    chunk_rows: dict[str, dict[str, object]],
    index_version_id: str,
) -> str | None:
    if chunk_id not in chunk_rows:
        return "chunk_not_found"
    if chunk_id not in candidate_chunk_ids:
        return "not_in_retrieval_candidates"

    row = chunk_rows[chunk_id]
    source = row.get("source")
    if (
        row.get("indexVersionId") != index_version_id
        or row.get("indexStatus") != "ready"
        or row.get("indexIsCurrent") is not True
        or row.get("sourceVersionStatus") != "ready"
        or not isinstance(source, dict)
        or source.get("status") != "ready"
    ):
        return "source_version_not_valid"
    if not _is_locatable(row):
        return "location_not_valid"
    return None


def _chunk_payload(row: sqlite3.Row) -> dict[str, object]:
    return {
        "chunkId": str(row["chunk_id"]),
        "indexVersionId": row["index_version_id"],
        "sourceVersionId": str(row["source_version_id"]),
        "pageNumber": row["page_number"],
        "boundingBox": _json_object(row["bounding_box_json"]),
        "headingPath": _json_string_list(row["heading_path_json"]),
        "anchor": row["anchor"],
        "originalText": str(row["original_text"]),
        "normalizedText": str(row["normalized_text"]),
        "sourceVersionStatus": str(row["source_version_status"]),
        "source": {
            "id": str(row["source_id"]),
            "type": str(row["source_type"]),
            "displayName": str(row["display_name"]),
            "uri": row["uri"],
            "status": str(row["source_status"]),
        },
        "indexStatus": row["index_status"],
        "indexIsCurrent": bool(row["is_current"]),
    }


def _is_locatable(row: dict[str, object]) -> bool:
    source = row.get("source")
    source_type = source.get("type") if isinstance(source, dict) else None
    page_number = row.get("pageNumber")
    bounding_box = row.get("boundingBox")
    heading_path = row.get("headingPath")
    anchor = row.get("anchor")

    if source_type == "pdf":
        return isinstance(page_number, int) and isinstance(bounding_box, dict)
    if source_type == "docx":
        return _has_heading_path(heading_path) or _has_anchor(anchor)
    if source_type == "web":
        return _has_anchor(anchor) or _has_heading_path(heading_path)
    if source_type == "image":
        return isinstance(bounding_box, dict)
    return False


def _citation_payload(*, paragraph_index: int, row: dict[str, object]) -> dict[str, object]:
    source = row["source"]
    assert isinstance(source, dict)
    return {
        "paragraphIndex": paragraph_index,
        "chunkId": row["chunkId"],
        "source": {
            "id": source["id"],
            "versionId": row["sourceVersionId"],
            "type": source["type"],
            "displayName": source["displayName"],
            "uri": source["uri"],
        },
        "location": {
            "pageNumber": row["pageNumber"],
            "boundingBox": row["boundingBox"],
            "headingPath": row["headingPath"],
            "anchor": row["anchor"],
        },
        "text": {
            "original": row["originalText"],
            "normalized": row["normalizedText"],
            "preview": _preview(str(row["normalizedText"])),
        },
    }


def _requested_chunk_ids(paragraphs: Sequence[dict[str, object]]) -> list[str]:
    chunk_ids: list[str] = []
    for paragraph in paragraphs:
        chunk_ids.extend(_paragraph_evidence_ids(paragraph))
    return list(dict.fromkeys(chunk_ids))


def _paragraph_text(paragraph: dict[str, object]) -> str:
    value = paragraph.get("text")
    return " ".join(value.split()) if isinstance(value, str) else ""


def _paragraph_evidence_ids(paragraph: dict[str, object]) -> list[str]:
    raw = paragraph.get("evidence_chunk_ids", paragraph.get("evidenceChunkIds"))
    if not isinstance(raw, list):
        return []
    return list(dict.fromkeys(item for item in raw if isinstance(item, str) and item))


def _json_object(value: object) -> dict[str, object] | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _json_string_list(value: object) -> list[str]:
    if not isinstance(value, str) or not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, str)]


def _has_heading_path(value: object) -> bool:
    return isinstance(value, list) and any(isinstance(item, str) and item for item in value)


def _has_anchor(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _preview(text: str) -> str:
    normalized = " ".join(text.split())
    if len(normalized) <= 240:
        return normalized
    return f"{normalized[:239]}…"
