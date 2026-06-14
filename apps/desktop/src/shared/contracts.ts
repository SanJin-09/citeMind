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

export interface UpdateSeedDefaultsRequest {
  defaultChatModel: string;
  defaultEmbeddingModel: string;
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
  currentVersionId: string | null;
  currentVersionNumber: number;
  pendingVersionCount: number;
  replacementSourceId: string | null;
  reviewAt: string | null;
  expiryStatus: "active" | "expired" | "replaced";
  modelSuggestion: SourceStatusSuggestion | null;
  lastCheckedAt: string | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SourceStatusSuggestion {
  status: "pending_confirmation" | "accepted" | "dismissed";
  suggestion: "expired" | "conflict";
  reason: string;
  confidence: number;
  createdAt: string;
  decidedAt?: string;
}

export interface SourceMaintenanceRecord {
  id: string;
  knowledgeBaseId: string;
  sourceType: KnowledgeBaseSource["sourceType"];
  displayName: string;
  uri: string | null;
  status: string;
  currentVersionId: string | null;
  currentVersionNumber: number;
  replacementSourceId: string | null;
  reviewAt: string | null;
  expiryStatus: KnowledgeBaseSource["expiryStatus"];
  modelSuggestion: SourceStatusSuggestion | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceVersionChangeSummary {
  addedBlocks?: number;
  removedBlocks?: number;
  changedBlocks?: number;
  unchangedBlocks?: number;
  beforeBlockCount?: number;
  afterBlockCount?: number;
}

export interface SourceVersionRecord {
  id: string;
  versionNumber: number;
  contentHash: string | null;
  originalPath: string | null;
  snapshotPath: string | null;
  parseArtifactPath: string | null;
  status: string;
  etag: string | null;
  lastModified: string | null;
  checkedAt: string | null;
  previousVersionId: string | null;
  reviewStatus: "current" | "pending_review" | "superseded" | "rejected";
  changeSummary: SourceVersionChangeSummary;
  createdAt: string;
}

export interface SourceVersionsResponse {
  source: SourceMaintenanceRecord;
  versions: SourceVersionRecord[];
}

export interface SourceVersionDiffResponse {
  sourceId: string;
  versionId: string;
  summary: SourceVersionChangeSummary;
  diff: string;
  truncated: boolean;
}

export interface WebUpdateCheckItem {
  sourceId: string;
  status: "unchanged" | "changed";
  checkedAt: string;
  pendingVersionId?: string;
  changeSummary?: SourceVersionChangeSummary;
}

export interface WebUpdateCheckResponse {
  knowledgeBaseId: string;
  checked: number;
  changed: number;
  items: WebUpdateCheckItem[];
}

export interface DecideSourceVersionRequest {
  sourceId: string;
  versionId: string;
  decision: "accept" | "reject";
}

export interface UpdateSourceMaintenanceRequest {
  sourceId: string;
  replacementSourceId?: string | null;
  reviewAt?: string | null;
  expiryStatus: KnowledgeBaseSource["expiryStatus"];
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
  | "skipped"
  | "linked"
  | "processing";

export type DuplicateAction = "skip" | "keep" | "link";

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
  duplicateKind: "original" | "content" | null;
  duplicateResolution: DuplicateAction | null;
  duplicateActions: DuplicateAction[];
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

export interface ResolveDuplicateRequest {
  sourceId: string;
  action: DuplicateAction;
}

export interface DeleteSourceResponse {
  knowledgeBaseId: string;
  sourceId: string;
  displayName: string;
  deleted: boolean;
  deletedChunkCount: number;
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
  activatedAt: string | null;
  retainedUntil: string | null;
  failureReason: string | null;
  reusedChunkCount: number;
  embeddedChunkCount: number;
  chunkCount: number;
}

export interface BuildIndexResponse {
  knowledgeBaseId: string;
  ready: boolean;
  indexVersion?: IndexVersionRecord;
  deletedIndexCount?: number;
  deletedChunkCount?: number;
  jobId?: string;
}

export interface IndexVersionListResponse {
  knowledgeBaseId: string;
  versions: IndexVersionRecord[];
}

export interface IndexBuildEstimate {
  knowledgeBaseId: string;
  embeddingModel: string;
  documentCount: number;
  chunkCount: number;
  estimatedEmbeddingCalls: number;
  estimatedInputCharacters: number;
  estimatedCost: number | null;
  pricingNotice: string;
}

export interface HybridSearchRequest {
  knowledgeBaseId: string;
  query: string;
  limit?: number;
  candidateLimit?: number;
  rerankModelVersion?: string | null;
}

export interface HybridSearchResult {
  chunkId: string;
  source: {
    id: string;
    versionId: string;
    type: KnowledgeBaseSource["sourceType"];
    displayName: string;
    uri: string | null;
  };
  location: {
    pageNumber: number | null;
    boundingBox: Record<string, unknown> | null;
    headingPath: string[];
    anchor: string | null;
  };
  text: {
    original: string;
    normalized: string;
    preview: string;
    contentHash: string;
  };
  match: {
    matchedBy: Array<"keyword" | "semantic">;
    keywordHits: string[];
    hasKeywordHit: boolean;
    hasSemanticMatch: boolean;
  };
  scores: {
    keywordBm25: number | null;
    keywordScore: number | null;
    semanticDistance: number | null;
    semanticScore: number | null;
    fusedScore: number;
  };
  ranks: {
    keyword: number | null;
    semantic: number | null;
    fused: number;
  };
  explanation: {
    summary: string;
    fusion: string;
    keyword: Record<string, unknown>;
    semantic: Record<string, unknown>;
  };
}

export interface HybridSearchResponse {
  knowledgeBaseId: string;
  query: string;
  indexVersion: IndexVersionRecord;
  limits: {
    resultLimit: number;
    candidateLimit: number;
  };
  retrieval: {
    keywordCandidateCount: number;
    semanticCandidateCount: number;
    mergedCandidateCount: number;
    fusion: "reciprocal_rank_fusion";
    rrfK: number;
  };
  rerank: {
    available: boolean;
    applied: boolean;
    modelVersion: string | null;
  };
  results: HybridSearchResult[];
  context: {
    chunkCount: number;
    chunks: Array<{
      chunkId: string;
      label: string;
      text: string;
      source: HybridSearchResult["source"];
      location: HybridSearchResult["location"];
    }>;
    text: string;
  };
}

export interface ConversationRecord {
  id: string;
  knowledgeBaseId: string;
  title: string;
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnswerCitation {
  paragraphIndex: number;
  chunkId: string;
  source: HybridSearchResult["source"];
  location: HybridSearchResult["location"];
  text: {
    preview: string;
    normalized?: string;
    original?: string;
  };
}

export interface ConversationMessageRecord {
  id: string;
  conversationId: string;
  role: "system" | "user" | "assistant";
  content: string;
  modelId: string | null;
  modelParams: Record<string, unknown>;
  indexVersionId: string | null;
  createdAt: string;
  citations: AnswerCitation[];
}

export interface ConversationListResponse {
  knowledgeBaseId: string;
  conversations: ConversationRecord[];
}

export interface ConversationMessagesResponse {
  conversation: ConversationRecord;
  messages: ConversationMessageRecord[];
}

export interface ConversationAnswerRequest {
  knowledgeBaseId: string;
  query: string;
  conversationId?: string | null;
  chatModel?: string;
  limit?: number;
  candidateLimit?: number;
  maxOutputTokens?: number;
}

export interface ConversationAnswerResponse {
  conversation: ConversationRecord;
  userMessage: ConversationMessageRecord;
  assistantMessage: ConversationMessageRecord;
  content: string;
  answer: {
    paragraphs: Array<{
      index: number;
      text: string;
      evidenceChunkIds: string[];
    }>;
    evidenceSufficient: boolean;
    refusalReason: string | null;
  };
  citations: AnswerCitation[];
  citationValidation: {
    valid: boolean;
    paragraphs: Array<Record<string, unknown>>;
    validCitations: AnswerCitation[];
    invalidCitations: Array<Record<string, unknown>>;
    candidateChunkIds: string[];
  };
  retrieval: HybridSearchResponse;
  model: {
    id: string;
    maxOutputTokens?: number;
    generationTimeMs: number;
    retryCount: number;
  };
  events: Array<Record<string, unknown>>;
}

export interface ConversationExportResult {
  cancelled: boolean;
  filePath?: string;
}

export interface UsageSummary {
  knowledgeBaseId: string;
  calls: {
    chat: number;
    queryEmbedding: number;
    indexEmbedding: number;
    total: number;
  };
  estimatedTokens: {
    input: number;
    output: number;
    total: number;
  };
  byModel: Record<string, number>;
  estimatedCostCny: number | null;
  pricingNotice: string;
}

export interface MaintenanceStatus {
  rootPath: string;
  totalBytes: number;
  sourceCount: number;
  chunkCount: number;
  recyclableIndexCount: number;
  recycledIndexCount?: number;
  removedFileCount?: number;
  removedVectorCount?: number;
  reclaimedBytes?: number;
}

export interface DesktopApi {
  system: {
    checkWorkerHealth: () => Promise<WorkerHealth>;
    restartWorker: () => Promise<WorkerHealth>;
    maintenanceStatus: () => Promise<MaintenanceStatus>;
    cleanupStorage: () => Promise<MaintenanceStatus>;
  };
  seed: {
    getStatus: () => Promise<SeedCredentialStatus>;
    saveCredential: (
      request: SaveSeedCredentialRequest,
    ) => Promise<SeedCredentialStatus>;
    validateCredential: () => Promise<SeedCredentialStatus>;
    deleteCredential: () => Promise<SeedCredentialStatus>;
    updateDefaults: (
      request: UpdateSeedDefaultsRequest,
    ) => Promise<SeedCredentialStatus>;
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
    delete: (sourceId: string) => Promise<DeleteSourceResponse>;
    resolveDuplicate: (
      request: ResolveDuplicateRequest,
    ) => Promise<ImportSourceResult>;
    checkWebAll: (
      knowledgeBaseId: string,
      dueOnly?: boolean,
    ) => Promise<WebUpdateCheckResponse>;
    checkWeb: (sourceId: string) => Promise<WebUpdateCheckItem>;
    versions: (sourceId: string) => Promise<SourceVersionsResponse>;
    versionDiff: (
      sourceId: string,
      versionId: string,
    ) => Promise<SourceVersionDiffResponse>;
    decideVersion: (
      request: DecideSourceVersionRequest,
    ) => Promise<SourceVersionsResponse>;
    updateMaintenance: (
      request: UpdateSourceMaintenanceRequest,
    ) => Promise<SourceVersionsResponse>;
    decideSuggestion: (
      sourceId: string,
      decision: "accept" | "dismiss",
    ) => Promise<SourceVersionsResponse>;
  };
  indexes: {
    build: (knowledgeBaseId: string) => Promise<BuildIndexResponse>;
    delete: (knowledgeBaseId: string) => Promise<BuildIndexResponse>;
    rebuild: (knowledgeBaseId: string) => Promise<BuildIndexResponse>;
    status: (knowledgeBaseId: string) => Promise<BuildIndexResponse>;
    list: (knowledgeBaseId: string) => Promise<IndexVersionListResponse>;
    estimate: (knowledgeBaseId: string) => Promise<IndexBuildEstimate>;
    rollback: (
      knowledgeBaseId: string,
      indexVersionId: string,
    ) => Promise<BuildIndexResponse>;
    retry: (
      knowledgeBaseId: string,
      indexVersionId: string,
    ) => Promise<BuildIndexResponse>;
  };
  retrieval: {
    hybridSearch: (
      request: HybridSearchRequest,
    ) => Promise<HybridSearchResponse>;
  };
  conversations: {
    list: (knowledgeBaseId: string) => Promise<ConversationListResponse>;
    messages: (conversationId: string) => Promise<ConversationMessagesResponse>;
    delete: (conversationId: string) => Promise<ConversationListResponse>;
    setModel: (
      conversationId: string,
      modelId: string,
    ) => Promise<ConversationRecord>;
    answer: (
      request: ConversationAnswerRequest,
    ) => Promise<ConversationAnswerResponse>;
    exportMarkdown: (
      conversationId: string,
      messageId?: string,
    ) => Promise<ConversationExportResult>;
    usageSummary: (knowledgeBaseId: string) => Promise<UsageSummary>;
  };
}

export const IPC_CHANNELS = {
  checkWorkerHealth: "citemind:system:check-worker-health",
  restartWorker: "citemind:system:restart-worker",
  maintenanceStatus: "citemind:system:maintenance-status",
  cleanupStorage: "citemind:system:cleanup-storage",
  getSeedStatus: "citemind:seed:get-status",
  saveSeedCredential: "citemind:seed:save-credential",
  validateSeedCredential: "citemind:seed:validate-credential",
  deleteSeedCredential: "citemind:seed:delete-credential",
  updateSeedDefaults: "citemind:seed:update-defaults",
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
  deleteSource: "citemind:sources:delete",
  resolveDuplicate: "citemind:sources:resolve-duplicate",
  checkAllWebSources: "citemind:sources:check-web-all",
  checkWebSource: "citemind:sources:check-web",
  listSourceVersions: "citemind:sources:versions",
  getSourceVersionDiff: "citemind:sources:version-diff",
  decideSourceVersion: "citemind:sources:decide-version",
  updateSourceMaintenance: "citemind:sources:update-maintenance",
  decideSourceSuggestion: "citemind:sources:decide-suggestion",
  buildIndex: "citemind:indexes:build",
  deleteIndex: "citemind:indexes:delete",
  rebuildIndex: "citemind:indexes:rebuild",
  getIndexStatus: "citemind:indexes:status",
  listIndexVersions: "citemind:indexes:list",
  estimateIndex: "citemind:indexes:estimate",
  rollbackIndex: "citemind:indexes:rollback",
  retryIndex: "citemind:indexes:retry",
  hybridSearch: "citemind:retrieval:hybrid-search",
  listConversations: "citemind:conversations:list",
  conversationMessages: "citemind:conversations:messages",
  deleteConversation: "citemind:conversations:delete",
  setConversationModel: "citemind:conversations:set-model",
  answerConversation: "citemind:conversations:answer",
  exportConversationMarkdown: "citemind:conversations:export-markdown",
  conversationUsageSummary: "citemind:conversations:usage-summary",
} as const;

export const SEED_DEFAULTS = {
  credentialId: "default",
  encryptedKeyRef: "safeStorage:seed-api/default",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  defaultChatModel: "doubao-seed-2-0-lite-260428",
  qualityChatModel: "doubao-seed-2-0-pro-260215",
  defaultEmbeddingModel: "doubao-embedding-vision-251215",
} as const;
