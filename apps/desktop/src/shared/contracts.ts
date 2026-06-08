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

export interface KnowledgeBaseSummary {
  sourceCount: number;
  sourcesByStatus: Record<string, number>;
  readyIndexCount: number;
  conversationCount: number;
  chunkCount: number;
}

export interface KnowledgeBaseRecord {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  summary: KnowledgeBaseSummary;
}

export interface KnowledgeBaseListResponse {
  knowledgeBases: KnowledgeBaseRecord[];
}

export interface KnowledgeBaseSource {
  id: string;
  sourceType: "pdf" | "docx" | "image" | "web";
  displayName: string;
  uri: string | null;
  status: string;
  latestVersionStatus: string | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseSourcesResponse {
  knowledgeBaseId: string;
  sources: KnowledgeBaseSource[];
  summary: KnowledgeBaseSummary;
}

export interface SaveKnowledgeBaseRequest {
  name: string;
  description?: string | null;
}

export interface RenameKnowledgeBaseRequest extends SaveKnowledgeBaseRequest {
  knowledgeBaseId: string;
}

export type BackgroundJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "paused"
  | "cancelled"
  | "failed"
  | "retrying";

export interface BackgroundJobStage {
  id: "parse" | "ocr" | "embedding" | "index";
  label: string;
  status: BackgroundJobStatus;
  progress: number;
}

export interface BackgroundJobCheckpoint {
  stages: BackgroundJobStage[];
  [key: string]: unknown;
}

export interface BackgroundJobRecord {
  id: string;
  jobType: string;
  targetId: string;
  status: BackgroundJobStatus;
  progress: number;
  checkpoint: BackgroundJobCheckpoint;
  retryCount: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackgroundJobListResponse {
  jobs: BackgroundJobRecord[];
}

export interface CreateBackgroundJobRequest {
  jobType: string;
  targetId: string;
  checkpoint?: BackgroundJobCheckpoint;
}

export interface UpdateBackgroundJobRequest {
  jobId: string;
  status?: BackgroundJobStatus;
  progress?: number;
  checkpoint?: BackgroundJobCheckpoint;
  errorMessage?: string | null;
}

export type ParseCheckStatus =
  | "success"
  | "needs_ocr"
  | "failed"
  | "duplicate"
  | "processing";

export interface ParseCheckSummary {
  total: number;
  success: number;
  needsOcr: number;
  failed: number;
  duplicate: number;
  processing: number;
}

export interface ParseCheckItem {
  sourceId: string;
  sourceVersionId: string | null;
  sourceType: KnowledgeBaseSource["sourceType"];
  displayName: string;
  uri: string | null;
  status: ParseCheckStatus;
  sourceStatus: string;
  versionStatus: string | null;
  jobStatus: BackgroundJobStatus | null;
  errorMessage: string | null;
  duplicateOfSourceId: string | null;
  originalHash: string | null;
  contentHash: string | null;
  originalPath: string | null;
  snapshotPath: string | null;
  parseArtifactPath: string | null;
  preview: string;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ParseChecksResponse {
  knowledgeBaseId: string;
  summary: ParseCheckSummary;
  items: ParseCheckItem[];
}

export interface ImportSourceResult {
  source: ParseCheckItem;
  parseCheck: ParseCheckItem;
}

export interface ImportFilesResponse {
  cancelled: boolean;
  imported: ImportSourceResult[];
}

export interface ImportWebRequest {
  knowledgeBaseId: string;
  url: string;
  displayName?: string | null;
}

export interface IndexVersionRecord {
  id: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimension: number;
  chunkingVersion: string;
  parserVersion: string;
  status: "building" | "ready" | "failed" | "retired";
  isCurrent: boolean;
  createdAt: string;
  chunkCount: number;
}

export interface BuildIndexResponse {
  knowledgeBaseId: string;
  ready: boolean;
  indexVersion?: IndexVersionRecord;
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
  knowledgeBases: {
    list: () => Promise<KnowledgeBaseListResponse>;
    create: (request: SaveKnowledgeBaseRequest) => Promise<KnowledgeBaseRecord>;
    rename: (
      request: RenameKnowledgeBaseRequest,
    ) => Promise<KnowledgeBaseRecord>;
    delete: (knowledgeBaseId: string) => Promise<KnowledgeBaseListResponse>;
    listSources: (
      knowledgeBaseId: string,
    ) => Promise<KnowledgeBaseSourcesResponse>;
  };
  jobs: {
    list: (options?: {
      status?: BackgroundJobStatus;
      targetId?: string;
      includeTerminal?: boolean;
      limit?: number;
    }) => Promise<BackgroundJobListResponse>;
    listUnfinished: () => Promise<BackgroundJobListResponse>;
    create: (
      request: CreateBackgroundJobRequest,
    ) => Promise<BackgroundJobRecord>;
    update: (
      request: UpdateBackgroundJobRequest,
    ) => Promise<BackgroundJobRecord>;
    pause: (jobId: string) => Promise<BackgroundJobRecord>;
    resume: (jobId: string) => Promise<BackgroundJobRecord>;
    cancel: (jobId: string) => Promise<BackgroundJobRecord>;
    retry: (jobId: string) => Promise<BackgroundJobRecord>;
    recover: () => Promise<BackgroundJobListResponse>;
  };
  sources: {
    importFiles: (knowledgeBaseId: string) => Promise<ImportFilesResponse>;
    importWeb: (request: ImportWebRequest) => Promise<ImportSourceResult>;
    parseChecks: (knowledgeBaseId: string) => Promise<ParseChecksResponse>;
  };
  indexes: {
    build: (knowledgeBaseId: string) => Promise<BuildIndexResponse>;
    status: (knowledgeBaseId: string) => Promise<BuildIndexResponse>;
  };
}

export const IPC_CHANNELS = {
  checkWorkerHealth: "citemind:system:check-worker-health",
  restartWorker: "citemind:system:restart-worker",
  getSeedStatus: "citemind:seed:get-status",
  saveSeedCredential: "citemind:seed:save-credential",
  validateSeedCredential: "citemind:seed:validate-credential",
  deleteSeedCredential: "citemind:seed:delete-credential",
  listKnowledgeBases: "citemind:knowledge-bases:list",
  createKnowledgeBase: "citemind:knowledge-bases:create",
  renameKnowledgeBase: "citemind:knowledge-bases:rename",
  deleteKnowledgeBase: "citemind:knowledge-bases:delete",
  listKnowledgeBaseSources: "citemind:knowledge-bases:list-sources",
  listJobs: "citemind:jobs:list",
  listUnfinishedJobs: "citemind:jobs:list-unfinished",
  createJob: "citemind:jobs:create",
  updateJob: "citemind:jobs:update",
  pauseJob: "citemind:jobs:pause",
  resumeJob: "citemind:jobs:resume",
  cancelJob: "citemind:jobs:cancel",
  retryJob: "citemind:jobs:retry",
  recoverJobs: "citemind:jobs:recover",
  importSourceFiles: "citemind:sources:import-files",
  importWebSource: "citemind:sources:import-web",
  listParseChecks: "citemind:sources:parse-checks",
  buildIndex: "citemind:indexes:build",
  getIndexStatus: "citemind:indexes:status",
} as const;

export const SEED_DEFAULTS = {
  credentialId: "default",
  encryptedKeyRef: "safeStorage:seed-api/default",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  defaultChatModel: "doubao-seed-2-0-lite-260428",
  qualityChatModel: "doubao-seed-2-0-pro-260215",
  defaultEmbeddingModel: "doubao-embedding-vision-251215",
} as const;
