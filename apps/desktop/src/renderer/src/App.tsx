import { useCallback, useEffect, useState } from "react";
import type {
  AnswerCitation,
  AgentRunConfirmationRecord,
  AgentRunEventRecord,
  AgentRunRecord,
  AgentRunResponse,
  AgentRunToolCallRecord,
  BackgroundJobRecord,
  BackgroundJobStatus,
  BuildIndexResponse,
  ConversationAnswerResponse,
  ConversationMessageRecord,
  ConversationRecord,
  DuplicateAction,
  HybridSearchResult,
  IndexBuildEstimate,
  IndexVersionRecord,
  KnowledgeBaseRecord,
  KnowledgeBaseSource,
  MaintenanceStatus,
  ModelCapabilityStatus,
  ModelValidationStatus,
  ParseCheckItem,
  ParseCheckSummary,
  SeedCredentialStatus,
  SeedModelDescriptor,
  SourceOrganizationResponse,
  SourceVersionDiffResponse,
  SourceVersionsResponse,
  UsageSummary,
  WorkerHealth,
  WritingProjectRecord,
  WritingProjectResponse,
  WritingSectionRecord,
  WritingWorkflowType,
} from "../../shared/contracts";
import { SEED_DEFAULTS } from "../../shared/contracts";

type WorkerState =
  | { kind: "checking" }
  | { kind: "online"; health: WorkerHealth }
  | { kind: "offline"; message: string };

type IconName =
  | "add"
  | "book"
  | "chat"
  | "check"
  | "chevron"
  | "close"
  | "document"
  | "download"
  | "evidence"
  | "folder"
  | "menu"
  | "panel"
  | "refresh"
  | "search"
  | "send"
  | "settings"
  | "sparkle"
  | "trash";

type SourceTone = "amber" | "blue" | "violet" | "green";

type KnowledgeBaseDialogMode = "create" | "rename" | "delete";

type ConfirmAction =
  | { kind: "delete-source"; source: KnowledgeBaseSource }
  | { kind: "delete-conversation"; conversation: ConversationRecord }
  | { kind: "delete-index" }
  | { kind: "rebuild-index" };

type EvidenceSelection =
  | {
      kind: "citation";
      citation: AnswerCitation;
      citationNumber?: number;
      retrievalResult?: HybridSearchResult;
      response?: ConversationAnswerResponse;
    }
  | {
      kind: "search";
      result: HybridSearchResult;
    };

const SUGGESTIONS = [
  "总结当前知识库的核心架构决策",
  "为什么回答必须经过引用校验？",
  "比较关键词检索与向量检索的用途",
];

const PENDING_CONVERSATION_ID = "pending-conversation";
const PENDING_USER_MESSAGE_PREFIX = "pending-user:";
const PENDING_ASSISTANT_MESSAGE_PREFIX = "pending-assistant:";

const FALLBACK_SEED_MODELS: SeedModelDescriptor[] = [
  {
    id: SEED_DEFAULTS.defaultChatModel,
    label: "默认对话",
    role: "default_chat",
    api: "responses",
    contextWindow: 256_000,
    vectorDimension: null,
    capabilities: ["chat", "vision", "structured_output", "streaming"],
  },
  {
    id: SEED_DEFAULTS.qualityChatModel,
    label: "高质量对话",
    role: "quality_chat",
    api: "responses",
    contextWindow: 256_000,
    vectorDimension: null,
    capabilities: ["chat", "vision", "structured_output", "streaming"],
  },
  {
    id: SEED_DEFAULTS.defaultEmbeddingModel,
    label: "Embedding",
    role: "embedding",
    api: "multimodal_embeddings",
    contextWindow: null,
    vectorDimension: 2048,
    capabilities: ["embedding", "vision_embedding"],
  },
];

const FALLBACK_KNOWLEDGE_BASES: KnowledgeBaseRecord[] = [
  {
    id: "demo-kb",
    name: "产品与架构资料库",
    description: "浏览器预览用知识库",
    createdAt: "",
    updatedAt: "",
    summary: {
      sourceCount: 4,
      sourcesByStatus: { ready: 3, pending: 1 },
      readyIndexCount: 1,
      conversationCount: 0,
      chunkCount: 128,
    },
  },
];

const FALLBACK_SOURCES: KnowledgeBaseSource[] = [
  {
    id: "demo-source-1",
    sourceType: "pdf",
    displayName: "RAG 产品与架构方案",
    uri: null,
    status: "ready",
    latestVersionStatus: "ready",
    currentVersionId: "demo-source-version-1",
    currentVersionNumber: 1,
    pendingVersionCount: 0,
    replacementSourceId: null,
    reviewAt: null,
    expiryStatus: "active",
    modelSuggestion: null,
    lastCheckedAt: null,
    chunkCount: 42,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "demo-source-2",
    sourceType: "pdf",
    displayName: "可信引用设计笔记",
    uri: null,
    status: "ready",
    latestVersionStatus: "ready",
    currentVersionId: "demo-source-version-2",
    currentVersionNumber: 1,
    pendingVersionCount: 0,
    replacementSourceId: null,
    reviewAt: null,
    expiryStatus: "active",
    modelSuggestion: null,
    lastCheckedAt: null,
    chunkCount: 35,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "demo-source-3",
    sourceType: "web",
    displayName: "Seed 模型能力清单",
    uri: null,
    status: "ready",
    latestVersionStatus: "ready",
    currentVersionId: "demo-source-version-3",
    currentVersionNumber: 1,
    pendingVersionCount: 0,
    replacementSourceId: null,
    reviewAt: null,
    expiryStatus: "active",
    modelSuggestion: null,
    lastCheckedAt: null,
    chunkCount: 21,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "demo-source-4",
    sourceType: "docx",
    displayName: "混合检索实验记录",
    uri: null,
    status: "pending",
    latestVersionStatus: "processing",
    currentVersionId: "demo-source-version-4",
    currentVersionNumber: 1,
    pendingVersionCount: 0,
    replacementSourceId: null,
    reviewAt: null,
    expiryStatus: "active",
    modelSuggestion: null,
    lastCheckedAt: null,
    chunkCount: 0,
    createdAt: "",
    updatedAt: "",
  },
];

const FALLBACK_JOBS: BackgroundJobRecord[] = [
  {
    id: "demo-job-1",
    jobType: "source.import",
    targetId: "demo-source-4",
    status: "running",
    progress: 0.42,
    checkpoint: {
      stages: [
        { id: "parse", label: "解析", status: "completed", progress: 1 },
        { id: "ocr", label: "OCR", status: "running", progress: 0.68 },
        {
          id: "embedding",
          label: "Embedding",
          status: "pending",
          progress: 0,
        },
        { id: "index", label: "索引", status: "pending", progress: 0 },
      ],
    },
    retryCount: 0,
    errorMessage: null,
    createdAt: "",
    updatedAt: "",
  },
];

const FALLBACK_PARSE_CHECKS: ParseCheckItem[] = [
  {
    sourceId: "demo-source-1",
    sourceVersionId: "demo-source-version-1",
    sourceType: "pdf",
    displayName: "RAG 产品与架构方案",
    uri: null,
    status: "success",
    sourceStatus: "processing",
    versionStatus: "parsed",
    jobStatus: "completed",
    errorMessage: null,
    duplicateOfSourceId: null,
    duplicateKind: null,
    duplicateResolution: null,
    duplicateActions: [],
    originalHash: "demo",
    contentHash: "demo-content",
    originalPath: null,
    snapshotPath: null,
    parseArtifactPath: null,
    preview: "模型只能引用本次检索得到且经过后端校验的文本块。",
    chunkCount: 3,
    createdAt: "",
    updatedAt: "",
  },
  {
    sourceId: "demo-source-4",
    sourceVersionId: "demo-source-version-4",
    sourceType: "docx",
    displayName: "混合检索实验记录",
    uri: null,
    status: "processing",
    sourceStatus: "processing",
    versionStatus: "processing",
    jobStatus: "running",
    errorMessage: null,
    duplicateOfSourceId: null,
    duplicateKind: null,
    duplicateResolution: null,
    duplicateActions: [],
    originalHash: "demo-2",
    contentHash: null,
    originalPath: null,
    snapshotPath: null,
    parseArtifactPath: null,
    preview: "正在解析文档结构，索引完成前不会进入检索结果。",
    chunkCount: 0,
    createdAt: "",
    updatedAt: "",
  },
];

function getDesktopApi(): Window["citeMind"] {
  if (!window.citeMind) {
    throw new Error("Preload IPC 未加载，请检查桌面端启动日志");
  }
  return window.citeMind;
}

function Icon({
  name,
  size = 18,
}: {
  name: IconName;
  size?: number;
}): React.JSX.Element {
  const paths: Record<IconName, React.JSX.Element> = {
    add: <path d="M12 5v14M5 12h14" />,
    book: (
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5Zm0 0v16" />
    ),
    chat: (
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
    ),
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    close: <path d="M18 6 6 18M6 6l12 12" />,
    document: (
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8M8 17h5" />
    ),
    download: <path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14" />,
    evidence: (
      <path d="M9 3h6l1 2h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3Zm-1 9 3 3 5-6" />
    ),
    folder: (
      <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    ),
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    panel: <path d="M4 4h16v16H4zM9 4v16" />,
    refresh: (
      <path d="M20 6v5h-5M4 18v-5h5M18.5 9A7 7 0 0 0 6 6.5L4 11m16 2-2 4.5A7 7 0 0 1 5.5 15" />
    ),
    search: <path d="m21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" />,
    send: <path d="m22 2-7 20-4-9-9-4Zm-11 11L22 2" />,
    settings: (
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-3.5a7.8 7.8 0 0 0-.1-1l2-1.5-2-3.5-2.5 1a8 8 0 0 0-1.7-1L14.7 3h-4l-.4 3a8 8 0 0 0-1.7 1L6.1 6 4 9.5 6.1 11a7.8 7.8 0 0 0 0 2L4 14.5 6.1 18l2.5-1a8 8 0 0 0 1.7 1l.4 3h4l.4-3a8 8 0 0 0 1.7-1l2.5 1 2-3.5-2-1.5a7.8 7.8 0 0 0 .1-1Z" />
    ),
    sparkle: (
      <path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6ZM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z" />
    ),
    trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3" />,
  };

  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      {paths[name]}
    </svg>
  );
}

