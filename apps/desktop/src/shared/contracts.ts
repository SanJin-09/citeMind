export interface WorkerHealth {
  status: "ok";
  service: "citemind-worker";
  protocolVersion: "2.0";
  pid: number;
  storage?: {
    ready: boolean;
    schemaVersion: number;
    fts5Enabled: boolean;
    vectorDimension: number;
  };
}

export type SeedModelRole = "default_chat" | "quality_chat" | "embedding";

export type ModelValidationStatus =
  | "unknown"
  | "callable"
  | "not_enabled"
  | "unauthorized"
  | "rate_limited"
  | "failed";

export interface SeedModelDescriptor {
  id: string;
  label: string;
  role: SeedModelRole;
  api: string;
  contextWindow: number | null;
  vectorDimension: number | null;
  capabilities: string[];
}

export interface ModelCapabilityStatus {
  modelId: string;
  role: SeedModelRole;
  status: ModelValidationStatus;
  checkedAt?: string;
  message?: string;
  capability: Record<string, unknown>;
}

export interface SeedCredentialStatus {
  configured: boolean;
  safeStorageAvailable: boolean;
  baseUrl: string;
  name?: string;
  maskedKey?: string;
  updatedAt?: string;
  defaultChatModel: string;
  defaultEmbeddingModel: string;
  models: SeedModelDescriptor[];
  capabilities: ModelCapabilityStatus[];
}

export interface SaveSeedCredentialRequest {
  name: string;
  apiKey: string;
  defaultChatModel?: string;
  defaultEmbeddingModel?: string;
}

export interface DesktopApi {
  system: {
    checkWorkerHealth: () => Promise<WorkerHealth>;
    restartWorker: () => Promise<WorkerHealth>;
  };
  seed: {
    getStatus: () => Promise<SeedCredentialStatus>;
    saveCredential: (
      request: SaveSeedCredentialRequest,
    ) => Promise<SeedCredentialStatus>;
    validateCredential: () => Promise<SeedCredentialStatus>;
    deleteCredential: () => Promise<SeedCredentialStatus>;
  };
}

export const IPC_CHANNELS = {
  checkWorkerHealth: "citemind:system:check-worker-health",
  restartWorker: "citemind:system:restart-worker",
  getSeedStatus: "citemind:seed:get-status",
  saveSeedCredential: "citemind:seed:save-credential",
  validateSeedCredential: "citemind:seed:validate-credential",
  deleteSeedCredential: "citemind:seed:delete-credential",
} as const;

export const SEED_DEFAULTS = {
  credentialId: "default",
  encryptedKeyRef: "safeStorage:seed-api/default",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  defaultChatModel: "doubao-seed-2-0-lite-260428",
  qualityChatModel: "doubao-seed-2-0-pro-260215",
  defaultEmbeddingModel: "doubao-embedding-vision-251215",
} as const;
