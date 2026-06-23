import json
import sqlite3
from collections.abc import Mapping, Sequence
from typing import cast
from uuid import uuid4

from citemind_worker.agent_run_service import AgentRunService
from citemind_worker.agent_skill_service import AgentSkillService
from citemind_worker.model_catalog import (
    DEFAULT_ARK_BASE_URL,
    DEFAULT_CHAT_MODEL,
    DEFAULT_EMBEDDING_MODEL,
)
from citemind_worker.storage import StorageRuntime

RESEARCH_ACTIONS = {
    "continue_research",
    "supplement_evidence",
    "audit_citations",
    "regenerate_section",
    "revise_document",
}
EDITABLE_WORKSPACE_KEYS = {"title", "goal", "plan", "outline", "draft", "final", "sections"}


class ResearchBriefService:
    def __init__(
        self,
        storage: StorageRuntime,
        *,
        agent_runs: AgentRunService | None = None,
        agent_skills: AgentSkillService | None = None,
    ) -> None:
        self.storage = storage
        self.agent_runs = agent_runs or AgentRunService(storage)
        self.agent_skills = agent_skills or AgentSkillService(
            storage,
            agent_runs=self.agent_runs,
        )

    def list_briefs(self, knowledge_base_id: str) -> dict[str, object]:
        with self.storage.database.connect() as connection:
            exists = connection.execute(
                "SELECT 1 FROM knowledge_bases WHERE id = ?",
                (knowledge_base_id,),
            ).fetchone()
            if exists is None:
                raise ValueError("Knowledge base not found")
            rows = connection.execute(
                """
                SELECT *
                FROM agent_runs
                WHERE knowledge_base_id = ?
                  AND skill_id = 'research_brief'
                  AND research_workspace_json != '{}'
                ORDER BY updated_at DESC, created_at DESC
                """,
                (knowledge_base_id,),
            ).fetchall()
        return {
            "knowledgeBaseId": knowledge_base_id,
            "briefs": [self._brief_summary(row) for row in rows],
        }

    async def create(
        self,
        knowledge_base_id: str,
        *,
        goal: str,
        source_ids: Sequence[str] | None = None,
        api_key: str | None = None,
        base_url: str = DEFAULT_ARK_BASE_URL,
        chat_model: str = DEFAULT_CHAT_MODEL,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
        conversation_id: str | None = None,
    ) -> dict[str, object]:
        response = await self.agent_skills.run_skill(
            knowledge_base_id=knowledge_base_id,
            skill_id="research_brief",
            goal=goal,
            source_ids=source_ids,
            api_key=api_key,
            base_url=base_url,
            chat_model=chat_model,
            embedding_model=embedding_model,
        )
        run = _mapping(response.get("run"))
        run_id = _required_text(run.get("id"), "AgentRun id")
        workspace = _workspace_from_agent_run(response)
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE agent_runs
                SET research_workspace_json = ?,
                    research_user_revision = 0,
                    research_agent_revision = 1,
                    research_pending_update_json = '{}',
                    conversation_id = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (_json(workspace), conversation_id, run_id),
            )
            connection.commit()
        self.agent_runs.record_workspace_event(
            run_id,
            event_type="workspace.created",
            title="研究简报工作区已创建",
            summary=str(workspace["title"]),
            payload={"relatedRunId": run_id},
        )
        return self.get(run_id)

    def get(self, run_id: str) -> dict[str, object]:
        row = self._workspace_row(run_id)
        workspace = _json_object(row["research_workspace_json"])
        related_run_ids = _string_list(workspace.get("relatedRunIds")) or [run_id]
        latest_run_id = related_run_ids[-1]
        try:
            latest_run = self.agent_runs.get(latest_run_id)
        except ValueError:
            latest_run = self.agent_runs.get(run_id)
        return {
            "brief": self._brief_summary(row),
            "workspace": workspace,
            "pendingAgentUpdate": _json_object(row["research_pending_update_json"]),
            "latestRun": latest_run,
            "externalCandidates": self._external_candidates(
                str(row["knowledge_base_id"]),
                related_run_ids,
            ),
            "citations": self._citations(related_run_ids),
        }

    def bind_to_message(
        self,
        run_id: str,
        *,
        conversation_id: str,
        assistant_message_id: str,
    ) -> dict[str, object]:
        row = self._workspace_row(run_id)
        if row["conversation_id"] not in {None, conversation_id}:
            raise ValueError("Research brief already belongs to another conversation")
        with self.storage.database.connect() as connection:
            message = connection.execute(
                """
                SELECT m.id, m.conversation_id, c.knowledge_base_id
                FROM messages m
                JOIN conversations c ON c.id = m.conversation_id
                WHERE m.id = ?
                """,
                (assistant_message_id,),
            ).fetchone()
            if (
                message is None
                or str(message["conversation_id"]) != conversation_id
                or str(message["knowledge_base_id"]) != str(row["knowledge_base_id"])
            ):
                raise ValueError("Artifact message does not match research brief scope")
            connection.execute(
                """
                UPDATE agent_runs
                SET conversation_id = ?,
                    assistant_message_id = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (conversation_id, assistant_message_id, run_id),
            )
            connection.commit()
        return self.get(run_id)

    def ensure_conversation_scope(
        self,
        run_id: str,
        *,
        knowledge_base_id: str,
        conversation_id: str,
    ) -> dict[str, object]:
        row = self._workspace_row(run_id)
        if (
            str(row["knowledge_base_id"]) != knowledge_base_id
            or str(row["conversation_id"] or "") != conversation_id
        ):
            raise ValueError("Current research brief does not belong to this conversation")
        return self.get(run_id)

    def update(
        self,
        run_id: str,
        *,
        expected_revision: int,
        patch: Mapping[str, object],
        source_ids: Sequence[str] | None = None,
    ) -> dict[str, object]:
        row = self._workspace_row(run_id)
        current_revision = int(row["research_user_revision"])
        if expected_revision != current_revision:
            raise ValueError("研究简报已被其他编辑更新，请刷新后重试")
        workspace = _json_object(row["research_workspace_json"])
        clean_patch = {key: value for key, value in patch.items() if key in EDITABLE_WORKSPACE_KEYS}
        source_scope = (
            self._validated_source_scope(str(row["knowledge_base_id"]), source_ids)
            if source_ids is not None
            else _json_string_list(row["source_scope_json"])
        )
        if not clean_patch and source_ids is None:
            raise ValueError("没有可保存的研究简报字段")
        workspace.update(clean_patch)
        workspace["lastEditedAt"] = _database_now(self.storage)
        workspace["lastEditOrigin"] = "user"
        with self.storage.database.connect() as connection:
            cursor = connection.execute(
                """
                UPDATE agent_runs
                SET research_workspace_json = ?,
                    source_scope_json = ?,
                    research_user_revision = research_user_revision + 1,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ? AND research_user_revision = ?
                """,
                (_json(workspace), _json(source_scope), run_id, expected_revision),
            )
            connection.commit()
        if cursor.rowcount != 1:
            raise ValueError("研究简报已被其他编辑更新，请刷新后重试")
        self.agent_runs.record_workspace_event(
            run_id,
            event_type="workspace.user_edited",
            title="人工编辑已保存",
            summary=f"用户修订版本 {expected_revision + 1}",
            payload={
                "updatedFields": list(clean_patch),
                "sourceIds": source_scope,
                "userRevision": expected_revision + 1,
            },
        )
        return self.get(run_id)

    async def operate(
        self,
        run_id: str,
        *,
        action: str,
        expected_revision: int,
        selection_text: str | None = None,
        section_id: str | None = None,
        api_key: str | None = None,
        base_url: str = DEFAULT_ARK_BASE_URL,
        chat_model: str = DEFAULT_CHAT_MODEL,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
    ) -> dict[str, object]:
        if action not in RESEARCH_ACTIONS:
            raise ValueError("Unsupported research brief action")
        anchor = self._workspace_row(run_id)
        if int(anchor["research_user_revision"]) != expected_revision:
            raise ValueError("研究简报已更新，请先刷新")
        workspace = _json_object(anchor["research_workspace_json"])
        source_ids = _json_string_list(anchor["source_scope_json"])
        goal = _operation_goal(
            action,
            workspace=workspace,
            selection_text=selection_text,
            section_id=section_id,
        )
        if action == "audit_citations":
            paragraphs = _paragraphs_for_audit(workspace, selection_text)
            result = await self.agent_skills.run_skill(
                knowledge_base_id=str(anchor["knowledge_base_id"]),
                skill_id="citation_conflict_audit",
                goal=goal,
                source_ids=source_ids,
                inputs={
                    "paragraphs": paragraphs,
                    "candidateChunkIds": _workspace_chunk_ids(workspace),
                },
                api_key=api_key,
                base_url=base_url,
                chat_model=chat_model,
                embedding_model=embedding_model,
            )
        else:
            result = await self.agent_skills.run_skill(
                knowledge_base_id=str(anchor["knowledge_base_id"]),
                skill_id="research_brief",
                goal=goal,
                source_ids=source_ids,
                inputs={"query": selection_text or goal},
                api_key=api_key,
                base_url=base_url,
                chat_model=chat_model,
                embedding_model=embedding_model,
            )
        proposal = _proposal_from_result(
            action,
            result,
            section_id=section_id,
            selection_text=selection_text,
        )
        latest = self._workspace_row(run_id)
        related_run_id = _required_text(_mapping(result.get("run")).get("id"), "AgentRun id")
        self._bind_related_run(related_run_id, anchor)
        if int(latest["research_user_revision"]) != expected_revision:
            self._save_pending_update(
                run_id,
                proposal=proposal,
                related_run_id=related_run_id,
                expected_revision=expected_revision,
            )
            return self.get(run_id)
        updated = _apply_proposal(workspace, proposal, related_run_id=related_run_id)
        with self.storage.database.connect() as connection:
            cursor = connection.execute(
                """
                UPDATE agent_runs
                SET research_workspace_json = ?,
                    research_agent_revision = research_agent_revision + 1,
                    research_pending_update_json = '{}',
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ? AND research_user_revision = ?
                """,
                (_json(updated), run_id, expected_revision),
            )
            connection.commit()
        if cursor.rowcount != 1:
            self._save_pending_update(
                run_id,
                proposal=proposal,
                related_run_id=related_run_id,
                expected_revision=expected_revision,
            )
            return self.get(run_id)
        self.agent_runs.record_workspace_event(
            run_id,
            event_type="workspace.agent_updated",
            title="研究简报已更新",
            summary=_action_label(action),
            payload={"action": action, "relatedRunId": related_run_id},
        )
        return self.get(run_id)

    def resolve_pending(
        self,
        run_id: str,
        *,
        decision: str,
        expected_revision: int,
    ) -> dict[str, object]:
        if decision not in {"apply", "discard"}:
            raise ValueError("decision must be apply or discard")
        row = self._workspace_row(run_id)
        if int(row["research_user_revision"]) != expected_revision:
            raise ValueError("研究简报已更新，请先刷新")
        pending = _json_object(row["research_pending_update_json"])
        if not pending:
            raise ValueError("没有待处理的 Agent 更新")
        workspace = _json_object(row["research_workspace_json"])
        if decision == "apply":
            workspace = _apply_proposal(
                workspace,
                pending,
                related_run_id=str(pending.get("relatedRunId") or ""),
            )
        with self.storage.database.connect() as connection:
            cursor = connection.execute(
                """
                UPDATE agent_runs
                SET research_workspace_json = ?,
                    research_agent_revision = research_agent_revision + ?,
                    research_pending_update_json = '{}',
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ? AND research_user_revision = ?
                """,
                (
                    _json(workspace),
                    int(decision == "apply"),
                    run_id,
                    expected_revision,
                ),
            )
            connection.commit()
        if cursor.rowcount != 1:
            raise ValueError("研究简报已更新，请先刷新")
        self.agent_runs.record_workspace_event(
            run_id,
            event_type=f"workspace.pending_{decision}",
            title="已合并 Agent 更新" if decision == "apply" else "已放弃 Agent 更新",
            summary=_action_label(str(pending.get("action") or "")),
            payload={"decision": decision},
        )
        return self.get(run_id)

    def export_markdown(self, run_id: str) -> dict[str, object]:
        row = self._workspace_row(run_id)
        workspace = _json_object(row["research_workspace_json"])
        content = str(workspace.get("final") or workspace.get("draft") or "")
        if not content.strip():
            content = _sections_markdown(_object_list(workspace.get("sections")))
        title = str(workspace.get("title") or row["title"])
        return {
            "runId": run_id,
            "fileName": f"{_safe_filename(title)}.md",
            "markdown": content,
        }

    def _workspace_row(self, run_id: str) -> sqlite3.Row:
        with self.storage.database.connect() as connection:
            row = connection.execute(
                """
                SELECT *
                FROM agent_runs
                WHERE id = ?
                  AND skill_id = 'research_brief'
                  AND research_workspace_json != '{}'
                """,
                (run_id,),
            ).fetchone()
        if row is None:
            raise ValueError("Research brief not found")
        return cast(sqlite3.Row, row)

    def _validated_source_scope(
        self,
        knowledge_base_id: str,
        source_ids: Sequence[str],
    ) -> list[str]:
        requested = list(dict.fromkeys(source_ids))
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                "SELECT id FROM sources WHERE knowledge_base_id = ?",
                (knowledge_base_id,),
            ).fetchall()
        available = {str(row["id"]) for row in rows}
        if any(source_id not in available for source_id in requested):
            raise ValueError("sourceIds must belong to the research brief knowledge base")
        return requested

    def _save_pending_update(
        self,
        run_id: str,
        *,
        proposal: Mapping[str, object],
        related_run_id: str,
        expected_revision: int,
    ) -> None:
        pending = {
            **proposal,
            "relatedRunId": related_run_id,
            "baseUserRevision": expected_revision,
            "createdAt": _database_now(self.storage),
        }
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE agent_runs
                SET research_pending_update_json = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (_json(pending), run_id),
            )
            connection.commit()
        self.agent_runs.record_workspace_event(
            run_id,
            event_type="workspace.agent_update_pending",
            title="Agent 结果等待人工合并",
            summary="执行期间检测到人工编辑，未覆盖当前内容",
            payload={
                "action": proposal.get("action"),
                "relatedRunId": related_run_id,
            },
        )

    def _bind_related_run(self, related_run_id: str, anchor: sqlite3.Row) -> None:
        conversation_id = anchor["conversation_id"]
        if conversation_id is None:
            return
        with self.storage.database.connect() as connection:
            connection.execute(
                """
                UPDATE agent_runs
                SET conversation_id = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (conversation_id, related_run_id),
            )
            connection.commit()

    def _brief_summary(self, row: sqlite3.Row) -> dict[str, object]:
        workspace = _json_object(row["research_workspace_json"])
        return {
            "runId": str(row["id"]),
            "knowledgeBaseId": str(row["knowledge_base_id"]),
            "conversationId": row["conversation_id"],
            "assistantMessageId": row["assistant_message_id"],
            "title": str(workspace.get("title") or row["title"]),
            "goal": str(workspace.get("goal") or row["goal"]),
            "status": str(row["status"]),
            "sourceIds": _json_string_list(row["source_scope_json"]),
            "userRevision": int(row["research_user_revision"]),
            "agentRevision": int(row["research_agent_revision"]),
            "hasPendingAgentUpdate": bool(_json_object(row["research_pending_update_json"])),
            "latestRunId": (_string_list(workspace.get("relatedRunIds")) or [str(row["id"])])[-1],
            "createdAt": str(row["created_at"]),
            "updatedAt": str(row["updated_at"]),
        }

    def _external_candidates(
        self,
        knowledge_base_id: str,
        related_run_ids: Sequence[str],
    ) -> list[dict[str, object]]:
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT erc.*
                FROM external_research_candidates erc
                JOIN agent_runs ar ON ar.id = erc.run_id
                WHERE ar.knowledge_base_id = ?
                  AND (
                      erc.status = 'candidate'
                      OR erc.run_id IN ({placeholders})
                  )
                ORDER BY erc.created_at DESC
                LIMIT 50
                """.format(placeholders=",".join("?" for _ in related_run_ids)),
                (knowledge_base_id, *related_run_ids),
            ).fetchall()
        return [
            {
                "id": str(row["id"]),
                "runId": str(row["run_id"]),
                "knowledgeBaseId": knowledge_base_id,
                "serverId": str(row["server_id"]),
                "toolName": str(row["tool_name"]),
                "title": str(row["title"]),
                "url": str(row["url"]),
                "snippet": str(row["snippet"]),
                "content": str(row["content"]),
                "sourceMetadata": _json_object(row["source_metadata_json"]),
                "status": str(row["status"]),
                "initialComparison": _json_object(row["initial_comparison_json"]),
                "finalComparison": _json_object(row["final_comparison_json"]),
                "importedSourceId": row["imported_source_id"],
                "indexedVersionId": row["indexed_version_id"],
                "errorMessage": row["error_message"],
                "createdAt": str(row["created_at"]),
                "updatedAt": str(row["updated_at"]),
            }
            for row in rows
        ]

    def _citations(self, related_run_ids: Sequence[str]) -> list[dict[str, object]]:
        placeholders = ",".join("?" for _ in related_run_ids)
        with self.storage.database.connect() as connection:
            rows = connection.execute(
                f"""
                SELECT
                    arc.paragraph_index,
                    arc.chunk_id,
                    c.page_number,
                    c.bounding_box_json,
                    c.heading_path_json,
                    c.anchor,
                    c.original_text,
                    c.normalized_text,
                    sv.id AS source_version_id,
                    s.id AS source_id,
                    s.source_type,
                    s.display_name,
                    s.uri
                FROM agent_run_citations arc
                JOIN chunks c ON c.id = arc.chunk_id
                JOIN source_versions sv ON sv.id = c.source_version_id
                JOIN sources s ON s.id = sv.source_id
                WHERE arc.run_id IN ({placeholders})
                ORDER BY arc.paragraph_index, arc.chunk_id
                """,
                tuple(related_run_ids),
            ).fetchall()
        return [
            {
                "paragraphIndex": int(row["paragraph_index"]),
                "chunkId": str(row["chunk_id"]),
                "source": {
                    "id": str(row["source_id"]),
                    "type": str(row["source_type"]),
                    "displayName": str(row["display_name"]),
                    "uri": row["uri"],
                    "versionId": str(row["source_version_id"]),
                },
                "location": {
                    "pageNumber": row["page_number"],
                    "boundingBox": _json_object(row["bounding_box_json"]) or None,
                    "headingPath": _json_string_list(row["heading_path_json"]),
                    "anchor": row["anchor"],
                },
                "text": {
                    "preview": str(row["normalized_text"])[:220],
                    "normalized": str(row["normalized_text"]),
                    "original": str(row["original_text"]),
                },
            }
            for row in rows
        ]


def _workspace_from_agent_run(response: Mapping[str, object]) -> dict[str, object]:
    run = _mapping(response.get("run"))
    outputs = _object_list(response.get("outputs"))
    final = next(
        (item for item in outputs if item.get("outputType") == "final"),
        outputs[0] if outputs else {},
    )
    payload = _mapping(final.get("payload"))
    skill_output = _mapping(payload.get("skillOutput"))
    content = str(final.get("content") or "")
    sections = _sections_from_markdown(content)
    if not sections:
        sections = [
            {
                "id": f"research-section-{uuid4().hex}",
                "title": "研究结论",
                "content": content,
                "evidenceChunkIds": _citation_chunk_ids(response),
                "origin": "agent",
            }
        ]
    return {
        "title": str(final.get("title") or run.get("title") or "证据研究简报"),
        "goal": str(run.get("goal") or ""),
        "plan": _mapping(run.get("plan")),
        "outline": {
            "researchQuestions": _string_list(skill_output.get("researchQuestions")),
            "sections": [{"id": section["id"], "title": section["title"]} for section in sections],
        },
        "draft": content,
        "final": content,
        "sections": sections,
        "latestAudit": _mapping(skill_output.get("citationValidation")),
        "conflicts": _object_list(skill_output.get("conflicts")),
        "gaps": _object_list(skill_output.get("gaps")),
        "evidenceChunkIds": _citation_chunk_ids(response),
        "relatedRunIds": [str(run.get("id"))],
        "lastEditOrigin": "agent",
    }


def _proposal_from_result(
    action: str,
    result: Mapping[str, object],
    *,
    section_id: str | None,
    selection_text: str | None,
) -> dict[str, object]:
    outputs = _object_list(result.get("outputs"))
    final = next(
        (item for item in outputs if item.get("outputType") == "final"),
        outputs[0] if outputs else {},
    )
    payload = _mapping(final.get("payload"))
    skill_output = _mapping(payload.get("skillOutput"))
    return {
        "action": action,
        "sectionId": section_id,
        "selectionText": selection_text,
        "content": str(final.get("content") or ""),
        "audit": (
            skill_output
            if action == "audit_citations"
            else _mapping(skill_output.get("citationValidation"))
        ),
        "conflicts": _object_list(skill_output.get("conflicts")),
        "evidenceChunkIds": _citation_chunk_ids(result),
    }


def _apply_proposal(
    workspace: Mapping[str, object],
    proposal: Mapping[str, object],
    *,
    related_run_id: str,
) -> dict[str, object]:
    updated = dict(workspace)
    action = str(proposal.get("action") or "")
    content = str(proposal.get("content") or "")
    sections = [dict(item) for item in _object_list(updated.get("sections"))]
    if action == "regenerate_section":
        section_id = str(proposal.get("sectionId") or "")
        for section in sections:
            if section.get("id") == section_id:
                section["content"] = content
                section["evidenceChunkIds"] = _string_list(proposal.get("evidenceChunkIds"))
                section["origin"] = "agent"
                break
        updated["draft"] = _sections_markdown(sections)
    elif action == "revise_document":
        updated["draft"] = content
        updated["final"] = content
        sections = _sections_from_markdown(content)
    elif action in {"continue_research", "supplement_evidence"}:
        title = "继续研究" if action == "continue_research" else "补充证据"
        sections.append(
            {
                "id": f"research-section-{uuid4().hex}",
                "title": title,
                "content": content,
                "evidenceChunkIds": _string_list(proposal.get("evidenceChunkIds")),
                "origin": "agent",
            }
        )
        updated["draft"] = _sections_markdown(sections)
    elif action == "audit_citations":
        updated["latestAudit"] = _mapping(proposal.get("audit"))
    updated["sections"] = sections
    updated["outline"] = {
        **_mapping(updated.get("outline")),
        "sections": [
            {"id": section.get("id"), "title": section.get("title")} for section in sections
        ],
    }
    updated["conflicts"] = _object_list(proposal.get("conflicts"))
    updated["evidenceChunkIds"] = list(
        dict.fromkeys(
            _string_list(updated.get("evidenceChunkIds"))
            + _string_list(proposal.get("evidenceChunkIds"))
        )
    )
    related = _string_list(updated.get("relatedRunIds"))
    if related_run_id and related_run_id not in related:
        related.append(related_run_id)
    updated["relatedRunIds"] = related
    updated["lastEditOrigin"] = "agent"
    return updated


def _operation_goal(
    action: str,
    *,
    workspace: Mapping[str, object],
    selection_text: str | None,
    section_id: str | None,
) -> str:
    goal = str(workspace.get("goal") or "")
    selected = " ".join((selection_text or "").split())
    if action == "continue_research":
        return f"继续研究：{selected or goal}"
    if action == "supplement_evidence":
        return f"为以下内容补充可引用证据：{selected or goal}"
    if action == "audit_citations":
        return f"审计以下研究简报内容的引用与来源冲突：{selected or goal}"
    if action == "revise_document":
        current = str(workspace.get("final") or workspace.get("draft") or "")
        return f"根据用户要求修订整份研究简报：{selected or goal}\n\n当前简报：\n{current}"
    section = next(
        (item for item in _object_list(workspace.get("sections")) if item.get("id") == section_id),
        {},
    )
    return (
        f"重新生成研究简报章节“{section.get('title', '指定章节')}”，"
        f"保持目标“{goal}”，重点处理：{selected or section.get('content', '')}"
    )


def _paragraphs_for_audit(
    workspace: Mapping[str, object],
    selection_text: str | None,
) -> list[dict[str, object]]:
    content = selection_text or str(workspace.get("final") or workspace.get("draft") or "")
    chunk_ids = _workspace_chunk_ids(workspace)
    return [
        {"text": paragraph, "evidenceChunkIds": chunk_ids}
        for paragraph in content.split("\n\n")
        if paragraph.strip()
    ]


def _workspace_chunk_ids(workspace: Mapping[str, object]) -> list[str]:
    return list(
        dict.fromkeys(
            _string_list(workspace.get("evidenceChunkIds"))
            + [
                chunk_id
                for section in _object_list(workspace.get("sections"))
                for chunk_id in _string_list(section.get("evidenceChunkIds"))
            ]
        )
    )


def _sections_from_markdown(content: str) -> list[dict[str, object]]:
    sections: list[dict[str, object]] = []
    title = "摘要"
    lines: list[str] = []
    for line in content.splitlines():
        if line.startswith("## "):
            section_content = "\n".join(lines).strip()
            if section_content:
                sections.append(
                    {
                        "id": f"research-section-{uuid4().hex}",
                        "title": title,
                        "content": section_content,
                        "evidenceChunkIds": [],
                        "origin": "agent",
                    }
                )
            title = line.removeprefix("## ").strip() or "未命名章节"
            lines = []
        elif not line.startswith("# "):
            lines.append(line)
    section_content = "\n".join(lines).strip()
    if section_content or not sections:
        sections.append(
            {
                "id": f"research-section-{uuid4().hex}",
                "title": title,
                "content": section_content,
                "evidenceChunkIds": [],
                "origin": "agent",
            }
        )
    return [section for section in sections if section["content"] or section["title"]]


def _sections_markdown(sections: Sequence[Mapping[str, object]]) -> str:
    return "\n\n".join(
        f"## {section.get('title', '未命名章节')}\n\n{section.get('content', '')}".strip()
        for section in sections
    )


def _citation_chunk_ids(response: Mapping[str, object]) -> list[str]:
    return list(
        dict.fromkeys(
            str(item["chunkId"])
            for item in _object_list(response.get("citations"))
            if isinstance(item.get("chunkId"), str)
        )
    )


def _action_label(action: str) -> str:
    return {
        "continue_research": "继续研究",
        "supplement_evidence": "补充证据",
        "audit_citations": "引用审计",
        "regenerate_section": "重新生成指定章节",
        "revise_document": "修订整份简报",
    }.get(action, action)


def _safe_filename(value: str) -> str:
    return (
        "".join(character if character not in '<>:"/\\|?*' else "_" for character in value).strip()
        or "研究简报"
    )


def _required_text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value.strip()


def _mapping(value: object) -> dict[str, object]:
    return cast(dict[str, object], value) if isinstance(value, dict) else {}


def _object_list(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    return [cast(dict[str, object], item) for item in value if isinstance(item, dict)]


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_object(value: object) -> dict[str, object]:
    if not isinstance(value, str) or not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return cast(dict[str, object], parsed) if isinstance(parsed, dict) else {}


def _json_string_list(value: object) -> list[str]:
    if not isinstance(value, str):
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    return [item for item in parsed if isinstance(item, str)] if isinstance(parsed, list) else []


def _json_list(value: object) -> list[object]:
    if not isinstance(value, str) or not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def _database_now(storage: StorageRuntime) -> str:
    with storage.database.connect() as connection:
        return str(connection.execute("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").fetchone()[0])
