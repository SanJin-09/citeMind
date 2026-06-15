import asyncio
import os
import sys
from pathlib import Path

from citemind_worker.background_job_service import BackgroundJobService
from citemind_worker.conversation_service import ConversationService
from citemind_worker.indexing_service import IndexingService
from citemind_worker.knowledge_base_service import KnowledgeBaseService
from citemind_worker.logging_config import configure_logging
from citemind_worker.maintenance_service import MaintenanceService
from citemind_worker.model_catalog import (
    DEFAULT_ARK_BASE_URL,
    DEFAULT_CHAT_MODEL,
    DEFAULT_CREDENTIAL_ID,
    DEFAULT_EMBEDDING_MODEL,
)
from citemind_worker.model_service import SeedModelService
from citemind_worker.retrieval_service import HybridRetrievalService
from citemind_worker.rpc import JsonValue, RpcError, RpcServer, require_object_params
from citemind_worker.source_import_service import SourceImportService
from citemind_worker.source_organization_service import SourceOrganizationService
from citemind_worker.storage import StorageRuntime
from citemind_worker.writing_workflow_service import WritingWorkflowService


def create_server(
    storage: StorageRuntime | None = None,
    model_service: SeedModelService | None = None,
    knowledge_base_service: KnowledgeBaseService | None = None,
    background_job_service: BackgroundJobService | None = None,
    source_import_service: SourceImportService | None = None,
    source_organization_service: SourceOrganizationService | None = None,
    indexing_service: IndexingService | None = None,
    retrieval_service: HybridRetrievalService | None = None,
    conversation_service: ConversationService | None = None,
    maintenance_service: MaintenanceService | None = None,
    writing_workflow_service: WritingWorkflowService | None = None,
) -> RpcServer:
    server = RpcServer()
    seed_models = model_service or (SeedModelService(storage) if storage is not None else None)
    knowledge_bases = knowledge_base_service or (
        KnowledgeBaseService(storage) if storage is not None else None
    )
    background_jobs = background_job_service or (
        BackgroundJobService(storage) if storage is not None else None
    )
    source_imports = source_import_service or (
        SourceImportService(storage, jobs=background_jobs) if storage is not None else None
    )
    source_organizations = source_organization_service or (
        SourceOrganizationService(storage) if storage is not None else None
    )
    indexes = indexing_service or (
        IndexingService(storage, jobs=background_jobs) if storage is not None else None
    )
    retrievals = retrieval_service or (
        HybridRetrievalService(storage) if storage is not None else None
    )
    conversations = conversation_service or (
        ConversationService(storage, retrieval=retrievals) if storage is not None else None
    )
    maintenance = maintenance_service or (
        MaintenanceService(storage) if storage is not None else None
    )
    writing = writing_workflow_service or (
        WritingWorkflowService(storage) if storage is not None else None
    )

    def health(params: JsonValue) -> JsonValue:
        require_object_params(params)
        result: dict[str, JsonValue] = {
            "status": "ok",
            "service": "citemind-worker",
            "protocolVersion": "2.0",
            "pid": os.getpid(),
        }
        if storage is not None:
            result["storage"] = storage.health_summary()  # type: ignore[assignment]
        return result

    def storage_status(params: JsonValue) -> JsonValue:
        require_object_params(params)
        if storage is None:
            return {"ready": False}
        return storage.status()  # type: ignore[return-value]

    def maintenance_status(params: JsonValue) -> JsonValue:
        require_object_params(params)
        service = _require_maintenance_service(maintenance)
        return service.status()  # type: ignore[return-value]

    def cleanup_storage(params: JsonValue) -> JsonValue:
        require_object_params(params)
        service = _require_maintenance_service(maintenance)
        return service.cleanup()  # type: ignore[return-value]

    def shutdown(params: JsonValue) -> JsonValue:
        require_object_params(params)
        server.stopped = True
        return {"status": "stopping"}

    def models_status(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_model_service(seed_models)
        credential_id = _optional_str(values, "credentialId", DEFAULT_CREDENTIAL_ID)
        return service.status(credential_id)  # type: ignore[return-value]

    async def validate_models(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_model_service(seed_models)
        api_key = _required_str(values, "apiKey")
        credential_id = _optional_str(values, "credentialId", DEFAULT_CREDENTIAL_ID)
        name = _optional_str(values, "name", "我的 Seed API")
        encrypted_key_ref = _optional_str(values, "encryptedKeyRef", "safeStorage:seed-api/default")
        base_url = _optional_str(values, "baseUrl", DEFAULT_ARK_BASE_URL)
        default_chat_model = _optional_str(values, "defaultChatModel", DEFAULT_CHAT_MODEL)
        default_embedding_model = _optional_str(
            values, "defaultEmbeddingModel", DEFAULT_EMBEDDING_MODEL
        )
        return await service.validate_defaults(
            api_key=api_key,
            credential_id=credential_id,
            name=name,
            encrypted_key_ref=encrypted_key_ref,
            base_url=base_url,
            default_chat_model=default_chat_model,
            default_embedding_model=default_embedding_model,
        )  # type: ignore[return-value]

    def delete_credential(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_model_service(seed_models)
        credential_id = _optional_str(values, "credentialId", DEFAULT_CREDENTIAL_ID)
        return service.delete_credential(credential_id)  # type: ignore[return-value]

    def list_knowledge_bases(params: JsonValue) -> JsonValue:
        require_object_params(params)
        service = _require_knowledge_base_service(knowledge_bases)
        return service.list_knowledge_bases()  # type: ignore[return-value]

    def create_knowledge_base(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_knowledge_base_service(knowledge_bases)
        name = _required_str(values, "name")
        description = _optional_nullable_str(values, "description")
        try:
            return service.create(name, description)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def rename_knowledge_base(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_knowledge_base_service(knowledge_bases)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        name = _required_str(values, "name")
        description = _optional_nullable_str(values, "description")
        try:
            return service.rename(knowledge_base_id, name, description)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def delete_knowledge_base(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_knowledge_base_service(knowledge_bases)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        try:
            return service.delete(knowledge_base_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def list_sources(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_knowledge_base_service(knowledge_bases)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        try:
            return service.sources(knowledge_base_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def create_job(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_background_job_service(background_jobs)
        job_type = _required_str(values, "jobType")
        target_id = _required_str(values, "targetId")
        checkpoint = _optional_dict(values, "checkpoint")
        try:
            return service.create(job_type, target_id, checkpoint=checkpoint)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def list_jobs(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_background_job_service(background_jobs)
        status = _optional_nullable_str(values, "status")
        target_id = _optional_nullable_str(values, "targetId")
        include_terminal = _optional_bool(values, "includeTerminal", True)
        limit = _optional_int(values, "limit", 50)
        try:
            return service.list_jobs(
                status=status,
                target_id=target_id,
                include_terminal=include_terminal,
                limit=limit,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def list_unfinished_jobs(params: JsonValue) -> JsonValue:
        require_object_params(params)
        service = _require_background_job_service(background_jobs)
        return service.list_unfinished()  # type: ignore[return-value]

    def update_job(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_background_job_service(background_jobs)
        job_id = _required_str(values, "jobId")
        status = _optional_nullable_str(values, "status")
        progress = _optional_float(values, "progress")
        checkpoint = _optional_dict(values, "checkpoint")
        error_message = _optional_nullable_str(values, "errorMessage")
        try:
            return service.update_progress(
                job_id,
                status=status,
                progress=progress,
                checkpoint=checkpoint,
                error_message=error_message,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def pause_job(params: JsonValue) -> JsonValue:
        service = _require_background_job_service(background_jobs)
        job_id = _required_str(require_object_params(params), "jobId")
        try:
            return service.pause(job_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def resume_job(params: JsonValue) -> JsonValue:
        service = _require_background_job_service(background_jobs)
        job_id = _required_str(require_object_params(params), "jobId")
        try:
            return service.resume(job_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def cancel_job(params: JsonValue) -> JsonValue:
        service = _require_background_job_service(background_jobs)
        job_id = _required_str(require_object_params(params), "jobId")
        try:
            return service.cancel(job_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def retry_job(params: JsonValue) -> JsonValue:
        service = _require_background_job_service(background_jobs)
        job_id = _required_str(require_object_params(params), "jobId")
        try:
            return service.retry(job_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def recover_jobs(params: JsonValue) -> JsonValue:
        require_object_params(params)
        service = _require_background_job_service(background_jobs)
        return service.recover_unfinished()  # type: ignore[return-value]

    def import_file(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_source_import_service(source_imports)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        file_path = _required_str(values, "filePath")
        display_name = _optional_nullable_str(values, "displayName")
        duplicate_action = _optional_str(values, "duplicateAction", "ask")
        try:
            return service.import_file(
                knowledge_base_id,
                file_path,
                display_name=display_name,
                duplicate_action=duplicate_action,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def import_web(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_source_import_service(source_imports)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        url = _required_str(values, "url")
        display_name = _optional_nullable_str(values, "displayName")
        duplicate_action = _optional_str(values, "duplicateAction", "ask")
        try:
            return service.import_web(
                knowledge_base_id,
                url,
                display_name=display_name,
                duplicate_action=duplicate_action,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def parse_checks(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_source_import_service(source_imports)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        try:
            return service.parse_checks(knowledge_base_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def delete_source(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_source_import_service(source_imports)
        source_id = _required_str(values, "sourceId")
        try:
            return service.delete_source(source_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def resolve_duplicate(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_source_import_service(source_imports)
        source_id = _required_str(values, "sourceId")
        action = _required_str(values, "action")
        try:
            return service.resolve_duplicate(source_id, action)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def check_web_sources(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_source_import_service(source_imports)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        due_only = _optional_bool(values, "dueOnly", False)
        try:
            return service.check_web_updates(knowledge_base_id, due_only=due_only)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def check_web_source(params: JsonValue) -> JsonValue:
        service = _require_source_import_service(source_imports)
        source_id = _required_str(require_object_params(params), "sourceId")
        try:
            return service.check_web_update(source_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def list_source_versions(params: JsonValue) -> JsonValue:
        service = _require_source_import_service(source_imports)
        source_id = _required_str(require_object_params(params), "sourceId")
        try:
            return service.source_versions(source_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def source_version_diff(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_source_import_service(source_imports)
        source_id = _required_str(values, "sourceId")
        version_id = _required_str(values, "versionId")
        try:
            return service.source_version_diff(source_id, version_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def decide_source_version(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_source_import_service(source_imports)
        source_id = _required_str(values, "sourceId")
        version_id = _required_str(values, "versionId")
        decision = _required_str(values, "decision")
        try:
            return service.decide_source_version(source_id, version_id, decision)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def update_source_maintenance(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_source_import_service(source_imports)
        source_id = _required_str(values, "sourceId")
        replacement_source_id = _optional_nullable_str(values, "replacementSourceId")
        review_at = _optional_nullable_str(values, "reviewAt")
        expiry_status = _optional_str(values, "expiryStatus", "active")
        try:
            return service.update_source_maintenance(
                source_id,
                replacement_source_id=replacement_source_id,
                review_at=review_at,
                expiry_status=expiry_status,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def suggest_source_status(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_source_import_service(source_imports)
        source_id = _required_str(values, "sourceId")
        suggestion = _required_str(values, "suggestion")
        reason = _required_str(values, "reason")
        confidence = _optional_float(values, "confidence")
        if confidence is None:
            raise RpcError(-32602, "confidence is required")
        try:
            return service.suggest_source_status(
                source_id,
                suggestion=suggestion,
                reason=reason,
                confidence=confidence,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def decide_source_suggestion(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_source_import_service(source_imports)
        source_id = _required_str(values, "sourceId")
        decision = _required_str(values, "decision")
        try:
            return service.decide_source_suggestion(source_id, decision)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def source_organization(params: JsonValue) -> JsonValue:
        service = _require_source_organization_service(source_organizations)
        source_id = _required_str(require_object_params(params), "sourceId")
        try:
            return service.details(source_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def classify_source(params: JsonValue) -> JsonValue:
        service = _require_source_organization_service(source_organizations)
        source_id = _required_str(require_object_params(params), "sourceId")
        try:
            return service.classify(source_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    async def suggest_source_tags(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_source_organization_service(source_organizations)
        source_id = _required_str(values, "sourceId")
        api_key = _required_str(values, "apiKey")
        base_url = _optional_str(values, "baseUrl", DEFAULT_ARK_BASE_URL)
        chat_model = _optional_str(values, "chatModel", DEFAULT_CHAT_MODEL)
        try:
            return await service.suggest_tags(
                source_id,
                api_key=api_key,
                base_url=base_url,
                chat_model=chat_model,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def decide_source_tag(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_source_organization_service(source_organizations)
        source_id = _required_str(values, "sourceId")
        tag_id = _required_str(values, "tagId")
        decision = _required_str(values, "decision")
        corrected_tag = _optional_nullable_str(values, "correctedTag")
        try:
            return service.decide_tag(
                source_id,
                tag_id,
                decision,
                corrected_tag=corrected_tag,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def decide_source_relation(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_source_organization_service(source_organizations)
        source_id = _required_str(values, "sourceId")
        relation_id = _required_str(values, "relationId")
        decision = _required_str(values, "decision")
        try:
            return service.decide_relation(source_id, relation_id, decision)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def list_writing_projects(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_writing_workflow_service(writing)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        try:
            return service.list_projects(knowledge_base_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def get_writing_project(params: JsonValue) -> JsonValue:
        service = _require_writing_workflow_service(writing)
        project_id = _required_str(require_object_params(params), "projectId")
        try:
            return service.project(project_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    async def create_writing_project(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_writing_workflow_service(writing)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        goal = _required_str(values, "goal")
        workflow_type = _required_str(values, "workflowType")
        api_key = _required_str(values, "apiKey")
        base_url = _optional_str(values, "baseUrl", DEFAULT_ARK_BASE_URL)
        chat_model = _optional_str(values, "chatModel", DEFAULT_CHAT_MODEL)
        embedding_model = _optional_str(values, "embeddingModel", DEFAULT_EMBEDDING_MODEL)
        try:
            return await service.create_project(
                knowledge_base_id,
                goal=goal,
                workflow_type=workflow_type,
                api_key=api_key,
                base_url=base_url,
                chat_model=chat_model,
                embedding_model=embedding_model,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    async def run_writing_section(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_writing_workflow_service(writing)
        project_id = _required_str(values, "projectId")
        section_id = _optional_nullable_str(values, "sectionId")
        revise = _optional_bool(values, "revise", False)
        api_key = _required_str(values, "apiKey")
        base_url = _optional_str(values, "baseUrl", DEFAULT_ARK_BASE_URL)
        chat_model = _optional_str(values, "chatModel", DEFAULT_CHAT_MODEL)
        embedding_model = _optional_str(values, "embeddingModel", DEFAULT_EMBEDDING_MODEL)
        try:
            return await service.run_section(
                project_id,
                section_id=section_id,
                revise=revise,
                api_key=api_key,
                base_url=base_url,
                chat_model=chat_model,
                embedding_model=embedding_model,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def update_writing_section(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_writing_workflow_service(writing)
        section_id = _required_str(values, "sectionId")
        content = _required_str(values, "content")
        try:
            return service.update_section(section_id, content)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def audit_writing_section(params: JsonValue) -> JsonValue:
        service = _require_writing_workflow_service(writing)
        section_id = _required_str(require_object_params(params), "sectionId")
        try:
            return service.audit_section(section_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def export_writing_word(params: JsonValue) -> JsonValue:
        service = _require_writing_workflow_service(writing)
        project_id = _required_str(require_object_params(params), "projectId")
        try:
            return service.export_word(project_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    async def build_index(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_indexing_service(indexes)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        api_key = _optional_nullable_str(values, "apiKey")
        base_url = _optional_str(values, "baseUrl", DEFAULT_ARK_BASE_URL)
        embedding_model = _optional_str(values, "embeddingModel", DEFAULT_EMBEDDING_MODEL)
        background = _optional_bool(values, "background", False)
        try:
            if background:
                return service.start_background_build(
                    knowledge_base_id,
                    api_key=api_key,
                    base_url=base_url,
                    embedding_model=embedding_model,
                )  # type: ignore[return-value]
            return await service.build_index(
                knowledge_base_id,
                api_key=api_key,
                base_url=base_url,
                embedding_model=embedding_model,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def delete_indexes(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_indexing_service(indexes)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        try:
            return service.delete_indexes(knowledge_base_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    async def rebuild_index(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_indexing_service(indexes)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        api_key = _optional_nullable_str(values, "apiKey")
        base_url = _optional_str(values, "baseUrl", DEFAULT_ARK_BASE_URL)
        embedding_model = _optional_str(values, "embeddingModel", DEFAULT_EMBEDDING_MODEL)
        background = _optional_bool(values, "background", False)
        try:
            if background:
                return service.start_background_build(
                    knowledge_base_id,
                    api_key=api_key,
                    base_url=base_url,
                    embedding_model=embedding_model,
                    job_type="index.rebuild",
                )  # type: ignore[return-value]
            return await service.rebuild_index(
                knowledge_base_id,
                api_key=api_key,
                base_url=base_url,
                embedding_model=embedding_model,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def index_status(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_indexing_service(indexes)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        index_version_id = _optional_nullable_str(values, "indexVersionId")
        try:
            return service.index_status(
                knowledge_base_id,
                index_version_id=index_version_id,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def list_index_versions(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_indexing_service(indexes)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        try:
            return service.list_versions(knowledge_base_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def estimate_index(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_indexing_service(indexes)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        embedding_model = _optional_str(values, "embeddingModel", DEFAULT_EMBEDDING_MODEL)
        try:
            return service.estimate_build(
                knowledge_base_id,
                embedding_model=embedding_model,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def rollback_index(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_indexing_service(indexes)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        index_version_id = _required_str(values, "indexVersionId")
        try:
            return service.rollback(knowledge_base_id, index_version_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    async def retry_index(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_indexing_service(indexes)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        index_version_id = _required_str(values, "indexVersionId")
        api_key = _optional_nullable_str(values, "apiKey")
        base_url = _optional_str(values, "baseUrl", DEFAULT_ARK_BASE_URL)
        background = _optional_bool(values, "background", False)
        try:
            if background:
                return service.start_background_retry(
                    knowledge_base_id,
                    index_version_id,
                    api_key=api_key,
                    base_url=base_url,
                )  # type: ignore[return-value]
            return await service.retry_failed(
                knowledge_base_id,
                index_version_id,
                api_key=api_key,
                base_url=base_url,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    async def hybrid_search(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_retrieval_service(retrievals)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        query = _required_str(values, "query")
        api_key = _optional_nullable_str(values, "apiKey")
        base_url = _optional_str(values, "baseUrl", DEFAULT_ARK_BASE_URL)
        embedding_model = _optional_str(values, "embeddingModel", DEFAULT_EMBEDDING_MODEL)
        limit = _optional_int(values, "limit", 8)
        candidate_limit = _optional_int(values, "candidateLimit", 24)
        rerank_model_version = _optional_nullable_str(values, "rerankModelVersion")
        try:
            return await service.retrieve(
                knowledge_base_id,
                query,
                api_key=api_key,
                base_url=base_url,
                embedding_model=embedding_model,
                limit=limit,
                candidate_limit=candidate_limit,
                rerank_model_version=rerank_model_version,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def list_conversations(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_conversation_service(conversations)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        try:
            return service.list_conversations(knowledge_base_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def conversation_messages(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_conversation_service(conversations)
        conversation_id = _required_str(values, "conversationId")
        try:
            return service.messages(conversation_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def delete_conversation(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_conversation_service(conversations)
        conversation_id = _required_str(values, "conversationId")
        try:
            return service.delete(conversation_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def set_conversation_model(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_conversation_service(conversations)
        conversation_id = _required_str(values, "conversationId")
        model_id = _required_str(values, "modelId")
        try:
            return service.set_model(conversation_id, model_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def export_conversation(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_conversation_service(conversations)
        conversation_id = _required_str(values, "conversationId")
        message_id = _optional_nullable_str(values, "messageId")
        try:
            return service.export_markdown(
                conversation_id,
                message_id=message_id,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    def usage_summary(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_conversation_service(conversations)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        try:
            return service.usage_summary(knowledge_base_id)  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    async def answer_conversation(params: JsonValue) -> JsonValue:
        values = require_object_params(params)
        service = _require_conversation_service(conversations)
        knowledge_base_id = _required_str(values, "knowledgeBaseId")
        query = _required_str(values, "query")
        conversation_id = _optional_nullable_str(values, "conversationId")
        api_key = _optional_nullable_str(values, "apiKey")
        base_url = _optional_str(values, "baseUrl", DEFAULT_ARK_BASE_URL)
        chat_model = _optional_nullable_str(values, "chatModel")
        embedding_model = _optional_str(values, "embeddingModel", DEFAULT_EMBEDDING_MODEL)
        limit = _optional_int(values, "limit", 8)
        candidate_limit = _optional_int(values, "candidateLimit", 24)
        max_output_tokens = _optional_int(values, "maxOutputTokens", 1200)
        try:
            return await service.answer(
                knowledge_base_id=knowledge_base_id,
                query=query,
                conversation_id=conversation_id,
                api_key=api_key,
                base_url=base_url,
                chat_model=chat_model,
                embedding_model=embedding_model,
                limit=limit,
                candidate_limit=candidate_limit,
                max_output_tokens=max_output_tokens,
            )  # type: ignore[return-value]
        except ValueError as error:
            raise RpcError(-32602, str(error)) from error

    server.register("system.health", health)
    server.register("system.storage_status", storage_status)
    server.register("system.maintenance_status", maintenance_status)
    server.register("system.cleanup_storage", cleanup_storage)
    server.register("system.shutdown", shutdown)
    server.register("models.status", models_status)
    server.register("models.validate_defaults", validate_models)
    server.register("models.delete_credential", delete_credential)
    server.register("knowledge_bases.list", list_knowledge_bases)
    server.register("knowledge_bases.create", create_knowledge_base)
    server.register("knowledge_bases.rename", rename_knowledge_base)
    server.register("knowledge_bases.delete", delete_knowledge_base)
    server.register("knowledge_bases.sources", list_sources)
    server.register("jobs.create", create_job)
    server.register("jobs.list", list_jobs)
    server.register("jobs.unfinished", list_unfinished_jobs)
    server.register("jobs.update", update_job)
    server.register("jobs.pause", pause_job)
    server.register("jobs.resume", resume_job)
    server.register("jobs.cancel", cancel_job)
    server.register("jobs.retry", retry_job)
    server.register("jobs.recover", recover_jobs)
    server.register("sources.import_file", import_file)
    server.register("sources.import_web", import_web)
    server.register("sources.parse_checks", parse_checks)
    server.register("sources.delete", delete_source)
    server.register("sources.resolve_duplicate", resolve_duplicate)
    server.register("sources.check_web_all", check_web_sources)
    server.register("sources.check_web", check_web_source)
    server.register("sources.versions", list_source_versions)
    server.register("sources.version_diff", source_version_diff)
    server.register("sources.decide_version", decide_source_version)
    server.register("sources.update_maintenance", update_source_maintenance)
    server.register("sources.suggest_status", suggest_source_status)
    server.register("sources.decide_suggestion", decide_source_suggestion)
    server.register("sources.organization", source_organization)
    server.register("sources.classify", classify_source)
    server.register("sources.suggest_tags", suggest_source_tags)
    server.register("sources.decide_tag", decide_source_tag)
    server.register("sources.decide_relation", decide_source_relation)
    server.register("writing.list", list_writing_projects)
    server.register("writing.project", get_writing_project)
    server.register("writing.create", create_writing_project)
    server.register("writing.run_section", run_writing_section)
    server.register("writing.update_section", update_writing_section)
    server.register("writing.audit_section", audit_writing_section)
    server.register("writing.export_word", export_writing_word)
    server.register("indexes.build", build_index)
    server.register("indexes.delete", delete_indexes)
    server.register("indexes.rebuild", rebuild_index)
    server.register("indexes.status", index_status)
    server.register("indexes.list", list_index_versions)
    server.register("indexes.estimate", estimate_index)
    server.register("indexes.rollback", rollback_index)
    server.register("indexes.retry", retry_index)
    server.register("retrieval.hybrid_search", hybrid_search)
    server.register("conversations.list", list_conversations)
    server.register("conversations.messages", conversation_messages)
    server.register("conversations.delete", delete_conversation)
    server.register("conversations.set_model", set_conversation_model)
    server.register("conversations.export_markdown", export_conversation)
    server.register("conversations.usage_summary", usage_summary)
    server.register("conversations.answer", answer_conversation)
    return server


async def serve() -> None:
    configure_logging()
    storage = StorageRuntime(_resolve_data_root())
    storage.initialize()
    BackgroundJobService(storage).recover_unfinished()
    server = create_server(storage)
    await server.serve(sys.stdin, sys.stdout)


def run() -> None:
    asyncio.run(serve())


def _resolve_data_root() -> Path:
    configured = os.environ.get("CITEMIND_DATA_DIR")
    if configured:
        return Path(configured)
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "citeMind"
    return Path.home() / ".citemind"


def _require_model_service(service: SeedModelService | None) -> SeedModelService:
    if service is None:
        raise RpcError(-32010, "Model service is not available")
    return service


def _require_knowledge_base_service(
    service: KnowledgeBaseService | None,
) -> KnowledgeBaseService:
    if service is None:
        raise RpcError(-32011, "Knowledge base service is not available")
    return service


def _require_background_job_service(
    service: BackgroundJobService | None,
) -> BackgroundJobService:
    if service is None:
        raise RpcError(-32012, "Background job service is not available")
    return service


def _require_source_import_service(
    service: SourceImportService | None,
) -> SourceImportService:
    if service is None:
        raise RpcError(-32013, "Source import service is not available")
    return service


def _require_source_organization_service(
    service: SourceOrganizationService | None,
) -> SourceOrganizationService:
    if service is None:
        raise RpcError(-32018, "Source organization service is not available")
    return service


def _require_indexing_service(service: IndexingService | None) -> IndexingService:
    if service is None:
        raise RpcError(-32014, "Indexing service is not available")
    return service


def _require_retrieval_service(
    service: HybridRetrievalService | None,
) -> HybridRetrievalService:
    if service is None:
        raise RpcError(-32015, "Retrieval service is not available")
    return service


def _require_conversation_service(
    service: ConversationService | None,
) -> ConversationService:
    if service is None:
        raise RpcError(-32016, "Conversation service is not available")
    return service


def _require_maintenance_service(
    service: MaintenanceService | None,
) -> MaintenanceService:
    if service is None:
        raise RpcError(-32017, "Maintenance service is not available")
    return service


def _require_writing_workflow_service(
    service: WritingWorkflowService | None,
) -> WritingWorkflowService:
    if service is None:
        raise RpcError(-32019, "Writing workflow service is not available")
    return service


def _required_str(values: dict[str, JsonValue], key: str) -> str:
    value = values.get(key)
    if not isinstance(value, str) or not value:
        raise RpcError(-32602, f"{key} must be a non-empty string")
    return value


def _optional_nullable_str(values: dict[str, JsonValue], key: str) -> str | None:
    value = values.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise RpcError(-32602, f"{key} must be a string")
    return value


def _optional_str(values: dict[str, JsonValue], key: str, fallback: str) -> str:
    value = values.get(key)
    if value is None:
        return fallback
    if not isinstance(value, str) or not value:
        raise RpcError(-32602, f"{key} must be a non-empty string")
    return value


def _optional_bool(values: dict[str, JsonValue], key: str, fallback: bool) -> bool:
    value = values.get(key)
    if value is None:
        return fallback
    if not isinstance(value, bool):
        raise RpcError(-32602, f"{key} must be a boolean")
    return value


def _optional_int(values: dict[str, JsonValue], key: str, fallback: int) -> int:
    value = values.get(key)
    if value is None:
        return fallback
    if not isinstance(value, int):
        raise RpcError(-32602, f"{key} must be an integer")
    return value


def _optional_float(values: dict[str, JsonValue], key: str) -> float | None:
    value = values.get(key)
    if value is None:
        return None
    if not isinstance(value, int | float):
        raise RpcError(-32602, f"{key} must be a number")
    return float(value)


def _optional_dict(values: dict[str, JsonValue], key: str) -> dict[str, object] | None:
    value = values.get(key)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise RpcError(-32602, f"{key} must be an object")
    return value  # type: ignore[return-value]