function App(): React.JSX.Element {
  const [worker, setWorker] = useState<WorkerState>({ kind: "checking" });
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseRecord[]>(
    FALLBACK_KNOWLEDGE_BASES,
  );
  const [activeKnowledgeBaseId, setActiveKnowledgeBaseId] = useState("");
  const [sources, setSources] =
    useState<KnowledgeBaseSource[]>(FALLBACK_SOURCES);
  const [selectedSourceIds, setSelectedSourceIds] = useState(
    FALLBACK_SOURCES.map((source) => source.id),
  );
  const [jobs, setJobs] = useState<BackgroundJobRecord[]>(FALLBACK_JOBS);
  const [jobsPanelOpen, setJobsPanelOpen] = useState(true);
  const [jobBusyId, setJobBusyId] = useState("");
  const [jobError, setJobError] = useState("");
  const [parseChecks, setParseChecks] = useState<ParseCheckItem[]>(
    FALLBACK_PARSE_CHECKS,
  );
  const [parseSummary, setParseSummary] = useState<ParseCheckSummary>(
    summarizeParseChecks(FALLBACK_PARSE_CHECKS),
  );
  const [parsePanelOpen, setParsePanelOpen] = useState(true);
  const [indexStatus, setIndexStatus] = useState<BuildIndexResponse | null>(
    null,
  );
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexError, setIndexError] = useState("");
  const [indexVersions, setIndexVersions] = useState<IndexVersionRecord[]>([]);
  const [indexEstimate, setIndexEstimate] = useState<IndexBuildEstimate | null>(
    null,
  );
  const [sourceDeleteBusyId, setSourceDeleteBusyId] = useState("");
  const [sourceMaintenance, setSourceMaintenance] =
    useState<SourceVersionsResponse | null>(null);
  const [sourceVersionDiff, setSourceVersionDiff] =
    useState<SourceVersionDiffResponse | null>(null);
  const [sourceOrganization, setSourceOrganization] =
    useState<SourceOrganizationResponse | null>(null);
  const [sourceTagDrafts, setSourceTagDrafts] = useState<
    Record<string, string>
  >({});
  const [sourceMaintenanceBusy, setSourceMaintenanceBusy] = useState(false);
  const [sourceMaintenanceError, setSourceMaintenanceError] = useState("");
  const [sourceMaintenanceForm, setSourceMaintenanceForm] = useState({
    replacementSourceId: "",
    reviewAt: "",
    expiryStatus: "active" as KnowledgeBaseSource["expiryStatus"],
  });
  const [duplicateBusyId, setDuplicateBusyId] = useState("");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(
    null,
  );
  const [confirmError, setConfirmError] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [webImportOpen, setWebImportOpen] = useState(false);
  const [webImportForm, setWebImportForm] = useState({
    url: "",
    displayName: "",
  });
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [lastSearchQuery, setLastSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<HybridSearchResult[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false);
  const [conversationDeleteBusyId, setConversationDeleteBusyId] = useState("");
  const [messages, setMessages] = useState<ConversationMessageRecord[]>([]);
  const [answerResponses, setAnswerResponses] = useState<
    Record<string, ConversationAnswerResponse>
  >({});
  const [agentRuns, setAgentRuns] = useState<AgentRunRecord[]>([]);
  const [agentRunTrace, setAgentRunTrace] = useState<AgentRunResponse | null>(
    null,
  );
  const [agentTraceExpanded, setAgentTraceExpanded] = useState(true);
  const [agentTraceStageFilter, setAgentTraceStageFilter] = useState("all");
  const [expandedTraceToolId, setExpandedTraceToolId] = useState("");
  const [agentTraceBusyId, setAgentTraceBusyId] = useState("");
  const [agentTraceError, setAgentTraceError] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState("");
  const [exportBusyId, setExportBusyId] = useState("");
  const [exportNotice, setExportNotice] = useState("");
  const [chatModel, setChatModel] = useState<string>(
    SEED_DEFAULTS.defaultChatModel,
  );
  const [selectedEvidence, setSelectedEvidence] =
    useState<EvidenceSelection | null>(null);
  const [sourceJumpNotice, setSourceJumpNotice] = useState("");
  const [evidenceOpen, setEvidenceOpen] = useState(true);
  const [systemOpen, setSystemOpen] = useState(false);
  const [knowledgeBaseMenuOpen, setKnowledgeBaseMenuOpen] = useState(false);
  const [knowledgeBaseDialog, setKnowledgeBaseDialog] =
    useState<KnowledgeBaseDialogMode | null>(null);
  const [knowledgeBaseForm, setKnowledgeBaseForm] = useState({
    name: "",
    description: "",
    confirmName: "",
  });
  const [knowledgeBaseBusy, setKnowledgeBaseBusy] = useState(false);
  const [knowledgeBaseError, setKnowledgeBaseError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [seedStatus, setSeedStatus] = useState<SeedCredentialStatus | null>(
    null,
  );
  const [seedForm, setSeedForm] = useState<{
    name: string;
    apiKey: string;
    defaultChatModel: string;
    defaultEmbeddingModel: string;
  }>({
    name: "我的 Seed API",
    apiKey: "",
    defaultChatModel: SEED_DEFAULTS.defaultChatModel,
    defaultEmbeddingModel: SEED_DEFAULTS.defaultEmbeddingModel,
  });
  const [seedBusy, setSeedBusy] = useState(false);
  const [seedError, setSeedError] = useState("");
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [maintenanceStatus, setMaintenanceStatus] =
    useState<MaintenanceStatus | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [maintenanceNotice, setMaintenanceNotice] = useState("");
  const [writingOpen, setWritingOpen] = useState(false);
  const [writingProjects, setWritingProjects] = useState<
    WritingProjectRecord[]
  >([]);
  const [writingProject, setWritingProject] =
    useState<WritingProjectResponse | null>(null);
  const [writingSelectedSectionId, setWritingSelectedSectionId] = useState("");
  const [writingDrafts, setWritingDrafts] = useState<Record<string, string>>(
    {},
  );
  const [writingGoal, setWritingGoal] = useState("");
  const [writingWorkflowType, setWritingWorkflowType] =
    useState<WritingWorkflowType>("review");
  const [writingBusy, setWritingBusy] = useState(false);
  const [writingError, setWritingError] = useState("");
  const [writingNotice, setWritingNotice] = useState("");

  const checkHealth = useCallback(async () => {
    setWorker({ kind: "checking" });
    try {
      setWorker({
        kind: "online",
        health: await getDesktopApi().system.checkWorkerHealth(),
      });
    } catch (error) {
      setWorker({
        kind: "offline",
        message: error instanceof Error ? error.message : "Worker 状态检查失败",
      });
    }
  }, []);

  const restart = useCallback(async () => {
    setWorker({ kind: "checking" });
    try {
      setWorker({
        kind: "online",
        health: await getDesktopApi().system.restartWorker(),
      });
    } catch (error) {
      setWorker({
        kind: "offline",
        message: error instanceof Error ? error.message : "Worker 重启失败",
      });
    }
  }, []);

  const loadSeedStatus = useCallback(async () => {
    try {
      const status = await getDesktopApi().seed.getStatus();
      setSeedStatus(status);
      if (status.name) {
        setSeedForm((form) => ({ ...form, name: status.name ?? form.name }));
      }
      setSeedForm((form) => ({
        ...form,
        defaultChatModel: status.defaultChatModel,
        defaultEmbeddingModel: status.defaultEmbeddingModel,
      }));
    } catch (error) {
      setSeedError(
        error instanceof Error ? error.message : "Seed API 状态读取失败",
      );
    }
  }, []);

  const loadOperationalStatus = useCallback(async (knowledgeBaseId: string) => {
    try {
      const [usage, maintenance] = await Promise.all([
        knowledgeBaseId
          ? getDesktopApi().conversations.usageSummary(knowledgeBaseId)
          : Promise.resolve(null),
        getDesktopApi().system.maintenanceStatus(),
      ]);
      setUsageSummary(usage);
      setMaintenanceStatus(maintenance);
      setMaintenanceNotice("");
    } catch (error) {
      setMaintenanceNotice(
        error instanceof Error ? error.message : "调用与存储状态读取失败",
      );
    }
  }, []);

  const loadSources = useCallback(async (knowledgeBaseId: string) => {
    if (!knowledgeBaseId) {
      setSources([]);
      setSelectedSourceIds([]);
      return;
    }
    const result =
      await getDesktopApi().knowledgeBases.listSources(knowledgeBaseId);
    setSources(result.sources);
    setSelectedSourceIds(result.sources.map((source) => source.id));
    setKnowledgeBases((items) =>
      items.map((item) =>
        item.id === knowledgeBaseId
          ? { ...item, summary: result.summary }
          : item,
      ),
    );
  }, []);

  const loadKnowledgeBases = useCallback(
    async (preferredId?: string) => {
      try {
        const result = await getDesktopApi().knowledgeBases.list();
        setKnowledgeBases(result.knowledgeBases);
        setKnowledgeBaseError("");
        const next =
          result.knowledgeBases.find((item) => item.id === preferredId) ??
          result.knowledgeBases[0];
        setActiveKnowledgeBaseId(next?.id ?? "");
        if (next) {
          await loadSources(next.id);
        } else {
          setSources([]);
          setSelectedSourceIds([]);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "知识库状态读取失败";
        if (!message.includes("Preload IPC")) {
          setKnowledgeBaseError(message);
        }
      }
    },
    [loadSources],
  );

  const loadJobs = useCallback(async () => {
    try {
      const result = await getDesktopApi().jobs.list({
        includeTerminal: false,
        limit: 20,
      });
      setJobs(result.jobs);
      setJobError("");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "任务状态读取失败";
      if (!message.includes("Preload IPC")) {
        setJobError(message);
      }
    }
  }, []);

  const loadParseChecks = useCallback(async (knowledgeBaseId: string) => {
    if (!knowledgeBaseId) {
      setParseChecks([]);
      setParseSummary(emptyParseSummary());
      return;
    }
    try {
      const result = await getDesktopApi().sources.parseChecks(knowledgeBaseId);
      setParseChecks(result.items);
      setParseSummary(result.summary);
      setImportError("");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "解析检查状态读取失败";
      if (!message.includes("Preload IPC")) {
        setImportError(message);
      }
    }
  }, []);

  const loadIndexStatus = useCallback(async (knowledgeBaseId: string) => {
    if (!knowledgeBaseId) {
      setIndexStatus(null);
      return;
    }
    try {
      setIndexStatus(await getDesktopApi().indexes.status(knowledgeBaseId));
      setIndexError("");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "索引状态读取失败";
      if (!message.includes("Preload IPC")) {
        setIndexError(message);
      }
    }
  }, []);

  const loadIndexLifecycle = useCallback(async (knowledgeBaseId: string) => {
    if (!knowledgeBaseId) {
      setIndexVersions([]);
      setIndexEstimate(null);
      return;
    }
    try {
      const [versions, estimate] = await Promise.all([
        getDesktopApi().indexes.list(knowledgeBaseId),
        getDesktopApi().indexes.estimate(knowledgeBaseId),
      ]);
      setIndexVersions(versions.versions);
      setIndexEstimate(estimate);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "索引版本状态读取失败";
      if (!message.includes("Preload IPC")) {
        setIndexError(message);
      }
    }
  }, []);

  const loadConversations = useCallback(async (knowledgeBaseId: string) => {
    if (!knowledgeBaseId) {
      setConversations([]);
      return;
    }
    try {
      const result = await getDesktopApi().conversations.list(knowledgeBaseId);
      setConversations(result.conversations);
      setChatError("");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "对话列表读取失败";
      if (!message.includes("Preload IPC")) {
        setChatError(message);
      }
    }
  }, []);

  const openAgentRunTrace = useCallback(
    async (
      runId: string,
      expand?: boolean,
      expectedKnowledgeBaseId?: string,
    ) => {
      try {
        const response = await getDesktopApi().agentRuns.get(runId);
        if (
          expectedKnowledgeBaseId &&
          response.run.knowledgeBaseId !== expectedKnowledgeBaseId
        ) {
          return;
        }
        setAgentRunTrace(response);
        setAgentRuns((items) => upsertAgentRun(items, response.run));
        setAgentTraceError("");
        if (expand !== undefined) {
          setAgentTraceExpanded(expand);
        } else {
          setAgentTraceExpanded(!isAgentRunFinished(response.run.status));
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "AgentRun Trace 读取失败";
        if (!message.includes("Preload IPC")) {
          setAgentTraceError(message);
        }
      }
    },
    [],
  );

  const loadAgentRuns = useCallback(
    async (knowledgeBaseId: string) => {
      if (!knowledgeBaseId) {
        setAgentRuns([]);
        setAgentRunTrace(null);
        return;
      }
      try {
        const result = await getDesktopApi().agentRuns.list(knowledgeBaseId, {
          includeTerminal: true,
          limit: 8,
        });
        setAgentRuns(result.runs);
        setAgentTraceError("");
        const active =
          result.runs.find((run) => !isAgentRunFinished(run.status)) ??
          result.runs[0];
        if (active) {
          await openAgentRunTrace(active.id, undefined, knowledgeBaseId);
        } else {
          setAgentRunTrace(null);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "AgentRun 列表读取失败";
        if (!message.includes("Preload IPC")) {
          setAgentTraceError(message);
        }
      }
    },
    [openAgentRunTrace],
  );

  useEffect(() => {
    void checkHealth();
    void loadSeedStatus();
    void loadJobs();
    void loadKnowledgeBases();
  }, [checkHealth, loadJobs, loadKnowledgeBases, loadSeedStatus]);

  useEffect(() => {
    if (!activeKnowledgeBaseId) {
      return;
    }
    void loadConversations(activeKnowledgeBaseId);
    void loadParseChecks(activeKnowledgeBaseId);
    void loadIndexStatus(activeKnowledgeBaseId);
    void loadIndexLifecycle(activeKnowledgeBaseId);
    void loadAgentRuns(activeKnowledgeBaseId);
  }, [
    activeKnowledgeBaseId,
    loadAgentRuns,
    loadConversations,
    loadIndexStatus,
    loadIndexLifecycle,
    loadParseChecks,
  ]);

  useEffect(() => {
    setWritingOpen(false);
    setWritingProjects([]);
    setWritingProject(null);
    setWritingSelectedSectionId("");
    setWritingDrafts({});
    setWritingError("");
    setWritingNotice("");
  }, [activeKnowledgeBaseId]);

  useEffect(() => {
    if (settingsOpen) {
      void loadOperationalStatus(activeKnowledgeBaseId);
    }
  }, [activeKnowledgeBaseId, loadOperationalStatus, settingsOpen]);

  const online = worker.kind === "online";

  useEffect(() => {
    if (!online || !activeKnowledgeBaseId || chatBusy) {
      return;
    }
    const timer = window.setInterval(() => {
      void loadJobs();
      void loadParseChecks(activeKnowledgeBaseId);
      void loadIndexStatus(activeKnowledgeBaseId);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [
    activeKnowledgeBaseId,
    loadIndexStatus,
    loadJobs,
    loadParseChecks,
    online,
    chatBusy,
  ]);

  useEffect(() => {
    if (!activeKnowledgeBaseId) {
      return;
    }
    try {
      return getDesktopApi().agentRuns.onTraceEvent((event) => {
        setAgentRunTrace((current) =>
          current?.run.id === event.runId
            ? { ...current, events: upsertAgentRunEvent(current.events, event) }
            : current,
        );
        void openAgentRunTrace(event.runId, undefined, activeKnowledgeBaseId);
      });
    } catch {
      return undefined;
    }
  }, [activeKnowledgeBaseId, openAgentRunTrace]);

  useEffect(() => {
    if (!online || !activeKnowledgeBaseId) {
      return;
    }
    const check = async (): Promise<void> => {
      try {
        const result = await getDesktopApi().sources.checkWebAll(
          activeKnowledgeBaseId,
          true,
        );
        if (result.changed > 0) {
          await loadSources(activeKnowledgeBaseId);
        }
      } catch {
        // Automatic checks stay silent; manual checks expose actionable errors.
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 15 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [activeKnowledgeBaseId, loadSources, online]);

  const activeKnowledgeBase =
    knowledgeBases.find((item) => item.id === activeKnowledgeBaseId) ??
    knowledgeBases[0];
  const selectedCount = selectedSourceIds.length;
  const sourceSummary =
    activeKnowledgeBase?.summary ?? emptyKnowledgeBaseSummary();
  const focusedSourceId = evidenceSourceId(selectedEvidence);
  const hasStartedConversation = messages.length > 0 || chatBusy;

  const toggleSource = (id: string): void => {
    setSelectedSourceIds((items) =>
      items.includes(id) ? items.filter((item) => item !== id) : [...items, id],
    );
  };

  const resetConversationWorkspace = (): void => {
    setConversationId(null);
    setMessages([]);
    setAnswerResponses({});
    setSelectedEvidence(null);
    setSourceJumpNotice("");
    setChatError("");
    setExportNotice("");
    setSearchQuery("");
    setLastSearchQuery("");
    setSearchResults([]);
    setSearchError("");
  };

  const exportMarkdown = async (messageId?: string): Promise<void> => {
    if (!conversationId || exportBusyId) {
      return;
    }
    setExportBusyId(messageId ?? "conversation");
    setChatError("");
    setExportNotice("");
    try {
      const result = await getDesktopApi().conversations.exportMarkdown(
        conversationId,
        messageId,
      );
      if (!result.cancelled) {
        setExportNotice(
          messageId ? "回答已导出为 Markdown" : "对话已导出为 Markdown",
        );
      }
    } catch (error) {
      setChatError(
        error instanceof Error ? error.message : "Markdown 导出失败",
      );
    } finally {
      setExportBusyId("");
    }
  };

  const cleanupStorage = async (): Promise<void> => {
    if (maintenanceBusy) {
      return;
    }
    setMaintenanceBusy(true);
    setMaintenanceNotice("");
    try {
      const result = await getDesktopApi().system.cleanupStorage();
      setMaintenanceStatus(result);
      setMaintenanceNotice(
        `已回收 ${result.recycledIndexCount ?? 0} 个索引、${result.removedFileCount ?? 0} 个孤儿文件`,
      );
    } catch (error) {
      setMaintenanceNotice(
        error instanceof Error ? error.message : "应用数据清理失败",
      );
    } finally {
      setMaintenanceBusy(false);
    }
  };

  const startNewConversation = (): void => {
    setConversationMenuOpen(false);
    resetConversationWorkspace();
    setQuery("");
    setChatModel(
      seedStatus?.defaultChatModel ?? SEED_DEFAULTS.defaultChatModel,
    );
  };

  const openConversation = async (
    targetConversationId: string,
  ): Promise<void> => {
    setConversationMenuOpen(false);
    setChatBusy(true);
    setChatError("");
    try {
      const result =
        await getDesktopApi().conversations.messages(targetConversationId);
      setConversationId(result.conversation.id);
      setChatModel(
        result.conversation.modelId ??
          seedStatus?.defaultChatModel ??
          SEED_DEFAULTS.defaultChatModel,
      );
      setMessages(result.messages);
      setAnswerResponses({});
      setSelectedEvidence(null);
      setSourceJumpNotice("");
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "对话读取失败");
    } finally {
      setChatBusy(false);
    }
  };

  const deleteConversation = async (
    conversation: ConversationRecord,
  ): Promise<void> => {
    setConversationDeleteBusyId(conversation.id);
    setConfirmError("");
    try {
      const result = await getDesktopApi().conversations.delete(
        conversation.id,
      );
      setConversations(result.conversations);
      setKnowledgeBases((items) =>
        items.map((item) =>
          item.id === result.knowledgeBaseId
            ? {
                ...item,
                summary: {
                  ...item.summary,
                  conversationCount: result.conversations.length,
                },
              }
            : item,
        ),
      );
      if (conversationId === conversation.id) {
        resetConversationWorkspace();
        setQuery("");
        setChatModel(
          seedStatus?.defaultChatModel ?? SEED_DEFAULTS.defaultChatModel,
        );
      }
      setConversationMenuOpen(false);
      setConfirmAction(null);
    } catch (error) {
      setConfirmError(
        error instanceof Error ? error.message : "历史对话删除失败",
      );
    } finally {
      setConversationDeleteBusyId("");
    }
  };

  const runSearch = async (): Promise<void> => {
    const value = searchQuery.trim();
    if (!value || searchBusy) {
      return;
    }
    if (!activeKnowledgeBaseId) {
      setSearchError("请先选择知识库");
      return;
    }
    setSearchBusy(true);
    setSearchError("");
    try {
      const response = await getDesktopApi().retrieval.hybridSearch({
        knowledgeBaseId: activeKnowledgeBaseId,
        query: value,
        limit: 8,
        candidateLimit: 24,
      });
      setLastSearchQuery(value);
      setSearchResults(response.results);
      if (response.results.length === 0) {
        setSearchError("当前知识库没有检索到可引用片段");
      }
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "资料搜索失败");
    } finally {
      setSearchBusy(false);
    }
  };

  const selectCitation = (
    citation: AnswerCitation,
    response?: ConversationAnswerResponse,
    citationNumber?: number,
  ): void => {
    setSelectedEvidence({
      kind: "citation",
      citation,
      citationNumber,
      response,
      retrievalResult: response
        ? retrievalResultForCitation(response, citation)
        : undefined,
    });
    setSourceJumpNotice("");
    setEvidenceOpen(true);
  };

  const selectSearchResult = (result: HybridSearchResult): void => {
    setSelectedEvidence({ kind: "search", result });
    setSourceJumpNotice("");
    setEvidenceOpen(true);
  };

  const focusEvidenceSource = (selection: EvidenceSelection): void => {
    const sourceId = evidenceSourceId(selection);
    if (!sourceId) {
      return;
    }
    setSelectedSourceIds((items) =>
      items.includes(sourceId) ? items : [...items, sourceId],
    );
    setSourceJumpNotice(
      `已定位到来源列表：${evidenceDisplayName(selection)} · ${evidenceLocationLabel(selection)}`,
    );
    window.requestAnimationFrame(() => {
      document
        .getElementById(`source-${sourceId}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  };

  const submitQuestion = async (): Promise<void> => {
    const value = query.trim();
    if (!value || chatBusy) {
      return;
    }
    if (!activeKnowledgeBaseId) {
      setChatError("请先选择知识库");
      return;
    }
    if (!seedStatus?.configured) {
      setChatError("请先在设置中配置 Ark API Key");
      return;
    }
    setChatBusy(true);
    setChatError("");
    setQuery("");
    setSearchQuery("");
    setLastSearchQuery("");
    setSearchResults([]);
    setSearchError("");
    setSelectedEvidence(null);
    setSourceJumpNotice("");
    const pendingRequestId = createPendingMessageId();
    const pendingConversationId = conversationId ?? PENDING_CONVERSATION_ID;
    const createdAt = new Date().toISOString();
    const pendingUserMessage: ConversationMessageRecord = {
      id: `${PENDING_USER_MESSAGE_PREFIX}${pendingRequestId}`,
      conversationId: pendingConversationId,
      role: "user",
      content: value,
      modelId: null,
      modelParams: {},
      indexVersionId: null,
      createdAt,
      citations: [],
    };
    const pendingAssistantMessage: ConversationMessageRecord = {
      id: `${PENDING_ASSISTANT_MESSAGE_PREFIX}${pendingRequestId}`,
      conversationId: pendingConversationId,
      role: "assistant",
      content: "",
      modelId: chatModel,
      modelParams: {},
      indexVersionId: null,
      createdAt,
      citations: [],
    };
    setMessages((items) => [
      ...items,
      pendingUserMessage,
      pendingAssistantMessage,
    ]);
    try {
      const response = await getDesktopApi().conversations.answer({
        knowledgeBaseId: activeKnowledgeBaseId,
        query: value,
        conversationId,
        chatModel,
        limit: 8,
        candidateLimit: 24,
      });
      setConversationId(response.conversation.id);
      setConversations((items) =>
        upsertConversation(items, response.conversation),
      );
      setMessages((items) =>
        uniqueMessages(
          items.map((message) => {
            if (message.id === pendingUserMessage.id) {
              return response.userMessage;
            }
            if (message.id === pendingAssistantMessage.id) {
              return response.assistantMessage;
            }
            return message;
          }),
        ),
      );
      setAnswerResponses((items) => ({
        ...items,
        [response.assistantMessage.id]: response,
      }));
      if (response.citations[0]) {
        selectCitation(response.citations[0], response, 1);
      } else {
        setSelectedEvidence(null);
        setSourceJumpNotice("");
      }
    } catch (error) {
      setMessages((items) =>
        items.filter((message) => message.id !== pendingAssistantMessage.id),
      );
      setQuery(value);
      setChatError(error instanceof Error ? error.message : "回答生成失败");
    } finally {
      setChatBusy(false);
    }
  };

  const switchKnowledgeBase = async (
    knowledgeBaseId: string,
  ): Promise<void> => {
    setActiveKnowledgeBaseId(knowledgeBaseId);
    setKnowledgeBaseMenuOpen(false);
    setConversationMenuOpen(false);
    setKnowledgeBaseError("");
    resetConversationWorkspace();
    setSearchResults([]);
    setLastSearchQuery("");
    setSearchError("");
    try {
      await loadSources(knowledgeBaseId);
      await loadConversations(knowledgeBaseId);
    } catch (error) {
      setKnowledgeBaseError(
        error instanceof Error ? error.message : "知识库切换失败",
      );
    }
  };

  const openKnowledgeBaseDialog = (mode: KnowledgeBaseDialogMode): void => {
    setKnowledgeBaseMenuOpen(false);
    setKnowledgeBaseError("");
    setKnowledgeBaseDialog(mode);
    if (mode === "create") {
      setKnowledgeBaseForm({
        name: "新的知识库",
        description: "",
        confirmName: "",
      });
      return;
    }
    setKnowledgeBaseForm({
      name: activeKnowledgeBase?.name ?? "",
      description: activeKnowledgeBase?.description ?? "",
      confirmName: "",
    });
  };

  const submitKnowledgeBaseDialog = async (): Promise<void> => {
    setKnowledgeBaseBusy(true);
    setKnowledgeBaseError("");
    try {
      if (knowledgeBaseDialog === "create") {
        const created = await getDesktopApi().knowledgeBases.create({
          name: knowledgeBaseForm.name,
          description: knowledgeBaseForm.description || null,
        });
        setKnowledgeBaseDialog(null);
        resetConversationWorkspace();
        setSearchResults([]);
        setLastSearchQuery("");
        await loadKnowledgeBases(created.id);
      }
      if (
        knowledgeBaseDialog === "rename" &&
        activeKnowledgeBase &&
        activeKnowledgeBaseId
      ) {
        const renamed = await getDesktopApi().knowledgeBases.rename({
          knowledgeBaseId: activeKnowledgeBaseId,
          name: knowledgeBaseForm.name,
          description: knowledgeBaseForm.description || null,
        });
        setKnowledgeBaseDialog(null);
        await loadKnowledgeBases(renamed.id);
      }
      if (
        knowledgeBaseDialog === "delete" &&
        activeKnowledgeBase &&
        activeKnowledgeBaseId
      ) {
        if (knowledgeBaseForm.confirmName !== activeKnowledgeBase.name) {
          throw new Error("请输入完整知识库名称以确认删除");
        }
        const result = await getDesktopApi().knowledgeBases.delete(
          activeKnowledgeBaseId,
        );
        const next = result.knowledgeBases[0];
        setKnowledgeBaseDialog(null);
        setKnowledgeBases(result.knowledgeBases);
        setActiveKnowledgeBaseId(next?.id ?? "");
        resetConversationWorkspace();
        setSearchResults([]);
        setLastSearchQuery("");
        if (next) {
          await loadSources(next.id);
        } else {
          setSources([]);
          setSelectedSourceIds([]);
        }
      }
    } catch (error) {
      setKnowledgeBaseError(
        error instanceof Error ? error.message : "知识库操作失败",
      );
    } finally {
      setKnowledgeBaseBusy(false);
    }
  };

  const handleJobAction = async (
    jobId: string,
    action: "pause" | "resume" | "cancel" | "retry" | "recover",
  ): Promise<void> => {
    setJobBusyId(action === "recover" ? "recover" : jobId);
    setJobError("");
    try {
      if (action === "pause") {
        await getDesktopApi().jobs.pause(jobId);
      }
      if (action === "resume") {
        await getDesktopApi().jobs.resume(jobId);
      }
      if (action === "cancel") {
        await getDesktopApi().jobs.cancel(jobId);
      }
      if (action === "retry") {
        await getDesktopApi().jobs.retry(jobId);
      }
      if (action === "recover") {
        await getDesktopApi().jobs.recover();
      }
      await loadJobs();
    } catch (error) {
      setJobError(error instanceof Error ? error.message : "任务操作失败");
    } finally {
      setJobBusyId("");
    }
  };

  const handleAgentRunAction = async (
    runId: string,
    action: "resume" | "cancel" | "retry",
  ): Promise<void> => {
    setAgentTraceBusyId(`${action}:${runId}`);
    setAgentTraceError("");
    try {
      const response =
        action === "resume"
          ? await getDesktopApi().agentRuns.resume(runId)
          : action === "retry"
            ? await getDesktopApi().agentRuns.retry(runId)
            : await getDesktopApi().agentRuns.cancel(
                runId,
                "user_cancelled_from_trace",
              );
      setAgentRunTrace(response);
      setAgentRuns((items) => upsertAgentRun(items, response.run));
      setAgentTraceExpanded(!isAgentRunFinished(response.run.status));
    } catch (error) {
      setAgentTraceError(
        error instanceof Error ? error.message : "AgentRun 操作失败",
      );
    } finally {
      setAgentTraceBusyId("");
    }
  };

  const refreshImportState = async (knowledgeBaseId: string): Promise<void> => {
    await Promise.all([
      loadSources(knowledgeBaseId),
      loadJobs(),
      loadParseChecks(knowledgeBaseId),
      loadIndexStatus(knowledgeBaseId),
      loadIndexLifecycle(knowledgeBaseId),
    ]);
  };

  const importFiles = async (): Promise<void> => {
    if (!activeKnowledgeBaseId) {
      setImportError("请先选择知识库");
      return;
    }
    setImportBusy(true);
    setImportError("");
    try {
      const result = await getDesktopApi().sources.importFiles(
        activeKnowledgeBaseId,
      );
      if (!result.cancelled) {
        await refreshImportState(activeKnowledgeBaseId);
      }
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "文件导入失败");
    } finally {
      setImportBusy(false);
    }
  };

  const importWebSource = async (): Promise<void> => {
    if (!activeKnowledgeBaseId) {
      setImportError("请先选择知识库");
      return;
    }
    setImportBusy(true);
    setImportError("");
    try {
      await getDesktopApi().sources.importWeb({
        knowledgeBaseId: activeKnowledgeBaseId,
        url: webImportForm.url,
        displayName: webImportForm.displayName || null,
      });
      setWebImportOpen(false);
      setWebImportForm({ url: "", displayName: "" });
      await refreshImportState(activeKnowledgeBaseId);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "网页导入失败");
    } finally {
      setImportBusy(false);
    }
  };

  const buildIndex = async (): Promise<void> => {
    if (!activeKnowledgeBaseId) {
      setIndexError("请先选择知识库");
      return;
    }
    setIndexBusy(true);
    setIndexError("");
    try {
      const result = await getDesktopApi().indexes.build(activeKnowledgeBaseId);
      setIndexStatus(result);
      await refreshImportState(activeKnowledgeBaseId);
    } catch (error) {
      setIndexError(error instanceof Error ? error.message : "索引构建失败");
    } finally {
      setIndexBusy(false);
    }
  };

  const deleteSource = async (source: KnowledgeBaseSource): Promise<void> => {
    setSourceDeleteBusyId(source.id);
    setConfirmError("");
    setImportError("");
    try {
      await getDesktopApi().sources.delete(source.id);
      setSelectedSourceIds((items) =>
        items.filter((sourceId) => sourceId !== source.id),
      );
      setSearchResults((items) =>
        items.filter((result) => result.source.id !== source.id),
      );
      setMessages((items) =>
        items.map((message) => ({
          ...message,
          citations: message.citations.filter(
            (citation) => citation.source.id !== source.id,
          ),
        })),
      );
      setAnswerResponses({});
      if (evidenceSourceId(selectedEvidence) === source.id) {
        setSelectedEvidence(null);
        setSourceJumpNotice("");
      }
      if (activeKnowledgeBaseId) {
        await refreshImportState(activeKnowledgeBaseId);
      }
      setConfirmAction(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "来源删除失败";
      setConfirmError(message);
      setImportError(message);
    } finally {
      setSourceDeleteBusyId("");
    }
  };

  const openSourceMaintenance = async (
    source: KnowledgeBaseSource,
  ): Promise<void> => {
    setSourceMaintenanceBusy(true);
    setSourceMaintenanceError("");
    setSourceVersionDiff(null);
    try {
      const [result, organization] = await Promise.all([
        getDesktopApi().sources.versions(source.id),
        getDesktopApi().sources.organization(source.id),
      ]);
      setSourceMaintenance(result);
      setSourceOrganization(organization);
      setSourceTagDrafts(
        Object.fromEntries(organization.tags.map((tag) => [tag.id, tag.tag])),
      );
      setSourceMaintenanceForm({
        replacementSourceId: result.source.replacementSourceId ?? "",
        reviewAt: toLocalDateTime(result.source.reviewAt),
        expiryStatus: result.source.expiryStatus,
      });
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "来源版本读取失败",
      );
    } finally {
      setSourceMaintenanceBusy(false);
    }
  };

  const classifySource = async (): Promise<void> => {
    if (!sourceMaintenance) {
      return;
    }
    setSourceMaintenanceBusy(true);
    setSourceMaintenanceError("");
    try {
      setSourceOrganization(
        await getDesktopApi().sources.classify(sourceMaintenance.source.id),
      );
    } catch (error) {
      setSourceMaintenanceError(
        error instanceof Error ? error.message : "来源规则分类失败",
      );
    } finally {
      setSourceMaintenanceBusy(false);
    }
  };

  const suggestSourceTags = async (): Promise<void> => {
    if (!sourceMaintenance) {
      return;
    }
    setSourceMaintenanceBusy(true);
    setSourceMaintenanceError("");
    try {
      const organization = await getDesktopApi().sources.suggestTags(
        sourceMaintenance.source.id,
      );
      setSourceOrganization(organization);
      setSourceTagDrafts(
        Object.fromEntries(organization.tags.map((tag) => [tag.id, tag.tag])),
      );
    } catch (error) {
      setSourceMaintenanceError(
        error instanceof Error ? error.message : "主题标签建议生成失败",
      );
    } finally {
      setSourceMaintenanceBusy(false);
    }
  };

  const decideSourceTag = async (
    tagId: string,
    decision: "confirm" | "dismiss",
  ): Promise<void> => {
    if (!sourceMaintenance) {
      return;
    }
    setSourceMaintenanceBusy(true);
    setSourceMaintenanceError("");
    try {
      const organization = await getDesktopApi().sources.decideTag({
        sourceId: sourceMaintenance.source.id,
        tagId,
        decision,
        correctedTag: decision === "confirm" ? sourceTagDrafts[tagId] : null,
      });
      setSourceOrganization(organization);
      setSourceTagDrafts(
        Object.fromEntries(organization.tags.map((tag) => [tag.id, tag.tag])),
      );
    } catch (error) {
      setSourceMaintenanceError(
        error instanceof Error ? error.message : "主题标签处理失败",
      );
    } finally {
      setSourceMaintenanceBusy(false);
    }
  };

  const decideSourceRelation = async (
    relationId: string,
    decision: "confirm" | "dismiss",
  ): Promise<void> => {
    if (!sourceMaintenance) {
      return;
    }
    setSourceMaintenanceBusy(true);
    setSourceMaintenanceError("");
    try {
      setSourceOrganization(
        await getDesktopApi().sources.decideRelation({
          sourceId: sourceMaintenance.source.id,
          relationId,
          decision,
        }),
      );
    } catch (error) {
      setSourceMaintenanceError(
        error instanceof Error ? error.message : "来源关联处理失败",
      );
    } finally {
      setSourceMaintenanceBusy(false);
    }
  };

  const checkSourceUpdate = async (): Promise<void> => {
    if (!sourceMaintenance) {
      return;
    }
    setSourceMaintenanceBusy(true);
    setSourceMaintenanceError("");
    try {
      await getDesktopApi().sources.checkWeb(sourceMaintenance.source.id);
      setSourceMaintenance(
        await getDesktopApi().sources.versions(sourceMaintenance.source.id),
      );
      if (activeKnowledgeBaseId) {
        await loadSources(activeKnowledgeBaseId);
      }
    } catch (error) {
      setSourceMaintenanceError(
        error instanceof Error ? error.message : "网页更新检查失败",
      );
    } finally {
      setSourceMaintenanceBusy(false);
    }
  };

  const inspectSourceVersionDiff = async (versionId: string): Promise<void> => {
    if (!sourceMaintenance) {
      return;
    }
    setSourceMaintenanceBusy(true);
    setSourceMaintenanceError("");
    try {
      setSourceVersionDiff(
        await getDesktopApi().sources.versionDiff(
          sourceMaintenance.source.id,
          versionId,
        ),
      );
    } catch (error) {
      setSourceMaintenanceError(
        error instanceof Error ? error.message : "版本差异读取失败",
      );
    } finally {
      setSourceMaintenanceBusy(false);
    }
  };

  const decideSourceVersion = async (
    versionId: string,
    decision: "accept" | "reject",
    rebuild: boolean,
  ): Promise<void> => {
    if (!sourceMaintenance) {
      return;
    }
    setSourceMaintenanceBusy(true);
    setSourceMaintenanceError("");
    try {
      setSourceMaintenance(
        await getDesktopApi().sources.decideVersion({
          sourceId: sourceMaintenance.source.id,
          versionId,
          decision,
        }),
      );
      setSourceVersionDiff(null);
      if (rebuild && activeKnowledgeBaseId) {
        setIndexStatus(
          await getDesktopApi().indexes.rebuild(activeKnowledgeBaseId),
        );
      }
      if (activeKnowledgeBaseId) {
        await refreshImportState(activeKnowledgeBaseId);
      }
    } catch (error) {
      setSourceMaintenanceError(
        error instanceof Error ? error.message : "来源版本处理失败",
      );
    } finally {
      setSourceMaintenanceBusy(false);
    }
  };

  const saveSourceMaintenance = async (): Promise<void> => {
    if (!sourceMaintenance) {
      return;
    }
    setSourceMaintenanceBusy(true);
    setSourceMaintenanceError("");
    try {
      setSourceMaintenance(
        await getDesktopApi().sources.updateMaintenance({
          sourceId: sourceMaintenance.source.id,
          replacementSourceId:
            sourceMaintenanceForm.replacementSourceId || null,
          reviewAt: fromLocalDateTime(sourceMaintenanceForm.reviewAt),
          expiryStatus: sourceMaintenanceForm.expiryStatus,
        }),
      );
      if (activeKnowledgeBaseId) {
        await loadSources(activeKnowledgeBaseId);
      }
    } catch (error) {
      setSourceMaintenanceError(
        error instanceof Error ? error.message : "来源维护设置保存失败",
      );
    } finally {
      setSourceMaintenanceBusy(false);
    }
  };

  const decideSourceSuggestion = async (
    decision: "accept" | "dismiss",
  ): Promise<void> => {
    if (!sourceMaintenance) {
      return;
    }
    setSourceMaintenanceBusy(true);
    try {
      setSourceMaintenance(
        await getDesktopApi().sources.decideSuggestion(
          sourceMaintenance.source.id,
          decision,
        ),
      );
      if (activeKnowledgeBaseId) {
        await loadSources(activeKnowledgeBaseId);
      }
    } catch (error) {
      setSourceMaintenanceError(
        error instanceof Error ? error.message : "来源建议处理失败",
      );
    } finally {
      setSourceMaintenanceBusy(false);
    }
  };

  const resolveDuplicate = async (
    sourceId: string,
    action: DuplicateAction,
  ): Promise<void> => {
    if (!activeKnowledgeBaseId) {
      return;
    }
    setDuplicateBusyId(sourceId);
    setImportError("");
    try {
      await getDesktopApi().sources.resolveDuplicate({ sourceId, action });
      await refreshImportState(activeKnowledgeBaseId);
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "重复来源处理失败",
      );
    } finally {
      setDuplicateBusyId("");
    }
  };

  const deleteIndex = async (): Promise<void> => {
    if (!activeKnowledgeBaseId) {
      setConfirmError("请先选择知识库");
      return;
    }
    setIndexBusy(true);
    setIndexError("");
    setConfirmError("");
    try {
      setIndexStatus(
        await getDesktopApi().indexes.delete(activeKnowledgeBaseId),
      );
      setSearchResults([]);
      setLastSearchQuery("");
      setSelectedEvidence(null);
      setSourceJumpNotice("");
      await refreshImportState(activeKnowledgeBaseId);
      setConfirmAction(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "索引删除失败";
      setConfirmError(message);
      setIndexError(message);
    } finally {
      setIndexBusy(false);
    }
  };

  const rebuildIndex = async (): Promise<void> => {
    if (!activeKnowledgeBaseId) {
      setConfirmError("请先选择知识库");
      return;
    }
    setIndexBusy(true);
    setIndexError("");
    setConfirmError("");
    try {
      setIndexStatus(
        await getDesktopApi().indexes.rebuild(activeKnowledgeBaseId),
      );
      setSearchResults([]);
      setLastSearchQuery("");
      setSelectedEvidence(null);
      setSourceJumpNotice("");
      await refreshImportState(activeKnowledgeBaseId);
      setConfirmAction(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "索引重构失败";
      setConfirmError(message);
      setIndexError(message);
    } finally {
      setIndexBusy(false);
    }
  };

  const rollbackIndex = async (indexVersionId: string): Promise<void> => {
    if (!activeKnowledgeBaseId) {
      return;
    }
    setIndexBusy(true);
    setIndexError("");
    try {
      setIndexStatus(
        await getDesktopApi().indexes.rollback(
          activeKnowledgeBaseId,
          indexVersionId,
        ),
      );
      await refreshImportState(activeKnowledgeBaseId);
    } catch (error) {
      setIndexError(error instanceof Error ? error.message : "索引回滚失败");
    } finally {
      setIndexBusy(false);
    }
  };

  const retryIndex = async (indexVersionId: string): Promise<void> => {
    if (!activeKnowledgeBaseId) {
      return;
    }
    setIndexBusy(true);
    setIndexError("");
    try {
      setIndexStatus(
        await getDesktopApi().indexes.retry(
          activeKnowledgeBaseId,
          indexVersionId,
        ),
      );
      await refreshImportState(activeKnowledgeBaseId);
    } catch (error) {
      setIndexError(error instanceof Error ? error.message : "索引重试失败");
    } finally {
      setIndexBusy(false);
    }
  };

  const changeChatModel = async (modelId: string): Promise<void> => {
    setChatModel(modelId);
    if (!conversationId) {
      return;
    }
    try {
      const conversation = await getDesktopApi().conversations.setModel(
        conversationId,
        modelId,
      );
      setConversations((items) => upsertConversation(items, conversation));
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "对话模型切换失败");
    }
  };

  const submitConfirmAction = async (): Promise<void> => {
    if (confirmAction?.kind === "delete-source") {
      await deleteSource(confirmAction.source);
      return;
    }
    if (confirmAction?.kind === "delete-conversation") {
      await deleteConversation(confirmAction.conversation);
      return;
    }
    if (confirmAction?.kind === "delete-index") {
      await deleteIndex();
      return;
    }
    if (confirmAction?.kind === "rebuild-index") {
      await rebuildIndex();
    }
  };

  const saveSeedCredential = async (): Promise<void> => {
    setSeedBusy(true);
    setSeedError("");
    try {
      const status = await getDesktopApi().seed.saveCredential(seedForm);
      setSeedStatus(status);
      setSeedForm((form) => ({ ...form, apiKey: "" }));
    } catch (error) {
      setSeedError(
        error instanceof Error ? error.message : "Seed API 保存失败",
      );
    } finally {
      setSeedBusy(false);
    }
  };

  const validateSeedCredential = async (): Promise<void> => {
    setSeedBusy(true);
    setSeedError("");
    try {
      setSeedStatus(await getDesktopApi().seed.validateCredential());
    } catch (error) {
      setSeedError(
        error instanceof Error ? error.message : "Seed API 验证失败",
      );
    } finally {
      setSeedBusy(false);
    }
  };

  const updateSeedDefaults = async (): Promise<void> => {
    setSeedBusy(true);
    setSeedError("");
    try {
      const status = await getDesktopApi().seed.updateDefaults({
        defaultChatModel: seedForm.defaultChatModel,
        defaultEmbeddingModel: seedForm.defaultEmbeddingModel,
      });
      setSeedStatus(status);
      if (!conversationId) {
        setChatModel(status.defaultChatModel);
      }
      if (activeKnowledgeBaseId) {
        await loadIndexLifecycle(activeKnowledgeBaseId);
      }
    } catch (error) {
      setSeedError(error instanceof Error ? error.message : "默认模型保存失败");
    } finally {
      setSeedBusy(false);
    }
  };

  const deleteSeedCredential = async (): Promise<void> => {
    setSeedBusy(true);
    setSeedError("");
    try {
      setSeedStatus(await getDesktopApi().seed.deleteCredential());
      setSeedForm({
        name: "我的 Seed API",
        apiKey: "",
        defaultChatModel: SEED_DEFAULTS.defaultChatModel,
        defaultEmbeddingModel: SEED_DEFAULTS.defaultEmbeddingModel,
      });
    } catch (error) {
      setSeedError(
        error instanceof Error ? error.message : "Seed API 删除失败",
      );
    } finally {
      setSeedBusy(false);
    }
  };

  const syncWritingProject = (value: WritingProjectResponse): void => {
    setWritingProject(value);
    setWritingProjects((items) => upsertWritingProject(items, value.project));
    setWritingSelectedSectionId((current) =>
      value.sections.some((section) => section.id === current)
        ? current
        : (value.sections[0]?.id ?? ""),
    );
    setWritingDrafts(
      Object.fromEntries(
        value.sections.map((section) => [section.id, section.content]),
      ),
    );
  };

  const openWritingWorkspace = async (): Promise<void> => {
    if (!activeKnowledgeBaseId) {
      setWritingError("请先选择知识库");
      setWritingOpen(true);
      return;
    }
    setWritingOpen(true);
    setWritingBusy(true);
    setWritingError("");
    setWritingNotice("");
    try {
      const result = await getDesktopApi().writing.list(activeKnowledgeBaseId);
      setWritingProjects(result.projects);
      if (result.projects[0]) {
        syncWritingProject(
          await getDesktopApi().writing.project(result.projects[0].id),
        );
      } else {
        setWritingProject(null);
        setWritingSelectedSectionId("");
        setWritingDrafts({});
      }
    } catch (error) {
      setWritingError(
        error instanceof Error ? error.message : "写作工作区读取失败",
      );
    } finally {
      setWritingBusy(false);
    }
  };

  const openWritingProject = async (projectId: string): Promise<void> => {
    setWritingBusy(true);
    setWritingError("");
    setWritingNotice("");
    try {
      syncWritingProject(await getDesktopApi().writing.project(projectId));
    } catch (error) {
      setWritingError(
        error instanceof Error ? error.message : "写作项目读取失败",
      );
    } finally {
      setWritingBusy(false);
    }
  };

  const createWritingProject = async (): Promise<void> => {
    if (!activeKnowledgeBaseId || !writingGoal.trim()) {
      setWritingError("请输入写作或复习目标");
      return;
    }
    setWritingBusy(true);
    setWritingError("");
    setWritingNotice("");
    try {
      syncWritingProject(
        await getDesktopApi().writing.create({
          knowledgeBaseId: activeKnowledgeBaseId,
          goal: writingGoal.trim(),
          workflowType: writingWorkflowType,
        }),
      );
      setWritingGoal("");
      setWritingNotice("已生成基于当前知识库证据的大纲");
    } catch (error) {
      setWritingError(
        error instanceof Error ? error.message : "写作大纲生成失败",
      );
    } finally {
      setWritingBusy(false);
    }
  };

  const runWritingSection = async (
    sectionId?: string,
    revise = false,
  ): Promise<void> => {
    if (!writingProject) {
      return;
    }
    setWritingBusy(true);
    setWritingError("");
    setWritingNotice("");
    try {
      syncWritingProject(
        await getDesktopApi().writing.runSection({
          projectId: writingProject.project.id,
          sectionId,
          revise,
        }),
      );
      setWritingNotice(
        revise
          ? "已根据检查结果生成修订内容"
          : "分节写作完成，引用与冲突检查已同步更新",
      );
    } catch (error) {
      setWritingError(error instanceof Error ? error.message : "分节写作失败");
    } finally {
      setWritingBusy(false);
    }
  };

  const saveWritingSection = async (sectionId: string): Promise<void> => {
    setWritingBusy(true);
    setWritingError("");
    setWritingNotice("");
    try {
      await getDesktopApi().writing.updateSection(
        sectionId,
        writingDrafts[sectionId] ?? "",
      );
      syncWritingProject(await getDesktopApi().writing.auditSection(sectionId));
      setWritingNotice("章节内容已保存并重新检查引用");
    } catch (error) {
      setWritingError(error instanceof Error ? error.message : "章节保存失败");
    } finally {
      setWritingBusy(false);
    }
  };

  const auditWritingSection = async (sectionId: string): Promise<void> => {
    setWritingBusy(true);
    setWritingError("");
    setWritingNotice("");
    try {
      syncWritingProject(await getDesktopApi().writing.auditSection(sectionId));
      setWritingNotice("引用与冲突检查已更新");
    } catch (error) {
      setWritingError(error instanceof Error ? error.message : "章节检查失败");
    } finally {
      setWritingBusy(false);
    }
  };

  const exportWritingWord = async (): Promise<void> => {
    if (!writingProject) {
      return;
    }
    setWritingBusy(true);
    setWritingError("");
    setWritingNotice("");
    try {
      const result = await getDesktopApi().writing.exportWord(
        writingProject.project.id,
      );
      setWritingNotice(
        result.cancelled
          ? "已取消导出"
          : `Word 文档已导出到 ${result.filePath ?? "所选位置"}`,
      );
    } catch (error) {
      setWritingError(error instanceof Error ? error.message : "Word 导出失败");
    } finally {
      setWritingBusy(false);
    }
  };

  return (
    <main className={`app-shell ${evidenceOpen ? "" : "evidence-collapsed"}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="sparkle" size={20} />
          </span>
          <span className="brand-name">citeMind</span>
          <span className="brand-divider" />
          <div className="notebook-menu-wrap">
            <button
              className="notebook-switcher"
              type="button"
              onClick={() => setKnowledgeBaseMenuOpen(!knowledgeBaseMenuOpen)}
            >
              {activeKnowledgeBase?.name ?? "未选择知识库"}{" "}
              <Icon name="chevron" size={15} />
            </button>
            {knowledgeBaseMenuOpen && (
              <div className="notebook-menu">
                <div className="notebook-menu-heading">
                  <strong>知识库</strong>
                  <span>{knowledgeBases.length} 个</span>
                </div>
                <div className="notebook-menu-list">
                  {knowledgeBases.map((item) => (
                    <button
                      className={
                        item.id === activeKnowledgeBaseId ? "active" : ""
                      }
                      key={item.id}
                      type="button"
                      onClick={() => void switchKnowledgeBase(item.id)}
                    >
                      <span>{item.name}</span>
                      <small>
                        {item.summary.sourceCount} 来源 ·{" "}
                        {item.summary.conversationCount} 对话
                      </small>
                    </button>
                  ))}
                </div>
                <div className="notebook-menu-actions">
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => openKnowledgeBaseDialog("create")}
                  >
                    新建
                  </button>
                  <button
                    className="text-button"
                    disabled={!activeKnowledgeBase}
                    type="button"
                    onClick={() => openKnowledgeBaseDialog("rename")}
                  >
                    重命名
                  </button>
                  <button
                    className="text-button danger-text"
                    disabled={!activeKnowledgeBase}
                    type="button"
                    onClick={() => openKnowledgeBaseDialog("delete")}
                  >
                    删除
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        <label className="global-search">
          <Icon name="search" size={17} />
          <input
            aria-label="搜索知识库"
            placeholder="关键词或自然语言搜索资料"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void runSearch();
              }
            }}
          />
          <kbd>{searchBusy ? "..." : "↵"}</kbd>
        </label>
        <div className="top-actions">
          <button
            className="button ghost"
            type="button"
            onClick={() => {
              setSettingsOpen(true);
              void loadSeedStatus();
            }}
          >
            <Icon name="settings" size={17} /> 设置
          </button>
          <button
            className="button primary"
            disabled={chatBusy}
            type="button"
            onClick={startNewConversation}
          >
            <Icon name="add" size={17} /> 新建对话
          </button>
          <button className="avatar" aria-label="账户" type="button">
            S
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="panel sources-panel">
          <PanelHeader icon="folder" title="来源资料" count={sources.length} />
          <div className="source-actions">
            <div className="source-action-row">
              <button
                className="button add-source"
                disabled={importBusy}
                type="button"
                onClick={() => void importFiles()}
              >
                <Icon name="add" /> 添加文件
              </button>
              <button
                className="button ghost"
                disabled={importBusy}
                type="button"
                onClick={() => {
                  setImportError("");
                  setWebImportOpen(true);
                }}
              >
                网页链接
              </button>
            </div>
            <label className="panel-search">
              <Icon name="search" size={16} />
              <input aria-label="筛选来源" placeholder="筛选来源" />
            </label>
          </div>
          <div className="source-toolbar">
            <span>{selectedCount} 个来源已用于对话</span>
            <button
              className="text-button"
              type="button"
              onClick={() =>
                setSelectedSourceIds(sources.map((source) => source.id))
              }
            >
              全选
            </button>
          </div>
          {knowledgeBaseError && (
            <div className="inline-error">{knowledgeBaseError}</div>
          )}
          <div className="source-list">
            {sources.length > 0 ? (
              sources.map((source) => (
                <article
                  className={`source-item ${
                    selectedSourceIds.includes(source.id) ? "selected" : ""
                  } ${focusedSourceId === source.id ? "focused" : ""}`}
                  id={`source-${source.id}`}
                  key={source.id}
                >
                  <button
                    className="source-main"
                    type="button"
                    onClick={() => toggleSource(source.id)}
                  >
                    <span className={`source-icon ${sourceTone(source)}`}>
                      <Icon name="document" size={17} />
                    </span>
                    <span className="source-copy">
                      <strong>{source.displayName}</strong>
                      <small>{sourceMeta(source)}</small>
                    </span>
                    <span className="source-check">
                      {selectedSourceIds.includes(source.id) && (
                        <Icon name="check" size={14} />
                      )}
                    </span>
                  </button>
                  <button
                    aria-label={`维护来源版本 ${source.displayName}`}
                    className="source-maintenance"
                    disabled={sourceMaintenanceBusy}
                    title="版本与时效维护"
                    type="button"
                    onClick={() => void openSourceMaintenance(source)}
                  >
                    <Icon name="refresh" size={15} />
                  </button>
                  <button
                    aria-label={`删除来源 ${source.displayName}`}
                    className="source-delete"
                    disabled={Boolean(sourceDeleteBusyId)}
                    title="删除来源"
                    type="button"
                    onClick={() => {
                      setConfirmError("");
                      setConfirmAction({ kind: "delete-source", source });
                    }}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </article>
              ))
            ) : (
              <div className="empty-source-state">
                <strong>还没有来源</strong>
                <span>导入功能完成后，文件和网页会按当前知识库隔离显示。</span>
              </div>
            )}
          </div>
          {parsePanelOpen && (
            <ParseCheckPanel
              busy={importBusy}
              error={importError}
              indexBusy={indexBusy}
              indexError={indexError}
              indexEstimate={indexEstimate}
              indexStatus={indexStatus}
              indexVersions={indexVersions}
              items={parseChecks}
              duplicateBusyId={duplicateBusyId}
              summary={parseSummary}
              onBuildIndex={() => void buildIndex()}
              onCollapse={() => setParsePanelOpen(false)}
              onDeleteIndex={() => {
                setConfirmError("");
                setConfirmAction({ kind: "delete-index" });
              }}
              onRefresh={() => void loadParseChecks(activeKnowledgeBaseId)}
              onRetryIndex={(indexVersionId) => void retryIndex(indexVersionId)}
              onRollbackIndex={(indexVersionId) =>
                void rollbackIndex(indexVersionId)
              }
              onResolveDuplicate={(sourceId, action) =>
                void resolveDuplicate(sourceId, action)
              }
              onRebuildIndex={() => {
                setConfirmError("");
                setConfirmAction({ kind: "rebuild-index" });
              }}
            />
          )}
          {jobsPanelOpen && (
            <JobProgressPanel
              busyJobId={jobBusyId}
              error={jobError}
              jobs={jobs}
              onCancel={(jobId) => void handleJobAction(jobId, "cancel")}
              onCollapse={() => setJobsPanelOpen(false)}
              onPause={(jobId) => void handleJobAction(jobId, "pause")}
              onRecover={() => void handleJobAction("", "recover")}
              onRefresh={() => void loadJobs()}
              onResume={(jobId) => void handleJobAction(jobId, "resume")}
              onRetry={(jobId) => void handleJobAction(jobId, "retry")}
            />
          )}
          {(!parsePanelOpen || !jobsPanelOpen) && (
            <div className="collapsed-source-panels">
              {!parsePanelOpen && (
                <button type="button" onClick={() => setParsePanelOpen(true)}>
                  <Icon name="check" size={15} />
                  <span>
                    <strong>导入检查</strong>
                    <small>
                      成功 {parseSummary.success} · 失败 {parseSummary.failed}
                    </small>
                  </span>
                  <Icon name="chevron" size={14} />
                </button>
              )}
              {!jobsPanelOpen && (
                <button type="button" onClick={() => setJobsPanelOpen(true)}>
                  <Icon name="panel" size={15} />
                  <span>
                    <strong>后台任务</strong>
                    <small>{jobs.length} 个未完成</small>
                  </span>
                  <Icon name="chevron" size={14} />
                </button>
              )}
            </div>
          )}
        </aside>

        <section className="panel chat-panel">
          <PanelHeader
            icon="chat"
            title="对话"
            subtitle={`${selectedCount} 个来源参与检索`}
            action={
              <div className="chat-header-actions">
                <button
                  className="writing-header-button"
                  title="复习与写作工作流"
                  type="button"
                  onClick={() => void openWritingWorkspace()}
                >
                  <Icon name="book" size={15} />
                  <span>写作</span>
                </button>
                <ConversationHistoryMenu
                  activeConversationId={conversationId}
                  busy={chatBusy || Boolean(conversationDeleteBusyId)}
                  conversations={conversations}
                  open={conversationMenuOpen}
                  onDelete={(conversation) => {
                    setConfirmError("");
                    setConfirmAction({
                      kind: "delete-conversation",
                      conversation,
                    });
                  }}
                  onOpen={(id) => void openConversation(id)}
                  onToggle={() => setConversationMenuOpen((value) => !value)}
                />
                <button
                  aria-label="导出当前对话"
                  className="icon-button"
                  disabled={!conversationId || Boolean(exportBusyId)}
                  title="导出当前对话为 Markdown"
                  type="button"
                  onClick={() => void exportMarkdown()}
                >
                  <Icon name="download" size={17} />
                </button>
              </div>
            }
          />
          <div
            className={`chat-scroll ${
              hasStartedConversation ? "conversation-active" : ""
            }`}
          >
            {!hasStartedConversation && (
              <div className="welcome-block">
                <span className="welcome-icon">
                  <Icon name="sparkle" size={25} />
                </span>
                <p className="eyebrow">
                  {activeKnowledgeBase?.name ?? "知识库"}
                </p>
                <h1>从当前知识库获得可验证的答案</h1>
                <p className="welcome-summary">
                  文档、索引和对话都绑定到当前知识库。切换知识库后，来源列表、引用证据和后续检索上下文会随之隔离。
                </p>
                <div className="overview-metrics">
                  <span>
                    <strong>{sourceSummary.sourceCount}</strong> 个来源
                  </span>
                  <span>
                    <strong>{selectedCount}</strong> 个已选择
                  </span>
                  <span>
                    <strong>{sourceSummary.readyIndexCount}</strong> 个可用索引
                  </span>
                  <span>
                    <strong>{sourceSummary.conversationCount}</strong> 个对话
                  </span>
                </div>
              </div>
            )}

            {!hasStartedConversation &&
              (searchBusy || searchError || searchResults.length > 0) && (
                <SearchResultsPanel
                  busy={searchBusy}
                  error={searchError}
                  query={lastSearchQuery || searchQuery}
                  results={searchResults}
                  selectedChunkId={selectedEvidenceChunkId(selectedEvidence)}
                  onSelect={selectSearchResult}
                />
              )}

            {agentRunTrace && (
              <AgentRunTracePanel
                busyAction={agentTraceBusyId}
                error={agentTraceError}
                expanded={agentTraceExpanded}
                expandedToolCallId={expandedTraceToolId}
                filter={agentTraceStageFilter}
                response={agentRunTrace}
                runs={agentRuns}
                onAction={(runId, action) =>
                  void handleAgentRunAction(runId, action)
                }
                onExpandTool={setExpandedTraceToolId}
                onFilterChange={setAgentTraceStageFilter}
                onOpenRun={(runId) =>
                  void openAgentRunTrace(runId, true, activeKnowledgeBaseId)
                }
                onToggleExpanded={() =>
                  setAgentTraceExpanded((value) => !value)
                }
              />
            )}

            {chatError && (
              <div className="message-flow">
                <div className="inline-error">{chatError}</div>
              </div>
            )}
            {exportNotice && (
              <div className="message-flow">
                <div className="inline-notice">{exportNotice}</div>
              </div>
            )}

            {messages.length > 0 && (
              <div className="message-flow">
                {messages.map((message) =>
                  message.role === "user" ? (
                    <p className="user-message" key={message.id}>
                      {message.content}
                    </p>
                  ) : message.role === "assistant" ? (
                    <AssistantAnswerMessage
                      key={message.id}
                      message={message}
                      response={answerResponses[message.id]}
                      selectedChunkId={selectedEvidenceChunkId(
                        selectedEvidence,
                      )}
                      onSelectCitation={selectCitation}
                      exportBusy={exportBusyId === message.id}
                      onExport={() => void exportMarkdown(message.id)}
                    />
                  ) : null,
                )}
              </div>
            )}

            {!hasStartedConversation && (
              <div className="suggestion-block">
                <span className="section-label">建议提问</span>
                <div className="suggestions">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => setQuery(suggestion)}
                    >
                      {suggestion}
                      <Icon name="chevron" size={15} />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="composer-wrap">
            <div className="composer">
              <textarea
                aria-label="向知识库提问"
                placeholder="向知识库提问，回答将附带真实引用…"
                rows={1}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submitQuestion();
                  }
                }}
              />
              <span className="composer-meta">
                {chatBusy ? "生成中" : `${selectedCount} 个来源`}
              </span>
              <label className="composer-model">
                <select
                  aria-label="当前对话模型"
                  disabled={chatBusy}
                  title="从下一条消息开始使用"
                  value={chatModel}
                  onChange={(event) => void changeChatModel(event.target.value)}
                >
                  {(seedStatus?.models ?? FALLBACK_SEED_MODELS)
                    .filter((model) => model.role !== "embedding")
                    .map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                </select>
                <Icon name="chevron" size={13} />
              </label>
              <button
                aria-label="发送问题"
                className="send-button"
                disabled={!query.trim() || chatBusy}
                type="button"
                onClick={() => void submitQuestion()}
              >
                <Icon name="send" size={17} />
              </button>
            </div>
            <p>回答必须经过后端引用校验，证据不足时会明确提示。</p>
          </div>
        </section>

        <aside className="panel evidence-panel">
          <PanelHeader
            icon="evidence"
            title="来源与证据"
            action={
              <button
                aria-label="收起证据面板"
                className="icon-button"
                type="button"
                onClick={() => setEvidenceOpen(false)}
              >
                <Icon name="close" size={17} />
              </button>
            }
          />
          <div className="evidence-content">
            <EvidenceDetail
              jumpNotice={sourceJumpNotice}
              selection={selectedEvidence}
              onFocusSource={focusEvidenceSource}
            />
          </div>
        </aside>

        {!evidenceOpen && (
          <button
            className="evidence-restore"
            type="button"
            onClick={() => setEvidenceOpen(true)}
          >
            <Icon name="panel" size={17} />
            证据
          </button>
        )}
      </section>

      <footer className="system-bar">
        <button
          className="system-summary"
          type="button"
          onClick={() => setSystemOpen(!systemOpen)}
        >
          <span className={`status-dot ${online ? "online" : worker.kind}`} />
          <span>
            {online
              ? "系统就绪"
              : worker.kind === "checking"
                ? "正在检查系统"
                : "系统不可用"}
          </span>
          <span className="system-detail">
            {online && worker.health.storage?.ready
              ? `Worker · JSON-RPC · Schema v${worker.health.storage.schemaVersion} · FTS5 · Vector ${worker.health.storage.vectorDimension}`
              : worker.kind === "offline"
                ? worker.message
                : "连接 Python Worker"}
          </span>
          <Icon name="chevron" size={14} />
        </button>
        {systemOpen && (
          <div className="system-popover">
            <div>
              <strong>工程服务状态</strong>
              <button
                aria-label="关闭状态面板"
                className="icon-button"
                type="button"
                onClick={() => setSystemOpen(false)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            <StatusRow
              label="Python Worker"
              value={online ? `运行中 · PID ${worker.health.pid}` : "不可用"}
              online={online}
            />
            <StatusRow
              label="JSON-RPC"
              value={online ? "已连接" : "未连接"}
              online={online}
            />
            <StatusRow
              label="本地存储"
              value={
                online && worker.health.storage?.ready
                  ? `Schema v${worker.health.storage.schemaVersion} · FTS5 · LanceDB`
                  : "未就绪"
              }
              online={Boolean(online && worker.health.storage?.ready)}
            />
            <StatusRow
              label="Seed API"
              value={
                seedStatus?.configured
                  ? `已配置 · ${seedStatus.maskedKey ?? "已加密"}`
                  : "未配置"
              }
              online={Boolean(seedStatus?.configured)}
            />
            <div className="system-actions">
              <button
                className="button ghost"
                disabled={worker.kind === "checking"}
                type="button"
                onClick={() => void checkHealth()}
              >
                <Icon name="refresh" size={15} /> 重新检查
              </button>
              <button
                className="button primary"
                disabled={worker.kind === "checking"}
                type="button"
                onClick={() => void restart()}
              >
                重启 Worker
              </button>
            </div>
          </div>
        )}
      </footer>

      {settingsOpen && (
        <SeedSettingsModal
          busy={seedBusy}
          error={seedError}
          form={seedForm}
          status={seedStatus}
          onClose={() => setSettingsOpen(false)}
          onDelete={() => void deleteSeedCredential()}
          onFormChange={setSeedForm}
          onReload={() => void loadSeedStatus()}
          maintenanceBusy={maintenanceBusy}
          maintenanceNotice={maintenanceNotice}
          maintenanceStatus={maintenanceStatus}
          usageSummary={usageSummary}
          onCleanup={() => void cleanupStorage()}
          onSave={() => void saveSeedCredential()}
          onSaveDefaults={() => void updateSeedDefaults()}
          onValidate={() => void validateSeedCredential()}
        />
      )}

      {writingOpen && (
        <WritingWorkspaceDialog
          busy={writingBusy}
          drafts={writingDrafts}
          error={writingError}
          goal={writingGoal}
          notice={writingNotice}
          project={writingProject}
          projects={writingProjects}
          selectedSectionId={writingSelectedSectionId}
          workflowType={writingWorkflowType}
          onAudit={(sectionId) => void auditWritingSection(sectionId)}
          onClose={() => {
            if (!writingBusy) {
              setWritingOpen(false);
            }
          }}
          onCreate={() => void createWritingProject()}
          onDraftChange={(sectionId, content) =>
            setWritingDrafts((items) => ({ ...items, [sectionId]: content }))
          }
          onExport={() => void exportWritingWord()}
          onGoalChange={setWritingGoal}
          onOpenProject={(projectId) => void openWritingProject(projectId)}
          onRevise={(sectionId) => void runWritingSection(sectionId, true)}
          onRun={(sectionId) => void runWritingSection(sectionId)}
          onRunNext={() => void runWritingSection()}
          onSave={(sectionId) => void saveWritingSection(sectionId)}
          onSelectSection={setWritingSelectedSectionId}
          onWorkflowTypeChange={setWritingWorkflowType}
        />
      )}

      {webImportOpen && (
        <WebImportDialog
          busy={importBusy}
          error={importError}
          form={webImportForm}
          onClose={() => setWebImportOpen(false)}
          onFormChange={setWebImportForm}
          onSubmit={() => void importWebSource()}
        />
      )}

      {sourceMaintenance && (
        <SourceMaintenanceDialog
          busy={sourceMaintenanceBusy}
          diff={sourceVersionDiff}
          error={sourceMaintenanceError}
          form={sourceMaintenanceForm}
          organization={sourceOrganization}
          sources={sources}
          tagDrafts={sourceTagDrafts}
          value={sourceMaintenance}
          onCheck={() => void checkSourceUpdate()}
          onClassify={() => void classifySource()}
          onClose={() => {
            if (!sourceMaintenanceBusy) {
              setSourceMaintenance(null);
              setSourceVersionDiff(null);
              setSourceOrganization(null);
              setSourceTagDrafts({});
            }
          }}
          onCloseDiff={() => setSourceVersionDiff(null)}
          onDecideSuggestion={(decision) =>
            void decideSourceSuggestion(decision)
          }
          onDecideRelation={(relationId, decision) =>
            void decideSourceRelation(relationId, decision)
          }
          onDecideTag={(tagId, decision) =>
            void decideSourceTag(tagId, decision)
          }
          onDecideVersion={(versionId, decision, rebuild) =>
            void decideSourceVersion(versionId, decision, rebuild)
          }
          onFormChange={setSourceMaintenanceForm}
          onInspectDiff={(versionId) =>
            void inspectSourceVersionDiff(versionId)
          }
          onSave={() => void saveSourceMaintenance()}
          onSuggestTags={() => void suggestSourceTags()}
          onTagDraftChange={(tagId, value) =>
            setSourceTagDrafts((items) => ({ ...items, [tagId]: value }))
          }
        />
      )}

      {knowledgeBaseDialog && (
        <KnowledgeBaseDialog
          activeKnowledgeBase={activeKnowledgeBase}
          busy={knowledgeBaseBusy}
          error={knowledgeBaseError}
          form={knowledgeBaseForm}
          mode={knowledgeBaseDialog}
          onClose={() => setKnowledgeBaseDialog(null)}
          onFormChange={setKnowledgeBaseForm}
          onSubmit={() => void submitKnowledgeBaseDialog()}
        />
      )}

      {confirmAction && (
        <ConfirmActionDialog
          action={confirmAction}
          busy={
            Boolean(sourceDeleteBusyId) ||
            Boolean(conversationDeleteBusyId) ||
            indexBusy
          }
          error={confirmError}
          onClose={() => {
            if (
              !sourceDeleteBusyId &&
              !conversationDeleteBusyId &&
              !indexBusy
            ) {
              setConfirmAction(null);
            }
          }}
          onSubmit={() => void submitConfirmAction()}
        />
      )}
    </main>
  );
}

function AgentRunTracePanel({
  busyAction,
  error,
  expanded,
  expandedToolCallId,
  filter,
  response,
  runs,
  onAction,
  onExpandTool,
  onFilterChange,
  onOpenRun,
  onToggleExpanded,
}: {
  busyAction: string;
  error: string;
  expanded: boolean;
  expandedToolCallId: string;
  filter: string;
  response: AgentRunResponse;
  runs: AgentRunRecord[];
  onAction: (runId: string, action: "resume" | "cancel" | "retry") => void;
  onExpandTool: (toolCallId: string) => void;
  onFilterChange: (filter: string) => void;
  onOpenRun: (runId: string) => void;
  onToggleExpanded: () => void;
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now());
  const { run, events, toolCalls, confirmations } = response;
  const finished = isAgentRunFinished(run.status);
  const snapshot = run.traceSnapshot ?? {};
  const phases = snapshot.phases ?? [];
  const currentStage =
    snapshot.currentStageLabel ?? agentRunStatusLabel(run.status);
  const elapsedMs = agentRunElapsedMs(run, now);
  const visibleEvents =
    filter === "all"
      ? events
      : events.filter((event) => eventStageId(event) === filter);

  useEffect(() => {
    if (finished) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [finished]);

  return (
    <section className={`agent-trace-panel ${expanded ? "expanded" : ""}`}>
      <header className="agent-trace-heading">
        <button
          className="agent-trace-title"
          type="button"
          onClick={onToggleExpanded}
        >
          <span className={`agent-trace-dot ${run.status}`} />
          <span>
            <strong>{finished ? "任务执行记录" : "任务进行中"}</strong>
            <small>
              {formatDurationMs(elapsedMs)} · {currentStage}
            </small>
          </span>
          <Icon name="chevron" size={15} />
        </button>
        <div className="agent-trace-actions">
          {runs.length > 1 && (
            <label className="agent-run-select">
              <select
                aria-label="切换 AgentRun"
                value={run.id}
                onChange={(event) => onOpenRun(event.target.value)}
              >
                {runs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
              <Icon name="chevron" size={12} />
            </label>
          )}
          {run.status === "paused" && (
            <button
              className="text-button"
              disabled={Boolean(busyAction)}
              type="button"
              onClick={() => onAction(run.id, "resume")}
            >
              {busyAction ? "处理中" : "继续"}
            </button>
          )}
          {run.status === "failed" && (
            <button
              className="text-button"
              disabled={Boolean(busyAction)}
              type="button"
              onClick={() => onAction(run.id, "retry")}
            >
              {busyAction ? "处理中" : "重试"}
            </button>
          )}
          {!finished && run.status !== "paused" && (
            <button
              className="text-button danger-text"
              disabled={Boolean(busyAction)}
              type="button"
              onClick={() => onAction(run.id, "cancel")}
            >
              取消
            </button>
          )}
        </div>
      </header>

      {!expanded ? (
        <div className="agent-trace-collapsed">
          <span>{events.length} 条记录</span>
          <button
            className="text-button"
            type="button"
            onClick={onToggleExpanded}
          >
            查看执行记录
          </button>
        </div>
      ) : (
        <div className="agent-trace-body">
          {error && <div className="inline-error">{error}</div>}
          <div className="agent-trace-progress">
            {phases.map((phase) => (
              <span className={phase.status} key={phase.id}>
                {phase.label}
              </span>
            ))}
          </div>
          <div className="agent-trace-toolbar">
            <label>
              <span>阶段</span>
              <select
                aria-label="筛选 Trace 阶段"
                value={filter}
                onChange={(event) => onFilterChange(event.target.value)}
              >
                <option value="all">全部</option>
                {phases.map((phase) => (
                  <option key={phase.id} value={phase.id}>
                    {phase.label}
                  </option>
                ))}
              </select>
            </label>
            <span>
              {events.length} 条事件 · {toolCalls.length} 个 Tool ·{" "}
              {pendingConfirmations(confirmations)} 个待确认
            </span>
          </div>
          <div className="agent-trace-list">
            {visibleEvents.map((event) => {
              const toolCall = event.toolCallId
                ? toolCalls.find((item) => item.id === event.toolCallId)
                : undefined;
              const expandedTool = Boolean(
                toolCall && expandedToolCallId === toolCall.id,
              );
              return (
                <article
                  className={`agent-trace-event ${traceEventTone(event)}`}
                  key={event.id}
                >
                  <button
                    className="agent-trace-event-main"
                    type="button"
                    onClick={() => {
                      if (toolCall) {
                        onExpandTool(expandedTool ? "" : toolCall.id);
                      }
                    }}
                  >
                    <span className="agent-trace-event-icon">
                      {traceEventSymbol(event)}
                    </span>
                    <span>
                      <strong>{event.title}</strong>
                      <small>
                        {traceEventMeta(event)}
                        {event.summary ? ` · ${event.summary}` : ""}
                      </small>
                    </span>
                    {toolCall && <Icon name="chevron" size={13} />}
                  </button>
                  {toolCall && expandedTool && (
                    <ToolTraceDetail toolCall={toolCall} />
                  )}
                  {event.eventType === "run.failed" && (
                    <div className="agent-trace-recovery">
                      <span>{event.summary ?? "执行失败"}</span>
                      <button
                        className="text-button"
                        disabled={Boolean(busyAction)}
                        type="button"
                        onClick={() => onAction(run.id, "retry")}
                      >
                        重新执行
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function ToolTraceDetail({
  toolCall,
}: {
  toolCall: AgentRunToolCallRecord;
}): React.JSX.Element {
  return (
    <div className="tool-trace-detail">
      <span>
        <strong>Tool</strong>
        {toolCall.toolName}
      </span>
      <span>
        <strong>Skill</strong>
        {toolCall.skillId
          ? `${toolCall.skillId}${toolCall.skillVersion ? `@${toolCall.skillVersion}` : ""}`
          : "未绑定"}
      </span>
      <span>
        <strong>动作</strong>
        {toolCall.actionSummary}
      </span>
      {toolCall.workingDirectory && (
        <span>
          <strong>目录</strong>
          {toolCall.workingDirectory}
        </span>
      )}
      <span>
        <strong>状态</strong>
        {toolCall.status}
        {toolCall.durationMs !== null
          ? ` · ${formatDurationMs(toolCall.durationMs)}`
          : ""}
        {toolCall.exitCode !== null ? ` · exit ${toolCall.exitCode}` : ""}
      </span>
      <span>
        <strong>参数</strong>
        {JSON.stringify(toolCall.sanitizedParams)}
      </span>
      {(toolCall.stdoutSummary ||
        toolCall.stderrSummary ||
        toolCall.errorMessage) && (
        <span>
          <strong>输出</strong>
          {[
            toolCall.stdoutSummary,
            toolCall.stderrSummary,
            toolCall.errorMessage,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
    </div>
  );
}

function WritingWorkspaceDialog({
  busy,
  drafts,
  error,
  goal,
  notice,
  project,
  projects,
  selectedSectionId,
  workflowType,
  onAudit,
  onClose,
  onCreate,
  onDraftChange,
  onExport,
  onGoalChange,
  onOpenProject,
  onRevise,
  onRun,
  onRunNext,
  onSave,
  onSelectSection,
  onWorkflowTypeChange,
}: {
  busy: boolean;
  drafts: Record<string, string>;
  error: string;
  goal: string;
  notice: string;
  project: WritingProjectResponse | null;
  projects: WritingProjectRecord[];
  selectedSectionId: string;
  workflowType: WritingWorkflowType;
  onAudit: (sectionId: string) => void;
  onClose: () => void;
  onCreate: () => void;
  onDraftChange: (sectionId: string, content: string) => void;
  onExport: () => void;
  onGoalChange: (value: string) => void;
  onOpenProject: (projectId: string) => void;
  onRevise: (sectionId: string) => void;
  onRun: (sectionId: string) => void;
  onRunNext: () => void;
  onSave: (sectionId: string) => void;
  onSelectSection: (sectionId: string) => void;
  onWorkflowTypeChange: (value: WritingWorkflowType) => void;
}): React.JSX.Element {
  const section =
    project?.sections.find((item) => item.id === selectedSectionId) ??
    project?.sections[0];
  const suggestions = section?.audit.revisionSuggestions ?? [];
  const conflicts = section?.audit.conflicts ?? [];
  const invalidCitations =
    section?.audit.citationValidation?.invalidCitations ?? [];

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        aria-modal="true"
        className="writing-workspace-dialog"
        role="dialog"
      >
        <header className="writing-workspace-heading">
          <div>
            <span className="eyebrow">LangGraph 写作工作流</span>
            <h2>复习与写作</h2>
            <p>大纲、逐节内容和检查点均绑定到当前知识库证据。</p>
          </div>
          <div>
            <button
              className="button ghost"
              disabled={!project || busy}
              type="button"
              onClick={onRunNext}
            >
              <Icon name="sparkle" size={15} /> 逐节继续
            </button>
            <button
              className="button ghost"
              disabled={!project || busy}
              type="button"
              onClick={onExport}
            >
              <Icon name="download" size={15} /> 导出 Word
            </button>
            <button
              aria-label="关闭写作工作区"
              className="icon-button"
              disabled={busy}
              type="button"
              onClick={onClose}
            >
              <Icon name="close" size={17} />
            </button>
          </div>
        </header>

        <div className="writing-workspace-body">
          <aside className="writing-projects">
            <div className="writing-create">
              <strong>创建工作流</strong>
              <div className="writing-mode-switch" role="group">
                <button
                  className={workflowType === "review" ? "active" : ""}
                  disabled={busy}
                  type="button"
                  onClick={() => onWorkflowTypeChange("review")}
                >
                  复习提纲
                </button>
                <button
                  className={workflowType === "article" ? "active" : ""}
                  disabled={busy}
                  type="button"
                  onClick={() => onWorkflowTypeChange("article")}
                >
                  写作大纲
                </button>
              </div>
              <textarea
                aria-label="写作或复习目标"
                disabled={busy}
                placeholder="例如：整理产品架构的复习提纲"
                value={goal}
                onChange={(event) => onGoalChange(event.target.value)}
              />
              <button
                className="button primary"
                disabled={busy || !goal.trim()}
                type="button"
                onClick={onCreate}
              >
                <Icon name="sparkle" size={15} /> 生成证据大纲
              </button>
            </div>
            <div className="writing-project-list">
              <div className="writing-column-heading">
                <strong>工作流</strong>
                <span>{projects.length}</span>
              </div>
              {projects.map((item) => (
                <button
                  className={item.id === project?.project.id ? "active" : ""}
                  disabled={busy}
                  key={item.id}
                  type="button"
                  onClick={() => onOpenProject(item.id)}
                >
                  <strong>{item.title}</strong>
                  <span>
                    {writingWorkflowLabel(item.workflowType)} ·{" "}
                    {writingStatusLabel(item.status)}
                  </span>
                </button>
              ))}
              {projects.length === 0 && (
                <p className="writing-empty">还没有写作工作流</p>
              )}
            </div>
          </aside>

          <section className="writing-editor">
            {project ? (
              <>
                <div className="writing-project-summary">
                  <div>
                    <span>
                      {writingWorkflowLabel(project.project.workflowType)}
                    </span>
                    <h3>{project.project.title}</h3>
                    <p>{project.project.goal}</p>
                  </div>
                  <span className={`writing-status ${project.project.status}`}>
                    {writingStatusLabel(project.project.status)}
                  </span>
                </div>
                <div className="writing-section-tabs">
                  {project.sections.map((item) => (
                    <button
                      className={item.id === section?.id ? "active" : ""}
                      disabled={busy}
                      key={item.id}
                      type="button"
                      onClick={() => onSelectSection(item.id)}
                    >
                      <span>{item.position + 1}</span>
                      <strong>{item.title}</strong>
                      <small>{writingStatusLabel(item.status)}</small>
                    </button>
                  ))}
                </div>
                {section && (
                  <div className="writing-section-editor">
                    <div className="writing-section-heading">
                      <div>
                        <h4>{section.title}</h4>
                        <p>{section.purpose}</p>
                      </div>
                      <span>{section.citations.length} 条引用</span>
                    </div>
                    {section.reviewPoints.length > 0 && (
                      <ul className="writing-review-points">
                        {section.reviewPoints.map((point) => (
                          <li key={point}>{point}</li>
                        ))}
                      </ul>
                    )}
                    <textarea
                      aria-label={`编辑章节 ${section.title}`}
                      disabled={busy}
                      placeholder="生成章节后可在此编辑内容"
                      value={drafts[section.id] ?? section.content}
                      onChange={(event) =>
                        onDraftChange(section.id, event.target.value)
                      }
                    />
                    <div className="writing-editor-actions">
                      <button
                        className="button primary"
                        disabled={busy}
                        type="button"
                        onClick={() => onRun(section.id)}
                      >
                        <Icon name="sparkle" size={15} />
                        {section.status === "failed"
                          ? "从检查点恢复"
                          : "生成章节"}
                      </button>
                      <button
                        className="button ghost"
                        disabled={busy || !(drafts[section.id] ?? "").trim()}
                        type="button"
                        onClick={() => onSave(section.id)}
                      >
                        保存编辑
                      </button>
                      <button
                        className="button ghost"
                        disabled={busy || !section.content}
                        type="button"
                        onClick={() => onAudit(section.id)}
                      >
                        <Icon name="check" size={15} /> 检查引用
                      </button>
                      <button
                        className="button ghost"
                        disabled={busy || suggestions.length === 0}
                        type="button"
                        onClick={() => onRevise(section.id)}
                      >
                        <Icon name="refresh" size={15} /> 自动修订
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="writing-empty-main">
                <Icon name="book" size={30} />
                <strong>创建复习提纲或证据写作大纲</strong>
                <span>生成后可逐节写作，并从失败检查点继续。</span>
              </div>
            )}
          </section>

          <aside className="writing-audit">
            <div className="writing-column-heading">
              <strong>引用与检查</strong>
              <span>{section?.audit.valid ? "通过" : "待处理"}</span>
            </div>
            {section ? (
              <>
                <div className="writing-audit-metrics">
                  <span>
                    <strong>{section.citations.length}</strong>
                    引用证据
                  </span>
                  <span>
                    <strong>{invalidCitations.length}</strong>
                    无效引用
                  </span>
                  <span>
                    <strong>{conflicts.length}</strong>
                    证据冲突
                  </span>
                </div>
                <WritingAuditList
                  empty="当前没有修订建议"
                  items={suggestions.map((item) => item.message)}
                  title="自动修订建议"
                />
                <WritingAuditList
                  empty="当前没有确认的证据冲突"
                  items={conflicts.map(writingConflictLabel)}
                  title="冲突检查"
                />
                <div className="writing-checkpoints">
                  <div className="writing-column-heading">
                    <strong>最近检查点</strong>
                    <span>{project?.checkpoints.length ?? 0}</span>
                  </div>
                  {project?.checkpoints.slice(0, 8).map((checkpoint) => (
                    <div key={checkpoint.id}>
                      <Icon
                        name={
                          checkpoint.status === "completed"
                            ? "check"
                            : "refresh"
                        }
                        size={13}
                      />
                      <span>
                        <strong>
                          {writingCheckpointLabel(checkpoint.step)}
                        </strong>
                        <small>{formatDateTime(checkpoint.createdAt)}</small>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="writing-empty">选择工作流后显示检查结果</p>
            )}
          </aside>
        </div>
        {(error || notice) && (
          <footer
            className={error ? "writing-feedback error" : "writing-feedback"}
          >
            {error || notice}
          </footer>
        )}
      </section>
    </div>
  );
}

function WritingAuditList({
  empty,
  items,
  title,
}: {
  empty: string;
  items: string[];
  title: string;
}): React.JSX.Element {
  return (
    <section className="writing-audit-list">
      <strong>{title}</strong>
      {items.length > 0 ? (
        <ul>
          {items.map((item, index) => (
            <li key={`${index}:${item}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}

function ConversationHistoryMenu({
  activeConversationId,
  busy,
  conversations,
  open,
  onDelete,
  onOpen,
  onToggle,
}: {
  activeConversationId: string | null;
  busy: boolean;
  conversations: ConversationRecord[];
  open: boolean;
  onDelete: (conversation: ConversationRecord) => void;
  onOpen: (conversationId: string) => void;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <div className="history-menu-wrap">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="history-menu-trigger"
        type="button"
        onClick={onToggle}
      >
        历史对话
        <span>{conversations.length}</span>
        <Icon name="chevron" size={13} />
      </button>
      {open && (
        <div className="history-menu" role="menu">
          <div className="history-menu-heading">
            <strong>历史对话</strong>
            <span>{conversations.length} 个</span>
          </div>
          {conversations.length > 0 ? (
            <div className="history-menu-list">
              {conversations.map((conversation) => (
                <div
                  className={`history-menu-item ${
                    conversation.id === activeConversationId ? "active" : ""
                  }`}
                  key={conversation.id}
                  role="menuitem"
                >
                  <button
                    className="history-menu-open"
                    disabled={busy}
                    type="button"
                    onClick={() => onOpen(conversation.id)}
                  >
                    <strong>{conversation.title}</strong>
                    <small>{conversation.modelId ?? "未生成回答"}</small>
                  </button>
                  <button
                    aria-label={`删除历史对话 ${conversation.title}`}
                    className="history-menu-delete"
                    disabled={busy}
                    title="删除历史对话"
                    type="button"
                    onClick={() => onDelete(conversation)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="history-menu-empty">还没有历史对话</p>
          )}
        </div>
      )}
    </div>
  );
}

function SearchResultsPanel({
  busy,
  error,
  query,
  results,
  selectedChunkId,
  onSelect,
}: {
  busy: boolean;
  error: string;
  query: string;
  results: HybridSearchResult[];
  selectedChunkId?: string;
  onSelect: (result: HybridSearchResult) => void;
}): React.JSX.Element {
  return (
    <section className="search-results-panel" aria-label="资料搜索结果">
      <div className="search-results-heading">
        <div>
          <span className="section-label">资料搜索</span>
          <strong>{query ? `“${query}”` : "关键词 / 自然语言检索"}</strong>
        </div>
        <small>FTS5 + 向量混合召回</small>
      </div>
      {busy && <p className="search-status">正在检索当前知识库...</p>}
      {error && <div className="inline-error">{error}</div>}
      {results.length > 0 && (
        <div className="search-result-list">
          {results.map((result) => (
            <button
              className={`search-result-card ${
                selectedChunkId === result.chunkId ? "selected" : ""
              }`}
              key={result.chunkId}
              type="button"
              onClick={() => onSelect(result)}
            >
              <span
                className={`source-icon ${sourceToneFromType(result.source.type)}`}
              >
                <Icon name="document" size={16} />
              </span>
              <span className="search-result-copy">
                <strong>{result.source.displayName}</strong>
                <small>
                  {sourceTypeLabel(result.source.type)} ·{" "}
                  {formatLocation(result.source.type, result.location)}
                </small>
                <span>{result.text.preview}</span>
              </span>
              <span className="search-result-meta">
                <small>#{result.ranks.fused}</small>
                <small>{matchLabel(result)}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function AssistantAnswerMessage({
  message,
  response,
  selectedChunkId,
  exportBusy,
  onExport,
  onSelectCitation,
}: {
  message: ConversationMessageRecord;
  response?: ConversationAnswerResponse;
  selectedChunkId?: string;
  exportBusy: boolean;
  onExport: () => void;
  onSelectCitation: (
    citation: AnswerCitation,
    response?: ConversationAnswerResponse,
    citationNumber?: number,
  ) => void;
}): React.JSX.Element {
  if (isPendingAssistantMessage(message)) {
    return <p className="assistant-thinking">思考回复中...</p>;
  }

  const citations = response?.citations ?? message.citations;
  const paragraphs = response
    ? response.answer.paragraphs
    : message.content
        .split(/\n{2,}/)
        .filter(Boolean)
        .map((text, index) => ({
          index,
          text,
          evidenceChunkIds: citations
            .filter((citation) => citation.paragraphIndex === index)
            .map((citation) => citation.chunkId),
        }));
  const evidenceSufficient = response
    ? response.answer.evidenceSufficient
    : citations.length > 0;
  const citationNumbers = citationNumberMap(citations);

  return (
    <article className="assistant-message">
      <div className="assistant-heading">
        <span className="mini-mark">
          <Icon name="sparkle" size={15} />
        </span>
        <strong>citeMind</strong>
        <button
          aria-label="导出这条回答"
          className="icon-button"
          disabled={exportBusy}
          title="导出这条回答为 Markdown"
          type="button"
          onClick={onExport}
        >
          <Icon name="download" size={15} />
        </button>
      </div>
      {!evidenceSufficient && (
        <div className="evidence-warning">
          证据不足：没有通过检索与引用校验的来源。
        </div>
      )}
      <div className="answer-paragraphs">
        {paragraphs.map((paragraph) => {
          const paragraphCitations = citationsForParagraph(
            citations,
            paragraph.index,
            paragraph.evidenceChunkIds,
          );
          const citationTail = splitCitationTail(paragraph.text);
          return (
            <section className="answer-paragraph" key={paragraph.index}>
              <p>
                {citationTail.body}
                {paragraphCitations.length > 0 ? (
                  <span className="inline-citation-list">
                    {paragraphCitations.map((citation) => {
                      const citationNumber =
                        citationNumbers.get(citationKey(citation)) ?? 1;
                      return (
                        <InlineCitationButton
                          citation={citation}
                          citationNumber={citationNumber}
                          key={`${paragraph.index}:${citationKey(citation)}`}
                          response={response}
                          selected={selectedChunkId === citation.chunkId}
                          onSelect={onSelectCitation}
                        />
                      );
                    })}
                  </span>
                ) : null}
                {citationTail.tail}
              </p>
            </section>
          );
        })}
      </div>
      <div className="answer-meta">
        <span>{message.modelId ?? response?.model.id ?? "历史回答"}</span>
        <span>
          {response
            ? `检索候选 ${response.retrieval.retrieval.mergedCandidateCount}`
            : `${citations.length} 条持久化引用`}
        </span>
        <span>
          {!evidenceSufficient
            ? "证据不足"
            : response?.citationValidation.valid
              ? "引用校验通过"
              : "历史引用"}
        </span>
      </div>
    </article>
  );
}

function InlineCitationButton({
  citation,
  citationNumber,
  response,
  selected,
  onSelect,
}: {
  citation: AnswerCitation;
  citationNumber: number;
  response?: ConversationAnswerResponse;
  selected: boolean;
  onSelect: (
    citation: AnswerCitation,
    response?: ConversationAnswerResponse,
    citationNumber?: number,
  ) => void;
}): React.JSX.Element {
  return (
    <button
      aria-label={`查看引用 ${citationNumber}：${citation.source.displayName}`}
      className={`inline-citation-ref ${selected ? "selected" : ""}`}
      title={`${citation.source.displayName} · ${formatLocation(
        citation.source.type,
        citation.location,
      )}`}
      type="button"
      onClick={() => onSelect(citation, response, citationNumber)}
    >
      {citationNumber}
    </button>
  );
}

function EvidenceDetail({
  jumpNotice,
  selection,
  onFocusSource,
}: {
  jumpNotice: string;
  selection: EvidenceSelection | null;
  onFocusSource: (selection: EvidenceSelection) => void;
}): React.JSX.Element {
  if (!selection) {
    return (
      <div className="evidence-empty">
        <span className="evidence-illustration">
          <Icon name="evidence" size={26} />
        </span>
        <h2>可信证据会显示在这里</h2>
        <p>点击回答中的引用，即可查看原始片段、定位信息与检索相关度。</p>
      </div>
    );
  }

  const source =
    selection.kind === "citation"
      ? selection.citation.source
      : selection.result.source;
  const location =
    selection.kind === "citation"
      ? selection.citation.location
      : selection.result.location;
  const retrievalResult =
    selection.kind === "citation"
      ? selection.retrievalResult
      : selection.result;
  const quote =
    selection.kind === "citation"
      ? citationQuote(selection.citation)
      : resultQuote(selection.result);

  return (
    <>
      <article className="evidence-card">
        <div className="evidence-card-heading">
          <span className={`source-icon ${sourceToneFromType(source.type)}`}>
            <Icon name="document" size={16} />
          </span>
          {selection.kind === "citation" && selection.citationNumber ? (
            <span className="evidence-citation-number">
              [{selection.citationNumber}]
            </span>
          ) : null}
          <div>
            <strong>{source.displayName}</strong>
            <small>
              {selection.kind === "citation" ? "回答引用" : "资料搜索结果"} ·{" "}
              {sourceTypeLabel(source.type)}
            </small>
          </div>
        </div>
        <blockquote>{quote}</blockquote>
        <div className="evidence-stats">
          <span>证据强度：{evidenceStrength(retrievalResult)}</span>
          <span>{retrievalLabel(retrievalResult)}</span>
          <span>{matchLabel(retrievalResult)}</span>
        </div>
        <dl className="evidence-location-list">
          {locationRows(source.type, location).map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        <p className="evidence-explain">
          {retrievalResult?.explanation.summary ??
            "这是历史持久化引用，原回答检索解释未随消息列表加载。"}
        </p>
        {jumpNotice && <p className="source-jump-notice">{jumpNotice}</p>}
        <button
          className="button evidence-action"
          type="button"
          onClick={() => onFocusSource(selection)}
        >
          定位来源位置 <Icon name="chevron" size={15} />
        </button>
      </article>
    </>
  );
}

function JobProgressPanel({
  busyJobId,
  error,
  jobs,
  onCancel,
  onCollapse,
  onPause,
  onRecover,
  onRefresh,
  onResume,
  onRetry,
}: {
  busyJobId: string;
  error: string;
  jobs: BackgroundJobRecord[];
  onCancel: (jobId: string) => void;
  onCollapse: () => void;
  onPause: (jobId: string) => void;
  onRecover: () => void;
  onRefresh: () => void;
  onResume: (jobId: string) => void;
  onRetry: (jobId: string) => void;
}): React.JSX.Element {
  return (
    <section className="job-panel" aria-label="后台任务">
      <div className="job-panel-heading">
        <div>
          <strong>后台任务</strong>
          <span>{jobs.length} 个未完成</span>
        </div>
        <div className="job-heading-actions">
          <button
            className="text-button"
            disabled={busyJobId === "recover"}
            type="button"
            onClick={onRecover}
          >
            恢复扫描
          </button>
          <button className="icon-button" type="button" onClick={onRefresh}>
            <Icon name="refresh" size={15} />
          </button>
          <button
            aria-label="收起后台任务"
            className="icon-button"
            type="button"
            onClick={onCollapse}
          >
            <Icon name="chevron" size={15} />
          </button>
        </div>
      </div>
      {error && <div className="inline-error">{error}</div>}
      <div className="job-list">
        {jobs.length > 0 ? (
          jobs.map((job) => (
            <article className={`job-card ${job.status}`} key={job.id}>
              <div className="job-card-heading">
                <div>
                  <strong>{jobTypeLabel(job.jobType)}</strong>
                  <span>{job.targetId}</span>
                </div>
                <span className={`job-status ${job.status}`}>
                  {jobStatusLabel(job.status)}
                </span>
              </div>
              <div className="job-progress">
                <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
              </div>
              <div className="job-meta">
                <span>{Math.round(job.progress * 100)}%</span>
                <span>重试 {job.retryCount} 次</span>
              </div>
              <div className="job-stages">
                {jobStages(job).map((stage) => (
                  <span className={stage.status} key={stage.id}>
                    {stage.label}
                  </span>
                ))}
              </div>
              {job.errorMessage && (
                <p className="job-error">{job.errorMessage}</p>
              )}
              <div className="job-actions">
                {job.status === "running" && (
                  <button
                    className="text-button"
                    disabled={busyJobId === job.id}
                    type="button"
                    onClick={() => onPause(job.id)}
                  >
                    暂停
                  </button>
                )}
                {["pending", "paused", "retrying"].includes(job.status) && (
                  <button
                    className="text-button"
                    disabled={busyJobId === job.id}
                    type="button"
                    onClick={() => onResume(job.id)}
                  >
                    {job.status === "pending" ? "开始" : "继续"}
                  </button>
                )}
                {job.status === "failed" && (
                  <button
                    className="text-button"
                    disabled={busyJobId === job.id}
                    type="button"
                    onClick={() => onRetry(job.id)}
                  >
                    重试
                  </button>
                )}
                {jobCanCancel(job.status) && (
                  <button
                    className="text-button danger-text"
                    disabled={busyJobId === job.id}
                    type="button"
                    onClick={() => onCancel(job.id)}
                  >
                    取消
                  </button>
                )}
              </div>
            </article>
          ))
        ) : (
          <div className="empty-job-state">
            <strong>暂无后台任务</strong>
            <span>导入、OCR、Embedding 和索引任务会在这里实时更新。</span>
          </div>
        )}
      </div>
    </section>
  );
}

function ParseCheckPanel({
  busy,
  error,
  indexBusy,
  indexError,
  indexEstimate,
  indexStatus,
  indexVersions,
  items,
  duplicateBusyId,
  summary,
  onBuildIndex,
  onCollapse,
  onDeleteIndex,
  onRefresh,
  onRetryIndex,
  onRollbackIndex,
  onResolveDuplicate,
  onRebuildIndex,
}: {
  busy: boolean;
  error: string;
  indexBusy: boolean;
  indexError: string;
  indexEstimate: IndexBuildEstimate | null;
  indexStatus: BuildIndexResponse | null;
  indexVersions: IndexVersionRecord[];
  items: ParseCheckItem[];
  duplicateBusyId: string;
  summary: ParseCheckSummary;
  onBuildIndex: () => void;
  onCollapse: () => void;
  onDeleteIndex: () => void;
  onRefresh: () => void;
  onRetryIndex: (indexVersionId: string) => void;
  onRollbackIndex: (indexVersionId: string) => void;
  onResolveDuplicate: (sourceId: string, action: DuplicateAction) => void;
  onRebuildIndex: () => void;
}): React.JSX.Element {
  const indexableCount = items.filter((item) =>
    ["success", "processing"].includes(item.status),
  ).length;

  return (
    <section className="parse-panel" aria-label="导入检查">
      <div className="parse-panel-heading">
        <div>
          <strong>导入检查</strong>
          <span>{summary.total} 个来源</span>
        </div>
        <div className="job-heading-actions">
          <button
            className="icon-button"
            disabled={busy}
            type="button"
            onClick={onRefresh}
          >
            <Icon name="refresh" size={15} />
          </button>
          <button
            aria-label="收起导入检查"
            className="icon-button"
            type="button"
            onClick={onCollapse}
          >
            <Icon name="chevron" size={15} />
          </button>
        </div>
      </div>
      <div className="parse-summary-grid">
        <span className="success">成功 {summary.success}</span>
        <span className="needs-ocr">需要 OCR {summary.needsOcr}</span>
        <span className="failed">失败 {summary.failed}</span>
        <span className="duplicate">重复 {summary.duplicate}</span>
      </div>
      {error && <div className="inline-error">{error}</div>}
      {indexError && <div className="inline-error">{indexError}</div>}
      {indexEstimate && (
        <div className="index-estimate">
          <strong>新索引预估</strong>
          <span>
            {indexEstimate.documentCount} 文档 · {indexEstimate.chunkCount}{" "}
            文本块 · {indexEstimate.estimatedEmbeddingCalls} 次 Embedding 调用
          </span>
          <small>{indexEstimate.pricingNotice}</small>
        </div>
      )}
      <div className="parse-list">
        {items.length > 0 ? (
          items.slice(0, 4).map((item) => (
            <article
              className={`parse-card ${item.status}`}
              key={item.sourceId}
            >
              <div className="parse-card-heading">
                <strong>{item.displayName}</strong>
                <span>{parseStatusLabel(item.status)}</span>
              </div>
              <small>
                {sourceTypeLabel(item.sourceType)} · {item.chunkCount} 片段
                {item.versionStatus
                  ? ` · ${sourceStatusLabel(item.versionStatus)}`
                  : ""}
              </small>
              {item.preview && <p>{item.preview}</p>}
              {item.errorMessage && (
                <p className="parse-error">{item.errorMessage}</p>
              )}
              {item.status === "duplicate" && (
                <div className="duplicate-actions">
                  <span>
                    {item.duplicateKind === "original"
                      ? "文件完全重复"
                      : "正文内容重复"}
                  </span>
                  <div>
                    <button
                      disabled={duplicateBusyId === item.sourceId}
                      type="button"
                      onClick={() => onResolveDuplicate(item.sourceId, "skip")}
                    >
                      跳过
                    </button>
                    <button
                      disabled={duplicateBusyId === item.sourceId}
                      type="button"
                      onClick={() => onResolveDuplicate(item.sourceId, "keep")}
                    >
                      保留副本
                    </button>
                    <button
                      disabled={duplicateBusyId === item.sourceId}
                      type="button"
                      onClick={() => onResolveDuplicate(item.sourceId, "link")}
                    >
                      关联已有
                    </button>
                  </div>
                </div>
              )}
            </article>
          ))
        ) : (
          <div className="empty-parse-state">
            <strong>还没有解析结果</strong>
            <span>添加 PDF、DOCX、图片或网页后会显示检查结果。</span>
          </div>
        )}
      </div>
      {indexStatus?.indexVersion && (
        <div className="index-status-card">
          <div>
            <strong>
              {indexStatus.ready ? "当前索引可检索" : "当前索引未就绪"}
            </strong>
            <span>
              {indexStatus.indexVersion.chunkCount} chunks ·{" "}
              {indexStatus.indexVersion.chunkingVersion}
            </span>
          </div>
          <div className="index-card-actions">
            <button
              className="text-button danger-text"
              disabled={indexBusy}
              type="button"
              onClick={onDeleteIndex}
            >
              删除索引
            </button>
            <button
              className="text-button"
              disabled={indexBusy || indexableCount === 0}
              type="button"
              onClick={onRebuildIndex}
            >
              {indexBusy ? "重构中..." : "重构索引"}
            </button>
          </div>
        </div>
      )}
      {!indexStatus?.indexVersion && (
        <button
          className="button primary parse-index-action"
          disabled={indexBusy || indexableCount === 0}
          type="button"
          onClick={onBuildIndex}
        >
          {indexBusy ? "建立索引中..." : "开始建立索引"}
        </button>
      )}
      {indexVersions.length > 0 && (
        <div className="index-version-list">
          {indexVersions.slice(0, 4).map((version) => (
            <article key={version.id}>
              <div>
                <strong>
                  {version.isCurrent
                    ? "当前版本"
                    : sourceStatusLabel(version.status)}
                </strong>
                <span>{version.embeddingModel}</span>
                <small>
                  {version.chunkCount} chunks · {version.id.slice(0, 12)}
                </small>
              </div>
              {!version.isCurrent && version.status === "retired" && (
                <button
                  disabled={indexBusy}
                  type="button"
                  onClick={() => onRollbackIndex(version.id)}
                >
                  回滚
                </button>
              )}
              {version.status === "failed" && (
                <button
                  disabled={indexBusy}
                  type="button"
                  onClick={() => onRetryIndex(version.id)}
                >
                  重试
                </button>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function SourceMaintenanceDialog({
  busy,
  diff,
  error,
  form,
  organization,
  sources,
  tagDrafts,
  value,
  onCheck,
  onClassify,
  onClose,
  onCloseDiff,
  onDecideRelation,
  onDecideSuggestion,
  onDecideTag,
  onDecideVersion,
  onFormChange,
  onInspectDiff,
  onSave,
  onSuggestTags,
  onTagDraftChange,
}: {
  busy: boolean;
  diff: SourceVersionDiffResponse | null;
  error: string;
  form: {
    replacementSourceId: string;
    reviewAt: string;
    expiryStatus: KnowledgeBaseSource["expiryStatus"];
  };
  organization: SourceOrganizationResponse | null;
  sources: KnowledgeBaseSource[];
  tagDrafts: Record<string, string>;
  value: SourceVersionsResponse;
  onCheck: () => void;
  onClassify: () => void;
  onClose: () => void;
  onCloseDiff: () => void;
  onDecideRelation: (
    relationId: string,
    decision: "confirm" | "dismiss",
  ) => void;
  onDecideSuggestion: (decision: "accept" | "dismiss") => void;
  onDecideTag: (tagId: string, decision: "confirm" | "dismiss") => void;
  onDecideVersion: (
    versionId: string,
    decision: "accept" | "reject",
    rebuild: boolean,
  ) => void;
  onFormChange: (next: {
    replacementSourceId: string;
    reviewAt: string;
    expiryStatus: KnowledgeBaseSource["expiryStatus"];
  }) => void;
  onInspectDiff: (versionId: string) => void;
  onSave: () => void;
  onSuggestTags: () => void;
  onTagDraftChange: (tagId: string, value: string) => void;
}): React.JSX.Element {
  const suggestion = value.source.modelSuggestion;
  const confirmedTags =
    organization?.tags.filter((tag) => tag.status === "confirmed") ?? [];
  const pendingTags =
    organization?.tags.filter((tag) => tag.status === "pending") ?? [];
  const visibleRelations =
    organization?.relations.filter(
      (relation) => relation.status !== "dismissed",
    ) ?? [];
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        aria-modal="true"
        className="source-maintenance-dialog"
        role="dialog"
      >
        <header className="settings-heading">
          <div>
            <p className="eyebrow">Source Maintenance</p>
            <h2>{value.source.displayName}</h2>
            <span>
              当前 v{value.source.currentVersionNumber} ·{" "}
              {expiryStatusLabel(value.source.expiryStatus)}
            </span>
          </div>
          <button
            aria-label="关闭来源版本维护"
            className="icon-button"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            <Icon name="close" size={17} />
          </button>
        </header>

        <div className="source-maintenance-body">
          <section className="source-maintenance-settings">
            <label>
              <span>时效状态</span>
              <select
                value={form.expiryStatus}
                onChange={(event) =>
                  onFormChange({
                    ...form,
                    expiryStatus: event.target
                      .value as KnowledgeBaseSource["expiryStatus"],
                  })
                }
              >
                <option value="active">有效</option>
                <option value="expired">已过期</option>
                <option value="replaced">已替代</option>
              </select>
            </label>
            <label>
              <span>复查时间</span>
              <input
                type="datetime-local"
                value={form.reviewAt}
                onChange={(event) =>
                  onFormChange({ ...form, reviewAt: event.target.value })
                }
              />
            </label>
            <label>
              <span>替代文档</span>
              <select
                value={form.replacementSourceId}
                onChange={(event) =>
                  onFormChange({
                    ...form,
                    replacementSourceId: event.target.value,
                  })
                }
              >
                <option value="">未指定</option>
                {sources
                  .filter((source) => source.id !== value.source.id)
                  .map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.displayName}
                    </option>
                  ))}
              </select>
            </label>
            <button
              className="button ghost"
              disabled={busy}
              type="button"
              onClick={onSave}
            >
              保存维护设置
            </button>
            {value.source.sourceType === "web" && (
              <button
                className="button primary"
                disabled={busy}
                type="button"
                onClick={onCheck}
              >
                <Icon name="refresh" size={15} />
                检查网页更新
              </button>
            )}
          </section>

          {suggestion?.status === "pending_confirmation" && (
            <section className="source-suggestion">
              <strong>
                待确认建议：{sourceSuggestionLabel(suggestion.suggestion)}
              </strong>
              <span>{suggestion.reason}</span>
              <small>置信度 {Math.round(suggestion.confidence * 100)}%</small>
              <div>
                <button
                  className="text-button"
                  disabled={busy}
                  type="button"
                  onClick={() => onDecideSuggestion("dismiss")}
                >
                  忽略
                </button>
                <button
                  className="button ghost"
                  disabled={busy}
                  type="button"
                  onClick={() => onDecideSuggestion("accept")}
                >
                  确认建议
                </button>
              </div>
            </section>
          )}

          <section className="source-organization-section">
            <div className="source-version-heading">
              <strong>规则分类</strong>
              <button
                className="text-button"
                disabled={busy}
                type="button"
                onClick={onClassify}
              >
                重新分析
              </button>
            </div>
            {organization?.classification ? (
              <>
                <div className="source-classification-grid">
                  <div>
                    <span>分类</span>
                    <strong>{organization.classification.category}</strong>
                  </div>
                  <div>
                    <span>标题</span>
                    <strong>
                      {organization.classification.title || "未识别"}
                    </strong>
                  </div>
                  <div>
                    <span>作者</span>
                    <strong>
                      {organization.classification.author || "未识别"}
                    </strong>
                  </div>
                  <div>
                    <span>文档时间</span>
                    <strong>
                      {organization.classification.documentTime || "未识别"}
                    </strong>
                  </div>
                </div>
                {organization.classification.ruleBasis.rules &&
                  organization.classification.ruleBasis.rules.length > 0 && (
                    <p className="source-organization-basis">
                      分类依据：
                      {organization.classification.ruleBasis.rules
                        .map((rule) => `${rule.field}=${rule.value}`)
                        .join(" · ")}
                    </p>
                  )}
              </>
            ) : (
              <p className="source-organization-empty">正在读取分类结果...</p>
            )}
          </section>

          <section className="source-organization-section">
            <div className="source-version-heading">
              <strong>主题标签</strong>
              <button
                className="button ghost"
                disabled={busy}
                type="button"
                onClick={onSuggestTags}
              >
                <Icon name="sparkle" size={14} />
                生成标签建议
              </button>
            </div>
            {confirmedTags.length > 0 && (
              <div className="source-confirmed-tags">
                {confirmedTags.map((tag) => (
                  <span key={tag.id}>{tag.tag}</span>
                ))}
              </div>
            )}
            {pendingTags.length > 0 ? (
              <div className="source-tag-suggestions">
                {pendingTags.map((tag) => (
                  <article key={tag.id}>
                    <div>
                      <input
                        aria-label={`修改标签 ${tag.tag}`}
                        disabled={busy}
                        value={tagDrafts[tag.id] ?? tag.tag}
                        onChange={(event) =>
                          onTagDraftChange(tag.id, event.target.value)
                        }
                      />
                      <span>
                        {tag.origin === "correction" ? "已复用历史修正 · " : ""}
                        置信度 {Math.round(tag.confidence * 100)}%
                      </span>
                      <small>{tag.reason || "模型根据正文主题生成"}</small>
                    </div>
                    <div>
                      <button
                        className="text-button danger-text"
                        disabled={busy}
                        type="button"
                        onClick={() => onDecideTag(tag.id, "dismiss")}
                      >
                        忽略
                      </button>
                      <button
                        className="button ghost"
                        disabled={busy}
                        type="button"
                        onClick={() => onDecideTag(tag.id, "confirm")}
                      >
                        确认
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              confirmedTags.length === 0 && (
                <p className="source-organization-empty">
                  尚无标签，生成建议后可确认、修改或忽略。
                </p>
              )
            )}
          </section>

          <section className="source-organization-section">
            <div className="source-version-heading">
              <strong>来源关联</strong>
              <span>{visibleRelations.length} 个候选关联</span>
            </div>
            {visibleRelations.length > 0 ? (
              <div className="source-relation-list">
                {visibleRelations.map((relation) => (
                  <article key={relation.id}>
                    <div>
                      <strong>{relation.relatedDisplayName}</strong>
                      <span>
                        {sourceRelationLabel(relation.relationType)} · 置信度{" "}
                        {Math.round(relation.confidence * 100)}% ·{" "}
                        {sourceRelationStatusLabel(relation.status)}
                      </span>
                      <small>
                        {relation.basis.reason || "根据来源内容生成关联"}
                      </small>
                      {relation.basis.sharedKeywords &&
                        relation.basis.sharedKeywords.length > 0 && (
                          <small>
                            共享关键词：
                            {relation.basis.sharedKeywords.join("、")}
                          </small>
                        )}
                      {relation.basis.textSimilarity !== undefined && (
                        <small>
                          正文相似{" "}
                          {Math.round(relation.basis.textSimilarity * 100)}% ·
                          标题相似{" "}
                          {Math.round(
                            (relation.basis.titleSimilarity ?? 0) * 100,
                          )}
                          % · 关键词相似{" "}
                          {Math.round(
                            (relation.basis.tokenSimilarity ?? 0) * 100,
                          )}
                          %
                        </small>
                      )}
                    </div>
                    {relation.status === "pending" && (
                      <div>
                        <button
                          className="text-button danger-text"
                          disabled={busy}
                          type="button"
                          onClick={() =>
                            onDecideRelation(relation.id, "dismiss")
                          }
                        >
                          忽略
                        </button>
                        <button
                          className="button ghost"
                          disabled={busy}
                          type="button"
                          onClick={() =>
                            onDecideRelation(relation.id, "confirm")
                          }
                        >
                          确认关联
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <p className="source-organization-empty">
                未发现精确重复或近似重复来源。
              </p>
            )}
          </section>

          {error && <div className="settings-error">{error}</div>}

          <section className="source-version-section">
            <div className="source-version-heading">
              <strong>版本记录</strong>
              <span>{value.versions.length} 个版本</span>
            </div>
            <div className="source-version-list">
              {value.versions.map((version) => (
                <article key={version.id}>
                  <div>
                    <strong>
                      v{version.versionNumber} ·{" "}
                      {sourceVersionReviewLabel(version.reviewStatus)}
                    </strong>
                    <small>
                      {version.checkedAt
                        ? `检查于 ${formatDateTime(version.checkedAt)}`
                        : formatDateTime(version.createdAt)}
                    </small>
                    {version.etag && <small>ETag {version.etag}</small>}
                    {version.changeSummary.afterBlockCount !== undefined && (
                      <span>
                        +{version.changeSummary.addedBlocks ?? 0} / -
                        {version.changeSummary.removedBlocks ?? 0} / 未变{" "}
                        {version.changeSummary.unchangedBlocks ?? 0}
                      </span>
                    )}
                  </div>
                  <div className="source-version-actions">
                    {version.previousVersionId && (
                      <button
                        className="text-button"
                        disabled={busy}
                        type="button"
                        onClick={() => onInspectDiff(version.id)}
                      >
                        查看差异
                      </button>
                    )}
                    {version.reviewStatus === "pending_review" && (
                      <>
                        <button
                          className="text-button danger-text"
                          disabled={busy}
                          type="button"
                          onClick={() =>
                            onDecideVersion(version.id, "reject", false)
                          }
                        >
                          忽略
                        </button>
                        <button
                          className="button ghost"
                          disabled={busy}
                          type="button"
                          onClick={() =>
                            onDecideVersion(version.id, "accept", false)
                          }
                        >
                          采用
                        </button>
                        <button
                          className="button primary"
                          disabled={busy}
                          type="button"
                          onClick={() =>
                            onDecideVersion(version.id, "accept", true)
                          }
                        >
                          采用并重建索引
                        </button>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>

          {diff && (
            <section className="source-version-diff">
              <div>
                <strong>版本差异</strong>
                <button
                  aria-label="关闭版本差异"
                  className="icon-button"
                  type="button"
                  onClick={onCloseDiff}
                >
                  <Icon name="close" size={15} />
                </button>
              </div>
              <pre>
                {diff.diff || "正文结构发生变化，但没有可展示的行级差异。"}
              </pre>
            </section>
          )}
        </div>
      </section>
    </div>
  );
}

function ConfirmActionDialog({
  action,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  action: ConfirmAction;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: () => void;
}): React.JSX.Element {
  const content =
    action.kind === "delete-source"
      ? {
          eyebrow: "Source",
          title: "删除已导入来源",
          description: `将删除“${action.source.displayName}”的文件副本、解析产物、文本块、向量和历史引用。此操作无法撤销。`,
          submitLabel: "删除来源",
          busyLabel: "删除中...",
          danger: true,
        }
      : action.kind === "delete-conversation"
        ? {
            eyebrow: "Conversation",
            title: "删除历史对话",
            description: `将删除“${action.conversation.title}”及其全部消息和引用记录。此操作无法撤销。`,
            submitLabel: "删除对话",
            busyLabel: "删除中...",
            danger: true,
          }
        : action.kind === "delete-index"
          ? {
              eyebrow: "Index",
              title: "删除当前知识库索引",
              description:
                "将删除关键词索引、向量索引和文本块，但保留已导入来源与解析产物，之后可直接重新构建。",
              submitLabel: "删除索引",
              busyLabel: "删除中...",
              danger: true,
            }
          : {
              eyebrow: "Index",
              title: "重构当前知识库索引",
              description:
                "将使用当前解析结果和 Ark Embedding 模型构建新版本；成功前，现有索引仍可继续检索。",
              submitLabel: "开始重构",
              busyLabel: "重构中...",
              danger: false,
            };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="kb-dialog" role="dialog" aria-modal="true">
        <header className="settings-heading">
          <div>
            <p className="eyebrow">{content.eyebrow}</p>
            <h2>{content.title}</h2>
            <span>{content.description}</span>
          </div>
          <button
            aria-label="关闭确认弹窗"
            className="icon-button"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            <Icon name="close" size={17} />
          </button>
        </header>
        {error && <div className="settings-error">{error}</div>}
        <div className="settings-actions confirm-actions">
          <button
            className="button ghost"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className={`button ${content.danger ? "danger" : "primary"}`}
            disabled={busy}
            type="button"
            onClick={onSubmit}
          >
            {busy ? content.busyLabel : content.submitLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function WebImportDialog({
  busy,
  error,
  form,
  onClose,
  onFormChange,
  onSubmit,
}: {
  busy: boolean;
  error: string;
  form: { url: string; displayName: string };
  onClose: () => void;
  onFormChange: (next: { url: string; displayName: string }) => void;
  onSubmit: () => void;
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="kb-dialog" role="dialog" aria-modal="true">
        <header className="settings-heading">
          <div>
            <p className="eyebrow">Web Source</p>
            <h2>导入网页链接</h2>
            <span>
              优先使用正文提取器；静态正文不足时会尝试 Playwright 动态网页兜底。
            </span>
          </div>
          <button
            aria-label="关闭网页导入"
            className="icon-button"
            type="button"
            onClick={onClose}
          >
            <Icon name="close" size={17} />
          </button>
        </header>
        <div className="kb-dialog-body">
          <label>
            <span>网页 URL</span>
            <input
              placeholder="https://example.com/article"
              value={form.url}
              onChange={(event) =>
                onFormChange({ ...form, url: event.target.value })
              }
            />
          </label>
          <label>
            <span>显示名称</span>
            <input
              placeholder="可选"
              value={form.displayName}
              onChange={(event) =>
                onFormChange({ ...form, displayName: event.target.value })
              }
            />
          </label>
          {error && <div className="settings-error">{error}</div>}
        </div>
        <div className="settings-actions">
          <button
            className="button ghost"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="button primary"
            disabled={busy || !form.url.trim()}
            type="button"
            onClick={onSubmit}
          >
            {busy ? "导入中..." : "导入网页"}
          </button>
        </div>
      </section>
    </div>
  );
}

function KnowledgeBaseDialog({
  activeKnowledgeBase,
  busy,
  error,
  form,
  mode,
  onClose,
  onFormChange,
  onSubmit,
}: {
  activeKnowledgeBase?: KnowledgeBaseRecord;
  busy: boolean;
  error: string;
  form: { name: string; description: string; confirmName: string };
  mode: KnowledgeBaseDialogMode;
  onClose: () => void;
  onFormChange: (next: {
    name: string;
    description: string;
    confirmName: string;
  }) => void;
  onSubmit: () => void;
}): React.JSX.Element {
  const deleting = mode === "delete";
  const title =
    mode === "create"
      ? "新建知识库"
      : mode === "rename"
        ? "重命名知识库"
        : "删除知识库";
  const disabled =
    busy ||
    (deleting
      ? form.confirmName !== activeKnowledgeBase?.name
      : !form.name.trim());

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="kb-dialog" role="dialog" aria-modal="true">
        <header className="settings-heading">
          <div>
            <p className="eyebrow">Knowledge Base</p>
            <h2>{title}</h2>
            <span>
              {deleting
                ? "删除会级联移除该知识库下的来源、索引、对话和引用。"
                : "知识库用于隔离来源、索引、对话与后续引用证据。"}
            </span>
          </div>
          <button
            aria-label="关闭知识库弹窗"
            className="icon-button"
            type="button"
            onClick={onClose}
          >
            <Icon name="close" size={17} />
          </button>
        </header>
        <div className="kb-dialog-body">
          {deleting ? (
            <label>
              <span>
                输入 <strong>{activeKnowledgeBase?.name}</strong> 确认删除
              </span>
              <input
                value={form.confirmName}
                onChange={(event) =>
                  onFormChange({ ...form, confirmName: event.target.value })
                }
              />
            </label>
          ) : (
            <>
              <label>
                <span>知识库名称</span>
                <input
                  value={form.name}
                  onChange={(event) =>
                    onFormChange({ ...form, name: event.target.value })
                  }
                />
              </label>
              <label>
                <span>描述</span>
                <input
                  value={form.description}
                  placeholder="可选"
                  onChange={(event) =>
                    onFormChange({ ...form, description: event.target.value })
                  }
                />
              </label>
            </>
          )}
          {error && <div className="settings-error">{error}</div>}
        </div>
        <div className="settings-actions">
          <button
            className="button ghost"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className={`button ${deleting ? "danger" : "primary"}`}
            disabled={disabled}
            type="button"
            onClick={onSubmit}
          >
            {busy ? "处理中..." : title}
          </button>
        </div>
      </section>
    </div>
  );
}

function SeedSettingsModal({
  busy,
  error,
  form,
  status,
  maintenanceBusy,
  maintenanceNotice,
  maintenanceStatus,
  usageSummary,
  onCleanup,
  onClose,
  onDelete,
  onFormChange,
  onReload,
  onSave,
  onSaveDefaults,
  onValidate,
}: {
  busy: boolean;
  error: string;
  form: {
    name: string;
    apiKey: string;
    defaultChatModel: string;
    defaultEmbeddingModel: string;
  };
  status: SeedCredentialStatus | null;
  maintenanceBusy: boolean;
  maintenanceNotice: string;
  maintenanceStatus: MaintenanceStatus | null;
  usageSummary: UsageSummary | null;
  onCleanup: () => void;
  onClose: () => void;
  onDelete: () => void;
  onFormChange: (next: {
    name: string;
    apiKey: string;
    defaultChatModel: string;
    defaultEmbeddingModel: string;
  }) => void;
  onReload: () => void;
  onSave: () => void;
  onSaveDefaults: () => void;
  onValidate: () => void;
}): React.JSX.Element {
  const configured = Boolean(status?.configured);
  const models = status?.models.length ? status.models : FALLBACK_SEED_MODELS;

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="settings-modal" role="dialog" aria-modal="true">
        <header className="settings-heading">
          <div>
            <p className="eyebrow">Seed API</p>
            <h2>配置火山方舟 Ark API</h2>
            <span>
              Key 会在 Electron Main 中加密保存，前端只显示掩码和验证状态。
            </span>
          </div>
          <button
            aria-label="关闭设置"
            className="icon-button"
            type="button"
            onClick={onClose}
          >
            <Icon name="close" size={17} />
          </button>
        </header>

        <div className="settings-form">
          <label>
            <span>配置名称</span>
            <input
              value={form.name}
              onChange={(event) =>
                onFormChange({ ...form, name: event.target.value })
              }
            />
          </label>
          <label>
            <span>Ark API Key</span>
            <input
              type="password"
              value={form.apiKey}
              placeholder={
                configured
                  ? `已保存 ${status?.maskedKey ?? "加密 Key"}，输入新 Key 可覆盖`
                  : "粘贴 Ark API Key"
              }
              onChange={(event) =>
                onFormChange({ ...form, apiKey: event.target.value })
              }
            />
          </label>
          <label>
            <span>新对话默认模型</span>
            <select
              value={form.defaultChatModel}
              onChange={(event) =>
                onFormChange({
                  ...form,
                  defaultChatModel: event.target.value,
                })
              }
            >
              {models
                .filter((model) => model.role !== "embedding")
                .map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label} · {model.id}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <span>默认 Embedding 模型</span>
            <select
              value={form.defaultEmbeddingModel}
              onChange={(event) =>
                onFormChange({
                  ...form,
                  defaultEmbeddingModel: event.target.value,
                })
              }
            >
              {models
                .filter((model) => model.role === "embedding")
                .map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label} · {model.id}
                  </option>
                ))}
            </select>
          </label>
          <div className="seed-status-line">
            <span>Base URL</span>
            <strong>
              {status?.baseUrl ?? "https://ark.cn-beijing.volces.com/api/v3"}
            </strong>
          </div>
          <div className="seed-status-line">
            <span>safeStorage</span>
            <strong
              className={
                status
                  ? status.safeStorageAvailable
                    ? "online"
                    : "offline"
                  : "offline"
              }
            >
              {status
                ? status.safeStorageAvailable
                  ? "可用"
                  : "不可用"
                : "待连接"}
            </strong>
          </div>
        </div>

        {error && <div className="settings-error">{error}</div>}

        <div className="settings-actions">
          <button
            className="button primary"
            disabled={busy || !form.apiKey.trim()}
            type="button"
            onClick={onSave}
          >
            {busy ? "验证中..." : "保存并验证"}
          </button>
          <button
            className="button ghost"
            disabled={busy || !configured}
            type="button"
            onClick={onSaveDefaults}
          >
            保存默认模型
          </button>
          <button
            className="button ghost"
            disabled={busy || !configured}
            type="button"
            onClick={onValidate}
          >
            重新验证
          </button>
          <button
            className="button ghost"
            disabled={busy}
            type="button"
            onClick={onReload}
          >
            刷新状态
          </button>
          <button
            className="button danger"
            disabled={busy || !configured}
            type="button"
            onClick={onDelete}
          >
            删除配置
          </button>
        </div>

        <section className="operational-status">
          <div className="model-validation-heading">
            <strong>调用与存储</strong>
            <span>{usageSummary?.pricingNotice ?? "正在读取本地估算..."}</span>
          </div>
          <div className="operational-metrics">
            <span>
              <small>API 调用</small>
              <strong>{formatNumber(usageSummary?.calls.total ?? 0)}</strong>
            </span>
            <span>
              <small>估算 Token</small>
              <strong>
                {formatNumber(usageSummary?.estimatedTokens.total ?? 0)}
              </strong>
            </span>
            <span>
              <small>数据占用</small>
              <strong>{formatBytes(maintenanceStatus?.totalBytes ?? 0)}</strong>
            </span>
            <span>
              <small>可回收索引</small>
              <strong>{maintenanceStatus?.recyclableIndexCount ?? 0}</strong>
            </span>
            <span>
              <small>可回收旧版本</small>
              <strong>
                {maintenanceStatus?.recyclableSourceVersionCount ?? 0}
              </strong>
            </span>
            <button
              className="button ghost"
              disabled={maintenanceBusy}
              type="button"
              onClick={onCleanup}
            >
              <Icon name="trash" size={14} />
              {maintenanceBusy ? "清理中..." : "立即清理"}
            </button>
          </div>
          <div className="quality-metric-strip">
            <span>
              <small>解析成功率</small>
              <strong>
                {formatMetricPercent(
                  maintenanceStatus?.qualityMetrics.parseSuccessRate,
                )}
              </strong>
            </span>
            <span>
              <small>平均索引耗时</small>
              <strong>
                {formatMetricDuration(
                  maintenanceStatus?.qualityMetrics.indexDurationMs,
                )}
              </strong>
            </span>
            <span>
              <small>平均检索延迟</small>
              <strong>
                {formatMetricDuration(
                  maintenanceStatus?.qualityMetrics.retrievalLatencyMs,
                )}
              </strong>
            </span>
            <span>
              <small>回答首 Token</small>
              <strong>
                {formatMetricDuration(
                  maintenanceStatus?.qualityMetrics.firstTokenLatencyMs,
                )}
              </strong>
            </span>
            <span>
              <small>引用失败率</small>
              <strong>
                {formatMetricPercent(
                  maintenanceStatus?.qualityMetrics.citationFailureRate,
                )}
              </strong>
            </span>
            <span>
              <small>Embedding 调用 / 重试</small>
              <strong>
                {formatNumber(
                  maintenanceStatus?.qualityMetrics.embeddingCalls ?? 0,
                )}{" "}
                /{" "}
                {formatNumber(
                  maintenanceStatus?.qualityMetrics.embeddingRetries ?? 0,
                )}
              </strong>
            </span>
          </div>
          {maintenanceNotice && (
            <p className="maintenance-notice">{maintenanceNotice}</p>
          )}
        </section>

        <section className="model-validation">
          <div className="model-validation-heading">
            <strong>默认 Seed 模型权限</strong>
            <span>
              {configured ? "已绑定当前 Ark Key" : "保存 Key 后执行验证"}
            </span>
          </div>
          <div className="model-list">
            {models.map((model) => (
              <ModelValidationCard
                key={`${model.role}:${model.id}`}
                capability={findCapability(status?.capabilities ?? [], model)}
                model={model}
              />
            ))}
          </div>
        </section>
      </section>
    </div>
  );
}

function ModelValidationCard({
  capability,
  model,
}: {
  capability?: ModelCapabilityStatus;
  model: SeedModelDescriptor;
}): React.JSX.Element {
  const status = capability?.status ?? "unknown";
  return (
    <article className="model-card">
      <div>
        <strong>{model.label}</strong>
        <span>{model.id}</span>
        <small>{model.capabilities.join(" · ")}</small>
      </div>
      <div className="model-card-meta">
        <span className={`validation-pill ${status}`}>
          {validationLabel(status)}
        </span>
        <small>{capabilityDetails(model, capability)}</small>
      </div>
    </article>
  );
}

function PanelHeader({
  icon,
  title,
  count,
  subtitle,
  action,
}: {
  icon: IconName;
  title: string;
  count?: number;
  subtitle?: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <header className="panel-header">
      <div>
        <Icon name={icon} size={18} />
        <strong>{title}</strong>
        {count !== undefined && <span className="count-badge">{count}</span>}
      </div>
      {subtitle && <small>{subtitle}</small>}
      {action ?? (
        <button
          aria-label={`${title}菜单`}
          className="icon-button"
          type="button"
        >
          <Icon name="menu" size={17} />
        </button>
      )}
    </header>
  );
}

function StatusRow({
  label,
  value,
  online,
}: {
  label: string;
  value: string;
  online: boolean;
}): React.JSX.Element {
  return (
    <div className="system-row">
      <span>{label}</span>
      <strong className={online ? "online" : "offline"}>{value}</strong>
    </div>
  );
}

function upsertAgentRun(
  runs: AgentRunRecord[],
  run: AgentRunRecord,
): AgentRunRecord[] {
  return [run, ...runs.filter((item) => item.id !== run.id)];
}

function upsertAgentRunEvent(
  events: AgentRunEventRecord[],
  event: AgentRunEventRecord,
): AgentRunEventRecord[] {
  return [...events.filter((item) => item.id !== event.id), event].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

function isAgentRunFinished(status: AgentRunRecord["status"]): boolean {
  return (
    status === "completed" || status === "cancelled" || status === "failed"
  );
}

function agentRunStatusLabel(status: AgentRunRecord["status"]): string {
  return {
    planning: "规划",
    waiting_confirmation: "等待确认",
    executing: "执行中",
    paused: "已暂停",
    completed: "已完成",
    cancelled: "已取消",
    failed: "失败",
  }[status];
}

function agentRunElapsedMs(run: AgentRunRecord, now: number): number {
  const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : now;
  const completedAt = run.completedAt
    ? new Date(run.completedAt).getTime()
    : now;
  if (Number.isNaN(startedAt) || Number.isNaN(completedAt)) {
    return 0;
  }
  return Math.max(0, completedAt - startedAt);
}

function eventStageId(event: AgentRunEventRecord): string {
  const stage = event.stage?.toLowerCase().replace(/[.-]/g, "_") ?? "";
  if (event.eventType === "run.created" || stage.includes("plan")) {
    return "planning";
  }
  if (
    stage.includes("retrieval") ||
    stage.includes("search") ||
    stage.includes("evidence")
  ) {
    return "evidence_retrieval";
  }
  if (stage.includes("source") || stage.includes("read")) {
    return "source_reading";
  }
  if (event.eventType.startsWith("tool_call") || stage.includes("tool")) {
    return "tool_calling";
  }
  if (stage.includes("draft") || stage.includes("write")) {
    return "drafting";
  }
  if (stage.includes("citation") || stage.includes("validate")) {
    return "citation_validation";
  }
  if (stage.includes("conflict") || stage.includes("audit")) {
    return "conflict_audit";
  }
  if (
    stage.includes("confirmation") ||
    event.eventType.startsWith("confirmation")
  ) {
    return "waiting_confirmation";
  }
  if (event.eventType.startsWith("output.final") || stage.includes("final")) {
    return "finalizing";
  }
  return stage || "planning";
}

function pendingConfirmations(
  confirmations: AgentRunConfirmationRecord[],
): number {
  return confirmations.filter((item) => item.status === "pending").length;
}

function traceEventTone(event: AgentRunEventRecord): string {
  if (event.eventType.includes("failed") || event.status === "failed") {
    return "failed";
  }
  if (event.eventType.includes("cancelled") || event.status === "cancelled") {
    return "cancelled";
  }
  if (
    event.eventType.includes("completed") ||
    event.eventType.includes("confirmed") ||
    event.eventType.includes("rejected")
  ) {
    return "completed";
  }
  if (event.eventType.includes("requested")) {
    return "waiting";
  }
  return "running";
}

function traceEventSymbol(event: AgentRunEventRecord): string {
  const tone = traceEventTone(event);
  if (tone === "completed") {
    return "✓";
  }
  if (tone === "failed") {
    return "!";
  }
  if (tone === "waiting") {
    return "?";
  }
  return "›";
}

function traceEventMeta(event: AgentRunEventRecord): string {
  const duration =
    event.durationMs !== null ? ` · ${formatDurationMs(event.durationMs)}` : "";
  return `#${event.sequence} · ${event.eventType}${duration}`;
}

function upsertConversation(
  conversations: ConversationRecord[],
  conversation: ConversationRecord,
): ConversationRecord[] {
  return [
    conversation,
    ...conversations.filter((item) => item.id !== conversation.id),
  ];
}

function uniqueMessages(
  messages: ConversationMessageRecord[],
): ConversationMessageRecord[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) {
      return false;
    }
    seen.add(message.id);
    return true;
  });
}

function createPendingMessageId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function isPendingAssistantMessage(
  message: ConversationMessageRecord,
): boolean {
  return message.id.startsWith(PENDING_ASSISTANT_MESSAGE_PREFIX);
}

function citationsForParagraph(
  citations: AnswerCitation[],
  paragraphIndex: number,
  evidenceChunkIds: string[],
): AnswerCitation[] {
  const evidenceIds = new Set(evidenceChunkIds);
  return uniqueCitations(
    citations.filter(
      (citation) =>
        citation.paragraphIndex === paragraphIndex ||
        evidenceIds.has(citation.chunkId),
    ),
  );
}

function citationNumberMap(citations: AnswerCitation[]): Map<string, number> {
  const numbers = new Map<string, number>();
  uniqueCitations(citations).forEach((citation, index) => {
    numbers.set(citationKey(citation), index + 1);
  });
  return numbers;
}

function uniqueCitations(citations: AnswerCitation[]): AnswerCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = citationKey(citation);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function citationKey(citation: AnswerCitation): string {
  return citation.chunkId;
}

function splitCitationTail(text: string): { body: string; tail: string } {
  const trimmedLength = text.trimEnd().length;
  let body = text.slice(0, trimmedLength);
  const trailingWhitespace = text.slice(trimmedLength);
  let tail = "";
  while (body && isCitationTailMark(body.charAt(body.length - 1))) {
    tail = `${body.charAt(body.length - 1)}${tail}`;
    body = body.slice(0, -1);
  }
  return { body, tail: `${tail}${trailingWhitespace}` };
}

function isCitationTailMark(value: string): boolean {
  return "。！？!?；;：:，,、.\"'”’)]）】".includes(value);
}

function retrievalResultForCitation(
  response: ConversationAnswerResponse,
  citation: AnswerCitation,
): HybridSearchResult | undefined {
  return response.retrieval.results.find(
    (result) => result.chunkId === citation.chunkId,
  );
}

function selectedEvidenceChunkId(
  selection: EvidenceSelection | null,
): string | undefined {
  if (!selection) {
    return undefined;
  }
  return selection.kind === "citation"
    ? selection.citation.chunkId
    : selection.result.chunkId;
}

function evidenceSourceId(selection: EvidenceSelection | null): string | null {
  if (!selection) {
    return null;
  }
  return selection.kind === "citation"
    ? selection.citation.source.id
    : selection.result.source.id;
}

function evidenceDisplayName(selection: EvidenceSelection): string {
  return selection.kind === "citation"
    ? selection.citation.source.displayName
    : selection.result.source.displayName;
}

function evidenceLocationLabel(selection: EvidenceSelection): string {
  return selection.kind === "citation"
    ? formatLocation(
        selection.citation.source.type,
        selection.citation.location,
      )
    : formatLocation(selection.result.source.type, selection.result.location);
}

function sourceToneFromType(
  type: KnowledgeBaseSource["sourceType"],
): SourceTone {
  const tones: Record<KnowledgeBaseSource["sourceType"], SourceTone> = {
    pdf: "amber",
    docx: "blue",
    image: "green",
    web: "violet",
  };
  return tones[type];
}

function citationQuote(citation: AnswerCitation): string {
  return (
    citation.text.original ??
    citation.text.normalized ??
    citation.text.preview ??
    "引用原文为空"
  );
}

function resultQuote(result: HybridSearchResult): string {
  return result.text.original || result.text.normalized || result.text.preview;
}

function evidenceStrength(result?: HybridSearchResult): string {
  if (!result) {
    return "已校验";
  }
  if (result.ranks.fused <= 3 && result.match.matchedBy.length >= 2) {
    return "高";
  }
  if (result.ranks.fused <= 8) {
    return "中";
  }
  return "低";
}

function retrievalLabel(result?: HybridSearchResult): string {
  if (!result) {
    return "检索信息未加载";
  }
  return `融合排名 #${result.ranks.fused}`;
}

function matchLabel(result?: HybridSearchResult): string {
  if (!result) {
    return "历史引用";
  }
  const matchedBy = result.match.matchedBy
    .map((item) => (item === "keyword" ? "关键词" : "语义"))
    .join("+");
  if (result.match.keywordHits.length > 0) {
    return `${matchedBy} · ${result.match.keywordHits.slice(0, 2).join("/")}`;
  }
  return matchedBy || "召回";
}

function formatLocation(
  sourceType: KnowledgeBaseSource["sourceType"],
  location: HybridSearchResult["location"],
): string {
  if (sourceType === "pdf") {
    const page =
      location.pageNumber === null
        ? "页码缺失"
        : `第 ${location.pageNumber} 页`;
    const box = location.boundingBox ? " · bbox" : "";
    return `${page}${box}`;
  }
  if (sourceType === "docx") {
    return location.headingPath.length > 0
      ? location.headingPath.join(" / ")
      : location.anchor
        ? `段落 ${location.anchor}`
        : "段落锚点缺失";
  }
  if (sourceType === "web") {
    return location.headingPath.length > 0
      ? location.headingPath.join(" / ")
      : location.anchor
        ? `快照块 ${location.anchor}`
        : "快照文本块缺失";
  }
  return location.boundingBox
    ? `OCR 区域 ${formatBoundingBox(location.boundingBox)}`
    : location.anchor
      ? `OCR ${location.anchor}`
      : "OCR 区域缺失";
}

function locationRows(
  sourceType: KnowledgeBaseSource["sourceType"],
  location: HybridSearchResult["location"],
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [
    { label: "定位方式", value: formatLocation(sourceType, location) },
  ];
  if (sourceType === "pdf" && location.pageNumber !== null) {
    rows.push({ label: "页码", value: String(location.pageNumber) });
  }
  if (location.headingPath.length > 0) {
    rows.push({ label: "标题路径", value: location.headingPath.join(" / ") });
  }
  if (location.anchor) {
    rows.push({ label: "锚点", value: location.anchor });
  }
  if (location.boundingBox) {
    rows.push({
      label: "高亮区域",
      value: formatBoundingBox(location.boundingBox),
    });
  }
  return rows;
}

function formatBoundingBox(box: Record<string, unknown>): string {
  const entries = ["x", "y", "width", "height"]
    .map((key) => {
      const value = box[key];
      return typeof value === "number" ? `${key}:${value}` : "";
    })
    .filter(Boolean);
  return entries.length > 0 ? entries.join(" ") : JSON.stringify(box);
}

function findCapability(
  capabilities: ModelCapabilityStatus[],
  model: SeedModelDescriptor,
): ModelCapabilityStatus | undefined {
  return capabilities.find(
    (capability) =>
      capability.modelId === model.id && capability.role === model.role,
  );
}

function validationLabel(status: ModelValidationStatus): string {
  const labels: Record<ModelValidationStatus, string> = {
    unknown: "未验证",
    callable: "可调用",
    not_enabled: "未开通",
    unauthorized: "无权限",
    rate_limited: "限流",
    failed: "失败",
  };
  return labels[status];
}

function capabilityDetails(
  model: SeedModelDescriptor,
  capability?: ModelCapabilityStatus,
): string {
  if (!capability) {
    return model.vectorDimension
      ? `${model.vectorDimension} 维 · 待验证`
      : "待验证";
  }
  const values = capability.capability;
  if (typeof values.vectorDimension === "number") {
    const vision =
      typeof values.visionEmbedding === "string"
        ? ` · 视觉 ${values.visionEmbedding === "callable" ? "可用" : "待确认"}`
        : "";
    return `${values.vectorDimension} 维${vision}`;
  }
  if (typeof values.structuredOutput === "string") {
    const vision =
      typeof values.vision === "string"
        ? ` · 视觉 ${values.vision === "callable" ? "可用" : "待确认"}`
        : "";
    return `结构化 ${values.structuredOutput}${vision}`;
  }
  return capability.message ?? "已验证";
}

function emptyKnowledgeBaseSummary(): KnowledgeBaseRecord["summary"] {
  return {
    sourceCount: 0,
    sourcesByStatus: {},
    readyIndexCount: 0,
    conversationCount: 0,
    chunkCount: 0,
  };
}

function sourceTone(source: KnowledgeBaseSource): SourceTone {
  if (source.status === "failed") {
    return "violet";
  }
  const tones: Record<KnowledgeBaseSource["sourceType"], SourceTone> = {
    pdf: "amber",
    docx: "blue",
    image: "green",
    web: "violet",
  };
  return tones[source.sourceType];
}

function sourceMeta(source: KnowledgeBaseSource): string {
  const chunks = source.chunkCount > 0 ? ` · ${source.chunkCount} 块` : "";
  const version =
    source.latestVersionStatus && source.latestVersionStatus !== source.status
      ? ` · ${sourceStatusLabel(source.latestVersionStatus)}`
      : "";
  const pending =
    source.pendingVersionCount > 0
      ? ` · ${source.pendingVersionCount} 个更新`
      : "";
  const expiry =
    source.expiryStatus !== "active"
      ? ` · ${expiryStatusLabel(source.expiryStatus)}`
      : "";
  return `${sourceTypeLabel(source.sourceType)} · ${sourceStatusLabel(source.status)}${version}${pending}${expiry}${chunks}`;
}

function expiryStatusLabel(
  status: KnowledgeBaseSource["expiryStatus"],
): string {
  return {
    active: "有效",
    expired: "已过期",
    replaced: "已替代",
  }[status];
}

function sourceSuggestionLabel(suggestion: "expired" | "conflict"): string {
  return suggestion === "expired" ? "可能已过期" : "可能存在冲突";
}

function sourceVersionReviewLabel(status: string): string {
  return (
    {
      current: "当前版本",
      pending_review: "待确认",
      superseded: "历史版本",
      rejected: "已忽略",
    }[status] ?? status
  );
}

function sourceRelationLabel(
  type: SourceOrganizationResponse["relations"][number]["relationType"],
): string {
  return {
    duplicate: "精确重复",
    near_duplicate: "近似重复",
    related: "相关资料",
    supplements: "补充资料",
    conflicts: "内容冲突",
    replaces: "替代资料",
  }[type];
}

function sourceRelationStatusLabel(
  status: SourceOrganizationResponse["relations"][number]["status"],
): string {
  return {
    pending: "待确认",
    confirmed: "已确认",
    dismissed: "已忽略",
  }[status];
}

function toLocalDateTime(value: string | null): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fromLocalDateTime(value: string): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sourceTypeLabel(type: KnowledgeBaseSource["sourceType"]): string {
  const labels: Record<KnowledgeBaseSource["sourceType"], string> = {
    pdf: "PDF",
    docx: "DOCX",
    image: "图片",
    web: "网页",
  };
  return labels[type];
}

function sourceStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "待处理",
    processing: "处理中",
    parsed: "已解析",
    needs_ocr: "需要 OCR",
    duplicate: "重复",
    skipped: "已跳过",
    linked: "已关联",
    ready: "可用",
    failed: "失败",
    paused: "已暂停",
    retrying: "重试中",
    completed: "已完成",
  };
  return labels[status] ?? status;
}

function parseStatusLabel(status: ParseCheckItem["status"]): string {
  const labels: Record<ParseCheckItem["status"], string> = {
    success: "成功",
    needs_ocr: "需要 OCR",
    failed: "失败",
    duplicate: "重复",
    skipped: "已跳过",
    linked: "已关联",
    processing: "处理中",
  };
  return labels[status];
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatDurationMs(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const parts = hours > 0 ? [hours, minutes, rest] : [minutes, rest];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

function upsertWritingProject(
  projects: WritingProjectRecord[],
  value: WritingProjectRecord,
): WritingProjectRecord[] {
  return [value, ...projects.filter((project) => project.id !== value.id)].sort(
    (left, right) => right.updatedAt.localeCompare(left.updatedAt),
  );
}

function writingWorkflowLabel(value: WritingWorkflowType): string {
  return value === "review" ? "复习提纲" : "证据写作";
}

function writingStatusLabel(
  value: WritingProjectRecord["status"] | WritingSectionRecord["status"],
): string {
  const labels: Record<string, string> = {
    planning: "规划中",
    ready: "大纲就绪",
    pending: "待生成",
    running: "执行中",
    needs_review: "待检查",
    needs_revision: "待修订",
    completed: "已完成",
    failed: "可恢复",
  };
  return labels[value] ?? value;
}

function writingConflictLabel(value: Record<string, unknown>): string {
  if (
    typeof value.sourceDisplayName === "string" &&
    typeof value.relatedDisplayName === "string"
  ) {
    return `${value.sourceDisplayName} 与 ${value.relatedDisplayName} 存在已确认冲突`;
  }
  for (const key of ["reason", "basis", "summary", "message"]) {
    if (typeof value[key] === "string" && value[key]) {
      return value[key] as string;
    }
  }
  return "引用证据之间存在已确认冲突";
}

function writingCheckpointLabel(value: string): string {
  const labels: Record<string, string> = {
    outline: "证据大纲",
    prepare: "准备章节",
    retrieval: "检索证据",
    retrieve: "检索证据",
    draft: "生成草稿",
    audit: "引用检查",
    persist: "保存章节",
    workflow: "失败恢复点",
  };
  return labels[value] ?? value;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${unit}`;
}

function formatMetricPercent(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "暂无"
    : `${(value * 100).toFixed(1)}%`;
}

function formatMetricDuration(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "暂无";
  }
  return value >= 1000
    ? `${(value / 1000).toFixed(1)} s`
    : `${Math.round(value)} ms`;
}

function emptyParseSummary(): ParseCheckSummary {
  return {
    total: 0,
    success: 0,
    needsOcr: 0,
    failed: 0,
    duplicate: 0,
    processing: 0,
  };
}

function summarizeParseChecks(items: ParseCheckItem[]): ParseCheckSummary {
  return items.reduce<ParseCheckSummary>((summary, item) => {
    summary.total += 1;
    if (item.status === "needs_ocr") {
      summary.needsOcr += 1;
    } else if (item.status === "skipped" || item.status === "linked") {
      summary.success += 1;
    } else {
      summary[item.status] += 1;
    }
    return summary;
  }, emptyParseSummary());
}

function jobTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    "source.import": "导入与解析",
    "source.parse": "文档解析",
    ocr: "OCR",
    embedding: "Embedding",
    "index.build": "索引构建",
    "index.rebuild": "索引重建",
    "index.retry": "索引重试",
    "web.refresh": "网页更新",
  };
  return labels[type] ?? type;
}

function jobStatusLabel(status: BackgroundJobStatus): string {
  const labels: Record<BackgroundJobStatus, string> = {
    pending: "待执行",
    running: "运行中",
    completed: "已完成",
    paused: "已暂停",
    cancelled: "已取消",
    failed: "失败",
    retrying: "重试中",
  };
  return labels[status];
}

function jobStages(
  job: BackgroundJobRecord,
): BackgroundJobRecord["checkpoint"]["stages"] {
  const stages = Array.isArray(job.checkpoint.stages)
    ? job.checkpoint.stages
    : [];
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const stageTemplates: Array<
    Pick<BackgroundJobRecord["checkpoint"]["stages"][number], "id" | "label">
  > = [
    { id: "parse", label: "解析" },
    { id: "ocr", label: "OCR" },
    { id: "embedding", label: "Embedding" },
    { id: "index", label: "索引" },
  ];
  return stageTemplates.map((stage) => ({
    id: stage.id,
    label: stage.label,
    status: byId.get(stage.id)?.status ?? "pending",
    progress: byId.get(stage.id)?.progress ?? 0,
  }));
}

function jobCanCancel(status: BackgroundJobStatus): boolean {
  return !["completed", "cancelled"].includes(status);
}

export default App;
