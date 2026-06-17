import { BrowserWindow, dialog, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import {
  type AgentRunConfirmationRequest,
  type AgentRunConfirmationResolution,
  type AgentRunDelegationRequest,
  type AgentRunListResponse,
  type AgentRunOutputRequest,
  type AgentRunRecoveryResponse,
  type AgentRunResponse,
  type AgentRunSkillLoadedRequest,
  type AgentRunStageRequest,
  type AgentRunToolOutputRequest,
  type AgentRunToolCallFinishRequest,
  type AgentRunToolCallStartRequest,
  type AgentRunTransitionRequest,
  type AgentSkillDescriptor,
  type AgentSkillListResponse,
  type AgentToolInvocationRequest,
  type AgentToolInvocationResponse,
  type BackgroundJobListResponse,
  type BackgroundJobRecord,
  type BackgroundJobStatus,
  type BuildIndexResponse,
  type ConversationAnswerRequest,
  type ConversationAnswerResponse,
  type ConversationExportResult,
  type ConversationListResponse,
  type ConversationMessagesResponse,
  type CreateAgentRunRequest,
  type CreateBackgroundJobRequest,
  type DeleteSourceResponse,
  type DecideSourceRelationRequest,
  type DecideSourceTagRequest,
  type DecideSourceVersionRequest,
  type HybridSearchRequest,
  type HybridSearchResponse,
  type IndexBuildEstimate,
  type IndexVersionListResponse,
  type ImportFilesResponse,
  type ImportSourceResult,
  type ImportWebRequest,
  IPC_CHANNELS,
  type KnowledgeBaseListResponse,
  type KnowledgeBaseRecord,
  type KnowledgeBaseSourcesResponse,
  type MaintenanceStatus,
  type ModelCapabilityStatus,
  type ParseChecksResponse,
  type RenameKnowledgeBaseRequest,
  type ResolveDuplicateRequest,
  type RunAgentSkillRequest,
  type SaveSeedCredentialRequest,
  type SaveKnowledgeBaseRequest,
  SEED_DEFAULTS,
  type SeedCredentialStatus,
  type SeedModelDescriptor,
  type SourceVersionDiffResponse,
  type SourceVersionsResponse,
  type SourceOrganizationResponse,
  type UpdateSourceMaintenanceRequest,
  type UsageSummary,
  type UpdateSeedDefaultsRequest,
  type UpdateBackgroundJobRequest,
  type WebUpdateCheckItem,
  type WebUpdateCheckResponse,
  type WritingExportResult,
  type WritingProjectListResponse,
  type WritingProjectResponse,
} from "../shared/contracts";
import type { PythonWorkerManager } from "./python-worker-manager";
import {
  SeedCredentialStore,
  type SeedCredentialSummary,
} from "./seed-credential-store";

interface WorkerSeedStatus {
  models: SeedModelDescriptor[];
  capabilities: ModelCapabilityStatus[];
}

interface WorkerMarkdownExport {
  conversationId: string;
  messageId: string | null;
  fileName: string;
  markdown: string;
}

interface WorkerWordExport {
  projectId: string;
  fileName: string;
  base64: string;
}

export function registerIpcHandlers(workerManager: PythonWorkerManager): void {
  const seedStore = new SeedCredentialStore();

  for (const channel of Object.values(IPC_CHANNELS)) {
    ipcMain.removeHandler(channel);
  }

  workerManager.onNotification("agent_runs.trace_event", (params) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.agentRunTraceEvent, params);
    }
  });

  ipcMain.handle(IPC_CHANNELS.checkWorkerHealth, () => workerManager.health());
  ipcMain.handle(IPC_CHANNELS.restartWorker, () => workerManager.restart());
  ipcMain.handle(IPC_CHANNELS.maintenanceStatus, () =>
    workerManager.call<MaintenanceStatus>(
      "system.maintenance_status",
      {},
      30_000,
    ),
  );
  ipcMain.handle(IPC_CHANNELS.cleanupStorage, () =>
    workerManager.call<MaintenanceStatus>(
      "system.cleanup_storage",
      {},
      120_000,
    ),
  );
  ipcMain.handle(IPC_CHANNELS.getSeedStatus, async () => {
    const summary = await seedStore.summary();
    const workerStatus = await getWorkerSeedStatus(workerManager);
    return buildSeedStatus(summary, workerStatus);
  });
  ipcMain.handle(IPC_CHANNELS.saveSeedCredential, async (_event, payload) => {
    const request = normalizeSaveRequest(payload);
    const summary = await seedStore.save(request);
    const workerStatus = await validateSeedModels(
      workerManager,
      summary,
      request.apiKey,
    );
    return buildSeedStatus(await seedStore.summary(), workerStatus);
  });
  ipcMain.handle(IPC_CHANNELS.validateSeedCredential, async () => {
    const summary = await seedStore.summary();
    const apiKey = await seedStore.readApiKey();
    const workerStatus = await validateSeedModels(
      workerManager,
      summary,
      apiKey,
    );
    return buildSeedStatus(await seedStore.summary(), workerStatus);
  });
  ipcMain.handle(IPC_CHANNELS.deleteSeedCredential, async () => {
    const summary = await seedStore.delete();
    const workerStatus = await workerManager.call<WorkerSeedStatus>(
      "models.delete_credential",
      { credentialId: SEED_DEFAULTS.credentialId },
      10_000,
    );
    return buildSeedStatus(summary, workerStatus);
  });
  ipcMain.handle(IPC_CHANNELS.updateSeedDefaults, async (_event, payload) => {
    const request = normalizeUpdateSeedDefaultsRequest(payload);
    const summary = await seedStore.updateDefaults(request);
    return buildSeedStatus(summary, await getWorkerSeedStatus(workerManager));
  });
  ipcMain.handle(IPC_CHANNELS.listKnowledgeBases, () =>
    workerManager.call<KnowledgeBaseListResponse>("knowledge_bases.list"),
  );
  ipcMain.handle(IPC_CHANNELS.createKnowledgeBase, (_event, payload) => {
    const request = normalizeSaveKnowledgeBaseRequest(payload);
    return workerManager.call<KnowledgeBaseRecord>("knowledge_bases.create", {
      name: request.name,
      description: request.description,
    });
  });
  ipcMain.handle(IPC_CHANNELS.renameKnowledgeBase, (_event, payload) => {
    const request = normalizeRenameKnowledgeBaseRequest(payload);
    return workerManager.call<KnowledgeBaseRecord>("knowledge_bases.rename", {
      knowledgeBaseId: request.knowledgeBaseId,
      name: request.name,
      description: request.description,
    });
  });
  ipcMain.handle(
    IPC_CHANNELS.deleteKnowledgeBase,
    (_event, knowledgeBaseId) => {
      if (typeof knowledgeBaseId !== "string" || !knowledgeBaseId) {
        throw new Error("知识库 ID 无效");
      }
      return workerManager.call<KnowledgeBaseListResponse>(
        "knowledge_bases.delete",
        {
          knowledgeBaseId,
        },
      );
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.listKnowledgeBaseSources,
    (_event, knowledgeBaseId) => {
      if (typeof knowledgeBaseId !== "string" || !knowledgeBaseId) {
        throw new Error("知识库 ID 无效");
      }
      return workerManager.call<KnowledgeBaseSourcesResponse>(
        "knowledge_bases.sources",
        { knowledgeBaseId },
      );
    },
  );
  ipcMain.handle(IPC_CHANNELS.listJobs, (_event, payload) => {
    const options = normalizeListJobsOptions(payload);
    return workerManager.call<BackgroundJobListResponse>("jobs.list", options);
  });
  ipcMain.handle(IPC_CHANNELS.listUnfinishedJobs, () =>
    workerManager.call<BackgroundJobListResponse>("jobs.unfinished"),
  );
  ipcMain.handle(IPC_CHANNELS.createJob, (_event, payload) => {
    const request = normalizeCreateJobRequest(payload);
    return workerManager.call<BackgroundJobRecord>("jobs.create", {
      jobType: request.jobType,
      targetId: request.targetId,
      checkpoint: request.checkpoint,
    });
  });
  ipcMain.handle(IPC_CHANNELS.updateJob, (_event, payload) => {
    const request = normalizeUpdateJobRequest(payload);
    return workerManager.call<BackgroundJobRecord>("jobs.update", {
      jobId: request.jobId,
      status: request.status,
      progress: request.progress,
      checkpoint: request.checkpoint,
      errorMessage: request.errorMessage,
    });
  });
  ipcMain.handle(IPC_CHANNELS.pauseJob, (_event, jobId) =>
    workerManager.call<BackgroundJobRecord>("jobs.pause", {
      jobId: normalizeJobId(jobId),
    }),
  );
  ipcMain.handle(IPC_CHANNELS.resumeJob, (_event, jobId) =>
    workerManager.call<BackgroundJobRecord>("jobs.resume", {
      jobId: normalizeJobId(jobId),
    }),
  );
  ipcMain.handle(IPC_CHANNELS.cancelJob, (_event, jobId) =>
    workerManager.call<BackgroundJobRecord>("jobs.cancel", {
      jobId: normalizeJobId(jobId),
    }),
  );
  ipcMain.handle(IPC_CHANNELS.retryJob, (_event, jobId) =>
    workerManager.call<BackgroundJobRecord>("jobs.retry", {
      jobId: normalizeJobId(jobId),
    }),
  );
  ipcMain.handle(IPC_CHANNELS.recoverJobs, () =>
    workerManager.call<BackgroundJobListResponse>("jobs.recover"),
  );
  ipcMain.handle(IPC_CHANNELS.createAgentRun, (_event, payload) => {
    const request = normalizeCreateAgentRunRequest(payload);
    return workerManager.call<AgentRunResponse>("agent_runs.create", request);
  });
  ipcMain.handle(IPC_CHANNELS.listAgentRuns, (_event, payload) => {
    const request = normalizeListAgentRunsRequest(payload);
    return workerManager.call<AgentRunListResponse>("agent_runs.list", request);
  });
  ipcMain.handle(IPC_CHANNELS.getAgentRun, (_event, runId) =>
    workerManager.call<AgentRunResponse>("agent_runs.get", {
      runId: normalizeAgentRunId(runId),
    }),
  );
  ipcMain.handle(IPC_CHANNELS.updateAgentRunPlan, (_event, payload) => {
    const request = normalizeAgentRunPlanRequest(payload);
    return workerManager.call<AgentRunResponse>(
      "agent_runs.update_plan",
      request,
    );
  });
  ipcMain.handle(IPC_CHANNELS.recordAgentRunStage, (_event, payload) => {
    const request = normalizeAgentRunStageRequest(payload);
    return workerManager.call<AgentRunResponse>(
      "agent_runs.record_stage",
      request,
    );
  });
  ipcMain.handle(IPC_CHANNELS.recordAgentRunSkillLoaded, (_event, payload) => {
    const request = normalizeAgentRunSkillLoadedRequest(payload);
    return workerManager.call<AgentRunResponse>(
      "agent_runs.record_skill_loaded",
      request,
    );
  });
  ipcMain.handle(IPC_CHANNELS.transitionAgentRun, (_event, payload) => {
    const request = normalizeAgentRunTransitionRequest(payload);
    return workerManager.call<AgentRunResponse>(
      "agent_runs.transition",
      request,
    );
  });
  ipcMain.handle(IPC_CHANNELS.pauseAgentRun, (_event, runId) =>
    workerManager.call<AgentRunResponse>("agent_runs.pause", {
      runId: normalizeAgentRunId(runId),
    }),
  );
  ipcMain.handle(IPC_CHANNELS.resumeAgentRun, (_event, runId) =>
    workerManager.call<AgentRunResponse>("agent_runs.resume", {
      runId: normalizeAgentRunId(runId),
    }),
  );
  ipcMain.handle(IPC_CHANNELS.cancelAgentRun, (_event, payload) => {
    const request = normalizeAgentRunCancelRequest(payload);
    return workerManager.call<AgentRunResponse>("agent_runs.cancel", request);
  });
  ipcMain.handle(IPC_CHANNELS.retryAgentRun, (_event, runId) =>
    workerManager.call<AgentRunResponse>("agent_runs.retry", {
      runId: normalizeAgentRunId(runId),
    }),
  );
  ipcMain.handle(IPC_CHANNELS.recoverAgentRuns, () =>
    workerManager.call<AgentRunRecoveryResponse>("agent_runs.recover"),
  );
  ipcMain.handle(IPC_CHANNELS.listAgentSkills, () =>
    workerManager.call<AgentSkillListResponse>("agent_skills.list"),
  );
  ipcMain.handle(IPC_CHANNELS.getAgentSkill, (_event, payload) => {
    const request = normalizeAgentSkillLookupRequest(payload);
    return workerManager.call<AgentSkillDescriptor>(
      "agent_skills.get",
      request,
    );
  });
  ipcMain.handle(IPC_CHANNELS.runAgentSkill, async (_event, payload) => {
    const request = normalizeRunAgentSkillRequest(payload);
    const summary = await seedStore.summary();
    const apiKey = await seedStore.readApiKey();
    return workerManager.call<AgentRunResponse>(
      "agent_skills.run",
      {
        ...request,
        apiKey,
        baseUrl: summary.baseUrl,
        chatModel: summary.defaultChatModel,
        embeddingModel: summary.defaultEmbeddingModel,
      },
      180_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.invokeAgentTool, async (_event, payload) => {
    const request = normalizeAgentToolInvocationRequest(payload);
    const params: Record<string, unknown> = { ...(request.params ?? {}) };
    if (request.toolName === "hybrid_retrieval.search") {
      const summary = await seedStore.summary();
      params.apiKey = await seedStore.readApiKey();
      params.baseUrl = summary.baseUrl;
      params.embeddingModel = summary.defaultEmbeddingModel;
    }
    return workerManager.call<AgentToolInvocationResponse>(
      "agent_tools.invoke",
      {
        ...request,
        params,
      },
      180_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.startAgentRunToolCall, (_event, payload) => {
    const request = normalizeAgentRunToolCallStartRequest(payload);
    return workerManager.call<AgentRunResponse>(
      "agent_runs.start_tool_call",
      request,
    );
  });
  ipcMain.handle(IPC_CHANNELS.recordAgentRunToolOutput, (_event, payload) => {
    const request = normalizeAgentRunToolOutputRequest(payload);
    return workerManager.call<AgentRunResponse>(
      "agent_runs.record_tool_output",
      request,
    );
  });
  ipcMain.handle(IPC_CHANNELS.finishAgentRunToolCall, (_event, payload) => {
    const request = normalizeAgentRunToolCallFinishRequest(payload);
    return workerManager.call<AgentRunResponse>(
      "agent_runs.finish_tool_call",
      request,
    );
  });
  ipcMain.handle(
    IPC_CHANNELS.requestAgentRunConfirmation,
    (_event, payload) => {
      const request = normalizeAgentRunConfirmationRequest(payload);
      return workerManager.call<AgentRunResponse>(
        "agent_runs.request_confirmation",
        request,
      );
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.resolveAgentRunConfirmation,
    (_event, payload) => {
      const request = normalizeAgentRunConfirmationResolution(payload);
      return workerManager.call<AgentRunResponse>(
        "agent_runs.resolve_confirmation",
        request,
      );
    },
  );
  ipcMain.handle(IPC_CHANNELS.recordAgentRunDelegation, (_event, payload) => {
    const request = normalizeAgentRunDelegationRequest(payload);
    return workerManager.call<AgentRunResponse>(
      "agent_runs.record_delegation",
      request,
    );
  });
  ipcMain.handle(IPC_CHANNELS.saveAgentRunOutput, (_event, payload) => {
    const request = normalizeAgentRunOutputRequest(payload);
    return workerManager.call<AgentRunResponse>(
      "agent_runs.save_output",
      request,
    );
  });
  ipcMain.handle(
    IPC_CHANNELS.importSourceFiles,
    async (_event, knowledgeBaseId) => {
      const targetKnowledgeBaseId = normalizeKnowledgeBaseId(knowledgeBaseId);
      const selection = await dialog.showOpenDialog({
        title: "添加来源",
        properties: ["openFile", "multiSelections"],
        filters: [
          {
            name: "支持的来源",
            extensions: [
              "pdf",
              "docx",
              "png",
              "jpg",
              "jpeg",
              "webp",
              "bmp",
              "tif",
              "tiff",
            ],
          },
        ],
      });
      if (selection.canceled || selection.filePaths.length === 0) {
        return { cancelled: true, imported: [] } satisfies ImportFilesResponse;
      }
      const imported: ImportSourceResult[] = [];
      for (const filePath of selection.filePaths) {
        imported.push(
          await workerManager.call<ImportSourceResult>(
            "sources.import_file",
            { knowledgeBaseId: targetKnowledgeBaseId, filePath },
            180_000,
          ),
        );
      }
      return { cancelled: false, imported } satisfies ImportFilesResponse;
    },
  );
  ipcMain.handle(IPC_CHANNELS.importWebSource, (_event, payload) => {
    const request = normalizeImportWebRequest(payload);
    return workerManager.call<ImportSourceResult>(
      "sources.import_web",
      {
        knowledgeBaseId: request.knowledgeBaseId,
        url: request.url,
        displayName: request.displayName,
      },
      180_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.listParseChecks, (_event, knowledgeBaseId) =>
    workerManager.call<ParseChecksResponse>(
      "sources.parse_checks",
      { knowledgeBaseId: normalizeKnowledgeBaseId(knowledgeBaseId) },
      30_000,
    ),
  );
  ipcMain.handle(IPC_CHANNELS.deleteSource, (_event, sourceId) =>
    workerManager.call<DeleteSourceResponse>(
      "sources.delete",
      { sourceId: normalizeNonEmptyString(sourceId, "来源 ID") },
      60_000,
    ),
  );
  ipcMain.handle(IPC_CHANNELS.resolveDuplicate, (_event, payload) => {
    const request = normalizeResolveDuplicateRequest(payload);
    return workerManager.call<ImportSourceResult>(
      "sources.resolve_duplicate",
      { sourceId: request.sourceId, action: request.action },
      60_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.checkAllWebSources, (_event, payload) => {
    if (!isRecord(payload)) {
      throw new Error("网页更新检查参数无效");
    }
    return workerManager.call<WebUpdateCheckResponse>(
      "sources.check_web_all",
      {
        knowledgeBaseId: normalizeKnowledgeBaseId(payload.knowledgeBaseId),
        dueOnly: payload.dueOnly === true,
      },
      180_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.checkWebSource, (_event, sourceId) =>
    workerManager.call<WebUpdateCheckItem>(
      "sources.check_web",
      { sourceId: normalizeNonEmptyString(sourceId, "来源 ID") },
      180_000,
    ),
  );
  ipcMain.handle(IPC_CHANNELS.listSourceVersions, (_event, sourceId) =>
    workerManager.call<SourceVersionsResponse>(
      "sources.versions",
      { sourceId: normalizeNonEmptyString(sourceId, "来源 ID") },
      30_000,
    ),
  );
  ipcMain.handle(IPC_CHANNELS.getSourceVersionDiff, (_event, payload) => {
    const request = normalizeSourceVersionRequest(payload);
    return workerManager.call<SourceVersionDiffResponse>(
      "sources.version_diff",
      request,
      30_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.decideSourceVersion, (_event, payload) => {
    const request = normalizeDecideSourceVersionRequest(payload);
    return workerManager.call<SourceVersionsResponse>(
      "sources.decide_version",
      { ...request },
      30_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.updateSourceMaintenance, (_event, payload) => {
    const request = normalizeUpdateSourceMaintenanceRequest(payload);
    return workerManager.call<SourceVersionsResponse>(
      "sources.update_maintenance",
      { ...request },
      30_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.decideSourceSuggestion, (_event, payload) => {
    if (!isRecord(payload)) {
      throw new Error("来源建议处理参数无效");
    }
    const decision = payload.decision;
    if (decision !== "accept" && decision !== "dismiss") {
      throw new Error("来源建议处理方式无效");
    }
    return workerManager.call<SourceVersionsResponse>(
      "sources.decide_suggestion",
      {
        sourceId: normalizeNonEmptyString(payload.sourceId, "来源 ID"),
        decision,
      },
      30_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.getSourceOrganization, (_event, sourceId) =>
    workerManager.call<SourceOrganizationResponse>(
      "sources.organization",
      { sourceId: normalizeNonEmptyString(sourceId, "来源 ID") },
      60_000,
    ),
  );
  ipcMain.handle(IPC_CHANNELS.classifySource, (_event, sourceId) =>
    workerManager.call<SourceOrganizationResponse>(
      "sources.classify",
      { sourceId: normalizeNonEmptyString(sourceId, "来源 ID") },
      60_000,
    ),
  );
  ipcMain.handle(IPC_CHANNELS.suggestSourceTags, async (_event, sourceId) => {
    const summary = await seedStore.summary();
    const apiKey = await seedStore.readApiKey();
    if (!apiKey) {
      throw new Error("请先配置并验证 Seed API");
    }
    return workerManager.call<SourceOrganizationResponse>(
      "sources.suggest_tags",
      {
        sourceId: normalizeNonEmptyString(sourceId, "来源 ID"),
        apiKey,
        baseUrl: summary.baseUrl,
        chatModel: summary.defaultChatModel,
      },
      120_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.decideSourceTag, (_event, payload) => {
    const request = normalizeDecideSourceTagRequest(payload);
    return workerManager.call<SourceOrganizationResponse>(
      "sources.decide_tag",
      { ...request },
      30_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.decideSourceRelation, (_event, payload) => {
    const request = normalizeDecideSourceRelationRequest(payload);
    return workerManager.call<SourceOrganizationResponse>(
      "sources.decide_relation",
      { ...request },
      30_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.buildIndex, async (_event, knowledgeBaseId) => {
    const summary = await seedStore.summary();
    const apiKey = await seedStore.readApiKey();
    return workerManager.call<BuildIndexResponse>(
      "indexes.build",
      {
        knowledgeBaseId: normalizeKnowledgeBaseId(knowledgeBaseId),
        apiKey,
        baseUrl: summary.baseUrl,
        embeddingModel: summary.defaultEmbeddingModel,
        background: true,
      },
      300_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.deleteIndex, (_event, knowledgeBaseId) =>
    workerManager.call<BuildIndexResponse>(
      "indexes.delete",
      { knowledgeBaseId: normalizeKnowledgeBaseId(knowledgeBaseId) },
      120_000,
    ),
  );
  ipcMain.handle(IPC_CHANNELS.rebuildIndex, async (_event, knowledgeBaseId) => {
    const summary = await seedStore.summary();
    const apiKey = await seedStore.readApiKey();
    return workerManager.call<BuildIndexResponse>(
      "indexes.rebuild",
      {
        knowledgeBaseId: normalizeKnowledgeBaseId(knowledgeBaseId),
        apiKey,
        baseUrl: summary.baseUrl,
        embeddingModel: summary.defaultEmbeddingModel,
        background: true,
      },
      300_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.getIndexStatus, (_event, knowledgeBaseId) =>
    workerManager.call<BuildIndexResponse>(
      "indexes.status",
      { knowledgeBaseId: normalizeKnowledgeBaseId(knowledgeBaseId) },
      30_000,
    ),
  );
  ipcMain.handle(IPC_CHANNELS.listIndexVersions, (_event, knowledgeBaseId) =>
    workerManager.call<IndexVersionListResponse>(
      "indexes.list",
      { knowledgeBaseId: normalizeKnowledgeBaseId(knowledgeBaseId) },
      30_000,
    ),
  );
  ipcMain.handle(
    IPC_CHANNELS.estimateIndex,
    async (_event, knowledgeBaseId) => {
      const summary = await seedStore.summary();
      return workerManager.call<IndexBuildEstimate>(
        "indexes.estimate",
        {
          knowledgeBaseId: normalizeKnowledgeBaseId(knowledgeBaseId),
          embeddingModel: summary.defaultEmbeddingModel,
        },
        30_000,
      );
    },
  );
  ipcMain.handle(IPC_CHANNELS.rollbackIndex, (_event, payload) => {
    const request = normalizeIndexVersionRequest(payload);
    return workerManager.call<BuildIndexResponse>(
      "indexes.rollback",
      request,
      60_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.retryIndex, async (_event, payload) => {
    const request = normalizeIndexVersionRequest(payload);
    const summary = await seedStore.summary();
    const apiKey = await seedStore.readApiKey();
    return workerManager.call<BuildIndexResponse>(
      "indexes.retry",
      { ...request, apiKey, baseUrl: summary.baseUrl, background: true },
      300_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.hybridSearch, async (_event, payload) => {
    const request = normalizeHybridSearchRequest(payload);
    const summary = await seedStore.summary();
    const apiKey = await seedStore.readApiKey();
    return workerManager.call<HybridSearchResponse>(
      "retrieval.hybrid_search",
      {
        knowledgeBaseId: request.knowledgeBaseId,
        query: request.query,
        limit: request.limit,
        candidateLimit: request.candidateLimit,
        rerankModelVersion: request.rerankModelVersion,
        apiKey,
        baseUrl: summary.baseUrl,
        embeddingModel: summary.defaultEmbeddingModel,
      },
      120_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.listConversations, (_event, knowledgeBaseId) =>
    workerManager.call<ConversationListResponse>(
      "conversations.list",
      { knowledgeBaseId: normalizeKnowledgeBaseId(knowledgeBaseId) },
      30_000,
    ),
  );
  ipcMain.handle(IPC_CHANNELS.conversationMessages, (_event, conversationId) =>
    workerManager.call<ConversationMessagesResponse>(
      "conversations.messages",
      { conversationId: normalizeNonEmptyString(conversationId, "对话 ID") },
      30_000,
    ),
  );
  ipcMain.handle(IPC_CHANNELS.deleteConversation, (_event, conversationId) =>
    workerManager.call<ConversationListResponse>(
      "conversations.delete",
      { conversationId: normalizeNonEmptyString(conversationId, "对话 ID") },
      30_000,
    ),
  );
  ipcMain.handle(IPC_CHANNELS.setConversationModel, (_event, payload) => {
    const request = normalizeConversationModelRequest(payload);
    return workerManager.call<ConversationAnswerResponse["conversation"]>(
      "conversations.set_model",
      request,
      30_000,
    );
  });
  ipcMain.handle(
    IPC_CHANNELS.exportConversationMarkdown,
    async (_event, payload) => {
      const request = normalizeConversationExportRequest(payload);
      const exported = await workerManager.call<WorkerMarkdownExport>(
        "conversations.export_markdown",
        request,
        30_000,
      );
      const selection = await dialog.showSaveDialog({
        title: request.messageId ? "导出回答" : "导出对话",
        defaultPath: exported.fileName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (selection.canceled || !selection.filePath) {
        return { cancelled: true } satisfies ConversationExportResult;
      }
      await writeFile(selection.filePath, exported.markdown, "utf8");
      return {
        cancelled: false,
        filePath: selection.filePath,
      } satisfies ConversationExportResult;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.conversationUsageSummary,
    (_event, knowledgeBaseId) =>
      workerManager.call<UsageSummary>(
        "conversations.usage_summary",
        { knowledgeBaseId: normalizeKnowledgeBaseId(knowledgeBaseId) },
        30_000,
      ),
  );
  ipcMain.handle(IPC_CHANNELS.answerConversation, async (_event, payload) => {
    const request = normalizeConversationAnswerRequest(payload);
    const summary = await seedStore.summary();
    const apiKey = await seedStore.readApiKey();
    return workerManager.call<ConversationAnswerResponse>(
      "conversations.answer",
      {
        knowledgeBaseId: request.knowledgeBaseId,
        query: request.query,
        conversationId: request.conversationId,
        chatModel: request.chatModel ?? summary.defaultChatModel,
        limit: request.limit,
        candidateLimit: request.candidateLimit,
        maxOutputTokens: request.maxOutputTokens,
        apiKey,
        baseUrl: summary.baseUrl,
        embeddingModel: summary.defaultEmbeddingModel,
      },
      180_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.listWritingProjects, (_event, knowledgeBaseId) =>
    workerManager.call<WritingProjectListResponse>(
      "writing.list",
      { knowledgeBaseId: normalizeKnowledgeBaseId(knowledgeBaseId) },
      30_000,
    ),
  );
  ipcMain.handle(IPC_CHANNELS.getWritingProject, (_event, projectId) =>
    workerManager.call<WritingProjectResponse>(
      "writing.project",
      { projectId: normalizeNonEmptyString(projectId, "写作项目 ID") },
      30_000,
    ),
  );
  ipcMain.handle(IPC_CHANNELS.createWritingProject, async (_event, payload) => {
    if (!isRecord(payload)) {
      throw new Error("写作项目参数无效");
    }
    const workflowType = payload.workflowType;
    if (workflowType !== "review" && workflowType !== "article") {
      throw new Error("写作工作流类型无效");
    }
    const summary = await seedStore.summary();
    const apiKey = await seedStore.readApiKey();
    return workerManager.call<WritingProjectResponse>(
      "writing.create",
      {
        knowledgeBaseId: normalizeKnowledgeBaseId(payload.knowledgeBaseId),
        goal: normalizeNonEmptyString(payload.goal, "写作目标"),
        workflowType,
        apiKey,
        baseUrl: summary.baseUrl,
        chatModel: summary.defaultChatModel,
        embeddingModel: summary.defaultEmbeddingModel,
      },
      300_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.runWritingSection, async (_event, payload) => {
    if (!isRecord(payload)) {
      throw new Error("写作分节参数无效");
    }
    const sectionId =
      payload.sectionId === undefined || payload.sectionId === null
        ? null
        : normalizeNonEmptyString(payload.sectionId, "写作分节 ID");
    const summary = await seedStore.summary();
    const apiKey = await seedStore.readApiKey();
    return workerManager.call<WritingProjectResponse>(
      "writing.run_section",
      {
        projectId: normalizeNonEmptyString(payload.projectId, "写作项目 ID"),
        sectionId,
        revise: payload.revise === true,
        apiKey,
        baseUrl: summary.baseUrl,
        chatModel: summary.defaultChatModel,
        embeddingModel: summary.defaultEmbeddingModel,
      },
      300_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.updateWritingSection, (_event, payload) => {
    if (!isRecord(payload)) {
      throw new Error("写作分节参数无效");
    }
    return workerManager.call<WritingProjectResponse>(
      "writing.update_section",
      {
        sectionId: normalizeNonEmptyString(payload.sectionId, "写作分节 ID"),
        content: normalizeNonEmptyString(payload.content, "写作内容"),
      },
      30_000,
    );
  });
  ipcMain.handle(IPC_CHANNELS.auditWritingSection, (_event, sectionId) =>
    workerManager.call<WritingProjectResponse>(
      "writing.audit_section",
      { sectionId: normalizeNonEmptyString(sectionId, "写作分节 ID") },
      30_000,
    ),
  );
  ipcMain.handle(IPC_CHANNELS.exportWritingWord, async (_event, projectId) => {
    const exported = await workerManager.call<WorkerWordExport>(
      "writing.export_word",
      { projectId: normalizeNonEmptyString(projectId, "写作项目 ID") },
      30_000,
    );
    const selection = await dialog.showSaveDialog({
      title: "导出写作项目",
      defaultPath: exported.fileName,
      filters: [{ name: "Word 文档", extensions: ["docx"] }],
    });
    if (selection.canceled || !selection.filePath) {
      return { cancelled: true } satisfies WritingExportResult;
    }
    await writeFile(selection.filePath, Buffer.from(exported.base64, "base64"));
    return {
      cancelled: false,
      filePath: selection.filePath,
    } satisfies WritingExportResult;
  });
}

async function getWorkerSeedStatus(
  workerManager: PythonWorkerManager,
): Promise<WorkerSeedStatus> {
  return workerManager.call<WorkerSeedStatus>(
    "models.status",
    { credentialId: SEED_DEFAULTS.credentialId },
    10_000,
  );
}

async function validateSeedModels(
  workerManager: PythonWorkerManager,
  summary: SeedCredentialSummary,
  apiKey: string,
): Promise<WorkerSeedStatus> {
  return workerManager.call<WorkerSeedStatus>(
    "models.validate_defaults",
    {
      apiKey,
      credentialId: summary.id,
      name: summary.name ?? "我的 Seed API",
      encryptedKeyRef: summary.encryptedKeyRef,
      baseUrl: summary.baseUrl,
      defaultChatModel: summary.defaultChatModel,
      defaultEmbeddingModel: summary.defaultEmbeddingModel,
    },
    120_000,
  );
}

function buildSeedStatus(
  summary: SeedCredentialSummary,
  workerStatus: WorkerSeedStatus,
): SeedCredentialStatus {
  return {
    configured: summary.configured,
    safeStorageAvailable: summary.safeStorageAvailable,
    baseUrl: summary.baseUrl,
    name: summary.name,
    maskedKey: summary.maskedKey,
    updatedAt: summary.updatedAt,
    defaultChatModel: summary.defaultChatModel,
    defaultEmbeddingModel: summary.defaultEmbeddingModel,
    models: workerStatus.models,
    capabilities: workerStatus.capabilities,
  };
}

function normalizeSaveRequest(payload: unknown): SaveSeedCredentialRequest {
  if (!isRecord(payload)) {
    throw new Error("Seed API 配置参数无效");
  }
  const name = payload.name;
  const apiKey = payload.apiKey;
  const defaultChatModel = payload.defaultChatModel;
  const defaultEmbeddingModel = payload.defaultEmbeddingModel;
  if (typeof name !== "string") {
    throw new Error("配置名称必须是字符串");
  }
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("Ark API Key 不能为空");
  }
  return {
    name,
    apiKey,
    defaultChatModel:
      typeof defaultChatModel === "string" ? defaultChatModel : undefined,
    defaultEmbeddingModel:
      typeof defaultEmbeddingModel === "string"
        ? defaultEmbeddingModel
        : undefined,
  };
}

function normalizeUpdateSeedDefaultsRequest(
  payload: unknown,
): UpdateSeedDefaultsRequest {
  if (!isRecord(payload)) {
    throw new Error("默认模型参数无效");
  }
  return {
    defaultChatModel: normalizeNonEmptyString(
      payload.defaultChatModel,
      "默认对话模型",
    ),
    defaultEmbeddingModel: normalizeNonEmptyString(
      payload.defaultEmbeddingModel,
      "默认 Embedding 模型",
    ),
  };
}

function normalizeSaveKnowledgeBaseRequest(
  payload: unknown,
): SaveKnowledgeBaseRequest {
  if (!isRecord(payload)) {
    throw new Error("知识库参数无效");
  }
  const name = payload.name;
  const description = payload.description;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("知识库名称不能为空");
  }
  if (
    description !== undefined &&
    description !== null &&
    typeof description !== "string"
  ) {
    throw new Error("知识库描述必须是字符串");
  }
  return { name, description };
}

function normalizeRenameKnowledgeBaseRequest(
  payload: unknown,
): RenameKnowledgeBaseRequest {
  const request = normalizeSaveKnowledgeBaseRequest(payload);
  if (!isRecord(payload)) {
    throw new Error("知识库参数无效");
  }
  const knowledgeBaseId = payload.knowledgeBaseId;
  if (typeof knowledgeBaseId !== "string" || !knowledgeBaseId) {
    throw new Error("知识库 ID 无效");
  }
  return { ...request, knowledgeBaseId };
}

function normalizeKnowledgeBaseId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("知识库 ID 无效");
  }
  return value;
}

function normalizeImportWebRequest(payload: unknown): ImportWebRequest {
  if (!isRecord(payload)) {
    throw new Error("网页导入参数无效");
  }
  const knowledgeBaseId = normalizeKnowledgeBaseId(payload.knowledgeBaseId);
  const url = payload.url;
  const displayName = payload.displayName;
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("网页链接不能为空");
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("网页链接必须以 http:// 或 https:// 开头");
  }
  if (
    displayName !== undefined &&
    displayName !== null &&
    typeof displayName !== "string"
  ) {
    throw new Error("网页名称必须是字符串");
  }
  return { knowledgeBaseId, url, displayName };
}

function normalizeResolveDuplicateRequest(
  payload: unknown,
): ResolveDuplicateRequest {
  if (!isRecord(payload)) {
    throw new Error("重复来源处理参数无效");
  }
  const sourceId = normalizeNonEmptyString(payload.sourceId, "来源 ID");
  const action = payload.action;
  if (action !== "skip" && action !== "keep" && action !== "link") {
    throw new Error("重复来源处理方式无效");
  }
  return { sourceId, action };
}

function normalizeSourceVersionRequest(payload: unknown): {
  sourceId: string;
  versionId: string;
} {
  if (!isRecord(payload)) {
    throw new Error("来源版本参数无效");
  }
  return {
    sourceId: normalizeNonEmptyString(payload.sourceId, "来源 ID"),
    versionId: normalizeNonEmptyString(payload.versionId, "来源版本 ID"),
  };
}

function normalizeDecideSourceVersionRequest(
  payload: unknown,
): DecideSourceVersionRequest {
  const request = normalizeSourceVersionRequest(payload);
  if (!isRecord(payload)) {
    throw new Error("来源版本参数无效");
  }
  const decision = payload.decision;
  if (decision !== "accept" && decision !== "reject") {
    throw new Error("来源版本处理方式无效");
  }
  return { ...request, decision };
}

function normalizeUpdateSourceMaintenanceRequest(
  payload: unknown,
): UpdateSourceMaintenanceRequest {
  if (!isRecord(payload)) {
    throw new Error("来源维护参数无效");
  }
  const expiryStatus = payload.expiryStatus;
  if (
    expiryStatus !== "active" &&
    expiryStatus !== "expired" &&
    expiryStatus !== "replaced"
  ) {
    throw new Error("来源时效状态无效");
  }
  const replacementSourceId = payload.replacementSourceId;
  const reviewAt = payload.reviewAt;
  if (
    replacementSourceId !== undefined &&
    replacementSourceId !== null &&
    typeof replacementSourceId !== "string"
  ) {
    throw new Error("替代文档 ID 无效");
  }
  if (
    reviewAt !== undefined &&
    reviewAt !== null &&
    typeof reviewAt !== "string"
  ) {
    throw new Error("复查时间无效");
  }
  return {
    sourceId: normalizeNonEmptyString(payload.sourceId, "来源 ID"),
    replacementSourceId,
    reviewAt,
    expiryStatus,
  };
}

function normalizeDecideSourceTagRequest(
  payload: unknown,
): DecideSourceTagRequest {
  if (!isRecord(payload)) {
    throw new Error("标签处理参数无效");
  }
  const decision = payload.decision;
  if (decision !== "confirm" && decision !== "dismiss") {
    throw new Error("标签处理方式无效");
  }
  const correctedTag = payload.correctedTag;
  if (
    correctedTag !== undefined &&
    correctedTag !== null &&
    typeof correctedTag !== "string"
  ) {
    throw new Error("修正标签无效");
  }
  return {
    sourceId: normalizeNonEmptyString(payload.sourceId, "来源 ID"),
    tagId: normalizeNonEmptyString(payload.tagId, "标签 ID"),
    decision,
    correctedTag,
  };
}

function normalizeDecideSourceRelationRequest(
  payload: unknown,
): DecideSourceRelationRequest {
  if (!isRecord(payload)) {
    throw new Error("来源关联处理参数无效");
  }
  const decision = payload.decision;
  if (decision !== "confirm" && decision !== "dismiss") {
    throw new Error("来源关联处理方式无效");
  }
  return {
    sourceId: normalizeNonEmptyString(payload.sourceId, "来源 ID"),
    relationId: normalizeNonEmptyString(payload.relationId, "关联 ID"),
    decision,
  };
}

function normalizeHybridSearchRequest(payload: unknown): HybridSearchRequest {
  if (!isRecord(payload)) {
    throw new Error("检索参数无效");
  }
  const knowledgeBaseId = normalizeKnowledgeBaseId(payload.knowledgeBaseId);
  const query = payload.query;
  const rerankModelVersion = payload.rerankModelVersion;
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("检索查询不能为空");
  }
  if (
    rerankModelVersion !== undefined &&
    rerankModelVersion !== null &&
    typeof rerankModelVersion !== "string"
  ) {
    throw new Error("重排序模型版本必须是字符串");
  }
  return {
    knowledgeBaseId,
    query,
    limit: normalizeOptionalInteger(payload.limit, "检索结果数量限制"),
    candidateLimit: normalizeOptionalInteger(
      payload.candidateLimit,
      "检索候选数量限制",
    ),
    rerankModelVersion,
  };
}

function normalizeIndexVersionRequest(payload: unknown): {
  knowledgeBaseId: string;
  indexVersionId: string;
} {
  if (!isRecord(payload)) {
    throw new Error("索引版本参数无效");
  }
  return {
    knowledgeBaseId: normalizeKnowledgeBaseId(payload.knowledgeBaseId),
    indexVersionId: normalizeNonEmptyString(
      payload.indexVersionId,
      "索引版本 ID",
    ),
  };
}

function normalizeConversationModelRequest(payload: unknown): {
  conversationId: string;
  modelId: string;
} {
  if (!isRecord(payload)) {
    throw new Error("对话模型参数无效");
  }
  return {
    conversationId: normalizeNonEmptyString(payload.conversationId, "对话 ID"),
    modelId: normalizeNonEmptyString(payload.modelId, "对话模型"),
  };
}

function normalizeConversationExportRequest(payload: unknown): {
  conversationId: string;
  messageId?: string;
} {
  if (!isRecord(payload)) {
    throw new Error("对话导出参数无效");
  }
  const messageId = payload.messageId;
  if (
    messageId !== undefined &&
    messageId !== null &&
    typeof messageId !== "string"
  ) {
    throw new Error("回答消息 ID 必须是字符串");
  }
  return {
    conversationId: normalizeNonEmptyString(payload.conversationId, "对话 ID"),
    messageId: messageId
      ? normalizeNonEmptyString(messageId, "回答消息 ID")
      : undefined,
  };
}

function normalizeConversationAnswerRequest(
  payload: unknown,
): ConversationAnswerRequest {
  if (!isRecord(payload)) {
    throw new Error("对话请求参数无效");
  }
  const knowledgeBaseId = normalizeKnowledgeBaseId(payload.knowledgeBaseId);
  const query = normalizeNonEmptyString(payload.query, "问题");
  const conversationId = payload.conversationId;
  const chatModel = payload.chatModel;
  if (
    conversationId !== undefined &&
    conversationId !== null &&
    typeof conversationId !== "string"
  ) {
    throw new Error("对话 ID 必须是字符串");
  }
  if (
    chatModel !== undefined &&
    chatModel !== null &&
    typeof chatModel !== "string"
  ) {
    throw new Error("对话模型必须是字符串");
  }
  return {
    knowledgeBaseId,
    query,
    conversationId,
    chatModel: chatModel ?? undefined,
    limit: normalizeOptionalInteger(payload.limit, "检索结果数量限制"),
    candidateLimit: normalizeOptionalInteger(
      payload.candidateLimit,
      "检索候选数量限制",
    ),
    maxOutputTokens: normalizeOptionalInteger(
      payload.maxOutputTokens,
      "最大输出 Token 数",
    ),
  };
}

const JOB_STATUSES = new Set<BackgroundJobStatus>([
  "pending",
  "running",
  "completed",
  "paused",
  "cancelled",
  "failed",
  "retrying",
]);

const AGENT_RUN_STATUSES = new Set<AgentRunTransitionRequest["status"]>([
  "planning",
  "waiting_confirmation",
  "executing",
  "paused",
  "completed",
  "cancelled",
  "failed",
]);

const AGENT_TOOL_CALL_FINAL_STATUSES = new Set<
  AgentRunToolCallFinishRequest["status"]
>(["completed", "failed", "cancelled"]);

const AGENT_CONFIRMATION_FINAL_STATUSES = new Set<
  AgentRunConfirmationResolution["status"]
>(["confirmed", "rejected", "cancelled"]);

function normalizeListJobsOptions(payload: unknown): Record<string, unknown> {
  if (payload === undefined || payload === null) {
    return {};
  }
  if (!isRecord(payload)) {
    throw new Error("任务查询参数无效");
  }
  const result: Record<string, unknown> = {};
  if (payload.status !== undefined) {
    if (!isJobStatus(payload.status)) {
      throw new Error("任务状态无效");
    }
    result.status = payload.status;
  }
  if (payload.targetId !== undefined) {
    if (typeof payload.targetId !== "string" || !payload.targetId) {
      throw new Error("任务目标 ID 无效");
    }
    result.targetId = payload.targetId;
  }
  if (payload.includeTerminal !== undefined) {
    if (typeof payload.includeTerminal !== "boolean") {
      throw new Error("任务完成状态筛选参数无效");
    }
    result.includeTerminal = payload.includeTerminal;
  }
  if (payload.limit !== undefined) {
    if (typeof payload.limit !== "number" || !Number.isInteger(payload.limit)) {
      throw new Error("任务数量限制无效");
    }
    result.limit = payload.limit;
  }
  return result;
}

function normalizeOptionalInteger(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label}必须是整数`);
  }
  return value;
}

function normalizeNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}不能为空`);
  }
  return value;
}

function normalizeCreateJobRequest(
  payload: unknown,
): CreateBackgroundJobRequest {
  if (!isRecord(payload)) {
    throw new Error("任务创建参数无效");
  }
  const jobType = payload.jobType;
  const targetId = payload.targetId;
  if (typeof jobType !== "string" || !jobType.trim()) {
    throw new Error("任务类型不能为空");
  }
  if (typeof targetId !== "string" || !targetId.trim()) {
    throw new Error("任务目标不能为空");
  }
  return {
    jobType,
    targetId,
    checkpoint: normalizeCheckpoint(payload.checkpoint),
  };
}

function normalizeUpdateJobRequest(
  payload: unknown,
): UpdateBackgroundJobRequest {
  if (!isRecord(payload)) {
    throw new Error("任务更新参数无效");
  }
  const jobId = normalizeJobId(payload.jobId);
  const request: UpdateBackgroundJobRequest = { jobId };
  if (payload.status !== undefined) {
    if (!isJobStatus(payload.status)) {
      throw new Error("任务状态无效");
    }
    request.status = payload.status;
  }
  if (payload.progress !== undefined) {
    if (
      typeof payload.progress !== "number" ||
      payload.progress < 0 ||
      payload.progress > 1
    ) {
      throw new Error("任务进度必须在 0 到 1 之间");
    }
    request.progress = payload.progress;
  }
  if (payload.checkpoint !== undefined) {
    request.checkpoint = normalizeCheckpoint(payload.checkpoint);
  }
  if (payload.errorMessage !== undefined) {
    if (
      payload.errorMessage !== null &&
      typeof payload.errorMessage !== "string"
    ) {
      throw new Error("任务错误信息必须是字符串");
    }
    request.errorMessage = payload.errorMessage;
  }
  return request;
}

function normalizeCreateAgentRunRequest(
  payload: unknown,
): CreateAgentRunRequest {
  if (!isRecord(payload)) {
    throw new Error("AgentRun 创建参数无效");
  }
  return {
    knowledgeBaseId: normalizeKnowledgeBaseId(payload.knowledgeBaseId),
    goal: normalizeNonEmptyString(payload.goal, "AgentRun 目标"),
    skillId: normalizeNonEmptyString(payload.skillId, "Skill ID"),
    skillVersion: normalizeNonEmptyString(payload.skillVersion, "Skill 版本"),
    title: normalizeOptionalNullableString(payload.title, "AgentRun 标题"),
    sourceIds: normalizeOptionalStringArray(payload.sourceIds, "来源范围"),
    indexVersionId: normalizeOptionalNullableString(
      payload.indexVersionId,
      "索引版本 ID",
    ),
    models: normalizeOptionalRecord(payload.models, "模型配置"),
    budgets: normalizeOptionalRecord(payload.budgets, "预算配置"),
  };
}

function normalizeListAgentRunsRequest(
  payload: unknown,
): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new Error("AgentRun 列表参数无效");
  }
  const request: Record<string, unknown> = {
    knowledgeBaseId: normalizeKnowledgeBaseId(payload.knowledgeBaseId),
  };
  if (payload.includeTerminal !== undefined) {
    if (typeof payload.includeTerminal !== "boolean") {
      throw new Error("AgentRun 完成状态筛选参数无效");
    }
    request.includeTerminal = payload.includeTerminal;
  }
  if (payload.limit !== undefined) {
    if (typeof payload.limit !== "number" || !Number.isInteger(payload.limit)) {
      throw new Error("AgentRun 数量限制无效");
    }
    request.limit = payload.limit;
  }
  return request;
}

function normalizeAgentSkillLookupRequest(payload: unknown): {
  skillId: string;
  version?: string | null;
} {
  if (!isRecord(payload)) {
    throw new Error("Agent Skill 查询参数无效");
  }
  return {
    skillId: normalizeNonEmptyString(payload.skillId, "Skill ID"),
    version: normalizeOptionalNullableString(payload.version, "Skill 版本"),
  };
}

function normalizeRunAgentSkillRequest(payload: unknown): RunAgentSkillRequest {
  if (!isRecord(payload)) {
    throw new Error("Agent Skill 运行参数无效");
  }
  const request: RunAgentSkillRequest = {
    knowledgeBaseId: normalizeKnowledgeBaseId(payload.knowledgeBaseId),
    skillId: normalizeNonEmptyString(payload.skillId, "Skill ID"),
    goal: normalizeNonEmptyString(payload.goal, "Skill 目标"),
    sourceIds: normalizeOptionalStringArray(payload.sourceIds, "来源范围"),
    inputs: normalizeOptionalRecord(payload.inputs, "Skill 输入"),
  };
  if (payload.limit !== undefined) {
    request.limit = normalizePositiveInteger(payload.limit, "检索结果数");
  }
  if (payload.candidateLimit !== undefined) {
    request.candidateLimit = normalizePositiveInteger(
      payload.candidateLimit,
      "检索候选数",
    );
  }
  return request;
}

function normalizeAgentToolInvocationRequest(
  payload: unknown,
): AgentToolInvocationRequest {
  if (!isRecord(payload)) {
    throw new Error("Agent Tool 调用参数无效");
  }
  return {
    runId: normalizeAgentRunId(payload.runId),
    toolName: normalizeNonEmptyString(payload.toolName, "Tool 名称"),
    params: normalizeOptionalRecord(payload.params, "Tool 参数"),
  };
}

function normalizeAgentRunPlanRequest(payload: unknown): {
  runId: string;
  plan: Record<string, unknown>;
  summary?: string | null;
} {
  if (!isRecord(payload)) {
    throw new Error("AgentRun 计划参数无效");
  }
  const plan = normalizeOptionalRecord(payload.plan, "AgentRun 计划");
  if (!plan) {
    throw new Error("AgentRun 计划不能为空");
  }
  return {
    runId: normalizeAgentRunId(payload.runId),
    plan,
    summary: normalizeOptionalNullableString(payload.summary, "计划摘要"),
  };
}

function normalizeAgentRunStageRequest(payload: unknown): AgentRunStageRequest {
  if (!isRecord(payload)) {
    throw new Error("AgentRun 阶段 Trace 参数无效");
  }
  const status = payload.status;
  if (status !== undefined && status !== "started" && status !== "completed") {
    throw new Error("AgentRun 阶段状态无效");
  }
  return {
    runId: normalizeAgentRunId(payload.runId),
    stage: normalizeNonEmptyString(payload.stage, "阶段"),
    status,
    title: normalizeOptionalNullableString(payload.title, "阶段标题"),
    summary: normalizeOptionalNullableString(payload.summary, "阶段摘要"),
    stepId: normalizeOptionalNullableString(payload.stepId, "步骤 ID"),
    durationMs: normalizeOptionalNullableInteger(
      payload.durationMs,
      "阶段耗时",
    ),
  };
}

function normalizeAgentRunSkillLoadedRequest(
  payload: unknown,
): AgentRunSkillLoadedRequest {
  if (!isRecord(payload)) {
    throw new Error("AgentRun Skill Trace 参数无效");
  }
  return {
    runId: normalizeAgentRunId(payload.runId),
    skillId: normalizeNonEmptyString(payload.skillId, "Skill ID"),
    skillVersion: normalizeNonEmptyString(payload.skillVersion, "Skill 版本"),
    summary: normalizeOptionalNullableString(payload.summary, "Skill 摘要"),
  };
}

function normalizeAgentRunTransitionRequest(
  payload: unknown,
): AgentRunTransitionRequest {
  if (!isRecord(payload)) {
    throw new Error("AgentRun 状态迁移参数无效");
  }
  const status = payload.status;
  if (!isAgentRunStatus(status)) {
    throw new Error("AgentRun 状态无效");
  }
  return {
    runId: normalizeAgentRunId(payload.runId),
    status,
    stage: normalizeOptionalNullableString(payload.stage, "阶段"),
    summary: normalizeOptionalNullableString(payload.summary, "摘要"),
    errorMessage: normalizeOptionalNullableString(
      payload.errorMessage,
      "错误信息",
    ),
    stopReason: normalizeOptionalNullableString(payload.stopReason, "停止原因"),
  };
}

function normalizeAgentRunCancelRequest(payload: unknown): {
  runId: string;
  reason?: string | null;
} {
  if (!isRecord(payload)) {
    throw new Error("AgentRun 取消参数无效");
  }
  return {
    runId: normalizeAgentRunId(payload.runId),
    reason: normalizeOptionalNullableString(payload.reason, "取消原因"),
  };
}

function normalizeAgentRunToolCallStartRequest(
  payload: unknown,
): AgentRunToolCallStartRequest {
  if (!isRecord(payload)) {
    throw new Error("AgentRun Tool 调用参数无效");
  }
  return {
    runId: normalizeAgentRunId(payload.runId),
    toolName: normalizeNonEmptyString(payload.toolName, "Tool 名称"),
    actionSummary: normalizeNonEmptyString(payload.actionSummary, "动作摘要"),
    stepId: normalizeOptionalNullableString(payload.stepId, "步骤 ID"),
    skillId: normalizeOptionalNullableString(payload.skillId, "Skill ID"),
    skillVersion: normalizeOptionalNullableString(
      payload.skillVersion,
      "Skill 版本",
    ),
    workingDirectory: normalizeOptionalNullableString(
      payload.workingDirectory,
      "工作目录",
    ),
    sanitizedParams: normalizeOptionalRecord(
      payload.sanitizedParams,
      "脱敏参数",
    ),
  };
}

function normalizeAgentRunToolOutputRequest(
  payload: unknown,
): AgentRunToolOutputRequest {
  if (!isRecord(payload)) {
    throw new Error("AgentRun Tool 输出参数无效");
  }
  return {
    toolCallId: normalizeNonEmptyString(payload.toolCallId, "Tool 调用 ID"),
    stdoutSummary: normalizeOptionalNullableString(
      payload.stdoutSummary,
      "标准输出摘要",
    ),
    stderrSummary: normalizeOptionalNullableString(
      payload.stderrSummary,
      "错误输出摘要",
    ),
    payload: normalizeOptionalRecord(payload.payload, "Tool 输出元数据"),
  };
}

function normalizeAgentRunToolCallFinishRequest(
  payload: unknown,
): AgentRunToolCallFinishRequest {
  if (!isRecord(payload)) {
    throw new Error("AgentRun Tool 完成参数无效");
  }
  const status = payload.status;
  if (!isAgentToolCallFinalStatus(status)) {
    throw new Error("AgentRun Tool 状态无效");
  }
  return {
    toolCallId: normalizeNonEmptyString(payload.toolCallId, "Tool 调用 ID"),
    status,
    exitCode: normalizeOptionalNullableInteger(payload.exitCode, "退出码"),
    stdoutSummary: normalizeOptionalNullableString(
      payload.stdoutSummary,
      "标准输出摘要",
    ),
    stderrSummary: normalizeOptionalNullableString(
      payload.stderrSummary,
      "错误输出摘要",
    ),
    errorMessage: normalizeOptionalNullableString(
      payload.errorMessage,
      "错误信息",
    ),
  };
}

function normalizeAgentRunConfirmationRequest(
  payload: unknown,
): AgentRunConfirmationRequest {
  if (!isRecord(payload)) {
    throw new Error("AgentRun 确认请求参数无效");
  }
  return {
    runId: normalizeAgentRunId(payload.runId),
    prompt: normalizeNonEmptyString(payload.prompt, "确认提示"),
    options: normalizeOptionalObjectArray(payload.options, "确认选项"),
  };
}

function normalizeAgentRunConfirmationResolution(
  payload: unknown,
): AgentRunConfirmationResolution {
  if (!isRecord(payload)) {
    throw new Error("AgentRun 确认处理参数无效");
  }
  const status = payload.status;
  if (!isAgentConfirmationFinalStatus(status)) {
    throw new Error("AgentRun 确认状态无效");
  }
  return {
    confirmationId: normalizeNonEmptyString(
      payload.confirmationId,
      "确认请求 ID",
    ),
    status,
    decision: normalizeOptionalRecord(payload.decision, "确认决策"),
  };
}

function normalizeAgentRunDelegationRequest(
  payload: unknown,
): AgentRunDelegationRequest {
  if (!isRecord(payload)) {
    throw new Error("AgentRun 委派参数无效");
  }
  return {
    runId: normalizeAgentRunId(payload.runId),
    delegateeRole: normalizeNonEmptyString(
      payload.delegateeRole,
      "子 Agent 角色",
    ),
    task: normalizeNonEmptyString(payload.task, "委派任务"),
    inputScope: normalizeOptionalRecord(payload.inputScope, "输入范围"),
    childRunId: normalizeOptionalNullableString(
      payload.childRunId,
      "子 AgentRun ID",
    ),
  };
}

function normalizeAgentRunOutputRequest(
  payload: unknown,
): AgentRunOutputRequest {
  if (!isRecord(payload)) {
    throw new Error("AgentRun 输出参数无效");
  }
  const outputType = payload.outputType;
  if (
    outputType !== "draft" &&
    outputType !== "final" &&
    outputType !== "intermediate"
  ) {
    throw new Error("AgentRun 输出类型无效");
  }
  const content = payload.content;
  if (typeof content !== "string") {
    throw new Error("AgentRun 输出内容必须是字符串");
  }
  return {
    runId: normalizeAgentRunId(payload.runId),
    outputType,
    title: normalizeNonEmptyString(payload.title, "输出标题"),
    content,
    payload: normalizeOptionalRecord(payload.payload, "输出元数据"),
    citations: normalizeOptionalCitationArray(payload.citations),
  };
}

function normalizeJobId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("任务 ID 无效");
  }
  return value;
}

function normalizeAgentRunId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("AgentRun ID 无效");
  }
  return value;
}

function normalizeCheckpoint(
  value: unknown,
): CreateBackgroundJobRequest["checkpoint"] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("任务检查点必须是对象");
  }
  return value as CreateBackgroundJobRequest["checkpoint"];
}

function isJobStatus(value: unknown): value is BackgroundJobStatus {
  return (
    typeof value === "string" && JOB_STATUSES.has(value as BackgroundJobStatus)
  );
}

function isAgentRunStatus(
  value: unknown,
): value is AgentRunTransitionRequest["status"] {
  return (
    typeof value === "string" &&
    AGENT_RUN_STATUSES.has(value as AgentRunTransitionRequest["status"])
  );
}

function isAgentToolCallFinalStatus(
  value: unknown,
): value is AgentRunToolCallFinishRequest["status"] {
  return (
    typeof value === "string" &&
    AGENT_TOOL_CALL_FINAL_STATUSES.has(
      value as AgentRunToolCallFinishRequest["status"],
    )
  );
}

function isAgentConfirmationFinalStatus(
  value: unknown,
): value is AgentRunConfirmationResolution["status"] {
  return (
    typeof value === "string" &&
    AGENT_CONFIRMATION_FINAL_STATUSES.has(
      value as AgentRunConfirmationResolution["status"],
    )
  );
}

function normalizeOptionalNullableString(
  value: unknown,
  label: string,
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label}必须是字符串`);
  }
  return value;
}

function normalizeOptionalNullableInteger(
  value: unknown,
  label: string,
): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label}必须是整数`);
  }
  return value;
}

function normalizePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label}必须是正整数`);
  }
  return value;
}

function normalizeOptionalRecord(
  value: unknown,
  label: string,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label}必须是对象`);
  }
  return value;
}

function normalizeOptionalStringArray(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label}必须是字符串数组`);
  }
  return value;
}

function normalizeOptionalObjectArray(
  value: unknown,
  label: string,
): Array<Record<string, unknown>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new Error(`${label}必须是对象数组`);
  }
  return value;
}

function normalizeOptionalCitationArray(
  value: unknown,
): AgentRunOutputRequest["citations"] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("引用必须是数组");
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error("引用项必须是对象");
    }
    const paragraphIndex = item.paragraphIndex;
    if (
      typeof paragraphIndex !== "number" ||
      !Number.isInteger(paragraphIndex)
    ) {
      throw new Error("引用段落序号必须是整数");
    }
    return {
      paragraphIndex,
      chunkId: normalizeNonEmptyString(item.chunkId, "引用片段 ID"),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
