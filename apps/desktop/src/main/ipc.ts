import { ipcMain } from "electron";
import {
  IPC_CHANNELS,
  type ModelCapabilityStatus,
  type SaveSeedCredentialRequest,
  SEED_DEFAULTS,
  type SeedCredentialStatus,
  type SeedModelDescriptor,
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

export function registerIpcHandlers(workerManager: PythonWorkerManager): void {
  const seedStore = new SeedCredentialStore();

  for (const channel of Object.values(IPC_CHANNELS)) {
    ipcMain.removeHandler(channel);
  }

  ipcMain.handle(IPC_CHANNELS.checkWorkerHealth, () => workerManager.health());
  ipcMain.handle(IPC_CHANNELS.restartWorker, () => workerManager.restart());
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
