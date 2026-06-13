import { dialog, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import {
  type BackgroundJobListResponse,
  type BackgroundJobRecord,
  type BackgroundJobStatus,
  type BuildIndexResponse,
  type ConversationAnswerRequest,
  type ConversationAnswerResponse,
  type ConversationExportResult,
  type ConversationListResponse,
  type ConversationMessagesResponse,
  type CreateBackgroundJobRequest,
  type DeleteSourceResponse,
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
  type SaveSeedCredentialRequest,
  type SaveKnowledgeBaseRequest,
  SEED_DEFAULTS,
  type SeedCredentialStatus,
  type SeedModelDescriptor,
  type UsageSummary,
  type UpdateSeedDefaultsRequest,
  type UpdateBackgroundJobRequest,
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

export function registerIpcHandlers(workerManager: PythonWorkerManager): void {
  const seedStore = new SeedCredentialStore();

  for (const channel of Object.values(IPC_CHANNELS)) {
    ipcMain.removeHandler(channel);
  }

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

function normalizeJobId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("任务 ID 无效");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
