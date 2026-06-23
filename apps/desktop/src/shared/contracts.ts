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

export interface SourceClassificationRecord {
  category: string;
  title: string | null;
  author: string | null;
  documentTime: string | null;
  ruleBasis: {
    folder?: string | null;
    filename?: string;
    title?: string;
    author?: string | null;
    documentTime?: string | null;
    rules?: Array<{ field: string; value: string; result: string }>;
  };
  updatedAt: string;
}

export interface SourceTagRecord {
  id: string;
  tag: string;
  suggestedTag: string | null;
  origin: "model" | "correction" | "user";
  status: "pending" | "confirmed" | "dismissed";
  reason: string | null;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface SourceRelationRecord {
  id: string;
  relatedSourceId: string;
  relatedDisplayName: string;
  relationType:
    | "duplicate"
    | "near_duplicate"
    | "related"
    | "supplements"
    | "conflicts"
    | "replaces";
  basis: {
    reason?: string;
    contentHashEqual?: boolean;
    textSimilarity?: number;
    titleSimilarity?: number;
    tokenSimilarity?: number;
    sharedKeywords?: string[];
  };
  confidence: number;
  status: "pending" | "confirmed" | "dismissed";
  origin: "rule" | "model" | "user";
  createdAt: string;
  updatedAt: string;
}

export interface SourceOrganizationResponse {
  sourceId: string;
  knowledgeBaseId: string;
  classification: SourceClassificationRecord | null;
  tags: SourceTagRecord[];
  relations: SourceRelationRecord[];
}

export interface DecideSourceTagRequest {
  sourceId: string;
  tagId: string;
  decision: "confirm" | "dismiss";
  correctedTag?: string | null;
}

export interface DecideSourceRelationRequest {
  sourceId: string;
  relationId: string;
  decision: "confirm" | "dismiss";
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
  agentRunId: string | null;
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

export type WritingWorkflowType = "review" | "article";
export type WritingProjectStatus =
  | "planning"
  | "ready"
  | "running"
  | "needs_revision"
  | "completed"
  | "failed";
export type WritingSectionStatus =
  | "pending"
  | "running"
  | "needs_review"
  | "needs_revision"
  | "completed"
  | "failed";

export interface WritingProjectRecord {
  id: string;
  knowledgeBaseId: string;
  title: string;
  goal: string;
  workflowType: WritingWorkflowType;
  status: WritingProjectStatus;
  modelId: string | null;
  indexVersionId: string | null;
  outline: {
    title?: string;
    summary?: string;
    sections?: Array<Record<string, unknown>>;
  };
  audit: Record<string, unknown>;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WritingSectionRecord {
  id: string;
  projectId: string;
  position: number;
  title: string;
  purpose: string;
  reviewPoints: string[];
  outlineEvidenceChunkIds: string[];
  status: WritingSectionStatus;
  content: string;
  paragraphs: Array<{ text: string; evidenceChunkIds: string[] }>;
  audit: {
    valid?: boolean;
    conflicts?: Array<Record<string, unknown>>;
    revisionSuggestions?: Array<{ type: string; message: string }>;
    citationValidation?: {
      valid?: boolean;
      invalidCitations?: Array<Record<string, unknown>>;
    };
  };
  citations: AnswerCitation[];
  errorMessage: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WritingCheckpointRecord {
  id: string;
  sectionId: string | null;
  step: string;
  status: "completed" | "failed";
  errorMessage: string | null;
  createdAt: string;
}

export interface WritingProjectResponse {
  project: WritingProjectRecord;
  sections: WritingSectionRecord[];
  checkpoints: WritingCheckpointRecord[];
}

export interface WritingProjectListResponse {
  knowledgeBaseId: string;
  projects: WritingProjectRecord[];
}

export type AgentRunStatus =
  | "planning"
  | "waiting_confirmation"
  | "executing"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export interface AgentRunRecord {
  id: string;
  knowledgeBaseId: string;
  title: string;
  goal: string;
  skillId: string;
  skillVersion: string;
  status: AgentRunStatus;
  sourceScope: string[];
  indexVersionId: string | null;
  models: Record<string, unknown>;
  budgets: Record<string, unknown>;
  usage: Record<string, unknown>;
  plan: Record<string, unknown>;
  draft: Record<string, unknown>;
  finalOutput: Record<string, unknown>;
  traceSnapshot: AgentRunTraceSnapshot;
  errorMessage: string | null;
  stopReason: string | null;
  retryCount: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunTracePhase {
  id: string;
  label: string;
  status: "pending" | "active" | "completed" | "failed" | string;
}

export interface AgentRunTraceSnapshot {
  currentStage?: string;
  currentStageLabel?: string;
  currentEventType?: string;
  status?: string | null;
  title?: string | null;
  summary?: string | null;
  toolCallId?: string | null;
  stepId?: string | null;
  lastSequence?: number;
  lastEventAt?: string;
  phases?: AgentRunTracePhase[];
}

export interface AgentRunEventRecord {
  id: string;
  runId: string;
  sequence: number;
  eventType: string;
  stage: string | null;
  status: string | null;
  title: string;
  summary: string | null;
  payload: Record<string, unknown>;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  toolCallId: string | null;
  stepId: string | null;
  createdAt: string;
}

export interface AgentRunToolCallRecord {
  id: string;
  runId: string;
  stepId: string | null;
  toolName: string;
  skillId: string | null;
  skillVersion: string | null;
  actionSummary: string;
  workingDirectory: string | null;
  sanitizedParams: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  stdoutSummary: string | null;
  stderrSummary: string | null;
  errorMessage: string | null;
}

export interface AgentRunConfirmationRecord {
  id: string;
  runId: string;
  prompt: string;
  status: "pending" | "confirmed" | "rejected" | "cancelled";
  options: unknown[];
  decision: Record<string, unknown>;
  requestedAt: string;
  resolvedAt: string | null;
}

export interface AgentRunDelegationRecord {
  id: string;
  runId: string;
  childRunId: string | null;
  delegateeRole: string;
  task: string;
  inputScope: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  output: Record<string, unknown>;
  stopReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AgentRunOutputRecord {
  id: string;
  runId: string;
  outputType: "draft" | "final" | "intermediate";
  title: string;
  content: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunCitationRecord {
  id: string;
  runId: string;
  outputId: string | null;
  paragraphIndex: number;
  chunkId: string;
  createdAt: string;
}

export interface AgentRunResponse {
  run: AgentRunRecord;
  events: AgentRunEventRecord[];
  toolCalls: AgentRunToolCallRecord[];
  confirmations: AgentRunConfirmationRecord[];
  delegations: AgentRunDelegationRecord[];
  outputs: AgentRunOutputRecord[];
  citations: AgentRunCitationRecord[];
}

export interface AgentRunListResponse {
  knowledgeBaseId: string;
  runs: AgentRunRecord[];
}

export interface AgentRunRecoveryResponse {
  runs: AgentRunRecord[];
}

export interface CreateAgentRunRequest {
  knowledgeBaseId: string;
  goal: string;
  skillId: string;
  skillVersion: string;
  title?: string | null;
  sourceIds?: string[];
  indexVersionId?: string | null;
  models?: Record<string, unknown>;
  budgets?: Record<string, unknown>;
}

export interface AgentRunTransitionRequest {
  runId: string;
  status: AgentRunStatus;
  stage?: string | null;
  summary?: string | null;
  errorMessage?: string | null;
  stopReason?: string | null;
}

export interface AgentRunStageRequest {
  runId: string;
  stage: string;
  status?: "started" | "completed";
  title?: string | null;
  summary?: string | null;
  stepId?: string | null;
  durationMs?: number | null;
}

export interface AgentRunSkillLoadedRequest {
  runId: string;
  skillId: string;
  skillVersion: string;
  summary?: string | null;
}

export interface AgentRunToolCallStartRequest {
  runId: string;
  toolName: string;
  actionSummary: string;
  stepId?: string | null;
  skillId?: string | null;
  skillVersion?: string | null;
  workingDirectory?: string | null;
  sanitizedParams?: Record<string, unknown>;
}

export interface AgentRunToolOutputRequest {
  toolCallId: string;
  stdoutSummary?: string | null;
  stderrSummary?: string | null;
  payload?: Record<string, unknown>;
}

export interface AgentRunToolCallFinishRequest {
  toolCallId: string;
  status: "completed" | "failed" | "cancelled";
  exitCode?: number | null;
  stdoutSummary?: string | null;
  stderrSummary?: string | null;
  errorMessage?: string | null;
}

export interface AgentRunConfirmationRequest {
  runId: string;
  prompt: string;
  options?: Array<Record<string, unknown>>;
}

export interface AgentRunConfirmationResolution {
  confirmationId: string;
  status: "confirmed" | "rejected" | "cancelled";
  decision?: Record<string, unknown>;
}

export interface AgentRunDelegationRequest {
  runId: string;
  delegateeRole: string;
  task: string;
  inputScope?: Record<string, unknown>;
  childRunId?: string | null;
}

export interface AgentRunOutputRequest {
  runId: string;
  outputType: "draft" | "final" | "intermediate";
  title: string;
  content: string;
  payload?: Record<string, unknown>;
  citations?: Array<{
    paragraphIndex: number;
    chunkId: string;
  }>;
}

export interface AgentFactClass {
  id: string;
  label: string;
  description: string;
}

export interface AgentSubAgentDescriptor {
  role: "Evidence Scout" | "Auditor";
  allowedTools: string[];
  maxSteps: number;
  maxToolCalls: number;
  maxModelCalls: 0;
  maxDurationSeconds: number;
  canDelegate: false;
}

export interface AgentNativeToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentSkillDescriptor {
  id: string;
  version: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  allowedTools: string[];
  executionConstraints: Record<string, unknown>;
  budgetPolicy: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  factClasses: AgentFactClass[];
}

export interface AgentSkillListResponse {
  version: string;
  nativeTools: AgentNativeToolDescriptor[];
  factClasses: AgentFactClass[];
  subAgents: AgentSubAgentDescriptor[];
  skills: AgentSkillDescriptor[];
}

export interface RunAgentSkillRequest {
  knowledgeBaseId: string;
  skillId: string;
  goal: string;
  sourceIds?: string[];
  inputs?: Record<string, unknown>;
  limit?: number;
  candidateLimit?: number;
}

export interface AgentToolInvocationRequest {
  runId: string;
  toolName: string;
  params?: Record<string, unknown>;
}

export interface AgentToolInvocationResponse {
  toolName: string;
  result: Record<string, unknown>;
  agentRun: AgentRunResponse;
}

export interface McpServerRecord {
  id: string;
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  envKeys: string[];
  readOnlyTools: string[];
  enabled: boolean;
  timeoutSeconds: number;
  lastError: string | null;
  lastDiscoveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerListResponse {
  servers: McpServerRecord[];
}

export interface SaveMcpServerRequest {
  serverId?: string | null;
  name: string;
  command: string;
  args?: string[];
  envKeys?: string[];
  readOnlyTools?: string[];
  enabled?: boolean;
  timeoutSeconds?: number;
}

export interface McpToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
  };
  locallyAllowedReadOnly: boolean;
  trustNotice: string;
}

export interface McpDiscoveryResponse {
  server: McpServerRecord;
  tools: McpToolDescriptor[];
}

export interface ExternalComparison {
  classification: "consensus" | "supplement" | "conflict";
  label: string;
  matches: Array<{
    sourceId: string;
    displayName: string;
    overlap: number;
    polarityConflict: boolean;
  }>;
}

export interface ExternalResearchCandidate {
  id: string;
  runId: string;
  knowledgeBaseId: string;
  serverId: string;
  toolName: string;
  title: string;
  url: string;
  snippet: string;
  content: string;
  sourceMetadata: Record<string, unknown>;
  initialComparison: ExternalComparison;
  finalComparison: ExternalComparison | Record<string, never>;
  status: "candidate" | "rejected" | "importing" | "indexed" | "failed";
  importedSourceId: string | null;
  indexedVersionId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalResearchResponse {
  runId: string;
  candidates: ExternalResearchCandidate[];
  confirmationId?: string | null;
  addedCount?: number;
  indexVersionId?: string | null;
  errors?: Array<{ serverId: string; toolName: string; error: string }>;
  failures?: Array<{ candidateId: string; error: string }>;
  agentRun?: AgentRunResponse;
}

export interface ExternalResearchSearchRequest {
  runId: string;
  query: string;
  searches: Array<{ serverId: string; toolName: string }>;
  limit?: number;
}

export interface ExternalResearchDecisionRequest {
  runId: string;
  confirmationId: string;
  candidateIds: string[];
  decision: "import" | "reject";
}

export type ResearchBriefAction =
  | "continue_research"
  | "supplement_evidence"
  | "audit_citations"
  | "regenerate_section";

export interface ResearchBriefSection {
  id: string;
  title: string;
  content: string;
  evidenceChunkIds: string[];
  origin: "agent" | "user" | string;
}

export interface ResearchBriefWorkspace {
  title: string;
  goal: string;
  plan: Record<string, unknown>;
  outline: Record<string, unknown>;
  draft: string;
  final: string;
  sections: ResearchBriefSection[];
  latestAudit: Record<string, unknown>;
  conflicts: Array<Record<string, unknown>>;
  gaps: Array<Record<string, unknown>>;
  evidenceChunkIds: string[];
  relatedRunIds: string[];
  lastEditOrigin: "agent" | "user" | string;
  lastEditedAt?: string;
}

export interface ResearchBriefSummary {
  runId: string;
  knowledgeBaseId: string;
  title: string;
  goal: string;
  status: AgentRunStatus;
  sourceIds: string[];
  userRevision: number;
  agentRevision: number;
  hasPendingAgentUpdate: boolean;
  latestRunId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchBriefResponse {
  brief: ResearchBriefSummary;
  workspace: ResearchBriefWorkspace;
  pendingAgentUpdate: Record<string, unknown>;
  latestRun: AgentRunResponse;
  externalCandidates: ExternalResearchCandidate[];
}

export interface ResearchBriefListResponse {
  knowledgeBaseId: string;
  briefs: ResearchBriefSummary[];
}

export interface CreateResearchBriefRequest {
  knowledgeBaseId: string;
  goal: string;
  sourceIds?: string[];
}

export interface UpdateResearchBriefRequest {
  runId: string;
  expectedRevision: number;
  sourceIds?: string[];
  patch: Partial<
    Pick<
      ResearchBriefWorkspace,
      "title" | "goal" | "plan" | "outline" | "draft" | "final" | "sections"
    >
  >;
}

export interface ResearchBriefOperationRequest {
  runId: string;
  action: ResearchBriefAction;
  expectedRevision: number;
  selectionText?: string | null;
  sectionId?: string | null;
}

export interface ResolveResearchBriefPendingRequest {
  runId: string;
  decision: "apply" | "discard";
  expectedRevision: number;
}

export interface ResearchBriefExportResult {
  cancelled: boolean;
  filePath?: string;
}

export interface CreateWritingProjectRequest {
  knowledgeBaseId: string;
  goal: string;
  workflowType: WritingWorkflowType;
}

export interface RunWritingSectionRequest {
  projectId: string;
  sectionId?: string | null;
  revise?: boolean;
}

export interface WritingExportResult {
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
  recyclableSourceVersionCount: number;
  qualityMetrics: {
    parseSuccessRate: number | null;
    indexDurationMs: number | null;
    retrievalLatencyMs: number | null;
    firstTokenLatencyMs: number | null;
    citationFailureRate: number | null;
    embeddingCalls: number;
    embeddingTexts: number;
    embeddingRetries: number;
    embeddingInputCharacters: number;
  };
  recycledIndexCount?: number;
  recycledSourceVersionCount?: number;
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
    onUpdated: (listener: (job: BackgroundJobRecord) => void) => () => void;
  };
  agentRuns: {
    list: (
      knowledgeBaseId: string,
      options?: { includeTerminal?: boolean; limit?: number },
    ) => Promise<AgentRunListResponse>;
    get: (runId: string) => Promise<AgentRunResponse>;
    create: (request: CreateAgentRunRequest) => Promise<AgentRunResponse>;
    updatePlan: (
      runId: string,
      plan: Record<string, unknown>,
      summary?: string | null,
    ) => Promise<AgentRunResponse>;
    recordStage: (request: AgentRunStageRequest) => Promise<AgentRunResponse>;
    recordSkillLoaded: (
      request: AgentRunSkillLoadedRequest,
    ) => Promise<AgentRunResponse>;
    transition: (
      request: AgentRunTransitionRequest,
    ) => Promise<AgentRunResponse>;
    pause: (runId: string) => Promise<AgentRunResponse>;
    resume: (runId: string) => Promise<AgentRunResponse>;
    cancel: (
      runId: string,
      reason?: string | null,
    ) => Promise<AgentRunResponse>;
    retry: (runId: string) => Promise<AgentRunResponse>;
    recover: () => Promise<AgentRunRecoveryResponse>;
    startToolCall: (
      request: AgentRunToolCallStartRequest,
    ) => Promise<AgentRunResponse>;
    recordToolOutput: (
      request: AgentRunToolOutputRequest,
    ) => Promise<AgentRunResponse>;
    finishToolCall: (
      request: AgentRunToolCallFinishRequest,
    ) => Promise<AgentRunResponse>;
    requestConfirmation: (
      request: AgentRunConfirmationRequest,
    ) => Promise<AgentRunResponse>;
    resolveConfirmation: (
      request: AgentRunConfirmationResolution,
    ) => Promise<AgentRunResponse>;
    recordDelegation: (
      request: AgentRunDelegationRequest,
    ) => Promise<AgentRunResponse>;
    saveOutput: (request: AgentRunOutputRequest) => Promise<AgentRunResponse>;
    onTraceEvent: (
      listener: (event: AgentRunEventRecord) => void,
    ) => () => void;
  };
  agentSkills: {
    list: () => Promise<AgentSkillListResponse>;
    get: (
      skillId: string,
      version?: string | null,
    ) => Promise<AgentSkillDescriptor>;
    run: (request: RunAgentSkillRequest) => Promise<AgentRunResponse>;
    invokeTool: (
      request: AgentToolInvocationRequest,
    ) => Promise<AgentToolInvocationResponse>;
  };
  mcpServers: {
    list: () => Promise<McpServerListResponse>;
    save: (request: SaveMcpServerRequest) => Promise<McpServerRecord>;
    delete: (serverId: string) => Promise<McpServerListResponse>;
    discover: (serverId: string) => Promise<McpDiscoveryResponse>;
  };
  externalResearch: {
    setAccess: (
      runId: string,
      enabled: boolean,
      serverIds: string[],
    ) => Promise<{
      runId: string;
      enabled: boolean;
      serverIds: string[];
      agentRun: AgentRunResponse;
    }>;
    search: (
      request: ExternalResearchSearchRequest,
    ) => Promise<ExternalResearchResponse>;
    candidates: (runId: string) => Promise<ExternalResearchResponse>;
    decide: (
      request: ExternalResearchDecisionRequest,
    ) => Promise<ExternalResearchResponse>;
  };
  researchBriefs: {
    list: (knowledgeBaseId: string) => Promise<ResearchBriefListResponse>;
    get: (runId: string) => Promise<ResearchBriefResponse>;
    create: (
      request: CreateResearchBriefRequest,
    ) => Promise<ResearchBriefResponse>;
    update: (
      request: UpdateResearchBriefRequest,
    ) => Promise<ResearchBriefResponse>;
    operate: (
      request: ResearchBriefOperationRequest,
    ) => Promise<ResearchBriefResponse>;
    resolvePending: (
      request: ResolveResearchBriefPendingRequest,
    ) => Promise<ResearchBriefResponse>;
    exportMarkdown: (runId: string) => Promise<ResearchBriefExportResult>;
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
    organization: (sourceId: string) => Promise<SourceOrganizationResponse>;
    classify: (sourceId: string) => Promise<SourceOrganizationResponse>;
    suggestTags: (sourceId: string) => Promise<SourceOrganizationResponse>;
    decideTag: (
      request: DecideSourceTagRequest,
    ) => Promise<SourceOrganizationResponse>;
    decideRelation: (
      request: DecideSourceRelationRequest,
    ) => Promise<SourceOrganizationResponse>;
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
  writing: {
    list: (knowledgeBaseId: string) => Promise<WritingProjectListResponse>;
    project: (projectId: string) => Promise<WritingProjectResponse>;
    create: (
      request: CreateWritingProjectRequest,
    ) => Promise<WritingProjectResponse>;
    runSection: (
      request: RunWritingSectionRequest,
    ) => Promise<WritingProjectResponse>;
    updateSection: (
      sectionId: string,
      content: string,
    ) => Promise<WritingProjectResponse>;
    auditSection: (sectionId: string) => Promise<WritingProjectResponse>;
    exportWord: (projectId: string) => Promise<WritingExportResult>;
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
  backgroundJobUpdated: "citemind:jobs:updated",
  createAgentRun: "citemind:agent-runs:create",
  listAgentRuns: "citemind:agent-runs:list",
  getAgentRun: "citemind:agent-runs:get",
  updateAgentRunPlan: "citemind:agent-runs:update-plan",
  recordAgentRunStage: "citemind:agent-runs:record-stage",
  recordAgentRunSkillLoaded: "citemind:agent-runs:record-skill-loaded",
  transitionAgentRun: "citemind:agent-runs:transition",
  pauseAgentRun: "citemind:agent-runs:pause",
  resumeAgentRun: "citemind:agent-runs:resume",
  cancelAgentRun: "citemind:agent-runs:cancel",
  retryAgentRun: "citemind:agent-runs:retry",
  recoverAgentRuns: "citemind:agent-runs:recover",
  startAgentRunToolCall: "citemind:agent-runs:start-tool-call",
  recordAgentRunToolOutput: "citemind:agent-runs:record-tool-output",
  finishAgentRunToolCall: "citemind:agent-runs:finish-tool-call",
  requestAgentRunConfirmation: "citemind:agent-runs:request-confirmation",
  resolveAgentRunConfirmation: "citemind:agent-runs:resolve-confirmation",
  recordAgentRunDelegation: "citemind:agent-runs:record-delegation",
  saveAgentRunOutput: "citemind:agent-runs:save-output",
  agentRunTraceEvent: "citemind:agent-runs:trace-event",
  listAgentSkills: "citemind:agent-skills:list",
  getAgentSkill: "citemind:agent-skills:get",
  runAgentSkill: "citemind:agent-skills:run",
  invokeAgentTool: "citemind:agent-tools:invoke",
  listMcpServers: "citemind:mcp-servers:list",
  saveMcpServer: "citemind:mcp-servers:save",
  deleteMcpServer: "citemind:mcp-servers:delete",
  discoverMcpServer: "citemind:mcp-servers:discover",
  setExternalResearchAccess: "citemind:external-research:set-access",
  searchExternalResearch: "citemind:external-research:search",
  listExternalCandidates: "citemind:external-research:candidates",
  decideExternalCandidates: "citemind:external-research:decide",
  listResearchBriefs: "citemind:research-briefs:list",
  getResearchBrief: "citemind:research-briefs:get",
  createResearchBrief: "citemind:research-briefs:create",
  updateResearchBrief: "citemind:research-briefs:update",
  operateResearchBrief: "citemind:research-briefs:operate",
  resolveResearchBriefPending: "citemind:research-briefs:resolve-pending",
  exportResearchBriefMarkdown: "citemind:research-briefs:export-markdown",
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
  getSourceOrganization: "citemind:sources:organization",
  classifySource: "citemind:sources:classify",
  suggestSourceTags: "citemind:sources:suggest-tags",
  decideSourceTag: "citemind:sources:decide-tag",
  decideSourceRelation: "citemind:sources:decide-relation",
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
  listWritingProjects: "citemind:writing:list",
  getWritingProject: "citemind:writing:project",
  createWritingProject: "citemind:writing:create",
  runWritingSection: "citemind:writing:run-section",
  updateWritingSection: "citemind:writing:update-section",
  auditWritingSection: "citemind:writing:audit-section",
  exportWritingWord: "citemind:writing:export-word",
} as const;

export const SEED_DEFAULTS = {
  credentialId: "default",
  encryptedKeyRef: "safeStorage:seed-api/default",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  defaultChatModel: "doubao-seed-2-0-lite-260428",
  qualityChatModel: "doubao-seed-2-0-pro-260215",
  defaultEmbeddingModel: "doubao-embedding-vision-251215",
} as const;
