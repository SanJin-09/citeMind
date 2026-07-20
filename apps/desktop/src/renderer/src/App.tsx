import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  AnswerCitation,
  AgentRunConfirmationRecord,
  AgentRunDelegationRecord,
  AgentRunEventRecord,
  AgentRunRecord,
  AgentRunResponse,
  AgentRunToolCallRecord,
  BackgroundJobRecord,
  ConversationAnswerResponse,
  ConversationMessageRecord,
  ConversationRecord,
  ConversationRouteHint,
  ExternalResearchCandidate,
  ExternalResearchResponse,
  HybridSearchResult,
  KnowledgeBaseRecord,
  KnowledgeBaseSource,
  MaintenanceStatus,
  McpServerRecord,
  McpToolDescriptor,
  ModelCapabilityStatus,
  ModelValidationStatus,
  ParseCheckItem,
  ResearchBriefAction,
  ResearchBriefResponse,
  ResearchBriefSummary,
  ResearchBriefWorkspace,
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
  | "copy"
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
  | { kind: "delete-seed-credential" }
  | { kind: "cleanup-storage"; status: MaintenanceStatus | null };

type AppNotificationTone = "success" | "info" | "error";

type AppNotificationActionKind =
  | "open-settings"
  | "open-tasks"
  | "retry-job"
  | "retry-file-import"
  | "retry-web-import";

interface AppNotificationAction {
  kind: AppNotificationActionKind;
  label: string;
  jobId?: string;
}

interface AppNotification {
  id: string;
  tone: AppNotificationTone;
  title: string;
  message: string;
  createdAt: number;
  persistent?: boolean;
  dismissed?: boolean;
  actions?: AppNotificationAction[];
}

type AppNotificationInput = Omit<
  AppNotification,
  "id" | "createdAt" | "dismissed"
>;

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

type ResearchEditorTab = "plan" | "outline" | "draft" | "final";

const SUGGESTIONS = [
  "总结当前知识库的核心架构决策",
  "为什么回答必须经过引用校验？",
  "比较关键词检索与向量检索的用途",
];

