import re
from dataclasses import dataclass

import jieba

from citemind_worker.storage.database import SqliteDatabase

_ASCII_TOKEN = re.compile(r"[A-Za-z0-9_]+")


def tokenize_for_search(text: str) -> str:
    normalized = " ".join(text.split()).lower()
    tokens = [token.strip() for token in jieba.cut_for_search(normalized) if token.strip()]
    tokens.extend(_ASCII_TOKEN.findall(normalized))
    return " ".join(dict.fromkeys(tokens))


@dataclass(frozen=True, slots=True)
class FullTextResult:
    chunk_id: str
    rank: float


class FullTextIndex:
    def __init__(self, database: SqliteDatabase) -> None:
        self.database = database

    def upsert(
        self,
        *,
        chunk_id: str,
        knowledge_base_id: str,
        index_version_id: str,
        text: str,
    ) -> None:
        search_text = tokenize_for_search(text)
        with self.database.connect() as connection:
            connection.execute("DELETE FROM chunks_fts WHERE chunk_id = ?", (chunk_id,))
            connection.execute(
                """
                INSERT INTO chunks_fts(chunk_id, knowledge_base_id, index_version_id, search_text)
                VALUES (?, ?, ?, ?)
                """,
                (chunk_id, knowledge_base_id, index_version_id, search_text),
            )
            connection.commit()

    def search(
        self,
        *,
        knowledge_base_id: str,
        index_version_id: str,
        query: str,
        limit: int = 20,
    ) -> list[FullTextResult]:
        tokens = tokenize_for_search(query).split()
        if not tokens:
            return []
        match_query = " OR ".join(_fts_phrase(token) for token in tokens)
        with self.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT chunk_id, bm25(chunks_fts) AS rank
                FROM chunks_fts
                WHERE chunks_fts MATCH ?
                  AND knowledge_base_id = ?
                  AND index_version_id = ?
                ORDER BY rank
                LIMIT ?
                """,
                (match_query, knowledge_base_id, index_version_id, limit),
            ).fetchall()
        return [
            FullTextResult(chunk_id=str(row["chunk_id"]), rank=float(row["rank"])) for row in rows
        ]


def _fts_phrase(token: str) -> str:
    return f'"{token.replace('"', '""')}"'