const PENDING_CONVERSATION_ID = "pending-conversation";
const PENDING_USER_MESSAGE_PREFIX = "pending-user:";
const PENDING_ASSISTANT_MESSAGE_PREFIX = "pending-assistant:";
const CHAT_BOTTOM_THRESHOLD_PX = 96;
const EVIDENCE_PANEL_OPEN_STORAGE_KEY = "citemind:evidence-panel-open";
const DIALOG_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

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
    copy: <path d="M9 9h11v11H9zM4 15H3V4h11v1M9 9l5-4M9 9 5 5M9 9H4" />,
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
  const [sourceFilter, setSourceFilter] = useState("");
  const [selectedSourceIds, setSelectedSourceIds] = useState(
    FALLBACK_SOURCES.map((source) => source.id),
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
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(
    null,
  );
  const [confirmError, setConfirmError] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notificationHistoryOpen, setNotificationHistoryOpen] = useState(false);
  const notificationIdRef = useRef(0);
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJobRecord[]>(
    [],
  );
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  const [taskActionBusyId, setTaskActionBusyId] = useState("");
  const automaticIndexBuildsRef = useRef(
    new Map<
      string,
      { jobId: string | null; context: string; queuedContext: string | null }
    >(),
  );
  const reportedJobNotificationsRef = useRef(new Set<string>());
  const [webImportOpen, setWebImportOpen] = useState(false);
  const [webImportForm, setWebImportForm] = useState({
    url: "",
    displayName: "",
  });
  const [externalResearchOpen, setExternalResearchOpen] = useState(false);
  const [externalResearchBusy, setExternalResearchBusy] = useState(false);
  const [externalResearchError, setExternalResearchError] = useState("");
  const [externalResearchQuery, setExternalResearchQuery] = useState("");
  const [externalResearchRunId, setExternalResearchRunId] = useState("");
  const [externalResearchConfirmationId, setExternalResearchConfirmationId] =
    useState("");
  const [externalResearchResult, setExternalResearchResult] =
    useState<ExternalResearchResponse | null>(null);
  const [externalCandidateIds, setExternalCandidateIds] = useState<string[]>(
    [],
  );
  const [mcpServers, setMcpServers] = useState<McpServerRecord[]>([]);
  const [selectedMcpServerId, setSelectedMcpServerId] = useState("");
  const [mcpTools, setMcpTools] = useState<McpToolDescriptor[]>([]);
  const [selectedMcpToolName, setSelectedMcpToolName] = useState("");
  const [mcpServerForm, setMcpServerForm] = useState({
    name: "",
    command: "",
    args: "",
    envKeys: "",
    readOnlyTools: "",
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
  const [agentRunTraces, setAgentRunTraces] = useState<
    Record<string, AgentRunResponse>
  >({});
  const pendingTraceMessageIdRef = useRef("");
  const [agentTraceBusyId, setAgentTraceBusyId] = useState("");
  const [agentTraceError, setAgentTraceError] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState("");
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatAutoScrollRef = useRef(true);
  const chatProgrammaticScrollRef = useRef(false);
  const [chatAtBottom, setChatAtBottom] = useState(true);
  const [exportBusyId, setExportBusyId] = useState("");
  const [exportNotice, setExportNotice] = useState("");
  const [chatModel, setChatModel] = useState<string>(
    SEED_DEFAULTS.defaultChatModel,
  );
  const [selectedEvidence, setSelectedEvidence] =
    useState<EvidenceSelection | null>(null);
  const [sourceJumpNotice, setSourceJumpNotice] = useState("");
  const [sourceOpenBusy, setSourceOpenBusy] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(() => {
    try {
      return (
        window.localStorage.getItem(EVIDENCE_PANEL_OPEN_STORAGE_KEY) !== "false"
      );
    } catch {
      return true;
    }
  });
  const [systemOpen, setSystemOpen] = useState(false);
  const [knowledgeBaseMenuOpen, setKnowledgeBaseMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
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
  const [researchArtifacts, setResearchArtifacts] = useState<
    Record<string, ResearchBriefResponse>
  >({});
  const [focusedResearchRunId, setFocusedResearchRunId] = useState("");
  const [researchEditorOpen, setResearchEditorOpen] = useState(false);
  const [researchExpandedRunIds, setResearchExpandedRunIds] = useState<
    string[]
  >([]);
  const [composerToolsOpen, setComposerToolsOpen] = useState(false);
  const [nextRouteHint, setNextRouteHint] =
    useState<ConversationRouteHint>("auto");
  const [researchBrief, setResearchBrief] =
    useState<ResearchBriefResponse | null>(null);
  const [researchWorkspace, setResearchWorkspace] =
    useState<ResearchBriefWorkspace | null>(null);
  const [researchLiveRun, setResearchLiveRun] =
    useState<AgentRunResponse | null>(null);
  const [researchEditorTab, setResearchEditorTab] =
    useState<ResearchEditorTab>("draft");
  const [researchPlanText, setResearchPlanText] = useState("");
  const [researchOutlineText, setResearchOutlineText] = useState("");
  const [researchSelectedSectionId, setResearchSelectedSectionId] =
    useState("");
  const [researchSelection, setResearchSelection] = useState("");
  const [researchBusy, setResearchBusy] = useState(false);
  const [researchError, setResearchError] = useState("");
  const [researchNotice, setResearchNotice] = useState("");
  const [researchSaveState, setResearchSaveState] = useState<
    "idle" | "saving" | "saved" | "conflict"
  >("idle");
  const researchEditSequenceRef = useRef(0);

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
        if (message.includes("Preload IPC")) {
          const fallback =
            FALLBACK_KNOWLEDGE_BASES.find((item) => item.id === preferredId) ??
            FALLBACK_KNOWLEDGE_BASES[0];
          setActiveKnowledgeBaseId(fallback?.id ?? "");
          setSources(FALLBACK_SOURCES);
          setSelectedSourceIds(FALLBACK_SOURCES.map((source) => source.id));
        } else {
          setKnowledgeBaseError(message);
        }
      }
    },
    [loadSources],
  );

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

  const syncResearchBrief = useCallback(
    (value: ResearchBriefResponse): void => {
      setResearchBrief(value);
      setResearchWorkspace(value.workspace);
      setResearchLiveRun(value.latestRun);
      setResearchPlanText(JSON.stringify(value.workspace.plan ?? {}, null, 2));
      setResearchOutlineText(
        JSON.stringify(value.workspace.outline ?? {}, null, 2),
      );
      setSelectedSourceIds(value.brief.sourceIds);
      setResearchSelectedSectionId((current) =>
        value.workspace.sections.some((section) => section.id === current)
          ? current
          : (value.workspace.sections[0]?.id ?? ""),
      );
      setResearchArtifacts((items) => ({
        ...items,
        [value.brief.runId]: value,
      }));
      setFocusedResearchRunId(value.brief.runId);
      setResearchSaveState("saved");
    },
    [],
  );

  const loadResearchBrief = useCallback(
    async (runId: string, openEditor = false): Promise<void> => {
      setResearchBusy(true);
      setResearchError("");
      setResearchNotice("");
      try {
        syncResearchBrief(await getDesktopApi().researchBriefs.get(runId));
        if (openEditor) {
          setResearchEditorOpen(true);
          setResearchEditorTab("final");
          setResearchSaveState("saved");
        }
      } catch (error) {
        setResearchError(
          error instanceof Error ? error.message : "研究简报读取失败",
        );
      } finally {
        setResearchBusy(false);
      }
    },
    [syncResearchBrief],
  );

  const loadResearchArtifacts = useCallback(
    async (
      conversationMessages: ConversationMessageRecord[],
    ): Promise<void> => {
      const runIds = Array.from(
        new Set(
          conversationMessages
            .map((message) => message.artifact?.runId)
            .filter((runId): runId is string => Boolean(runId)),
        ),
      );
      if (runIds.length === 0) {
        setResearchArtifacts({});
        setFocusedResearchRunId("");
        return;
      }
      const values = await Promise.all(
        runIds.map((runId) => getDesktopApi().researchBriefs.get(runId)),
      );
      setResearchArtifacts(
        Object.fromEntries(values.map((value) => [value.brief.runId, value])),
      );
      const latestRunId = [...conversationMessages]
        .reverse()
        .find((message) => message.artifact?.runId)?.artifact?.runId;
      setFocusedResearchRunId(latestRunId ?? runIds[runIds.length - 1] ?? "");
    },
    [],
  );

  const showAppNotification = useCallback((input: AppNotificationInput) => {
    setNotifications((items) => {
      notificationIdRef.current += 1;
      return [
        {
          ...input,
          id: `notification-${Date.now()}-${notificationIdRef.current}`,
          createdAt: Date.now(),
        },
        ...items,
      ].slice(0, 24);
    });
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((items) =>
      items.map((item) =>
        item.id === id ? { ...item, dismissed: true } : item,
      ),
    );
  }, []);

  const showAppError = useCallback(
    (
      message: string,
      options: {
        title?: string;
        actions?: AppNotificationAction[];
      } = {},
    ) => {
      showAppNotification({
        tone: "error",
        title: options.title ?? "操作失败",
        message,
        persistent: true,
        actions: options.actions,
      });
    },
    [showAppNotification],
  );

  const showSuccessNotification = useCallback(
    (
      title: string,
      message: string,
      actions: AppNotificationAction[] = [
        { kind: "open-tasks", label: "查看任务" },
      ],
    ) => {
      showAppNotification({
        tone: "success",
        title,
        message,
        actions,
      });
    },
    [showAppNotification],
  );

  const showInfoNotification = useCallback(
    (
      title: string,
      message: string,
      actions: AppNotificationAction[] = [
        { kind: "open-tasks", label: "查看任务" },
      ],
    ) => {
      showAppNotification({
        tone: "info",
        title,
        message,
        actions,
      });
    },
    [showAppNotification],
  );

  const clearNotificationHistory = useCallback(() => {
    setNotifications([]);
    setNotificationHistoryOpen(false);
  }, []);

  const updateChatScrollState = useCallback((element: HTMLDivElement): void => {
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    const atBottom = distanceFromBottom <= CHAT_BOTTOM_THRESHOLD_PX;
    setChatAtBottom(atBottom);
    if (atBottom) {
      chatAutoScrollRef.current = true;
      return;
    }
    if (!chatProgrammaticScrollRef.current) {
      chatAutoScrollRef.current = false;
    }
  }, []);

  const scrollChatToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth"): void => {
      const element = chatScrollRef.current;
      if (!element) {
        return;
      }
      chatAutoScrollRef.current = true;
      chatProgrammaticScrollRef.current = true;
      element.scrollTo({ top: element.scrollHeight, behavior });
      window.setTimeout(
        () => {
          chatProgrammaticScrollRef.current = false;
          if (chatScrollRef.current) {
            updateChatScrollState(chatScrollRef.current);
          }
        },
        behavior === "smooth" ? 360 : 0,
      );
    },
    [updateChatScrollState],
  );

  const handleChatScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>): void => {
      updateChatScrollState(event.currentTarget);
    },
    [updateChatScrollState],
  );

  const rememberBackgroundJob = useCallback((job: BackgroundJobRecord) => {
    setBackgroundJobs((items) => {
      const next = [job, ...items.filter((item) => item.id !== job.id)];
      return next
        .sort(
          (left, right) =>
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
        )
        .slice(0, 16);
    });
  }, []);

  const loadBackgroundJobs = useCallback(async (): Promise<void> => {
    try {
      const result = await getDesktopApi().jobs.list({
        includeTerminal: true,
        limit: 16,
      });
      setBackgroundJobs(result.jobs);
    } catch {
      // 任务中心是辅助入口，读取失败不阻断主流程。
    }
  }, []);

  const startAutomaticIndexBuild = useCallback(
    async (knowledgeBaseId: string, context: string): Promise<void> => {
      const current = automaticIndexBuildsRef.current.get(knowledgeBaseId);
      if (current) {
        current.queuedContext = context;
        return;
      }
      const trackedBuild: {
        jobId: string | null;
        context: string;
        queuedContext: string | null;
      } = {
        jobId: null,
        context,
        queuedContext: null,
      };
      automaticIndexBuildsRef.current.set(knowledgeBaseId, trackedBuild);
      try {
        const result = await getDesktopApi().indexes.build(knowledgeBaseId);
        const tracked = automaticIndexBuildsRef.current.get(knowledgeBaseId);
        if (result.jobId && tracked === trackedBuild) {
          trackedBuild.jobId = result.jobId;
          showInfoNotification(
            "索引构建已开始",
            `正在为 ${context} 构建检索索引，完成后会提示摘要。`,
          );
        }
      } catch (error) {
        if (
          automaticIndexBuildsRef.current.get(knowledgeBaseId) === trackedBuild
        ) {
          automaticIndexBuildsRef.current.delete(knowledgeBaseId);
        }
        const reason =
          error instanceof Error ? error.message : "后台任务启动失败";
        showAppError(`索引构建失败（${context}）：${reason}`, {
          title: "索引构建失败",
          actions: [{ kind: "open-tasks", label: "查看任务" }],
        });
      }
    },
    [showAppError, showInfoNotification],
  );

  const handleBackgroundJobUpdate = useCallback(
    async (job: BackgroundJobRecord): Promise<void> => {
      rememberBackgroundJob(job);
      if (!isTerminalJobStatus(job.status)) {
        setTaskCenterOpen(true);
      }
      const terminal = ["completed", "failed", "cancelled"].includes(
        job.status,
      );
      const tracked = automaticIndexBuildsRef.current.get(job.targetId);
      const isTrackedIndex =
        job.jobType.startsWith("index.") &&
        tracked !== undefined &&
        (tracked.jobId === null || tracked.jobId === job.id);

      if (isTrackedIndex && tracked.jobId === null) {
        tracked.jobId = job.id;
      }

      if (!terminal) {
        return;
      }

      if (activeKnowledgeBaseId) {
        try {
          await loadSources(activeKnowledgeBaseId);
        } catch {
          // A later user action will retry the source refresh.
        }
      }

      const notificationKey = `${job.id}:${job.status}`;
      const shouldReportTerminal =
        !reportedJobNotificationsRef.current.has(notificationKey);
      if (shouldReportTerminal) {
        reportedJobNotificationsRef.current.add(notificationKey);
      }

      if (shouldReportTerminal && job.status === "completed") {
        const sourceNamesById = new Map(
          sources.map((source) => [source.id, source.displayName]),
        );
        const title = jobTitle(job, sourceNamesById);
        const context = isTrackedIndex ? tracked.context : title;
        showSuccessNotification(
          "后台任务已完成",
          jobCompletionSummary(job, title, context),
          [{ kind: "open-tasks", label: "查看摘要" }],
        );
      }

      const reportTrackedIndexFailure =
        job.status === "failed" &&
        job.jobType.startsWith("index.") &&
        (isTrackedIndex || job.targetId === activeKnowledgeBaseId);

      if (shouldReportTerminal && reportTrackedIndexFailure) {
        const failedStage = job.checkpoint.stages.find(
          (stage) => stage.status === "failed",
        )?.label;
        const stage = failedStage ? ` / ${failedStage}` : "";
        const context = isTrackedIndex ? tracked.context : "当前知识库";
        showAppError(
          `索引构建失败（${context}${stage}）：${
            job.errorMessage ?? "未知错误"
          }`,
          {
            title: "索引构建失败",
            actions: [
              { kind: "retry-job", label: "重试", jobId: job.id },
              { kind: "open-tasks", label: "查看任务" },
            ],
          },
        );
      }

      if (
        shouldReportTerminal &&
        job.status === "failed" &&
        !reportTrackedIndexFailure
      ) {
        const sourceNamesById = new Map(
          sources.map((source) => [source.id, source.displayName]),
        );
        const title = jobTitle(job, sourceNamesById);
        showAppError(`${title}：${job.errorMessage ?? "未知错误"}`, {
          title: "后台任务失败",
          actions: [
            { kind: "retry-job", label: "重试", jobId: job.id },
            { kind: "open-tasks", label: "查看任务" },
          ],
        });
      }

      if (!isTrackedIndex) {
        return;
      }

      automaticIndexBuildsRef.current.delete(job.targetId);
      if (tracked.queuedContext) {
        await startAutomaticIndexBuild(job.targetId, tracked.queuedContext);
      }
    },
    [
      activeKnowledgeBaseId,
      loadSources,
      showAppError,
      showSuccessNotification,
      startAutomaticIndexBuild,
      rememberBackgroundJob,
      sources,
    ],
  );

  const storeAgentRunTrace = useCallback(
    (response: AgentRunResponse, preferredMessageId?: string) => {
      if (response.run.skillId !== "conversation_answer") {
        return;
      }
      const messageId =
        preferredMessageId || traceAssistantMessageId(response) || "";
      if (!messageId) {
        return;
      }
      setAgentRunTraces((items) => ({
        ...items,
        [messageId]: mergeAgentRunResponse(items[messageId], response),
      }));
    },
    [],
  );

  const openAgentRunTrace = useCallback(
    async (
      runId: string,
      preferredMessageId?: string,
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
        storeAgentRunTrace(response, preferredMessageId);
        setAgentTraceError("");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "AgentRun Trace 读取失败";
        if (!message.includes("Preload IPC")) {
          setAgentTraceError(message);
        }
      }
    },
    [storeAgentRunTrace],
  );

  const loadConversationAgentTraces = useCallback(
    async (knowledgeBaseId: string, targetConversationId: string) => {
      if (!knowledgeBaseId || !targetConversationId) {
        setAgentRunTraces({});
        return;
      }
      try {
        const result = await getDesktopApi().agentRuns.list(knowledgeBaseId, {
          includeTerminal: true,
          limit: 200,
        });
        const matchingRuns = result.runs.filter(
          (run) =>
            run.skillId === "conversation_answer" &&
            run.plan.conversationId === targetConversationId,
        );
        const responses = await Promise.all(
          matchingRuns.map((run) => getDesktopApi().agentRuns.get(run.id)),
        );
        const traces = responses.reduce<Record<string, AgentRunResponse>>(
          (items, response) => {
            const messageId = traceAssistantMessageId(response);
            if (messageId) {
              items[messageId] = response;
            }
            return items;
          },
          {},
        );
        setAgentRunTraces(traces);
        setAgentTraceError("");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "AgentRun 列表读取失败";
        if (!message.includes("Preload IPC")) {
          setAgentTraceError(message);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void checkHealth();
    void loadSeedStatus();
    void loadKnowledgeBases();
  }, [checkHealth, loadKnowledgeBases, loadSeedStatus]);

  useEffect(() => {
    if (!activeKnowledgeBaseId) {
      return;
    }
    void loadConversations(activeKnowledgeBaseId);
  }, [activeKnowledgeBaseId, loadConversations]);

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

  useEffect(() => {
    try {
      window.localStorage.setItem(
        EVIDENCE_PANEL_OPEN_STORAGE_KEY,
        evidenceOpen ? "true" : "false",
      );
    } catch {
      // localStorage 可能在受限预览环境不可用，面板状态降级为本次会话内生效。
    }
  }, [evidenceOpen]);

  useEffect(() => {
    const visibleNotification = notifications.find((item) => !item.dismissed);
    if (!visibleNotification || visibleNotification.persistent) {
      return;
    }
    const timer = window.setTimeout(
      () => dismissNotification(visibleNotification.id),
      6200,
    );
    return () => window.clearTimeout(timer);
  }, [dismissNotification, notifications]);

  const online = worker.kind === "online";

  useEffect(() => {
    if (!online) {
      return;
    }
    void loadBackgroundJobs();
    try {
      return getDesktopApi().jobs.onUpdated((job) => {
        void handleBackgroundJobUpdate(job);
      });
    } catch {
      return undefined;
    }
  }, [handleBackgroundJobUpdate, loadBackgroundJobs, online]);

  useEffect(() => {
    if (!activeKnowledgeBaseId) {
      return;
    }
    try {
      return getDesktopApi().agentRuns.onTraceEvent((event) => {
        setAgentRunTraces((items) =>
          updateAgentRunTraceEvent(
            items,
            event,
            pendingTraceMessageIdRef.current,
            activeKnowledgeBaseId,
          ),
        );
        if (isTerminalTraceEvent(event)) {
          void openAgentRunTrace(event.runId, undefined, activeKnowledgeBaseId);
        }
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
  const hasSearchOutput =
    searchBusy || Boolean(searchError) || searchResults.length > 0;
  const activeSearchQuery = lastSearchQuery || searchQuery;
  const seedStatusLoading = seedStatus === null;
  const apiSetupBlocked = seedStatus?.configured !== true;
  const apiSetupTitle = seedStatusLoading
    ? seedError
      ? "模型配置状态读取失败"
      : "正在检查模型服务配置"
    : "需要先配置 Ark API Key";
  const apiSetupDescription = seedStatusLoading
    ? seedError || "检查完成前暂不能生成回答和研究简报。"
    : "配置完成后才能生成回答和研究简报。";
  const apiSetupActionLabel = seedStatusLoading
    ? seedError
      ? "打开设置"
      : "检查中"
    : "去配置";
  const activeBackgroundJobs = backgroundJobs.filter(
    (job) => !isTerminalJobStatus(job.status),
  );
  const taskCenterJobs = taskCenterOpen ? backgroundJobs : activeBackgroundJobs;
  const chatScrollSignature = [
    messages
      .map(
        (message) =>
          `${message.id}:${message.role}:${message.content.length}:${message.citations.length}`,
      )
      .join("|"),
    chatBusy ? "busy" : "idle",
    chatError.length,
    exportNotice.length,
    Object.values(agentRunTraces)
      .map(
        (trace) =>
          `${trace.run.id}:${trace.run.status}:${trace.events.length}:${trace.toolCalls.length}`,
      )
      .join("|"),
    Object.keys(answerResponses).length,
    Object.keys(researchArtifacts).length,
  ].join("::");
  const normalizedSourceFilter = sourceFilter.trim().toLowerCase();
  const hasSourceFilter = normalizedSourceFilter.length > 0;
  const visibleSources = hasSourceFilter
    ? sources.filter((source) =>
        [
          source.displayName,
          source.uri ?? "",
          sourceTypeLabel(source.sourceType),
          sourceStatusLabel(source.status),
          source.latestVersionStatus
            ? sourceStatusLabel(source.latestVersionStatus)
            : "",
          source.expiryStatus !== "active"
            ? expiryStatusLabel(source.expiryStatus)
            : "",
          source.chunkCount > 0 ? `${source.chunkCount} 块` : "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSourceFilter),
      )
    : sources;

  useEffect(() => {
    if (!hasStartedConversation || !chatAutoScrollRef.current) {
      return;
    }
    const frame = window.requestAnimationFrame(() =>
      scrollChatToBottom("auto"),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [chatScrollSignature, hasStartedConversation, scrollChatToBottom]);

  const focusedResearchBrief = researchArtifacts[focusedResearchRunId] ?? null;
  const researchDirty =
    researchBrief && researchWorkspace
      ? isResearchWorkspaceDirty(
          researchBrief.workspace,
          researchWorkspace,
          researchPlanText,
          researchOutlineText,
          researchBrief.brief.sourceIds,
          selectedSourceIds,
        )
      : false;

  const toggleSource = (id: string): void => {
    setSelectedSourceIds((items) =>
      items.includes(id) ? items.filter((item) => item !== id) : [...items, id],
    );
  };

  const resetConversationWorkspace = (): void => {
    chatAutoScrollRef.current = true;
    chatProgrammaticScrollRef.current = false;
    setChatAtBottom(true);
    setConversationId(null);
    setMessages([]);
    setAnswerResponses({});
    setAgentRunTraces({});
    pendingTraceMessageIdRef.current = "";
    setSelectedEvidence(null);
    setSourceJumpNotice("");
    setChatError("");
    setExportNotice("");
    setSearchQuery("");
    setLastSearchQuery("");
    setSearchResults([]);
    setSearchError("");
    setResearchArtifacts({});
    setFocusedResearchRunId("");
    setResearchEditorOpen(false);
    setResearchBrief(null);
    setResearchWorkspace(null);
    setResearchLiveRun(null);
    setResearchSelection("");
    setResearchError("");
    setResearchNotice("");
    setComposerToolsOpen(false);
    setNextRouteHint("auto");
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
    setConfirmError("");
    try {
      const result = await getDesktopApi().system.cleanupStorage();
      setMaintenanceStatus(result);
      setMaintenanceNotice(
        `已回收 ${result.recycledIndexCount ?? 0} 个索引、${result.removedFileCount ?? 0} 个孤儿文件`,
      );
      setConfirmAction(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "应用数据清理失败";
      setMaintenanceNotice(message);
      setConfirmError(message);
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
    chatAutoScrollRef.current = true;
    setChatAtBottom(true);
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
      await Promise.all([
        loadConversationAgentTraces(
          activeKnowledgeBaseId,
          targetConversationId,
        ),
        loadResearchArtifacts(result.messages),
      ]);
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

  const openEvidenceSource = async (
    selection: EvidenceSelection,
  ): Promise<void> => {
    const sourceId = evidenceSourceId(selection);
    if (!sourceId || sourceOpenBusy) {
      return;
    }
    setSourceOpenBusy(true);
    setSourceJumpNotice("");
    try {
      const result = await getDesktopApi().sources.open({
        sourceId,
        location: evidenceLocation(selection),
      });
      setSourceJumpNotice(
        `${result.message}：${evidenceDisplayName(selection)} · ${evidenceLocationLabel(selection)}`,
      );
    } catch (error) {
      setSourceJumpNotice(
        error instanceof Error ? error.message : "原文打开失败",
      );
    } finally {
      setSourceOpenBusy(false);
    }
  };

  const handleBackgroundJobAction = async (
    job: BackgroundJobRecord,
    action: "pause" | "resume" | "cancel" | "retry",
  ): Promise<void> => {
    const busyId = `${job.id}:${action}`;
    setTaskActionBusyId(busyId);
    try {
      const updated = await getDesktopApi().jobs[action](job.id);
      rememberBackgroundJob(updated);
      setTaskCenterOpen(true);
    } catch (error) {
      showAppError(error instanceof Error ? error.message : "后台任务操作失败");
    } finally {
      setTaskActionBusyId("");
    }
  };

  const clearCompletedBackgroundJobs = (): void => {
    setBackgroundJobs((items) =>
      items.filter((job) => !isTerminalJobStatus(job.status)),
    );
  };

  const submitQuestion = async (): Promise<void> => {
    const value = query.trim();
    if (!value || chatBusy) {
      return;
    }
    if (!activeKnowledgeBaseId) {
      const message = "请先选择知识库";
      setChatError(message);
      showAppError(message, {
        title: "无法生成回答",
      });
      return;
    }
    if (!seedStatus?.configured) {
      const message = "请先在设置中配置 Ark API Key";
      setChatError(message);
      showAppError(message, {
        title: "模型配置未完成",
        actions: [{ kind: "open-settings", label: "打开设置" }],
      });
      return;
    }
    setChatBusy(true);
    chatAutoScrollRef.current = true;
    setChatAtBottom(true);
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
    pendingTraceMessageIdRef.current = pendingAssistantMessage.id;
    setMessages((items) => [
      ...items,
      pendingUserMessage,
      pendingAssistantMessage,
    ]);
    try {
      const response = await getDesktopApi().conversations.submit({
        knowledgeBaseId: activeKnowledgeBaseId,
        query: value,
        conversationId,
        routeHint: nextRouteHint,
        currentBriefRunId:
          nextRouteHint === "research_brief"
            ? null
            : focusedResearchRunId || null,
        sourceIds: selectedSourceIds,
        chatModel,
        limit: 8,
        candidateLimit: 24,
      });
      const resolved =
        response.kind === "answer"
          ? {
              conversation: response.answer.conversation,
              userMessage: response.answer.userMessage,
              assistantMessage: response.answer.assistantMessage,
            }
          : response;
      setConversationId(resolved.conversation.id);
      setConversations((items) =>
        upsertConversation(items, resolved.conversation),
      );
      setMessages((items) =>
        uniqueMessages(
          items.map((message) => {
            if (message.id === pendingUserMessage.id) {
              return resolved.userMessage;
            }
            if (message.id === pendingAssistantMessage.id) {
              return resolved.assistantMessage;
            }
            return message;
          }),
        ),
      );
      setAgentRunTraces((items) => {
        const next = { ...items };
        const pendingTrace = next[pendingAssistantMessage.id];
        delete next[pendingAssistantMessage.id];
        if (response.kind === "answer") {
          if (pendingTrace) {
            next[response.answer.assistantMessage.id] = mergeAgentRunResponse(
              pendingTrace,
              next[response.answer.assistantMessage.id] ?? pendingTrace,
            );
          }
        } else if (
          response.kind === "research_brief_created" ||
          response.kind === "research_brief_updated"
        ) {
          next[response.assistantMessage.id] = response.brief.latestRun;
        }
        return next;
      });
      if (response.kind === "answer") {
        setAnswerResponses((items) => ({
          ...items,
          [response.answer.assistantMessage.id]: response.answer,
        }));
      }
      const agentRunId =
        response.kind === "answer"
          ? response.answer.agentRunId
          : response.kind === "clarification"
            ? null
            : response.agentRunId;
      if (agentRunId && response.kind === "answer") {
        await openAgentRunTrace(
          agentRunId,
          response.answer.assistantMessage.id,
          activeKnowledgeBaseId,
        );
      }
      if (
        response.kind === "research_brief_created" ||
        response.kind === "research_brief_updated"
      ) {
        syncResearchBrief(response.brief);
      }
      if (response.kind === "answer" && response.answer.citations[0]) {
        selectCitation(response.answer.citations[0], response.answer, 1);
      } else {
        setSelectedEvidence(null);
        setSourceJumpNotice("");
      }
      setNextRouteHint("auto");
      setComposerToolsOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "回答生成失败";
      setMessages((items) =>
        items.filter((message) => message.id !== pendingAssistantMessage.id),
      );
      setAgentRunTraces((items) => {
        const next = { ...items };
        delete next[pendingAssistantMessage.id];
        return next;
      });
      setQuery(value);
      setChatError(message);
      showAppError(message, {
        title: "回答生成失败",
        actions: [
          { kind: "open-settings", label: "打开设置" },
          { kind: "open-tasks", label: "查看任务" },
        ],
      });
    } finally {
      if (pendingTraceMessageIdRef.current === pendingAssistantMessage.id) {
        pendingTraceMessageIdRef.current = "";
      }
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
    setSourceFilter("");
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
      setAgentRunTraces((items) =>
        updateAgentRunTraceResponse(items, response),
      );
    } catch (error) {
      setAgentTraceError(
        error instanceof Error ? error.message : "AgentRun 操作失败",
      );
    } finally {
      setAgentTraceBusyId("");
    }
  };

  const refreshImportState = async (knowledgeBaseId: string): Promise<void> => {
    await loadSources(knowledgeBaseId);
  };

  const importFiles = async (): Promise<void> => {
    if (!activeKnowledgeBaseId) {
      const message = "请先选择知识库";
      setImportError(message);
      showAppError(message, {
        title: "无法导入资料",
      });
      return;
    }
    setImportBusy(true);
    setImportError("");
    try {
      const result = await getDesktopApi().sources.importFiles(
        activeKnowledgeBaseId,
      );
      if (!result.cancelled) {
        const failed = result.imported.filter(
          (item) => item.parseCheck.status === "failed",
        );
        if (failed.length > 0) {
          showAppError(
            parseFailureMessage(failed.map((item) => item.parseCheck)),
            {
              title: "资料解析失败",
              actions: [
                { kind: "retry-file-import", label: "重新导入" },
                { kind: "open-tasks", label: "查看任务" },
              ],
            },
          );
        }
        const succeeded = result.imported.filter(
          (item) => item.parseCheck.status === "success",
        );
        if (succeeded.length > 0) {
          showSuccessNotification(
            "导入成功",
            `已导入 ${succeeded.length} 份资料，正在准备后台索引。`,
            [{ kind: "open-tasks", label: "查看任务" }],
          );
          await startAutomaticIndexBuild(
            activeKnowledgeBaseId,
            sourceNames(succeeded.map((item) => item.parseCheck.displayName)),
          );
        }
        await refreshImportState(activeKnowledgeBaseId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "文件导入失败";
      setImportError(message);
      showAppError(`资料导入失败：${message}`, {
        title: "资料导入失败",
        actions: [
          { kind: "retry-file-import", label: "重试导入" },
          { kind: "open-tasks", label: "查看任务" },
        ],
      });
    } finally {
      setImportBusy(false);
    }
  };

  const importWebSource = async (): Promise<void> => {
    if (!activeKnowledgeBaseId) {
      const message = "请先选择知识库";
      setImportError(message);
      showAppError(message, {
        title: "无法导入网页",
      });
      return;
    }
    setImportBusy(true);
    setImportError("");
    try {
      const result = await getDesktopApi().sources.importWeb({
        knowledgeBaseId: activeKnowledgeBaseId,
        url: webImportForm.url,
        displayName: webImportForm.displayName || null,
      });
      setWebImportOpen(false);
      setWebImportForm({ url: "", displayName: "" });
      if (result.parseCheck.status === "failed") {
        showAppError(parseFailureMessage([result.parseCheck]), {
          title: "网页解析失败",
          actions: [
            { kind: "retry-web-import", label: "重新导入" },
            { kind: "open-tasks", label: "查看任务" },
          ],
        });
      }
      if (result.parseCheck.status === "success") {
        showSuccessNotification(
          "网页导入成功",
          `“${result.parseCheck.displayName}”已导入，正在准备后台索引。`,
          [{ kind: "open-tasks", label: "查看任务" }],
        );
        await startAutomaticIndexBuild(
          activeKnowledgeBaseId,
          result.parseCheck.displayName,
        );
      }
      await refreshImportState(activeKnowledgeBaseId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "网页导入失败";
      setImportError(message);
      showAppError(`资料导入失败：${message}`, {
        title: "网页导入失败",
        actions: [
          { kind: "retry-web-import", label: "重试导入" },
          { kind: "open-tasks", label: "查看任务" },
        ],
      });
    } finally {
      setImportBusy(false);
    }
  };

  const discoverMcpServer = async (serverId: string): Promise<void> => {
    const discovery = await getDesktopApi().mcpServers.discover(serverId);
    setMcpTools(discovery.tools);
    const allowed = discovery.tools.find((tool) => tool.locallyAllowedReadOnly);
    setSelectedMcpToolName(allowed?.name ?? "");
  };

  const openExternalResearch = async (): Promise<void> => {
    setExternalResearchOpen(true);
    setExternalResearchBusy(true);
    setExternalResearchError("");
    setExternalResearchResult(null);
    setExternalCandidateIds([]);
    setExternalResearchRunId("");
    setExternalResearchConfirmationId("");
    try {
      const result = await getDesktopApi().mcpServers.list();
      setMcpServers(result.servers);
      const first = result.servers.find((server) => server.enabled);
      setSelectedMcpServerId(first?.id ?? "");
      if (first) {
        await discoverMcpServer(first.id);
      } else {
        setMcpTools([]);
        setSelectedMcpToolName("");
      }
    } catch (error) {
      setExternalResearchError(
        error instanceof Error ? error.message : "MCP 服务读取失败",
      );
    } finally {
      setExternalResearchBusy(false);
    }
  };

  const saveMcpServer = async (): Promise<void> => {
    setExternalResearchBusy(true);
    setExternalResearchError("");
    try {
      const server = await getDesktopApi().mcpServers.save({
        name: mcpServerForm.name,
        command: mcpServerForm.command,
        args: splitConfigValues(mcpServerForm.args, "\n"),
        envKeys: splitConfigValues(mcpServerForm.envKeys, ","),
        readOnlyTools: splitConfigValues(mcpServerForm.readOnlyTools, ","),
        enabled: true,
      });
      const result = await getDesktopApi().mcpServers.list();
      setMcpServers(result.servers);
      setSelectedMcpServerId(server.id);
      await discoverMcpServer(server.id);
    } catch (error) {
      setExternalResearchError(
        error instanceof Error ? error.message : "MCP 服务保存失败",
      );
    } finally {
      setExternalResearchBusy(false);
    }
  };

  const searchExternalResearch = async (): Promise<void> => {
    if (
      !activeKnowledgeBaseId ||
      !selectedMcpServerId ||
      !selectedMcpToolName
    ) {
      setExternalResearchError("请选择已通过本地只读校验的 MCP Tool");
      return;
    }
    setExternalResearchBusy(true);
    setExternalResearchError("");
    try {
      const created = await getDesktopApi().agentRuns.create({
        knowledgeBaseId: activeKnowledgeBaseId,
        goal: externalResearchQuery,
        title: "寻找外部资料",
        skillId: "research_brief",
        skillVersion: "1.0.0",
        sourceIds: selectedSourceIds,
      });
      const runId = created.run.id;
      setExternalResearchRunId(runId);
      await getDesktopApi().externalResearch.setAccess(runId, true, [
        selectedMcpServerId,
      ]);
      const result = await getDesktopApi().externalResearch.search({
        runId,
        query: externalResearchQuery,
        searches: [
          {
            serverId: selectedMcpServerId,
            toolName: selectedMcpToolName,
          },
        ],
        limit: 8,
      });
      setExternalResearchResult(result);
      setExternalResearchConfirmationId(result.confirmationId ?? "");
      setExternalCandidateIds(
        result.candidates
          .filter((candidate) => candidate.status === "candidate")
          .map((candidate) => candidate.id),
      );
    } catch (error) {
      setExternalResearchError(
        error instanceof Error ? error.message : "外部资料检索失败",
      );
    } finally {
      setExternalResearchBusy(false);
    }
  };

  const decideExternalResearch = async (
    decision: "import" | "reject",
  ): Promise<void> => {
    if (!externalResearchRunId || !externalResearchConfirmationId) {
      return;
    }
    setExternalResearchBusy(true);
    setExternalResearchError("");
    try {
      const result = await getDesktopApi().externalResearch.decide({
        runId: externalResearchRunId,
        confirmationId: externalResearchConfirmationId,
        candidateIds: decision === "import" ? externalCandidateIds : [],
        decision,
      });
      setExternalResearchResult(result);
      if (activeKnowledgeBaseId) {
        await loadSources(activeKnowledgeBaseId);
      }
      if (researchBrief) {
        syncResearchBrief(
          await getDesktopApi().researchBriefs.get(researchBrief.brief.runId),
        );
      }
    } catch (error) {
      setExternalResearchError(
        error instanceof Error ? error.message : "外部资料处理失败",
      );
    } finally {
      setExternalResearchBusy(false);
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
      const message =
        error instanceof Error ? error.message : "网页更新检查失败";
      setSourceMaintenanceError(message);
      showAppError(
        `资料解析失败（${sourceMaintenance.source.displayName}）：${message}`,
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
  ): Promise<void> => {
    if (!sourceMaintenance) {
      return;
    }
    setSourceMaintenanceBusy(true);
    setSourceMaintenanceError("");
    try {
      const updated = await getDesktopApi().sources.decideVersion({
        sourceId: sourceMaintenance.source.id,
        versionId,
        decision,
      });
      setSourceMaintenance(updated);
      setSourceVersionDiff(null);
      if (decision === "accept" && activeKnowledgeBaseId) {
        await startAutomaticIndexBuild(
          activeKnowledgeBaseId,
          sourceMaintenance.source.displayName,
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
    if (confirmAction?.kind === "delete-seed-credential") {
      await deleteSeedCredential();
      return;
    }
    if (confirmAction?.kind === "cleanup-storage") {
      await cleanupStorage();
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
    } catch (error) {
      setSeedError(error instanceof Error ? error.message : "默认模型保存失败");
    } finally {
      setSeedBusy(false);
    }
  };

  const deleteSeedCredential = async (): Promise<void> => {
    if (seedBusy) {
      return;
    }
    setSeedBusy(true);
    setSeedError("");
    setConfirmError("");
    try {
      setSeedStatus(await getDesktopApi().seed.deleteCredential());
      setSeedForm({
        name: "我的 Seed API",
        apiKey: "",
        defaultChatModel: SEED_DEFAULTS.defaultChatModel,
        defaultEmbeddingModel: SEED_DEFAULTS.defaultEmbeddingModel,
      });
      setConfirmAction(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Seed API 删除失败";
      setSeedError(message);
      setConfirmError(message);
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

  const persistResearchBrief =
    async (): Promise<ResearchBriefResponse | null> => {
      if (!researchBrief || !researchWorkspace) {
        return null;
      }
      if (
        !isResearchWorkspaceDirty(
          researchBrief.workspace,
          researchWorkspace,
          researchPlanText,
          researchOutlineText,
          researchBrief.brief.sourceIds,
          selectedSourceIds,
        )
      ) {
        setResearchSaveState("saved");
        return researchBrief;
      }
      let plan: Record<string, unknown>;
      let outline: Record<string, unknown>;
      try {
        plan = parseStructuredEditor(researchPlanText, "计划");
        outline = parseStructuredEditor(researchOutlineText, "大纲");
      } catch (error) {
        setResearchError(
          error instanceof Error ? error.message : "结构化内容无效",
        );
        setResearchSaveState("conflict");
        return null;
      }
      const editSequence = researchEditSequenceRef.current;
      setResearchSaveState("saving");
      try {
        const value = await getDesktopApi().researchBriefs.update({
          runId: researchBrief.brief.runId,
          expectedRevision: researchBrief.brief.userRevision,
          sourceIds: selectedSourceIds,
          patch: {
            title: researchWorkspace.title,
            goal: researchWorkspace.goal,
            plan,
            outline,
            draft: researchWorkspace.draft,
            final: researchWorkspace.final,
            sections: researchWorkspace.sections,
          },
        });
        if (researchEditSequenceRef.current === editSequence) {
          syncResearchBrief(value);
          setResearchSaveState("saved");
        } else {
          setResearchBrief(value);
          setResearchArtifacts((items) => ({
            ...items,
            [value.brief.runId]: value,
          }));
          setResearchSaveState("idle");
        }
        return value;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "研究简报保存失败";
        setResearchError(message);
        setResearchSaveState(
          message.includes("刷新") || message.includes("更新")
            ? "conflict"
            : "idle",
        );
        throw error;
      }
    };

  const saveResearchBrief = async (): Promise<void> => {
    if (!researchBrief || researchSaveState === "saving") {
      return;
    }
    setResearchError("");
    try {
      const value = await persistResearchBrief();
      if (value) {
        setResearchNotice("人工编辑已自动保存");
      }
    } catch {
      // persistResearchBrief exposes the actionable error and conflict state.
    }
  };

  const changeResearchWorkspace = (value: ResearchBriefWorkspace): void => {
    researchEditSequenceRef.current += 1;
    setResearchWorkspace(value);
    setResearchSaveState("idle");
  };

  const changeResearchPlanText = (value: string): void => {
    researchEditSequenceRef.current += 1;
    setResearchPlanText(value);
    setResearchSaveState("idle");
  };

  const changeResearchOutlineText = (value: string): void => {
    researchEditSequenceRef.current += 1;
    setResearchOutlineText(value);
    setResearchSaveState("idle");
  };

  useEffect(() => {
    if (!researchEditorOpen || !researchDirty) {
      return;
    }
    const timer = window.setTimeout(
      () => {
        void saveResearchBrief();
      },
      researchBusy ? 0 : 800,
    );
    return () => window.clearTimeout(timer);
  }, [
    researchBusy,
    researchDirty,
    researchEditorOpen,
    researchOutlineText,
    researchPlanText,
    researchWorkspace,
    selectedSourceIds,
  ]);

  const operateResearchBrief = async (
    action: ResearchBriefAction,
  ): Promise<void> => {
    if (!researchBrief || !researchWorkspace || researchBusy) {
      return;
    }
    if (action === "regenerate_section" && !researchSelectedSectionId) {
      setResearchError("请先选择要重新生成的章节");
      return;
    }
    setResearchBusy(true);
    setResearchError("");
    setResearchNotice("");
    try {
      const saved = await persistResearchBrief();
      if (!saved) {
        return;
      }
      const value = await getDesktopApi().researchBriefs.operate({
        runId: saved.brief.runId,
        action,
        expectedRevision: saved.brief.userRevision,
        selectionText: researchSelection || null,
        sectionId:
          action === "regenerate_section" ? researchSelectedSectionId : null,
      });
      syncResearchBrief(value);
      setResearchSelection("");
      setResearchNotice(
        value.brief.hasPendingAgentUpdate
          ? "检测到执行期间的人工编辑，Agent 结果正在等待合并"
          : `${researchActionLabel(action)}完成`,
      );
    } catch (error) {
      setResearchError(
        error instanceof Error ? error.message : "研究任务执行失败",
      );
    } finally {
      setResearchBusy(false);
    }
  };

  const resolveResearchPending = async (
    decision: "apply" | "discard",
  ): Promise<void> => {
    if (!researchBrief || researchBusy) {
      return;
    }
    setResearchBusy(true);
    setResearchError("");
    setResearchNotice("");
    try {
      const value = await getDesktopApi().researchBriefs.resolvePending({
        runId: researchBrief.brief.runId,
        decision,
        expectedRevision: researchBrief.brief.userRevision,
      });
      syncResearchBrief(value);
      setResearchNotice(
        decision === "apply" ? "Agent 更新已合并" : "Agent 更新已放弃",
      );
    } catch (error) {
      setResearchError(
        error instanceof Error ? error.message : "Agent 更新处理失败",
      );
    } finally {
      setResearchBusy(false);
    }
  };

  const exportResearchBrief = async (runId?: string): Promise<void> => {
    const target =
      (runId ? researchArtifacts[runId] : researchBrief) ?? researchBrief;
    if (!target || researchBusy) {
      return;
    }
    setResearchBusy(true);
    setResearchError("");
    setResearchNotice("");
    try {
      const saved =
        researchBrief?.brief.runId === target.brief.runId
          ? await persistResearchBrief()
          : target;
      if (!saved) return;
      const result = await getDesktopApi().researchBriefs.exportMarkdown(
        saved.brief.runId,
      );
      setResearchNotice(
        result.cancelled
          ? "已取消导出"
          : `研究简报已导出到 ${result.filePath ?? "所选位置"}`,
      );
    } catch (error) {
      setResearchError(
        error instanceof Error ? error.message : "研究简报导出失败",
      );
    } finally {
      setResearchBusy(false);
    }
  };

  const copyResearchBrief = async (runId: string): Promise<void> => {
    const value = researchArtifacts[runId];
    if (!value) return;
    const content = value.workspace.final || value.workspace.draft;
    await navigator.clipboard.writeText(content);
    setExportNotice("研究简报已复制");
  };

  const closeResearchEditor = async (): Promise<void> => {
    if (researchSaveState === "saving") return;
    if (researchDirty) {
      const saved = await persistResearchBrief().catch(() => null);
      if (!saved) return;
    }
    setResearchEditorOpen(false);
  };

  const visibleNotification =
    notifications.find((item) => !item.dismissed) ?? null;

  const handleNotificationAction = (action: AppNotificationAction): void => {
    if (action.kind === "open-settings") {
      setSettingsOpen(true);
      return;
    }
    if (action.kind === "open-tasks") {
      setTaskCenterOpen(true);
      return;
    }
    if (action.kind === "retry-file-import") {
      void importFiles();
      return;
    }
    if (action.kind === "retry-web-import") {
      if (webImportForm.url.trim()) {
        void importWebSource();
        return;
      }
      setWebImportOpen(true);
      return;
    }
    if (action.kind === "retry-job" && action.jobId) {
      const job = backgroundJobs.find((item) => item.id === action.jobId);
      if (job) {
        void handleBackgroundJobAction(job, "retry");
      }
      setTaskCenterOpen(true);
    }
  };

  return (
    <main className={`app-shell ${evidenceOpen ? "" : "evidence-collapsed"}`}>
      {visibleNotification && (
        <AppNotificationToast
          historyCount={notifications.length}
          notification={visibleNotification}
          onAction={handleNotificationAction}
          onDismiss={() => dismissNotification(visibleNotification.id)}
          onToggleHistory={() => setNotificationHistoryOpen((value) => !value)}
        />
      )}
      {!visibleNotification && notifications.length > 0 && (
        <button
          className="notification-history-trigger"
          type="button"
          onClick={() => setNotificationHistoryOpen((value) => !value)}
        >
          通知 {notifications.length}
        </button>
      )}
      {notificationHistoryOpen && (
        <NotificationHistory
          notifications={notifications}
          onAction={handleNotificationAction}
          onClear={clearNotificationHistory}
          onClose={() => setNotificationHistoryOpen(false)}
        />
      )}
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
        <div className="top-center">
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
        </div>
        <div className="top-actions">
          <button
            className="button ghost"
            type="button"
            onClick={() => {
              setSettingsOpen(true);
              setAccountMenuOpen(false);
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
          <div className="account-menu-wrap">
            <button
              aria-expanded={accountMenuOpen}
              aria-haspopup="menu"
              aria-label="打开账户菜单"
              className="avatar"
              type="button"
              onClick={() => setAccountMenuOpen((value) => !value)}
            >
              S
            </button>
            {accountMenuOpen && (
              <div className="account-menu" role="menu">
                <div className="account-menu-heading">
                  <strong>本地账户</strong>
                  <span>citeMind Desktop</span>
                </div>
                <div className="account-menu-status">
                  <span>模型服务</span>
                  <strong>
                    {seedStatus?.configured ? "已配置" : "未配置"}
                  </strong>
                </div>
                <div className="account-menu-status">
                  <span>当前知识库</span>
                  <strong>{activeKnowledgeBase?.name ?? "未选择"}</strong>
                </div>
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setSettingsOpen(true);
                    setAccountMenuOpen(false);
                    void loadSeedStatus();
                  }}
                >
                  <Icon name="settings" size={15} />
                  打开设置
                </button>
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    startNewConversation();
                    setAccountMenuOpen(false);
                  }}
                >
                  <Icon name="add" size={15} />
                  新建对话
                </button>
              </div>
            )}
          </div>
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
            <button
              className="button external-research-button"
              disabled={importBusy || !activeKnowledgeBaseId}
              type="button"
              onClick={() => void openExternalResearch()}
            >
              <Icon name="sparkle" size={16} />
              寻找外部资料
            </button>
            <div className="panel-search">
              <Icon name="search" size={16} />
              <input
                aria-label="筛选来源"
                placeholder="筛选来源"
                value={sourceFilter}
                onChange={(event) => setSourceFilter(event.target.value)}
              />
              {hasSourceFilter && (
                <button
                  aria-label="清除来源筛选"
                  className="panel-search-clear"
                  title="清除筛选"
                  type="button"
                  onClick={() => setSourceFilter("")}
                >
                  <Icon name="close" size={13} />
                </button>
              )}
            </div>
          </div>
          <div className="source-toolbar">
            <span>
              {hasSourceFilter
                ? `${visibleSources.length}/${sources.length} 个来源匹配，${selectedCount} 个用于对话`
                : `${selectedCount} 个来源已用于对话`}
            </span>
            <button
              className="text-button"
              disabled={visibleSources.length === 0}
              type="button"
              onClick={() =>
                setSelectedSourceIds(visibleSources.map((source) => source.id))
              }
            >
              {hasSourceFilter ? "全选结果" : "全选"}
            </button>
          </div>
          {knowledgeBaseError && (
            <div className="inline-error">{knowledgeBaseError}</div>
          )}
          <div className="source-list">
            {sources.length > 0 ? (
              visibleSources.length > 0 ? (
                visibleSources.map((source) => {
                  const sourceJob = sourceActiveJob(
                    source,
                    activeBackgroundJobs,
                    activeKnowledgeBaseId,
                  );
                  return (
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
                      {sourceJob && <SourceProgress job={sourceJob} />}
                    </article>
                  );
                })
              ) : (
                <div className="empty-source-state">
                  <strong>没有匹配来源</strong>
                  <span>换个关键词，或清除筛选后查看全部来源。</span>
                </div>
              )
            ) : (
              <div className="empty-source-state">
                <strong>还没有来源</strong>
                <span>
                  添加文件或网页后会自动解析并构建索引，完成后即可参与检索和回答。
                </span>
                <div className="empty-source-actions">
                  <button
                    className="button add-source"
                    disabled={importBusy || !activeKnowledgeBaseId}
                    type="button"
                    onClick={() => void importFiles()}
                  >
                    <Icon name="add" size={15} />
                    添加文件
                  </button>
                  <button
                    className="button ghost"
                    disabled={importBusy || !activeKnowledgeBaseId}
                    type="button"
                    onClick={() => {
                      setImportError("");
                      setWebImportOpen(true);
                    }}
                  >
                    网页链接
                  </button>
                </div>
              </div>
            )}
          </div>
          <TaskCenter
            actionBusyId={taskActionBusyId}
            jobs={taskCenterJobs}
            open={taskCenterOpen}
            sources={sources}
            totalCount={backgroundJobs.length}
            onAction={(job, action) =>
              void handleBackgroundJobAction(job, action)
            }
            onClearCompleted={clearCompletedBackgroundJobs}
            onToggle={() => setTaskCenterOpen((value) => !value)}
          />
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
            ref={chatScrollRef}
            onScroll={handleChatScroll}
          >
            {apiSetupBlocked && !hasStartedConversation && (
              <SetupGuide
                actionLabel={
                  seedStatusLoading
                    ? seedError
                      ? "打开设置"
                      : "检查配置中"
                    : "配置 Ark API"
                }
                busy={seedStatusLoading && !seedError}
                description={apiSetupDescription}
                knowledgeBaseName={activeKnowledgeBase?.name ?? "当前知识库"}
                sourceCount={sourceSummary.sourceCount}
                title={apiSetupTitle}
                onOpenSettings={() => {
                  setSettingsOpen(true);
                  void loadSeedStatus();
                }}
              />
            )}

            {!hasStartedConversation && !apiSetupBlocked && (
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

            {hasSearchOutput && (
              <div
                aria-label="资料搜索结果"
                className={`chat-search-region ${
                  hasStartedConversation ? "sticky" : ""
                }`}
                role="region"
              >
                <SearchResultsPanel
                  busy={searchBusy}
                  error={searchError}
                  query={activeSearchQuery}
                  results={searchResults}
                  selectedChunkId={selectedEvidenceChunkId(selectedEvidence)}
                  onClear={() => {
                    setSearchQuery("");
                    setLastSearchQuery("");
                    setSearchResults([]);
                    setSearchError("");
                    setSelectedEvidence((value) =>
                      value?.kind === "search" ? null : value,
                    );
                    setSourceJumpNotice("");
                  }}
                  onSelect={selectSearchResult}
                />
              </div>
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
                {messages.map((message) => {
                  const trace = agentRunTraces[message.id];
                  if (message.role === "user") {
                    return (
                      <p className="user-message" key={message.id}>
                        {message.content}
                      </p>
                    );
                  }
                  if (message.role === "assistant") {
                    const artifactRunId = message.artifact?.runId;
                    const artifactBrief = artifactRunId
                      ? researchArtifacts[artifactRunId]
                      : undefined;
                    return (
                      <div className="assistant-turn" key={message.id}>
                        {trace && (
                          <AgentRunTracePanel
                            answerVisible={!isPendingAssistantMessage(message)}
                            busyAction={agentTraceBusyId}
                            error={agentTraceError}
                            response={trace}
                            onAction={(runId, action) =>
                              void handleAgentRunAction(runId, action)
                            }
                          />
                        )}
                        {!trace && isPendingAssistantMessage(message) && (
                          <PendingAgentRunTracePanel
                            startedAt={message.createdAt}
                          />
                        )}
                        {message.artifact?.type === "research_brief" ? (
                          <ResearchBriefArtifactMessage
                            brief={artifactBrief}
                            display={message.artifact.display}
                            expanded={researchExpandedRunIds.includes(
                              message.artifact.runId,
                            )}
                            focused={
                              focusedResearchRunId === message.artifact.runId
                            }
                            message={message}
                            onCopy={() =>
                              void copyResearchBrief(message.artifact!.runId)
                            }
                            onEdit={() =>
                              void loadResearchBrief(
                                message.artifact!.runId,
                                true,
                              )
                            }
                            onExport={() =>
                              void exportResearchBrief(message.artifact!.runId)
                            }
                            onFocus={() =>
                              setFocusedResearchRunId(message.artifact!.runId)
                            }
                            onSelectCitation={selectCitation}
                            onToggleExpanded={() =>
                              setResearchExpandedRunIds((items) =>
                                items.includes(message.artifact!.runId)
                                  ? items.filter(
                                      (item) =>
                                        item !== message.artifact!.runId,
                                    )
                                  : [...items, message.artifact!.runId],
                              )
                            }
                            selectedChunkId={selectedEvidenceChunkId(
                              selectedEvidence,
                            )}
                          />
                        ) : (
                          <AssistantAnswerMessage
                            message={message}
                            response={answerResponses[message.id]}
                            selectedChunkId={selectedEvidenceChunkId(
                              selectedEvidence,
                            )}
                            trace={trace}
                            onSelectCitation={selectCitation}
                            exportBusy={exportBusyId === message.id}
                            onExport={() => void exportMarkdown(message.id)}
                          />
                        )}
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            )}

            {!hasStartedConversation && !apiSetupBlocked && (
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
          {hasStartedConversation && !chatAtBottom && (
            <button
              className="chat-scroll-bottom"
              type="button"
              onClick={() => scrollChatToBottom("smooth")}
            >
              回到底部 <Icon name="chevron" size={14} />
            </button>
          )}
          <div className="composer-wrap">
            {apiSetupBlocked && (
              <div className="composer-blocker" role="status">
                <span>
                  <strong>{apiSetupTitle}</strong>
                  <small>{apiSetupDescription}</small>
                </span>
                <button
                  className="text-button"
                  disabled={seedStatusLoading && !seedError}
                  type="button"
                  onClick={() => {
                    setSettingsOpen(true);
                    void loadSeedStatus();
                  }}
                >
                  {apiSetupActionLabel}
                </button>
              </div>
            )}
            {(focusedResearchBrief || nextRouteHint === "research_brief") && (
              <div className="composer-context-row">
                {focusedResearchBrief && (
                  <button
                    className="research-context-chip"
                    type="button"
                    onClick={() =>
                      void loadResearchBrief(
                        focusedResearchBrief.brief.runId,
                        true,
                      )
                    }
                  >
                    <Icon name="book" size={13} />
                    当前简报：{focusedResearchBrief.brief.title}
                    <span
                      aria-label="清除当前简报"
                      role="button"
                      tabIndex={0}
                      onClick={(event) => {
                        event.stopPropagation();
                        setFocusedResearchRunId("");
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.stopPropagation();
                          setFocusedResearchRunId("");
                        }
                      }}
                    >
                      <Icon name="close" size={12} />
                    </span>
                  </button>
                )}
                {nextRouteHint === "research_brief" && (
                  <button
                    className="research-context-chip route"
                    type="button"
                    onClick={() => setNextRouteHint("auto")}
                  >
                    <Icon name="sparkle" size={13} />
                    下一条生成新研究简报
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>
            )}
            <div className="composer">
              <div className="composer-tools-wrap">
                <button
                  aria-expanded={composerToolsOpen}
                  aria-label="打开输入工具"
                  className="composer-add-button"
                  type="button"
                  onClick={() => setComposerToolsOpen((value) => !value)}
                >
                  <Icon name="add" size={18} />
                </button>
                {composerToolsOpen && (
                  <div className="composer-tools-menu">
                    <button
                      type="button"
                      onClick={() => {
                        setNextRouteHint("research_brief");
                        setComposerToolsOpen(false);
                      }}
                    >
                      <Icon name="book" size={15} />
                      <span>
                        <strong>生成研究简报</strong>
                        <small>基于当前已选资料创建可编辑成果</small>
                      </span>
                    </button>
                  </div>
                )}
              </div>
              <textarea
                aria-label="向知识库提问"
                placeholder={
                  apiSetupBlocked
                    ? "先配置 Ark API Key 后开始提问…"
                    : focusedResearchBrief
                      ? "继续提问或要求修改当前简报…"
                      : nextRouteHint === "research_brief"
                        ? "描述要生成的研究简报…"
                        : "向知识库提问，回答将附带真实引用…"
                }
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
                {apiSetupBlocked
                  ? "需配置 API"
                  : chatBusy
                    ? "生成中"
                    : `${selectedCount} 个来源`}
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
                disabled={!query.trim() || chatBusy || apiSetupBlocked}
                type="button"
                onClick={() => void submitQuestion()}
              >
                <Icon name="send" size={17} />
              </button>
            </div>
            <p>回答必须经过后端引用校验，证据不足时会明确提示。</p>
          </div>
        </section>

        {evidenceOpen && (
          <button
            aria-label="关闭证据抽屉遮罩"
            className="evidence-backdrop"
            type="button"
            onClick={() => setEvidenceOpen(false)}
          />
        )}

        <aside aria-label="来源与证据" className="panel evidence-panel">
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
              openBusy={sourceOpenBusy}
              selection={selectedEvidence}
              onFocusSource={focusEvidenceSource}
              onOpenSource={(selection) => void openEvidenceSource(selection)}
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
          onDelete={() => {
            setSeedError("");
            setConfirmError("");
            setConfirmAction({ kind: "delete-seed-credential" });
          }}
          onFormChange={setSeedForm}
          onReload={() => void loadSeedStatus()}
          maintenanceBusy={maintenanceBusy}
          maintenanceNotice={maintenanceNotice}
          maintenanceStatus={maintenanceStatus}
          usageSummary={usageSummary}
          onCleanup={() => {
            setMaintenanceNotice("");
            setConfirmError("");
            setConfirmAction({
              kind: "cleanup-storage",
              status: maintenanceStatus,
            });
          }}
          onSave={() => void saveSeedCredential()}
          onSaveDefaults={() => void updateSeedDefaults()}
          onValidate={() => void validateSeedCredential()}
        />
      )}

      {researchEditorOpen && researchBrief && researchWorkspace && (
        <ResearchBriefEditorDialog
          brief={researchBrief}
          busy={researchBusy}
          editorTab={researchEditorTab}
          error={researchError}
          liveRun={researchLiveRun}
          notice={researchNotice}
          outlineText={researchOutlineText}
          planText={researchPlanText}
          saveState={researchSaveState}
          selectedSectionId={researchSelectedSectionId}
          selection={researchSelection}
          workspace={researchWorkspace}
          onClose={() => void closeResearchEditor()}
          onEditorTabChange={setResearchEditorTab}
          onExport={() => void exportResearchBrief(researchBrief.brief.runId)}
          onOperation={(action) => void operateResearchBrief(action)}
          onOutlineTextChange={changeResearchOutlineText}
          onPlanTextChange={changeResearchPlanText}
          onResolvePending={(decision) => void resolveResearchPending(decision)}
          onSelectCitation={selectCitation}
          onSectionSelect={setResearchSelectedSectionId}
          onSelectionChange={setResearchSelection}
          selectedChunkId={selectedEvidenceChunkId(selectedEvidence)}
          onWorkspaceChange={changeResearchWorkspace}
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

      {externalResearchOpen && (
        <ExternalResearchDialog
          busy={externalResearchBusy}
          candidateIds={externalCandidateIds}
          error={externalResearchError}
          mcpForm={mcpServerForm}
          query={externalResearchQuery}
          result={externalResearchResult}
          selectedServerId={selectedMcpServerId}
          selectedToolName={selectedMcpToolName}
          servers={mcpServers}
          tools={mcpTools}
          onCandidateToggle={(candidateId) =>
            setExternalCandidateIds((items) =>
              items.includes(candidateId)
                ? items.filter((item) => item !== candidateId)
                : [...items, candidateId],
            )
          }
          onClose={() => {
            if (!externalResearchBusy) {
              setExternalResearchOpen(false);
            }
          }}
          onDecide={(decision) => void decideExternalResearch(decision)}
          onDiscover={(serverId) => {
            setSelectedMcpServerId(serverId);
            setExternalResearchBusy(true);
            setExternalResearchError("");
            void discoverMcpServer(serverId)
              .catch((error: unknown) =>
                setExternalResearchError(
                  error instanceof Error ? error.message : "MCP 能力发现失败",
                ),
              )
              .finally(() => setExternalResearchBusy(false));
          }}
          onMcpFormChange={setMcpServerForm}
          onQueryChange={setExternalResearchQuery}
          onSaveServer={() => void saveMcpServer()}
          onSearch={() => void searchExternalResearch()}
          onToolChange={setSelectedMcpToolName}
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
          onDecideVersion={(versionId, decision) =>
            void decideSourceVersion(versionId, decision)
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
            seedBusy ||
            maintenanceBusy
          }
          error={confirmError}
          onClose={() => {
            if (
              !sourceDeleteBusyId &&
              !conversationDeleteBusyId &&
              !seedBusy &&
              !maintenanceBusy
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

function ResearchBriefArtifactMessage({
  brief,
  display,
  expanded,
  focused,
  message,
  selectedChunkId,
  onCopy,
  onEdit,
  onExport,
  onFocus,
  onSelectCitation,
  onToggleExpanded,
}: {
  brief?: ResearchBriefResponse;
  display: "full" | "reference";
  expanded: boolean;
  focused: boolean;
  message: ConversationMessageRecord;
  selectedChunkId?: string;
  onCopy: () => void;
  onEdit: () => void;
  onExport: () => void;
  onFocus: () => void;
  onSelectCitation: (citation: AnswerCitation) => void;
  onToggleExpanded: () => void;
}): React.JSX.Element {
  if (!brief) {
    return (
      <article className="research-artifact-card loading">
        <span className="status-dot online" />
        正在加载研究简报…
      </article>
    );
  }
  if (display === "reference") {
    return (
      <button
        className={`research-artifact-reference ${focused ? "focused" : ""}`}
        type="button"
        onClick={onFocus}
      >
        <Icon name="book" size={16} />
        <span>
          <strong>{message.content}</strong>
          <small>点击设为当前简报</small>
        </span>
        <Icon name="chevron" size={14} />
      </button>
    );
  }
  const content = brief.workspace.final || brief.workspace.draft;
  const citations = uniqueCitations(brief.citations);
  return (
    <div className="research-artifact-message">
      <p>{message.content}</p>
      <article
        className={`research-artifact-card ${focused ? "focused" : ""}`}
        onClick={onFocus}
      >
        <header>
          <button
            className="research-artifact-edit"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onEdit();
            }}
          >
            <Icon name="document" size={15} />
            编辑
          </button>
          <div>
            <button
              aria-label="复制研究简报"
              className="icon-button"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onCopy();
              }}
            >
              <Icon name="copy" size={15} />
            </button>
            <button
              aria-label="导出研究简报"
              className="icon-button"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onExport();
              }}
            >
              <Icon name="download" size={15} />
            </button>
            <button
              aria-label={expanded ? "收起研究简报" : "展开研究简报"}
              className="icon-button"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggleExpanded();
              }}
            >
              <Icon name="panel" size={15} />
            </button>
          </div>
        </header>
        <div
          className={`research-artifact-preview ${expanded ? "expanded" : ""}`}
        >
          <h2>{brief.workspace.title}</h2>
          <p>{researchPreviewContent(content, brief.workspace.title)}</p>
        </div>
        {citations.length > 0 && (
          <div className="research-artifact-citations">
            {citations
              .slice(0, expanded ? undefined : 6)
              .map((citation, index) => (
                <InlineCitationButton
                  citation={citation}
                  citationNumber={index + 1}
                  key={`${citation.chunkId}:${index}`}
                  selected={selectedChunkId === citation.chunkId}
                  onSelect={onSelectCitation}
                />
              ))}
          </div>
        )}
        <footer>
          <span>
            人工 v{brief.brief.userRevision} · Agent v
            {brief.brief.agentRevision}
          </span>
          <span>{brief.brief.sourceIds.length} 个来源</span>
          {brief.brief.hasPendingAgentUpdate && <span>Agent 更新待合并</span>}
        </footer>
      </article>
    </div>
  );
}

function ResearchBriefEditorDialog({
  brief,
  busy,
  editorTab,
  error,
  liveRun,
  notice,
  outlineText,
  planText,
  saveState,
  selectedChunkId,
  selectedSectionId,
  selection,
  workspace,
  onClose,
  onEditorTabChange,
  onExport,
  onOperation,
  onOutlineTextChange,
  onPlanTextChange,
  onResolvePending,
  onSelectCitation,
  onSectionSelect,
  onSelectionChange,
  onWorkspaceChange,
}: {
  brief: ResearchBriefResponse;
  busy: boolean;
  editorTab: ResearchEditorTab;
  error: string;
  liveRun: AgentRunResponse | null;
  notice: string;
  outlineText: string;
  planText: string;
  saveState: "idle" | "saving" | "saved" | "conflict";
  selectedChunkId?: string;
  selectedSectionId: string;
  selection: string;
  workspace: ResearchBriefWorkspace;
  onClose: () => void;
  onEditorTabChange: (tab: ResearchEditorTab) => void;
  onExport: () => void;
  onOperation: (action: ResearchBriefAction) => void;
  onOutlineTextChange: (value: string) => void;
  onPlanTextChange: (value: string) => void;
  onResolvePending: (decision: "apply" | "discard") => void;
  onSelectCitation: (citation: AnswerCitation) => void;
  onSectionSelect: (sectionId: string) => void;
  onSelectionChange: (value: string) => void;
  onWorkspaceChange: (value: ResearchBriefWorkspace) => void;
}): React.JSX.Element {
  const selectedSection = workspace.sections.find(
    (section) => section.id === selectedSectionId,
  );
  const captureSelection = (
    event: React.SyntheticEvent<HTMLTextAreaElement>,
  ): void => {
    const target = event.currentTarget;
    onSelectionChange(
      target.value.slice(target.selectionStart, target.selectionEnd).trim(),
    );
  };
  const updateSection = (
    patch: Partial<{ title: string; content: string }>,
  ): void => {
    if (!selectedSection) return;
    onWorkspaceChange({
      ...workspace,
      sections: workspace.sections.map((section) =>
        section.id === selectedSection.id ? { ...section, ...patch } : section,
      ),
    });
  };
  return (
    <AppDialog
      backdropClassName="research-editor-backdrop"
      className="research-editor-dialog"
      closeDisabled={saveState === "saving"}
      describedBy="research-editor-description"
      labelledBy="research-editor-title"
      onClose={onClose}
    >
      <header className="research-editor-heading">
        <div>
          <span className="eyebrow">对话内研究简报</span>
          <h2 id="research-editor-title">{workspace.title}</h2>
          <p id="research-editor-description">
            编辑研究计划、大纲、草稿和最终输出；保存中会临时锁定关闭。
          </p>
        </div>
        <div>
          <span className={`research-save-state ${saveState}`}>
            {researchSaveStateLabel(saveState)}
          </span>
          <button className="button ghost" type="button" onClick={onExport}>
            <Icon name="download" size={15} />
            导出
          </button>
          <button
            aria-label="关闭研究简报编辑器"
            className="icon-button"
            disabled={saveState === "saving"}
            type="button"
            onClick={onClose}
          >
            <Icon name="close" size={17} />
          </button>
        </div>
      </header>
      <div className="research-editor-layout">
        <main className="research-editor-main">
          {Object.keys(brief.pendingAgentUpdate).length > 0 && (
            <div className="research-pending-banner">
              <span>
                <strong>Agent 更新等待合并</strong>
                执行期间检测到人工编辑，当前内容未被覆盖。
              </span>
              <div>
                <button
                  className="button ghost"
                  disabled={busy}
                  type="button"
                  onClick={() => onResolvePending("discard")}
                >
                  放弃
                </button>
                <button
                  className="button primary"
                  disabled={busy}
                  type="button"
                  onClick={() => onResolvePending("apply")}
                >
                  合并更新
                </button>
              </div>
            </div>
          )}
          {error && <div className="inline-error">{error}</div>}
          {notice && <div className="inline-notice">{notice}</div>}
          <div className="research-title-fields">
            <input
              aria-label="研究简报标题"
              value={workspace.title}
              onChange={(event) =>
                onWorkspaceChange({ ...workspace, title: event.target.value })
              }
            />
            <textarea
              aria-label="研究简报目标"
              rows={2}
              value={workspace.goal}
              onChange={(event) =>
                onWorkspaceChange({ ...workspace, goal: event.target.value })
              }
            />
          </div>
          <div className="research-editor-tabs">
            {(
              [
                ["final", "最终稿"],
                ["draft", "草稿"],
                ["outline", "大纲"],
                ["plan", "计划"],
              ] as Array<[ResearchEditorTab, string]>
            ).map(([tab, label]) => (
              <button
                className={editorTab === tab ? "active" : ""}
                key={tab}
                type="button"
                onClick={() => onEditorTabChange(tab)}
              >
                {label}
              </button>
            ))}
          </div>
          {editorTab === "plan" && (
            <textarea
              aria-label="研究计划"
              className="research-main-editor structured"
              spellCheck={false}
              value={planText}
              onChange={(event) => onPlanTextChange(event.target.value)}
              onSelect={captureSelection}
            />
          )}
          {editorTab === "outline" && (
            <textarea
              aria-label="研究大纲"
              className="research-main-editor structured"
              spellCheck={false}
              value={outlineText}
              onChange={(event) => onOutlineTextChange(event.target.value)}
              onSelect={captureSelection}
            />
          )}
          {editorTab === "draft" && (
            <>
              <div className="research-section-tabs">
                {workspace.sections.map((section) => (
                  <button
                    className={section.id === selectedSectionId ? "active" : ""}
                    key={section.id}
                    type="button"
                    onClick={() => onSectionSelect(section.id)}
                  >
                    {section.title}
                  </button>
                ))}
              </div>
              <textarea
                aria-label="研究草稿"
                className="research-main-editor"
                value={workspace.draft}
                onChange={(event) =>
                  onWorkspaceChange({
                    ...workspace,
                    draft: event.target.value,
                  })
                }
                onSelect={captureSelection}
              />
              {selectedSection && (
                <div className="research-section-editor">
                  <input
                    aria-label="章节标题"
                    value={selectedSection.title}
                    onChange={(event) =>
                      updateSection({ title: event.target.value })
                    }
                  />
                  <textarea
                    aria-label="章节内容"
                    rows={5}
                    value={selectedSection.content}
                    onChange={(event) =>
                      updateSection({ content: event.target.value })
                    }
                    onSelect={captureSelection}
                  />
                </div>
              )}
            </>
          )}
          {editorTab === "final" && (
            <textarea
              aria-label="研究最终稿"
              className="research-main-editor"
              value={workspace.final}
              onChange={(event) =>
                onWorkspaceChange({
                  ...workspace,
                  final: event.target.value,
                })
              }
              onSelect={captureSelection}
            />
          )}
          <div className="research-operation-bar">
            <span>
              {selection
                ? `已选中 ${selection.length} 个字符`
                : "未选中文本时作用于整份简报"}
            </span>
            <div>
              <button
                className="button ghost"
                disabled={busy}
                type="button"
                onClick={() => onOperation("continue_research")}
              >
                继续研究
              </button>
              <button
                className="button ghost"
                disabled={busy}
                type="button"
                onClick={() => onOperation("supplement_evidence")}
              >
                补充证据
              </button>
              <button
                className="button ghost"
                disabled={busy}
                type="button"
                onClick={() => onOperation("audit_citations")}
              >
                审计引用
              </button>
              <button
                className="button ghost"
                disabled={busy || !selectedSectionId}
                type="button"
                onClick={() => onOperation("regenerate_section")}
              >
                重生成章节
              </button>
            </div>
          </div>
        </main>
        <aside className="research-editor-audit">
          {busy && (
            <div className="research-running-notice">
              <span className="status-dot online" />
              Agent 正在执行
            </div>
          )}
          {liveRun && (
            <AgentRunTracePanel
              answerVisible
              busyAction=""
              error=""
              response={liveRun}
              onAction={() => undefined}
            />
          )}
          {brief.citations.length > 0 && (
            <ResearchSideSection title="引用证据">
              <div className="research-artifact-citations">
                {uniqueCitations(brief.citations).map((citation, index) => (
                  <InlineCitationButton
                    citation={citation}
                    citationNumber={index + 1}
                    key={`${citation.chunkId}:${index}`}
                    selected={selectedChunkId === citation.chunkId}
                    onSelect={onSelectCitation}
                  />
                ))}
              </div>
            </ResearchSideSection>
          )}
          {workspace.conflicts.length > 0 && (
            <ResearchSideSection title="来源冲突">
              {workspace.conflicts.map((conflict, index) => (
                <article key={`editor-conflict-${index}`}>
                  <strong>
                    {researchRecordLabel(conflict, `冲突 ${index + 1}`)}
                  </strong>
                  <small>{JSON.stringify(conflict)}</small>
                </article>
              ))}
            </ResearchSideSection>
          )}
          {Object.keys(workspace.latestAudit).length > 0 && (
            <ResearchSideSection title="引用审计">
              <pre>{JSON.stringify(workspace.latestAudit, null, 2)}</pre>
            </ResearchSideSection>
          )}
        </aside>
      </div>
    </AppDialog>
  );
}

export function ResearchWorkspace({
  brief,
  briefs,
  busy,
  dirty,
  editorTab,
  error,
  goal,
  liveRun,
  notice,
  outlineText,
  planText,
  selectedSectionId,
  selectedSourceIds,
  selection,
  sources,
  workspace,
  onAddFiles,
  onAddWeb,
  onCreate,
  onEditorTabChange,
  onExport,
  onExternalResearch,
  onGoalChange,
  onOpenBrief,
  onOperation,
  onOutlineTextChange,
  onPlanTextChange,
  onResolvePending,
  onSave,
  onSectionSelect,
  onSelectAllSources,
  onSelectionChange,
  onSourceToggle,
  onTraceAction,
  onWorkspaceChange,
}: {
  brief: ResearchBriefResponse | null;
  briefs: ResearchBriefSummary[];
  busy: boolean;
  dirty: boolean;
  editorTab: ResearchEditorTab;
  error: string;
  goal: string;
  liveRun: AgentRunResponse | null;
  notice: string;
  outlineText: string;
  planText: string;
  selectedSectionId: string;
  selectedSourceIds: string[];
  selection: string;
  sources: KnowledgeBaseSource[];
  workspace: ResearchBriefWorkspace | null;
  onAddFiles: () => void;
  onAddWeb: () => void;
  onCreate: () => void;
  onEditorTabChange: (tab: ResearchEditorTab) => void;
  onExport: () => void;
  onExternalResearch: () => void;
  onGoalChange: (value: string) => void;
  onOpenBrief: (runId: string) => void;
  onOperation: (action: ResearchBriefAction) => void;
  onOutlineTextChange: (value: string) => void;
  onPlanTextChange: (value: string) => void;
  onResolvePending: (decision: "apply" | "discard") => void;
  onSave: () => void;
  onSectionSelect: (sectionId: string) => void;
  onSelectAllSources: () => void;
  onSelectionChange: (value: string) => void;
  onSourceToggle: (sourceId: string) => void;
  onTraceAction: (runId: string, action: "resume" | "cancel" | "retry") => void;
  onWorkspaceChange: (value: ResearchBriefWorkspace) => void;
}): React.JSX.Element {
  const selectedSection = workspace?.sections.find(
    (section) => section.id === selectedSectionId,
  );
  const pendingCandidates =
    brief?.externalCandidates.filter(
      (candidate) => candidate.status === "candidate",
    ) ?? [];
  const updateSection = (
    patch: Partial<{ title: string; content: string }>,
  ): void => {
    if (!workspace || !selectedSection) {
      return;
    }
    onWorkspaceChange({
      ...workspace,
      sections: workspace.sections.map((section) =>
        section.id === selectedSection.id ? { ...section, ...patch } : section,
      ),
    });
  };
  const captureSelection = (
    event: React.SyntheticEvent<HTMLTextAreaElement>,
  ): void => {
    const target = event.currentTarget;
    onSelectionChange(
      target.value.slice(target.selectionStart, target.selectionEnd).trim(),
    );
  };

  return (
    <>
      <aside className="panel research-scope-panel">
        <PanelHeader
          icon="folder"
          title="资料范围"
          count={selectedSourceIds.length}
        />
        <div className="research-create-block">
          <label>
            <span>研究目标</span>
            <textarea
              disabled={busy}
              placeholder="例如：梳理当前方案的核心结论、冲突与证据缺口"
              rows={3}
              value={goal}
              onChange={(event) => onGoalChange(event.target.value)}
            />
          </label>
          <button
            className="button primary"
            disabled={busy || !goal.trim()}
            type="button"
            onClick={onCreate}
          >
            <Icon name="sparkle" size={15} />
            生成研究简报
          </button>
        </div>

        {briefs.length > 0 && (
          <div className="research-brief-list">
            <div className="research-section-heading">
              <strong>研究任务</strong>
              <span>{briefs.length}</span>
            </div>
            {briefs.map((item) => (
              <button
                className={item.runId === brief?.brief.runId ? "active" : ""}
                disabled={busy}
                key={item.runId}
                type="button"
                onClick={() => onOpenBrief(item.runId)}
              >
                <strong>{item.title}</strong>
                <small>
                  人工 v{item.userRevision} · Agent v{item.agentRevision}
                  {item.hasPendingAgentUpdate ? " · 待合并" : ""}
                </small>
              </button>
            ))}
          </div>
        )}

        <div className="research-section-heading source-scope-heading">
          <strong>当前知识库来源</strong>
          <button
            className="text-button"
            type="button"
            onClick={onSelectAllSources}
          >
            全选
          </button>
        </div>
        <div className="research-source-actions">
          <button
            className="button ghost"
            disabled={busy}
            type="button"
            onClick={onAddFiles}
          >
            添加文件
          </button>
          <button
            className="button ghost"
            disabled={busy}
            type="button"
            onClick={onAddWeb}
          >
            网页链接
          </button>
        </div>
        <div className="research-source-list">
          {sources.map((source) => (
            <button
              className={
                selectedSourceIds.includes(source.id) ? "selected" : ""
              }
              key={source.id}
              type="button"
              onClick={() => onSourceToggle(source.id)}
            >
              <span className={`source-icon ${sourceTone(source)}`}>
                <Icon name="document" size={15} />
              </span>
              <span>
                <strong>{source.displayName}</strong>
                <small>{sourceMeta(source)}</small>
              </span>
              <span className="source-check">
                {selectedSourceIds.includes(source.id) && (
                  <Icon name="check" size={13} />
                )}
              </span>
            </button>
          ))}
        </div>

        <div className="research-external-block">
          <div className="research-section-heading">
            <strong>待确认外部资料</strong>
            <span>{pendingCandidates.length}</span>
          </div>
          <button
            className="button external-research-button"
            disabled={busy}
            type="button"
            onClick={onExternalResearch}
          >
            <Icon name="sparkle" size={15} />
            寻找外部资料
          </button>
          {pendingCandidates.map((candidate) => (
            <a
              href={candidate.url}
              key={candidate.id}
              rel="noreferrer"
              target="_blank"
            >
              <strong>{candidate.title}</strong>
              <small>{candidate.initialComparison.label ?? "等待确认"}</small>
            </a>
          ))}
        </div>
      </aside>

      <section className="panel research-editor-panel">
        <PanelHeader
          icon="book"
          title="可编辑研究简报"
          subtitle={
            workspace
              ? `${dirty ? "有未保存修改" : "已保存"} · 人工编辑优先`
              : "尚未创建"
          }
          action={
            <div className="research-header-actions">
              <button
                className="button ghost"
                disabled={!workspace || busy}
                type="button"
                onClick={onExport}
              >
                <Icon name="download" size={15} />
                导出
              </button>
              <button
                className="button primary"
                disabled={!workspace || busy || !dirty}
                type="button"
                onClick={onSave}
              >
                {busy ? "处理中" : "保存"}
              </button>
            </div>
          }
        />
        {!workspace ? (
          <div className="research-empty-state">
            <Icon name="sparkle" size={28} />
            <h2>建立一个可持续编辑的研究任务</h2>
            <p>
              选择左侧资料并输入目标。Agent
              会生成计划、大纲、草稿和最终稿，后续更新不会覆盖你的人工修改。
            </p>
          </div>
        ) : (
          <div className="research-editor-body">
            {Object.keys(brief?.pendingAgentUpdate ?? {}).length > 0 && (
              <div className="research-pending-banner">
                <span>
                  <strong>Agent 更新等待合并</strong>
                  执行期间检测到人工编辑，当前内容未被覆盖。
                </span>
                <div>
                  <button
                    className="button ghost"
                    disabled={busy}
                    type="button"
                    onClick={() => onResolvePending("discard")}
                  >
                    放弃
                  </button>
                  <button
                    className="button primary"
                    disabled={busy}
                    type="button"
                    onClick={() => onResolvePending("apply")}
                  >
                    合并更新
                  </button>
                </div>
              </div>
            )}
            {error && <div className="inline-error">{error}</div>}
            {notice && <div className="inline-notice">{notice}</div>}
            <div className="research-title-fields">
              <input
                aria-label="研究简报标题"
                value={workspace.title}
                onChange={(event) =>
                  onWorkspaceChange({
                    ...workspace,
                    title: event.target.value,
                  })
                }
              />
              <textarea
                aria-label="研究简报目标"
                rows={2}
                value={workspace.goal}
                onChange={(event) =>
                  onWorkspaceChange({
                    ...workspace,
                    goal: event.target.value,
                  })
                }
              />
            </div>
            <div className="research-editor-tabs">
              {(
                [
                  ["plan", "计划"],
                  ["outline", "大纲"],
                  ["draft", "草稿"],
                  ["final", "最终稿"],
                ] as Array<[ResearchEditorTab, string]>
              ).map(([tab, label]) => (
                <button
                  className={editorTab === tab ? "active" : ""}
                  key={tab}
                  type="button"
                  onClick={() => onEditorTabChange(tab)}
                >
                  {label}
                </button>
              ))}
            </div>
            {editorTab === "draft" && workspace.sections.length > 0 && (
              <div className="research-section-tabs">
                {workspace.sections.map((section) => (
                  <button
                    className={section.id === selectedSectionId ? "active" : ""}
                    key={section.id}
                    type="button"
                    onClick={() => onSectionSelect(section.id)}
                  >
                    {section.title}
                  </button>
                ))}
              </div>
            )}
            {editorTab === "plan" && (
              <textarea
                className="research-main-editor structured"
                aria-label="研究计划"
                spellCheck={false}
                value={planText}
                onChange={(event) => onPlanTextChange(event.target.value)}
                onSelect={captureSelection}
              />
            )}
            {editorTab === "outline" && (
              <textarea
                className="research-main-editor structured"
                aria-label="研究大纲"
                spellCheck={false}
                value={outlineText}
                onChange={(event) => onOutlineTextChange(event.target.value)}
                onSelect={captureSelection}
              />
            )}
            {editorTab === "draft" && (
              <>
                <textarea
                  className="research-main-editor"
                  aria-label="研究草稿"
                  value={workspace.draft}
                  onChange={(event) =>
                    onWorkspaceChange({
                      ...workspace,
                      draft: event.target.value,
                    })
                  }
                  onSelect={captureSelection}
                />
                {selectedSection && (
                  <div className="research-section-editor">
                    <label>
                      <span>指定章节</span>
                      <input
                        value={selectedSection.title}
                        onChange={(event) =>
                          updateSection({ title: event.target.value })
                        }
                      />
                    </label>
                    <textarea
                      aria-label="指定章节内容"
                      rows={5}
                      value={selectedSection.content}
                      onChange={(event) =>
                        updateSection({ content: event.target.value })
                      }
                      onSelect={captureSelection}
                    />
                  </div>
                )}
              </>
            )}
            {editorTab === "final" && (
              <textarea
                className="research-main-editor"
                aria-label="研究最终稿"
                value={workspace.final}
                onChange={(event) =>
                  onWorkspaceChange({
                    ...workspace,
                    final: event.target.value,
                  })
                }
                onSelect={captureSelection}
              />
            )}
            <div className="research-operation-bar">
              <span>
                {selection
                  ? `已选中 ${selection.length} 个字符`
                  : "未选中文本时将作用于当前研究目标"}
              </span>
              <div>
                <button
                  className="button ghost"
                  disabled={busy}
                  type="button"
                  onClick={() => onOperation("continue_research")}
                >
                  继续研究
                </button>
                <button
                  className="button ghost"
                  disabled={busy}
                  type="button"
                  onClick={() => onOperation("supplement_evidence")}
                >
                  补充证据
                </button>
                <button
                  className="button ghost"
                  disabled={busy}
                  type="button"
                  onClick={() => onOperation("audit_citations")}
                >
                  审计引用
                </button>
                <button
                  className="button ghost"
                  disabled={busy || !selectedSectionId}
                  type="button"
                  onClick={() => onOperation("regenerate_section")}
                >
                  重生成章节
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      <aside className="panel research-evidence-panel">
        <PanelHeader icon="evidence" title="执行、确认与证据" />
        <div className="research-evidence-scroll">
          {busy && (
            <div className="research-running-notice">
              <span className="status-dot online" />
              Agent 正在执行，人工编辑仍可保存为新修订。
            </div>
          )}
          {liveRun ? (
            <AgentRunTracePanel
              answerVisible
              busyAction=""
              error=""
              response={liveRun}
              onAction={onTraceAction}
            />
          ) : (
            <div className="research-side-empty">
              执行后将在这里显示 Trace。
            </div>
          )}
          {(liveRun?.confirmations.length ?? 0) > 0 && (
            <ResearchSideSection title="确认记录">
              {liveRun?.confirmations.map((confirmation) => (
                <article key={confirmation.id}>
                  <strong>{confirmation.prompt}</strong>
                  <small>{confirmationStatusLabel(confirmation.status)}</small>
                </article>
              ))}
            </ResearchSideSection>
          )}
          {(liveRun?.toolCalls.length ?? 0) > 0 && (
            <ResearchSideSection title="Tool 摘要">
              {liveRun?.toolCalls.slice(0, 6).map((tool) => (
                <article key={tool.id}>
                  <strong>{tool.toolName}</strong>
                  <small>
                    {tool.status} · {tool.stdoutSummary ?? tool.actionSummary}
                  </small>
                </article>
              ))}
            </ResearchSideSection>
          )}
          {(workspace?.evidenceChunkIds.length ?? 0) > 0 && (
            <ResearchSideSection title="引用证据">
              <div className="research-evidence-chips">
                {workspace?.evidenceChunkIds.map((chunkId) => (
                  <code key={chunkId}>{chunkId}</code>
                ))}
              </div>
            </ResearchSideSection>
          )}
          {(workspace?.conflicts.length ?? 0) > 0 && (
            <ResearchSideSection title="来源冲突">
              {workspace?.conflicts.map((conflict, index) => (
                <article key={`conflict-${index}`}>
                  <strong>
                    {researchRecordLabel(conflict, `冲突 ${index + 1}`)}
                  </strong>
                  <small>{JSON.stringify(conflict)}</small>
                </article>
              ))}
            </ResearchSideSection>
          )}
          {workspace && Object.keys(workspace.latestAudit).length > 0 && (
            <ResearchSideSection title="引用审计">
              <pre>{JSON.stringify(workspace.latestAudit, null, 2)}</pre>
            </ResearchSideSection>
          )}
        </div>
      </aside>
    </>
  );
}

function ResearchSideSection({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}): React.JSX.Element {
  return (
    <section className="research-side-section">
      <h3>{title}</h3>
      <div>{children}</div>
    </section>
  );
}

function PendingAgentRunTracePanel({
  startedAt,
}: {
  startedAt: string;
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now());
  const startedAtMs = new Date(startedAt).getTime();

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section className="agent-trace-panel expanded">
      <header className="agent-trace-heading">
        <div className="agent-trace-title">
          <strong>
            已处理{" "}
            {formatAgentRunDuration(
              Number.isNaN(startedAtMs) ? 0 : now - startedAtMs,
            )}
          </strong>
          <small>正在启动</small>
          <Icon name="chevron" size={15} />
        </div>
      </header>
      <div className="agent-trace-body">
        <div className="agent-trace-list">
          <article className="agent-trace-event running">
            <div className="agent-trace-event-main">
              <span className="agent-trace-event-icon">›</span>
              <span>
                <strong>正在创建当前任务</strong>
                <small>准备执行上下文与工具调用</small>
              </span>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

function AgentRunTracePanel({
  answerVisible,
  busyAction,
  error,
  response,
  onAction,
}: {
  answerVisible: boolean;
  busyAction: string;
  error: string;
  response: AgentRunResponse;
  onAction: (runId: string, action: "resume" | "cancel" | "retry") => void;
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now());
  const { run, events, toolCalls, confirmations, delegations } = response;
  const finished = isAgentRunFinished(run.status);
  const [expanded, setExpanded] = useState(!finished || !answerVisible);
  const [filter, setFilter] = useState("all");
  const [expandedToolCallId, setExpandedToolCallId] = useState("");
  const [expandedDelegationId, setExpandedDelegationId] = useState("");
  const previousRunStatusRef = useRef(run.status);
  const eventListRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    setFilter("all");
    setExpandedToolCallId("");
    setExpandedDelegationId("");
    setExpanded(!isAgentRunFinished(run.status) || !answerVisible);
    previousRunStatusRef.current = run.status;
  }, [answerVisible, run.id, run.status]);

  useEffect(() => {
    const previouslyFinished = isAgentRunFinished(previousRunStatusRef.current);
    if (!finished || !answerVisible) {
      setExpanded(true);
    } else if (!previouslyFinished) {
      setExpanded(false);
    }
    previousRunStatusRef.current = run.status;
  }, [answerVisible, finished, run.status]);

  useEffect(() => {
    const list = eventListRef.current;
    if (!list || !expanded || finished) {
      return;
    }
    const distanceFromBottom =
      list.scrollHeight - list.scrollTop - list.clientHeight;
    if (distanceFromBottom <= 80) {
      list.scrollTop = list.scrollHeight;
    }
  }, [events.length, expanded, finished]);

  return (
    <section className={`agent-trace-panel ${expanded ? "expanded" : ""}`}>
      <header className="agent-trace-heading">
        <button
          className="agent-trace-title"
          type="button"
          onClick={() => setExpanded((value) => !value)}
        >
          <strong>
            {finished ? "已执行" : "已处理"} {formatAgentRunDuration(elapsedMs)}
          </strong>
          {expanded && <small>{currentStage}</small>}
          <Icon name="chevron" size={15} />
        </button>
        <div className="agent-trace-actions">
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

      {expanded && (
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
                onChange={(event) => setFilter(event.target.value)}
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
              {delegations.length} 个子 Agent ·{" "}
              {pendingConfirmations(confirmations)} 个待确认
            </span>
          </div>
          {delegations.length > 0 && (
            <div className="sub-agent-trace-list">
              {delegations.map((delegation) => {
                const delegationExpanded =
                  expandedDelegationId === delegation.id;
                return (
                  <article
                    className={`sub-agent-trace-card ${delegation.status}`}
                    key={delegation.id}
                  >
                    <button
                      className="sub-agent-trace-heading"
                      type="button"
                      onClick={() =>
                        setExpandedDelegationId(
                          delegationExpanded ? "" : delegation.id,
                        )
                      }
                    >
                      <span>
                        <strong>{delegation.delegateeRole}</strong>
                        <small>{delegation.task}</small>
                      </span>
                      <span className="sub-agent-trace-status">
                        {delegationStatusLabel(delegation.status)}
                        <Icon name="chevron" size={13} />
                      </span>
                    </button>
                    {delegationExpanded && (
                      <SubAgentTraceDetail delegation={delegation} />
                    )}
                  </article>
                );
              })}
            </div>
          )}
          <div className="agent-trace-list" ref={eventListRef}>
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
                        setExpandedToolCallId(expandedTool ? "" : toolCall.id);
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

function SubAgentTraceDetail({
  delegation,
}: {
  delegation: AgentRunDelegationRecord;
}): React.JSX.Element {
  return (
    <div className="sub-agent-trace-detail">
      <span>
        <strong>任务</strong>
        {delegation.task}
      </span>
      <span>
        <strong>输入范围</strong>
        <code>{JSON.stringify(delegation.inputScope)}</code>
      </span>
      <span>
        <strong>产出</strong>
        <code>
          {Object.keys(delegation.output).length > 0
            ? JSON.stringify(delegation.output)
            : "等待执行"}
        </code>
      </span>
      <span>
        <strong>停止原因</strong>
        {delegation.stopReason ?? "执行中"}
      </span>
    </div>
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
    <AppDialog
      className="writing-workspace-dialog"
      closeDisabled={busy}
      describedBy="writing-workspace-description"
      labelledBy="writing-workspace-title"
      onClose={onClose}
    >
      <header className="writing-workspace-heading">
        <div>
          <span className="eyebrow">LangGraph 写作工作流</span>
          <h2 id="writing-workspace-title">复习与写作</h2>
          <p id="writing-workspace-description">
            大纲、逐节内容和检查点均绑定到当前知识库证据。
          </p>
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
                        checkpoint.status === "completed" ? "check" : "refresh"
                      }
                      size={13}
                    />
                    <span>
                      <strong>{writingCheckpointLabel(checkpoint.step)}</strong>
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
    </AppDialog>
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
  onClear,
  onSelect,
}: {
  busy: boolean;
  error: string;
  query: string;
  results: HybridSearchResult[];
  selectedChunkId?: string;
  onClear: () => void;
  onSelect: (result: HybridSearchResult) => void;
}): React.JSX.Element {
  return (
    <section
      className="search-results-panel"
      aria-label="资料搜索结果"
      aria-live="polite"
    >
      <div className="search-results-heading">
        <div>
          <span className="section-label">资料搜索</span>
          <strong>{query ? `“${query}”` : "关键词 / 自然语言检索"}</strong>
        </div>
        <div className="search-results-actions">
          <small>FTS5 + 向量混合召回</small>
          <button
            className="text-button"
            disabled={busy}
            type="button"
            onClick={onClear}
          >
            清除
          </button>
        </div>
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

function AppDialog({
  backdropClassName = "",
  children,
  className,
  closeDisabled = false,
  describedBy,
  labelledBy,
  onClose,
}: {
  backdropClassName?: string;
  children: ReactNode;
  className: string;
  closeDisabled?: boolean;
  describedBy?: string;
  labelledBy: string;
  onClose: () => void;
}): React.JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const timer = window.setTimeout(() => {
      const dialog = dialogRef.current;
      if (!dialog) {
        return;
      }
      const focusable = getDialogFocusableElements(dialog);
      (focusable[0] ?? dialog).focus({ preventScroll: true });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      const previous = previousFocusRef.current;
      if (previous?.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape" && !closeDisabled) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      trapDialogFocus(event, dialogRef.current);
    }
  };

  return (
    <div
      className={`modal-backdrop ${backdropClassName}`.trim()}
      role="presentation"
    >
      <section
        aria-describedby={describedBy}
        aria-labelledby={labelledBy}
        aria-modal="true"
        className={className}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {children}
      </section>
    </div>
  );
}

function AppNotificationToast({
  historyCount,
  notification,
  onAction,
  onDismiss,
  onToggleHistory,
}: {
  historyCount: number;
  notification: AppNotification;
  onAction: (action: AppNotificationAction) => void;
  onDismiss: () => void;
  onToggleHistory: () => void;
}): React.JSX.Element {
  return (
    <section
      aria-live={notification.tone === "error" ? "assertive" : "polite"}
      className={`app-notification-toast ${notification.tone}`}
      role={notification.tone === "error" ? "alert" : "status"}
    >
      <div className="app-notification-copy">
        <strong>{notification.title}</strong>
        <span>{notification.message}</span>
      </div>
      {(notification.actions?.length ?? 0) > 0 && (
        <div className="app-notification-actions">
          {notification.actions?.map((action) => (
            <button
              key={`${notification.id}:${action.kind}:${action.label}`}
              type="button"
              onClick={() => onAction(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      <button
        className="app-notification-history-button"
        type="button"
        onClick={onToggleHistory}
      >
        历史 {historyCount}
      </button>
      <button
        aria-label="关闭通知"
        className="app-notification-close"
        type="button"
        onClick={onDismiss}
      >
        <Icon name="close" size={15} />
      </button>
    </section>
  );
}

function NotificationHistory({
  notifications,
  onAction,
  onClear,
  onClose,
}: {
  notifications: AppNotification[];
  onAction: (action: AppNotificationAction) => void;
  onClear: () => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <aside className="notification-history" aria-label="通知历史">
      <header>
        <div>
          <strong>通知历史</strong>
          <small>{notifications.length} 条最近记录</small>
        </div>
        <button aria-label="关闭通知历史" type="button" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </header>
      <div className="notification-history-list">
        {notifications.map((notification) => (
          <article
            className={`notification-history-item ${notification.tone}`}
            key={notification.id}
          >
            <div>
              <strong>{notification.title}</strong>
              <small>{formatNotificationTime(notification.createdAt)}</small>
            </div>
            <p>{notification.message}</p>
            {(notification.actions?.length ?? 0) > 0 && (
              <div className="notification-history-actions">
                {notification.actions?.map((action) => (
                  <button
                    key={`${notification.id}:history:${action.kind}:${action.label}`}
                    type="button"
                    onClick={() => onAction(action)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
      <button
        className="notification-history-clear"
        disabled={notifications.length === 0}
        type="button"
        onClick={onClear}
      >
        清空历史
      </button>
    </aside>
  );
}

function SetupGuide({
  actionLabel,
  busy,
  description,
  knowledgeBaseName,
  sourceCount,
  title,
  onOpenSettings,
}: {
  actionLabel: string;
  busy: boolean;
  description: string;
  knowledgeBaseName: string;
  sourceCount: number;
  title: string;
  onOpenSettings: () => void;
}): React.JSX.Element {
  return (
    <section className="setup-guide" aria-label="首次使用引导">
      <span className="welcome-icon">
        <Icon name="sparkle" size={25} />
      </span>
      <p className="eyebrow">开始前需要完成</p>
      <h1>{title}</h1>
      <p>
        当前知识库是“{knowledgeBaseName}”。你的资料会保存在本机；{description}
      </p>
      <ol className="setup-steps">
        <li className="active">
          <span>1</span>
          <strong>配置 Ark API Key</strong>
          <small>{busy ? "检查中" : "未完成"}</small>
        </li>
        <li className={sourceCount > 0 ? "done" : ""}>
          <span>2</span>
          <strong>添加第一份资料</strong>
          <small>
            {sourceCount > 0 ? `${sourceCount} 个来源` : "等待配置后继续"}
          </small>
        </li>
        <li>
          <span>3</span>
          <strong>提出第一个问题</strong>
          <small>回答会附带可点击引用</small>
        </li>
      </ol>
      <button
        className="button primary"
        disabled={busy}
        type="button"
        onClick={onOpenSettings}
      >
        <Icon name="settings" size={16} />
        {actionLabel}
      </button>
    </section>
  );
}

function SourceProgress({
  job,
}: {
  job: BackgroundJobRecord;
}): React.JSX.Element {
  const progress = jobProgressPercent(job);
  return (
    <div
      aria-label={`${jobStatusLabel(job.status)}，${progress}%`}
      className="source-progress"
      role="status"
    >
      <span>
        {job.jobType.startsWith("index.") ? "索引" : "导入"} ·{" "}
        {jobStageSummary(job)}
      </span>
      <div aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

function TaskCenter({
  actionBusyId,
  jobs,
  open,
  sources,
  totalCount,
  onAction,
  onClearCompleted,
  onToggle,
}: {
  actionBusyId: string;
  jobs: BackgroundJobRecord[];
  open: boolean;
  sources: KnowledgeBaseSource[];
  totalCount: number;
  onAction: (
    job: BackgroundJobRecord,
    action: "pause" | "resume" | "cancel" | "retry",
  ) => void;
  onClearCompleted: () => void;
  onToggle: () => void;
}): React.JSX.Element | null {
  if (jobs.length === 0 && totalCount === 0) {
    return null;
  }
  const activeCount = jobs.filter(
    (job) => !isTerminalJobStatus(job.status),
  ).length;
  const sourceNames = new Map(
    sources.map((source) => [source.id, source.displayName]),
  );
  const hasVisibleJobs = jobs.length > 0;
  const hasTerminal = jobs.some((job) => isTerminalJobStatus(job.status));

  return (
    <section className="task-center" aria-label="后台任务中心">
      <button
        aria-expanded={open}
        className="task-center-heading"
        type="button"
        onClick={onToggle}
      >
        <span>
          <strong>后台任务</strong>
          <small>
            {activeCount > 0
              ? `正在处理 ${activeCount} 项`
              : totalCount > 0
                ? "最近任务"
                : "暂无任务"}
          </small>
        </span>
        <Icon name="chevron" size={14} />
      </button>
      {hasVisibleJobs && (
        <div className="task-list">
          {jobs.map((job) => (
            <article className={`task-card ${job.status}`} key={job.id}>
              <div className="task-card-heading">
                <span>
                  <strong>{jobTitle(job, sourceNames)}</strong>
                  <small>
                    {jobStatusLabel(job.status)} · {jobElapsedLabel(job)}
                  </small>
                </span>
                <small>{jobProgressPercent(job)}%</small>
              </div>
              <div className="task-progress" aria-hidden="true">
                <span style={{ width: `${jobProgressPercent(job)}%` }} />
              </div>
              <p>{jobStageSummary(job)}</p>
              {job.errorMessage && (
                <p className="task-error">{job.errorMessage}</p>
              )}
              <div className="task-actions">
                {job.status === "running" && (
                  <>
                    <button
                      disabled={actionBusyId === `${job.id}:pause`}
                      type="button"
                      onClick={() => onAction(job, "pause")}
                    >
                      暂停
                    </button>
                    <button
                      disabled={actionBusyId === `${job.id}:cancel`}
                      type="button"
                      onClick={() => onAction(job, "cancel")}
                    >
                      取消
                    </button>
                  </>
                )}
                {["pending", "retrying"].includes(job.status) && (
                  <button
                    disabled={actionBusyId === `${job.id}:cancel`}
                    type="button"
                    onClick={() => onAction(job, "cancel")}
                  >
                    取消
                  </button>
                )}
                {job.status === "paused" && (
                  <button
                    disabled={actionBusyId === `${job.id}:resume`}
                    type="button"
                    onClick={() => onAction(job, "resume")}
                  >
                    继续
                  </button>
                )}
                {job.status === "failed" && (
                  <button
                    disabled={actionBusyId === `${job.id}:retry`}
                    type="button"
                    onClick={() => onAction(job, "retry")}
                  >
                    重试
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {open && hasTerminal && (
        <button className="task-clear" type="button" onClick={onClearCompleted}>
          清理已结束任务
        </button>
      )}
    </section>
  );
}

function PendingAnswerMessage({
  message,
}: {
  message: ConversationMessageRecord;
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now());
  const startedAtMs = new Date(message.createdAt).getTime();
  const elapsedMs = Number.isNaN(startedAtMs) ? 0 : now - startedAtMs;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <article className="assistant-message pending-answer" aria-live="polite">
      <div className="assistant-heading">
        <span className="mini-mark">
          <Icon name="sparkle" size={15} />
        </span>
        <strong>citeMind 正在生成</strong>
        <small>{formatAgentRunDuration(elapsedMs)}</small>
      </div>
    </article>
  );
}

function AssistantAnswerMessage({
  message,
  response,
  selectedChunkId,
  trace,
  exportBusy,
  onExport,
  onSelectCitation,
}: {
  message: ConversationMessageRecord;
  response?: ConversationAnswerResponse;
  selectedChunkId?: string;
  trace?: AgentRunResponse;
  exportBusy: boolean;
  onExport: () => void;
  onSelectCitation: (
    citation: AnswerCitation,
    response?: ConversationAnswerResponse,
    citationNumber?: number,
  ) => void;
}): React.JSX.Element {
  if (isPendingAssistantMessage(message)) {
    return <PendingAnswerMessage message={message} />;
  }

  const citations = response?.citations ?? message.citations;
  const paragraphs =
    response?.answer.paragraphs ??
    answerParagraphsFromMessage(message) ??
    message.content
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
  const answerMode =
    response?.answer.answerMode ?? answerModeFromMessage(message);
  const systemMetaAnswer = answerMode === "system_meta";
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
      {!evidenceSufficient && !systemMetaAnswer && (
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
          {systemMetaAnswer
            ? "系统说明"
            : response
              ? `检索候选 ${response.retrieval.retrieval.mergedCandidateCount}`
              : `${citations.length} 条持久化引用`}
        </span>
        <span>
          {systemMetaAnswer
            ? "无需知识库引用"
            : !evidenceSufficient
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
  openBusy,
  selection,
  onFocusSource,
  onOpenSource,
}: {
  jumpNotice: string;
  openBusy: boolean;
  selection: EvidenceSelection | null;
  onFocusSource: (selection: EvidenceSelection) => void;
  onOpenSource: (selection: EvidenceSelection) => void;
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
        <div className="evidence-actions">
          <button
            className="button evidence-action primary-action"
            disabled={openBusy}
            type="button"
            onClick={() => onOpenSource(selection)}
          >
            {openBusy ? "打开中…" : "打开原文"}{" "}
            <Icon name="chevron" size={15} />
          </button>
          <button
            className="button evidence-action"
            type="button"
            onClick={() => onFocusSource(selection)}
          >
            来源列表定位 <Icon name="chevron" size={15} />
          </button>
        </div>
      </article>
    </>
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
  onDecideVersion: (versionId: string, decision: "accept" | "reject") => void;
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
    <AppDialog
      className="source-maintenance-dialog"
      closeDisabled={busy}
      describedBy="source-maintenance-description"
      labelledBy="source-maintenance-title"
      onClose={onClose}
    >
      <header className="settings-heading">
        <div>
          <p className="eyebrow">Source Maintenance</p>
          <h2 id="source-maintenance-title">{value.source.displayName}</h2>
          <span id="source-maintenance-description">
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
                        onClick={() => onDecideRelation(relation.id, "dismiss")}
                      >
                        忽略
                      </button>
                      <button
                        className="button ghost"
                        disabled={busy}
                        type="button"
                        onClick={() => onDecideRelation(relation.id, "confirm")}
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
                        onClick={() => onDecideVersion(version.id, "reject")}
                      >
                        忽略
                      </button>
                      <button
                        className="button primary"
                        disabled={busy}
                        type="button"
                        onClick={() => onDecideVersion(version.id, "accept")}
                      >
                        采用
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
    </AppDialog>
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
  const content = (() => {
    switch (action.kind) {
      case "delete-source":
        return {
          eyebrow: "Source",
          title: "删除已导入来源",
          description: `将删除“${action.source.displayName}”的文件副本、解析产物、文本块、向量和历史引用。此操作无法撤销。`,
          submitLabel: "删除来源",
          busyLabel: "删除中...",
          danger: true,
        };
      case "delete-conversation":
        return {
          eyebrow: "Conversation",
          title: "删除历史对话",
          description: `将删除“${action.conversation.title}”及其全部消息和引用记录。此操作无法撤销。`,
          submitLabel: "删除对话",
          busyLabel: "删除中...",
          danger: true,
        };
      case "delete-seed-credential":
        return {
          eyebrow: "Seed API",
          title: "删除 Ark API Key",
          description:
            "将删除本机加密保存的 Ark API Key。删除后，新对话、检索增强回答和模型验证会被配置要求阻断，直到重新保存有效 Key。",
          submitLabel: "删除 Key",
          busyLabel: "删除中...",
          danger: true,
        };
      case "cleanup-storage":
        return {
          eyebrow: "Storage",
          title: "清理应用存储",
          description: `将清理失效索引、旧版本索引和孤儿文件，不会删除知识库、来源或对话。当前可回收索引 ${action.status?.recyclableIndexCount ?? 0} 个，旧版本 ${action.status?.recyclableSourceVersionCount ?? 0} 个。`,
          submitLabel: "清理存储",
          busyLabel: "清理中...",
          danger: true,
        };
    }
  })();

  return (
    <AppDialog
      className="kb-dialog"
      closeDisabled={busy}
      describedBy="confirm-action-description"
      labelledBy="confirm-action-title"
      onClose={onClose}
    >
      <header className="settings-heading">
        <div>
          <p className="eyebrow">{content.eyebrow}</p>
          <h2 id="confirm-action-title">{content.title}</h2>
          <span id="confirm-action-description">{content.description}</span>
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
    </AppDialog>
  );
}

function ExternalResearchDialog({
  busy,
  candidateIds,
  error,
  mcpForm,
  query,
  result,
  selectedServerId,
  selectedToolName,
  servers,
  tools,
  onCandidateToggle,
  onClose,
  onDecide,
  onDiscover,
  onMcpFormChange,
  onQueryChange,
  onSaveServer,
  onSearch,
  onToolChange,
}: {
  busy: boolean;
  candidateIds: string[];
  error: string;
  mcpForm: {
    name: string;
    command: string;
    args: string;
    envKeys: string;
    readOnlyTools: string;
  };
  query: string;
  result: ExternalResearchResponse | null;
  selectedServerId: string;
  selectedToolName: string;
  servers: McpServerRecord[];
  tools: McpToolDescriptor[];
  onCandidateToggle: (candidateId: string) => void;
  onClose: () => void;
  onDecide: (decision: "import" | "reject") => void;
  onDiscover: (serverId: string) => void;
  onMcpFormChange: (value: {
    name: string;
    command: string;
    args: string;
    envKeys: string;
    readOnlyTools: string;
  }) => void;
  onQueryChange: (value: string) => void;
  onSaveServer: () => void;
  onSearch: () => void;
  onToolChange: (toolName: string) => void;
}): React.JSX.Element {
  const pending =
    result?.candidates.filter(
      (candidate) => candidate.status === "candidate",
    ) ?? [];
  const finished =
    result !== null &&
    result.candidates.some((candidate) =>
      ["indexed", "rejected", "failed"].includes(candidate.status),
    ) &&
    pending.length === 0;
  return (
    <AppDialog
      className="kb-dialog external-research-dialog"
      closeDisabled={busy || pending.length > 0}
      describedBy="external-research-description"
      labelledBy="external-research-title"
      onClose={onClose}
    >
      <header className="settings-heading">
        <div>
          <p className="eyebrow">External Evidence</p>
          <h2 id="external-research-title">寻找外部资料</h2>
          <span id="external-research-description">
            外部结果仅作为候选；确认后才会保存快照、导入当前知识库并重新索引。
          </span>
        </div>
        <button
          aria-label="关闭外部资料"
          className="icon-button"
          disabled={busy || pending.length > 0}
          type="button"
          onClick={onClose}
        >
          <Icon name="close" size={17} />
        </button>
      </header>
      <div className="external-research-body">
        <section className="external-mcp-panel">
          <h3>MCP 只读能力</h3>
          {servers.length > 0 ? (
            <>
              <label>
                <span>服务</span>
                <select
                  value={selectedServerId}
                  onChange={(event) => onDiscover(event.target.value)}
                >
                  {servers.map((server) => (
                    <option key={server.id} value={server.id}>
                      {server.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>只读 Tool</span>
                <select
                  value={selectedToolName}
                  onChange={(event) => onToolChange(event.target.value)}
                >
                  <option value="">请选择</option>
                  {tools.map((tool) => (
                    <option
                      disabled={!tool.locallyAllowedReadOnly}
                      key={tool.name}
                      value={tool.name}
                    >
                      {tool.title}
                      {tool.locallyAllowedReadOnly ? "" : "（未通过本地策略）"}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <p className="external-empty-copy">
              尚未配置 MCP 服务。命令由本机启动，密钥仅通过环境变量名传递。
            </p>
          )}
          <details className="external-config">
            <summary>
              {servers.length > 0 ? "新增 MCP 服务" : "配置 MCP 服务"}
            </summary>
            <div className="external-config-fields">
              <label>
                <span>名称</span>
                <input
                  value={mcpForm.name}
                  onChange={(event) =>
                    onMcpFormChange({ ...mcpForm, name: event.target.value })
                  }
                />
              </label>
              <label>
                <span>命令</span>
                <input
                  placeholder="例如 npx 或 uvx"
                  value={mcpForm.command}
                  onChange={(event) =>
                    onMcpFormChange({
                      ...mcpForm,
                      command: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                <span>参数（每行一个）</span>
                <textarea
                  rows={3}
                  value={mcpForm.args}
                  onChange={(event) =>
                    onMcpFormChange({ ...mcpForm, args: event.target.value })
                  }
                />
              </label>
              <label>
                <span>环境变量名（逗号分隔）</span>
                <input
                  placeholder="SEARCH_API_KEY"
                  value={mcpForm.envKeys}
                  onChange={(event) =>
                    onMcpFormChange({
                      ...mcpForm,
                      envKeys: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                <span>本地只读 Tool 白名单（逗号分隔）</span>
                <input
                  placeholder="search_web"
                  value={mcpForm.readOnlyTools}
                  onChange={(event) =>
                    onMcpFormChange({
                      ...mcpForm,
                      readOnlyTools: event.target.value,
                    })
                  }
                />
              </label>
              <button
                className="button ghost"
                disabled={
                  busy ||
                  !mcpForm.name.trim() ||
                  !mcpForm.command.trim() ||
                  !mcpForm.readOnlyTools.trim()
                }
                type="button"
                onClick={onSaveServer}
              >
                保存并发现能力
              </button>
            </div>
          </details>
        </section>
        <section className="external-candidate-panel">
          <div className="external-search-row">
            <input
              aria-label="外部资料检索词"
              placeholder="输入要补充或核验的问题"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
            />
            <button
              className="button primary"
              disabled={busy || !query.trim() || !selectedToolName}
              type="button"
              onClick={onSearch}
            >
              {busy && !result ? "检索中..." : "寻找候选"}
            </button>
          </div>
          {error && <div className="settings-error">{error}</div>}
          {!result && !error && (
            <div className="external-candidates-empty">
              <Icon name="sparkle" size={24} />
              <strong>候选资料会显示在这里</strong>
              <span>Tool 描述、注解和返回内容均按不可信输入处理。</span>
            </div>
          )}
          {result && (
            <div className="external-candidate-list">
              {result.candidates.map((candidate) => (
                <ExternalCandidateCard
                  candidate={candidate}
                  checked={candidateIds.includes(candidate.id)}
                  key={candidate.id}
                  onToggle={() => onCandidateToggle(candidate.id)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
      <div className="settings-actions">
        <button
          className="button ghost"
          disabled={busy || pending.length > 0}
          type="button"
          onClick={onClose}
        >
          {finished ? "完成" : "关闭"}
        </button>
        {pending.length > 0 && (
          <>
            <button
              className="button ghost"
              disabled={busy}
              type="button"
              onClick={() => onDecide("reject")}
            >
              全部拒绝
            </button>
            <button
              className="button primary"
              disabled={busy || candidateIds.length === 0}
              type="button"
              onClick={() => onDecide("import")}
            >
              {busy ? "导入并索引中..." : `导入所选 ${candidateIds.length} 项`}
            </button>
          </>
        )}
      </div>
    </AppDialog>
  );
}

function ExternalCandidateCard({
  candidate,
  checked,
  onToggle,
}: {
  candidate: ExternalResearchCandidate;
  checked: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const comparison =
    candidate.status === "indexed" &&
    "classification" in candidate.finalComparison
      ? candidate.finalComparison
      : candidate.initialComparison;
  return (
    <article className={`external-candidate-card ${candidate.status}`}>
      <label>
        <input
          checked={checked}
          disabled={candidate.status !== "candidate"}
          type="checkbox"
          onChange={onToggle}
        />
        <span>
          <strong>{candidate.title}</strong>
          <small>{candidate.url}</small>
        </span>
      </label>
      <p>{candidate.snippet || candidate.content.slice(0, 220)}</p>
      <div className="external-candidate-meta">
        <span className={`comparison-badge ${comparison.classification}`}>
          {comparison.label}
        </span>
        <span>{externalCandidateStatus(candidate.status)}</span>
      </div>
      {candidate.errorMessage && (
        <div className="settings-error">{candidate.errorMessage}</div>
      )}
    </article>
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
    <AppDialog
      className="kb-dialog"
      describedBy="web-import-description"
      labelledBy="web-import-title"
      onClose={onClose}
    >
      <header className="settings-heading">
        <div>
          <p className="eyebrow">Web Source</p>
          <h2 id="web-import-title">导入网页链接</h2>
          <span id="web-import-description">
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
    </AppDialog>
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
    <AppDialog
      className="kb-dialog"
      closeDisabled={busy}
      describedBy="knowledge-base-dialog-description"
      labelledBy="knowledge-base-dialog-title"
      onClose={onClose}
    >
      <header className="settings-heading">
        <div>
          <p className="eyebrow">Knowledge Base</p>
          <h2 id="knowledge-base-dialog-title">{title}</h2>
          <span id="knowledge-base-dialog-description">
            {deleting
              ? "删除会级联移除该知识库下的来源、索引、对话和引用。"
              : "知识库用于隔离来源、索引、对话与后续引用证据。"}
          </span>
        </div>
        <button
          aria-label="关闭知识库弹窗"
          className="icon-button"
          disabled={busy}
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
    </AppDialog>
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
    <AppDialog
      className="settings-modal"
      describedBy="seed-settings-description"
      labelledBy="seed-settings-title"
      onClose={onClose}
    >
      <header className="settings-heading">
        <div>
          <p className="eyebrow">Seed API</p>
          <h2 id="seed-settings-title">配置火山方舟 Ark API</h2>
          <span id="seed-settings-description">
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
    </AppDialog>
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
      {action}
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

function upsertAgentRunEvent(
  events: AgentRunEventRecord[],
  event: AgentRunEventRecord,
): AgentRunEventRecord[] {
  return [...events.filter((item) => item.id !== event.id), event].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

function updateAgentRunTraceEvent(
  traces: Record<string, AgentRunResponse>,
  event: AgentRunEventRecord,
  preferredMessageId?: string,
  fallbackKnowledgeBaseId?: string,
): Record<string, AgentRunResponse> {
  const matchingEntry = Object.entries(traces).find(
    ([, response]) => response.run.id === event.runId,
  );
  const messageId =
    matchingEntry?.[0] ||
    traceMessageIdFromEvent(event, preferredMessageId, fallbackKnowledgeBaseId);
  if (!messageId) {
    return traces;
  }
  const current = matchingEntry?.[1] ?? traces[messageId];
  const nextResponse = mergeAgentRunEventResponse(
    current,
    event,
    fallbackKnowledgeBaseId,
  );
  if (!nextResponse) {
    return traces;
  }
  if (current === nextResponse && traces[messageId] === nextResponse) {
    return traces;
  }
  const next = { ...traces };
  if (matchingEntry && matchingEntry[0] !== messageId) {
    delete next[matchingEntry[0]];
  }
  next[messageId] = nextResponse;
  return next;
}

function traceMessageIdFromEvent(
  event: AgentRunEventRecord,
  preferredMessageId?: string,
  fallbackKnowledgeBaseId?: string,
): string | null {
  if (!preferredMessageId || event.eventType !== "run.created") {
    return null;
  }
  const skillId = recordString(event.payload, "skillId");
  if (skillId !== "conversation_answer") {
    return null;
  }
  const eventKnowledgeBaseId = recordString(event.payload, "knowledgeBaseId");
  if (
    fallbackKnowledgeBaseId &&
    eventKnowledgeBaseId &&
    eventKnowledgeBaseId !== fallbackKnowledgeBaseId
  ) {
    return null;
  }
  return preferredMessageId;
}

function mergeAgentRunEventResponse(
  current: AgentRunResponse | undefined,
  event: AgentRunEventRecord,
  fallbackKnowledgeBaseId?: string,
): AgentRunResponse | null {
  const base =
    current ??
    syntheticAgentRunResponseFromEvent(event, fallbackKnowledgeBaseId);
  if (!base) {
    return null;
  }
  const events = upsertAgentRunEvent(base.events, event);
  return {
    ...base,
    run: updateSyntheticAgentRun(
      base.run,
      event,
      events,
      fallbackKnowledgeBaseId,
    ),
    events,
    toolCalls: upsertSyntheticToolCall(base.toolCalls, event),
  };
}

function syntheticAgentRunResponseFromEvent(
  event: AgentRunEventRecord,
  fallbackKnowledgeBaseId?: string,
): AgentRunResponse | null {
  const skillId = recordString(event.payload, "skillId");
  if (event.eventType !== "run.created" || skillId !== "conversation_answer") {
    return null;
  }
  const knowledgeBaseId =
    recordString(event.payload, "knowledgeBaseId") ??
    fallbackKnowledgeBaseId ??
    "";
  if (!knowledgeBaseId) {
    return null;
  }
  const createdAt = event.createdAt;
  const run: AgentRunRecord = {
    id: event.runId,
    knowledgeBaseId,
    title: "对话回答",
    goal: event.summary ?? "",
    skillId,
    skillVersion: recordString(event.payload, "skillVersion") ?? "1.0.0",
    status: normalizeAgentRunStatus(event.status) ?? "planning",
    sourceScope: recordStringArray(event.payload, "sourceScope"),
    indexVersionId: recordNullableString(event.payload, "indexVersionId"),
    models: recordObject(event.payload, "models"),
    budgets: recordObject(event.payload, "budgets"),
    usage: {},
    plan: {},
    draft: {},
    finalOutput: {},
    traceSnapshot: traceSnapshotFromEvents([event]),
    errorMessage: null,
    stopReason: null,
    retryCount: 0,
    startedAt: event.startedAt ?? createdAt,
    completedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
  return {
    run,
    events: [],
    toolCalls: [],
    confirmations: [],
    delegations: [],
    outputs: [],
    citations: [],
  };
}

function updateSyntheticAgentRun(
  run: AgentRunRecord,
  event: AgentRunEventRecord,
  events: AgentRunEventRecord[],
  fallbackKnowledgeBaseId?: string,
): AgentRunRecord {
  const nextStatus = normalizeAgentRunStatus(event.status) ?? run.status;
  const terminal = isAgentRunFinished(nextStatus);
  const plan = recordObjectOrNull(event.payload, "plan") ?? run.plan;
  return {
    ...run,
    knowledgeBaseId:
      recordString(event.payload, "knowledgeBaseId") ??
      run.knowledgeBaseId ??
      fallbackKnowledgeBaseId ??
      "",
    goal:
      event.eventType === "run.created"
        ? (event.summary ?? run.goal)
        : run.goal,
    skillId: recordString(event.payload, "skillId") ?? run.skillId,
    skillVersion:
      recordString(event.payload, "skillVersion") ?? run.skillVersion,
    status: nextStatus,
    sourceScope:
      event.eventType === "run.created"
        ? recordStringArray(event.payload, "sourceScope")
        : run.sourceScope,
    indexVersionId:
      event.eventType === "run.created"
        ? recordNullableString(event.payload, "indexVersionId")
        : run.indexVersionId,
    models:
      event.eventType === "run.created"
        ? recordObject(event.payload, "models")
        : run.models,
    budgets:
      event.eventType === "run.created"
        ? recordObject(event.payload, "budgets")
        : run.budgets,
    plan,
    traceSnapshot: traceSnapshotFromEvents(events),
    errorMessage:
      event.eventType === "run.failed"
        ? (event.summary ?? run.errorMessage)
        : run.errorMessage,
    stopReason: terminal ? (event.summary ?? run.stopReason) : run.stopReason,
    completedAt: terminal
      ? (event.completedAt ?? event.createdAt)
      : run.completedAt,
    updatedAt: event.createdAt,
  };
}

function upsertSyntheticToolCall(
  toolCalls: AgentRunToolCallRecord[],
  event: AgentRunEventRecord,
): AgentRunToolCallRecord[] {
  if (!event.toolCallId || !event.eventType.startsWith("tool_call.")) {
    return toolCalls;
  }
  const existing = toolCalls.find((item) => item.id === event.toolCallId);
  const startedAt = existing?.startedAt ?? event.startedAt ?? event.createdAt;
  const nextStatus =
    toolStatusFromEvent(event) ?? existing?.status ?? "running";
  const next: AgentRunToolCallRecord = {
    id: event.toolCallId,
    runId: event.runId,
    stepId:
      existing?.stepId ??
      recordString(event.payload, "stepId") ??
      event.stepId ??
      null,
    toolName:
      existing?.toolName ??
      recordString(event.payload, "toolName") ??
      "unknown_tool",
    skillId:
      existing?.skillId ?? recordNullableString(event.payload, "skillId"),
    skillVersion:
      existing?.skillVersion ??
      recordNullableString(event.payload, "skillVersion"),
    actionSummary: existing?.actionSummary ?? event.summary ?? event.title,
    workingDirectory:
      existing?.workingDirectory ??
      recordNullableString(event.payload, "workingDirectory"),
    sanitizedParams:
      existing?.sanitizedParams ??
      recordObject(event.payload, "sanitizedParams"),
    status: nextStatus,
    startedAt,
    completedAt: isTerminalToolStatus(nextStatus)
      ? (event.completedAt ?? event.createdAt)
      : (existing?.completedAt ?? null),
    durationMs:
      recordNumber(event.payload, "durationMs") ??
      event.durationMs ??
      existing?.durationMs ??
      null,
    exitCode:
      recordNumber(event.payload, "exitCode") ?? existing?.exitCode ?? null,
    stdoutSummary:
      recordString(event.payload, "stdoutSummary") ??
      (event.eventType === "tool_call.completed" ? event.summary : null) ??
      existing?.stdoutSummary ??
      null,
    stderrSummary:
      recordString(event.payload, "stderrSummary") ??
      existing?.stderrSummary ??
      null,
    errorMessage:
      nextStatus === "failed"
        ? (event.summary ?? existing?.errorMessage ?? null)
        : (existing?.errorMessage ?? null),
  };
  return [
    next,
    ...toolCalls.filter((item) => item.id !== event.toolCallId),
  ].sort(
    (left, right) =>
      new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
  );
}

function traceSnapshotFromEvents(
  events: AgentRunEventRecord[],
): AgentRunRecord["traceSnapshot"] {
  const ordered = [...events].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const phases: NonNullable<AgentRunRecord["traceSnapshot"]["phases"]> = [];
  const phaseById = new Map<string, (typeof phases)[number]>();
  for (const event of ordered) {
    const phaseId = eventStageId(event);
    let phase = phaseById.get(phaseId);
    if (!phase) {
      phase = {
        id: phaseId,
        label: tracePhaseLabel(phaseId),
        status: "pending",
      };
      phaseById.set(phaseId, phase);
      phases.push(phase);
    }
    if (isTerminalTraceEvent(event)) {
      for (const item of phases) {
        if (item.status === "active") {
          item.status =
            event.eventType === "run.failed" ? "failed" : "completed";
        }
      }
      phase.status = event.eventType === "run.failed" ? "failed" : "completed";
    } else if (traceEventTone(event) === "completed") {
      phase.status = "completed";
    } else {
      for (const item of phases) {
        if (item.status === "active" && item.id !== phaseId) {
          item.status = "completed";
        }
      }
      phase.status = "active";
    }
  }
  const last = ordered.at(-1);
  if (!last) {
    return { phases };
  }
  const currentStage = eventStageId(last);
  return {
    currentStage,
    currentStageLabel: tracePhaseLabel(currentStage),
    currentEventType: last.eventType,
    status: last.status,
    title: last.title,
    summary: last.summary,
    toolCallId: last.toolCallId,
    stepId: last.stepId,
    lastSequence: last.sequence,
    lastEventAt: last.createdAt,
    phases,
  };
}

function normalizeAgentRunStatus(
  value: string | null,
): AgentRunRecord["status"] | null {
  if (
    value === "planning" ||
    value === "waiting_confirmation" ||
    value === "executing" ||
    value === "paused" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "failed"
  ) {
    return value;
  }
  return null;
}

function toolStatusFromEvent(
  event: AgentRunEventRecord,
): AgentRunToolCallRecord["status"] | null {
  if (event.eventType === "tool_call.started") {
    return "running";
  }
  if (event.eventType === "tool_call.completed") {
    return "completed";
  }
  if (event.eventType === "tool_call.failed") {
    return "failed";
  }
  if (event.eventType === "tool_call.cancelled") {
    return "cancelled";
  }
  return null;
}

function isTerminalToolStatus(
  status: AgentRunToolCallRecord["status"],
): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function isTerminalTraceEvent(event: AgentRunEventRecord): boolean {
  return (
    event.eventType === "run.completed" ||
    event.eventType === "run.cancelled" ||
    event.eventType === "run.failed"
  );
}

function tracePhaseLabel(phaseId: string): string {
  return (
    {
      planning: "规划任务",
      evidence_retrieval: "检索证据",
      source_reading: "读取来源",
      tool_calling: "工具调用",
      drafting: "生成回答",
      citation_validation: "校验引用",
      conflict_audit: "冲突审计",
      waiting_confirmation: "等待确认",
      finalizing: "保存结果",
    }[phaseId] ?? phaseId
  );
}

function recordString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordNullableString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordNumber(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordObject(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return recordObjectOrNull(record, key) ?? {};
}

function recordObjectOrNull(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function recordStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function updateAgentRunTraceResponse(
  traces: Record<string, AgentRunResponse>,
  response: AgentRunResponse,
): Record<string, AgentRunResponse> {
  const entries = Object.entries(traces);
  const matchingMessageId = entries.find(
    ([, item]) => item.run.id === response.run.id,
  )?.[0];
  const messageId = matchingMessageId ?? traceAssistantMessageId(response);
  if (!messageId) {
    return traces;
  }
  return {
    ...traces,
    [messageId]: mergeAgentRunResponse(traces[messageId], response),
  };
}

function mergeAgentRunResponse(
  current: AgentRunResponse | undefined,
  incoming: AgentRunResponse,
): AgentRunResponse {
  if (!current || current.run.id !== incoming.run.id) {
    return incoming;
  }
  const currentSequence = current.events.at(-1)?.sequence ?? 0;
  const incomingSequence = incoming.events.at(-1)?.sequence ?? 0;
  if (incomingSequence > currentSequence) {
    return incoming;
  }
  if (incomingSequence < currentSequence) {
    return current;
  }
  return traceCompletenessScore(incoming) >= traceCompletenessScore(current)
    ? incoming
    : current;
}

function traceCompletenessScore(response: AgentRunResponse): number {
  return (
    response.events.length +
    response.toolCalls.length * 3 +
    response.outputs.length * 4 +
    response.citations.length +
    response.confirmations.length +
    response.delegations.length
  );
}

function traceAssistantMessageId(response: AgentRunResponse): string | null {
  for (const output of response.outputs) {
    const messageId = output.payload.assistantMessageId;
    if (output.outputType === "final" && typeof messageId === "string") {
      return messageId;
    }
  }
  return null;
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

function getDialogFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hasAttribute("disabled") &&
      element.getAttribute("aria-hidden") !== "true",
  );
}

function trapDialogFocus(
  event: React.KeyboardEvent<HTMLElement>,
  root: HTMLElement | null,
): void {
  if (!root) {
    return;
  }
  const focusable = getDialogFocusableElements(root);
  if (focusable.length === 0) {
    event.preventDefault();
    root.focus({ preventScroll: true });
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function isTerminalJobStatus(status: BackgroundJobRecord["status"]): boolean {
  return ["completed", "failed", "cancelled"].includes(status);
}

function sourceActiveJob(
  source: KnowledgeBaseSource,
  jobs: BackgroundJobRecord[],
  activeKnowledgeBaseId: string,
): BackgroundJobRecord | null {
  const directJob = jobs.find(
    (job) => !isTerminalJobStatus(job.status) && job.targetId === source.id,
  );
  if (directJob) {
    return directJob;
  }
  const waitingForIndex =
    source.status !== "ready" &&
    source.status !== "failed" &&
    source.status !== "duplicate" &&
    source.status !== "skipped";
  if (!waitingForIndex) {
    return null;
  }
  return (
    jobs.find(
      (job) =>
        !isTerminalJobStatus(job.status) &&
        job.jobType.startsWith("index.") &&
        job.targetId === activeKnowledgeBaseId,
    ) ?? null
  );
}

function jobProgressPercent(job: BackgroundJobRecord): number {
  return Math.max(0, Math.min(100, Math.round(job.progress * 100)));
}

function jobTitle(
  job: BackgroundJobRecord,
  sourceNames: Map<string, string>,
): string {
  const targetName = sourceNames.get(job.targetId);
  const prefix = job.jobType.startsWith("index.")
    ? "索引构建"
    : job.jobType.startsWith("source.import")
      ? "资料导入"
      : job.jobType.startsWith("web.")
        ? "网页更新"
        : "后台任务";
  return targetName ? `${prefix} · ${targetName}` : prefix;
}

function jobStatusLabel(status: BackgroundJobRecord["status"]): string {
  const labels: Record<BackgroundJobRecord["status"], string> = {
    pending: "排队中",
    running: "运行中",
    completed: "已完成",
    paused: "已暂停",
    cancelled: "已取消",
    failed: "失败",
    retrying: "重试中",
  };
  return labels[status];
}

function jobStageSummary(job: BackgroundJobRecord): string {
  const stages = job.checkpoint.stages ?? [];
  const current =
    stages.find((stage) => ["running", "retrying"].includes(stage.status)) ??
    stages.find((stage) => stage.status === "failed") ??
    [...stages].reverse().find((stage) => stage.status === "completed");
  if (!current) {
    return `${jobStatusLabel(job.status)} · ${jobProgressPercent(job)}%`;
  }
  return `${current.label} · ${Math.round(current.progress * 100)}%`;
}

function jobElapsedLabel(job: BackgroundJobRecord): string {
  const started = Date.parse(job.createdAt);
  const updated = Date.parse(job.updatedAt);
  if (!Number.isFinite(started) || !Number.isFinite(updated)) {
    return "时间未知";
  }
  const seconds = Math.max(0, Math.round((updated - started) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function jobCompletionSummary(
  job: BackgroundJobRecord,
  title: string,
  context: string,
): string {
  const elapsed = jobElapsedLabel(job);
  if (job.jobType.startsWith("index.")) {
    return `${context} 已完成索引，可用于检索、引用和回答。耗时 ${elapsed}。`;
  }
  if (
    job.jobType.startsWith("source.import") ||
    job.jobType.startsWith("web.")
  ) {
    return `${title} 已完成，来源卡片会刷新最新状态。耗时 ${elapsed}。`;
  }
  return `${title} 已完成。耗时 ${elapsed}。`;
}

function citationsForParagraph(
  citations: AnswerCitation[],
  paragraphIndex: number,
  evidenceChunkIds: string[],
): AnswerCitation[] {
  const directCitations = uniqueCitations(
    citations.filter((citation) => citation.paragraphIndex === paragraphIndex),
  );
  if (directCitations.length > 0) {
    return directCitations;
  }
  const evidenceIds = new Set(evidenceChunkIds);
  return uniqueCitations(
    citations.filter((citation) => evidenceIds.has(citation.chunkId)),
  );
}

function answerParagraphsFromMessage(
  message: ConversationMessageRecord,
): ConversationAnswerResponse["answer"]["paragraphs"] | null {
  const raw = message.modelParams.answerParagraphs;
  if (!Array.isArray(raw)) {
    return null;
  }
  const paragraphs = raw.flatMap((item, fallbackIndex) => {
    if (!isRecord(item) || typeof item.text !== "string" || !item.text.trim()) {
      return [];
    }
    const rawEvidenceIds = item.evidenceChunkIds;
    return [
      {
        index: Number.isInteger(item.index)
          ? Number(item.index)
          : fallbackIndex,
        text: item.text,
        evidenceChunkIds: Array.isArray(rawEvidenceIds)
          ? rawEvidenceIds.filter(
              (chunkId): chunkId is string =>
                typeof chunkId === "string" && chunkId.length > 0,
            )
          : [],
      },
    ];
  });
  return paragraphs.length > 0 ? paragraphs : null;
}

function answerModeFromMessage(
  message: ConversationMessageRecord,
): ConversationAnswerResponse["answer"]["answerMode"] | null {
  const mode = message.modelParams.answerMode;
  return mode === "system_meta" || mode === "knowledge_grounded" ? mode : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function evidenceLocation(
  selection: EvidenceSelection,
): HybridSearchResult["location"] {
  return selection.kind === "citation"
    ? selection.citation.location
    : selection.result.location;
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

function sourceNames(names: string[]): string {
  const visible = names.slice(0, 2).join("、");
  return names.length > 2 ? `${visible} 等 ${names.length} 份资料` : visible;
}

function parseFailureMessage(
  items: Array<Pick<ParseCheckItem, "displayName" | "errorMessage">>,
): string {
  const details = items
    .slice(0, 2)
    .map(
      (item) =>
        `${item.displayName}：${item.errorMessage ?? "无法读取或解析内容"}`,
    )
    .join("；");
  const suffix =
    items.length > 2 ? `；另有 ${items.length - 2} 份资料失败` : "";
  return `资料解析失败：${details}${suffix}`;
}

function formatNotificationTime(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
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

function formatAgentRunDuration(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const minutePart = `${String(minutes).padStart(2, "0")}m`;
  const secondPart = `${String(rest).padStart(2, "0")}s`;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}h ${minutePart} ${secondPart}`
    : `${minutePart} ${secondPart}`;
}

function splitConfigValues(value: string, separator: string): string[] {
  return value
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

function externalCandidateStatus(
  status: ExternalResearchCandidate["status"],
): string {
  return {
    candidate: "待确认",
    rejected: "已拒绝",
    importing: "正在导入",
    indexed: "已快照并索引",
    failed: "处理失败",
  }[status];
}

function delegationStatusLabel(
  status: AgentRunDelegationRecord["status"],
): string {
  return {
    pending: "等待",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  }[status];
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

function researchPreviewContent(content: string, title: string): string {
  const lines = content.trim().split("\n");
  const first = lines[0]?.replace(/^#\s+/, "").trim();
  if (first === title.trim()) {
    lines.shift();
  }
  return lines.join("\n").trim();
}

function isResearchWorkspaceDirty(
  saved: ResearchBriefWorkspace,
  current: ResearchBriefWorkspace,
  planText: string,
  outlineText: string,
  savedSourceIds: string[],
  currentSourceIds: string[],
): boolean {
  return (
    saved.title !== current.title ||
    saved.goal !== current.goal ||
    saved.draft !== current.draft ||
    saved.final !== current.final ||
    JSON.stringify(saved.sections) !== JSON.stringify(current.sections) ||
    JSON.stringify(saved.plan, null, 2) !== planText ||
    JSON.stringify(saved.outline, null, 2) !== outlineText ||
    JSON.stringify(savedSourceIds) !== JSON.stringify(currentSourceIds)
  );
}

function parseStructuredEditor(
  value: string,
  label: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "{}");
  } catch {
    throw new Error(`${label}必须是有效 JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label}必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

function researchActionLabel(action: ResearchBriefAction): string {
  return {
    continue_research: "继续研究",
    supplement_evidence: "补充证据",
    audit_citations: "引用审计",
    regenerate_section: "章节重生成",
    revise_document: "修订整份简报",
  }[action];
}

function researchSaveStateLabel(
  value: "idle" | "saving" | "saved" | "conflict",
): string {
  return {
    idle: "有未保存修改",
    saving: "保存中…",
    saved: "已保存",
    conflict: "保存冲突",
  }[value];
}

function confirmationStatusLabel(
  status: AgentRunConfirmationRecord["status"],
): string {
  return {
    pending: "等待确认",
    confirmed: "已确认",
    rejected: "已拒绝",
    cancelled: "已取消",
  }[status];
}

function researchRecordLabel(
  value: Record<string, unknown>,
  fallback: string,
): string {
  for (const key of ["summary", "message", "reason", "claim"]) {
    if (typeof value[key] === "string" && value[key]) {
      return value[key] as string;
    }
  }
  return fallback;
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

export default App;
