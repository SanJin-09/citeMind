import { useCallback, useEffect, useState } from "react";
import type {
  AnswerCitation,
  BackgroundJobRecord,
  BackgroundJobStatus,
  BuildIndexResponse,
  ConversationAnswerResponse,
  ConversationMessageRecord,
  ConversationRecord,
  DuplicateAction,
  HybridSearchResult,
  KnowledgeBaseRecord,
  KnowledgeBaseSource,
  ModelCapabilityStatus,
  ModelValidationStatus,
  ParseCheckItem,
  ParseCheckSummary,
  SeedCredentialStatus,
  SeedModelDescriptor,
  WorkerHealth,
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
  | { kind: "delete-index" }
  | { kind: "rebuild-index" };

type EvidenceSelection =
  | {
      kind: "citation";
      citation: AnswerCitation;
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
  const [sourceDeleteBusyId, setSourceDeleteBusyId] = useState("");
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
  const [messages, setMessages] = useState<ConversationMessageRecord[]>([]);
  const [answerResponses, setAnswerResponses] = useState<
    Record<string, ConversationAnswerResponse>
  >({});
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState("");
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
  const [seedForm, setSeedForm] = useState({
    name: "我的 Seed API",
    apiKey: "",
  });
  const [seedBusy, setSeedBusy] = useState(false);
  const [seedError, setSeedError] = useState("");

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
    } catch (error) {
      setSeedError(
        error instanceof Error ? error.message : "Seed API 状态读取失败",
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
  }, [
    activeKnowledgeBaseId,
    loadConversations,
    loadIndexStatus,
    loadParseChecks,
  ]);

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
    setSearchQuery("");
    setLastSearchQuery("");
    setSearchResults([]);
    setSearchError("");
  };

  const startNewConversation = (): void => {
    resetConversationWorkspace();
    setQuery("");
  };

  const openConversation = async (
    targetConversationId: string,
  ): Promise<void> => {
    setChatBusy(true);
    setChatError("");
    try {
      const result =
        await getDesktopApi().conversations.messages(targetConversationId);
      setConversationId(result.conversation.id);
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
  ): void => {
    setSelectedEvidence({
      kind: "citation",
      citation,
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
    try {
      const response = await getDesktopApi().conversations.answer({
        knowledgeBaseId: activeKnowledgeBaseId,
        query: value,
        conversationId,
        limit: 8,
        candidateLimit: 24,
      });
      setConversationId(response.conversation.id);
      setConversations((items) =>
        upsertConversation(items, response.conversation),
      );
      setMessages((items) =>
        uniqueMessages([
          ...items,
          response.userMessage,
          response.assistantMessage,
        ]),
      );
      setAnswerResponses((items) => ({
        ...items,
        [response.assistantMessage.id]: response,
      }));
      if (response.citations[0]) {
        selectCitation(response.citations[0], response);
      } else {
        setSelectedEvidence(null);
        setSourceJumpNotice("");
      }
    } catch (error) {
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

  const refreshImportState = async (knowledgeBaseId: string): Promise<void> => {
    await Promise.all([
      loadSources(knowledgeBaseId),
      loadJobs(),
      loadParseChecks(knowledgeBaseId),
      loadIndexStatus(knowledgeBaseId),
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

  const submitConfirmAction = async (): Promise<void> => {
    if (confirmAction?.kind === "delete-source") {
      await deleteSource(confirmAction.source);
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

  const deleteSeedCredential = async (): Promise<void> => {
    setSeedBusy(true);
    setSeedError("");
    try {
      setSeedStatus(await getDesktopApi().seed.deleteCredential());
      setSeedForm({ name: "我的 Seed API", apiKey: "" });
    } catch (error) {
      setSeedError(
        error instanceof Error ? error.message : "Seed API 删除失败",
      );
    } finally {
      setSeedBusy(false);
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
          <button className="source-footer" type="button">
            <Icon name="book" size={17} />
            {sourceStatusLine(sourceSummary.sourcesByStatus)}
            <Icon name="chevron" size={15} />
          </button>
          {parsePanelOpen && (
            <ParseCheckPanel
              busy={importBusy}
              error={importError}
              indexBusy={indexBusy}
              indexError={indexError}
              indexStatus={indexStatus}
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

            {!hasStartedConversation && conversations.length > 0 && (
              <ConversationStrip
                activeConversationId={conversationId}
                busy={chatBusy}
                conversations={conversations}
                onOpen={(id) => void openConversation(id)}
              />
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

            {chatError && (
              <div className="message-flow">
                <div className="inline-error">{chatError}</div>
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
                    />
                  ) : null,
                )}
              </div>
            )}

            {chatBusy && (
              <div className="message-flow">
                <article className="assistant-message loading-message">
                  <div className="assistant-heading">
                    <span className="mini-mark">
                      <Icon name="sparkle" size={15} />
                    </span>
                    <strong>citeMind</strong>
                  </div>
                  <p>正在检索当前知识库并校验引用...</p>
                </article>
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
          onSave={() => void saveSeedCredential()}
          onValidate={() => void validateSeedCredential()}
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
          busy={Boolean(sourceDeleteBusyId) || indexBusy}
          error={confirmError}
          onClose={() => {
            if (!sourceDeleteBusyId && !indexBusy) {
              setConfirmAction(null);
            }
          }}
          onSubmit={() => void submitConfirmAction()}
        />
      )}
    </main>
  );
}

function ConversationStrip({
  activeConversationId,
  busy,
  conversations,
  onOpen,
}: {
  activeConversationId: string | null;
  busy: boolean;
  conversations: ConversationRecord[];
  onOpen: (conversationId: string) => void;
}): React.JSX.Element {
  return (
    <section className="conversation-strip" aria-label="最近对话">
      <div className="conversation-strip-heading">
        <span className="section-label">对话工作区</span>
        <small>{conversations.length} 个历史对话</small>
      </div>
      <div className="conversation-pills">
        {conversations.slice(0, 5).map((conversation) => (
          <button
            className={conversation.id === activeConversationId ? "active" : ""}
            disabled={busy}
            key={conversation.id}
            type="button"
            onClick={() => onOpen(conversation.id)}
          >
            <strong>{conversation.title}</strong>
            <small>{conversation.modelId ?? "未生成回答"}</small>
          </button>
        ))}
      </div>
    </section>
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
  onSelectCitation,
}: {
  message: ConversationMessageRecord;
  response?: ConversationAnswerResponse;
  selectedChunkId?: string;
  onSelectCitation: (
    citation: AnswerCitation,
    response?: ConversationAnswerResponse,
  ) => void;
}): React.JSX.Element {
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

  return (
    <article className="assistant-message">
      <div className="assistant-heading">
        <span className="mini-mark">
          <Icon name="sparkle" size={15} />
        </span>
        <strong>citeMind</strong>
      </div>
      {!evidenceSufficient && (
        <div className="evidence-warning">
          证据不足：没有通过检索与引用校验的来源。
        </div>
      )}
      <div className="answer-paragraphs">
        {paragraphs.map((paragraph, paragraphIndex) => {
          const paragraphCitations = citationsForParagraph(
            citations,
            paragraph.index,
            paragraph.evidenceChunkIds,
          );
          return (
            <section className="answer-paragraph" key={paragraph.index}>
              <p>{paragraph.text}</p>
              {paragraphCitations.length > 0 ? (
                <div className="paragraph-evidence-list">
                  {paragraphCitations.map((citation, citationIndex) => (
                    <CitationEvidenceButton
                      citation={citation}
                      citationNumber={citationIndex + 1}
                      key={`${paragraph.index}:${citation.chunkId}`}
                      response={response}
                      selected={selectedChunkId === citation.chunkId}
                      onSelect={onSelectCitation}
                    />
                  ))}
                </div>
              ) : (
                <span className="no-citation-note">
                  {evidenceSufficient
                    ? "此段没有可展示引用。"
                    : "此段已按证据不足处理，不展示引用。"}
                </span>
              )}
              <small className="paragraph-index">
                段落 {paragraphIndex + 1}
              </small>
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

function CitationEvidenceButton({
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
  ) => void;
}): React.JSX.Element {
  const retrievalResult = response
    ? retrievalResultForCitation(response, citation)
    : undefined;
  return (
    <button
      className={`citation-evidence-card ${selected ? "selected" : ""}`}
      type="button"
      onClick={() => onSelect(citation, response)}
    >
      <span className="citation-evidence-heading">
        <strong>
          [{citationNumber}] {citation.source.displayName}
        </strong>
        <small>{formatLocation(citation.source.type, citation.location)}</small>
      </span>
      <span className="citation-quote">{citationQuote(citation)}</span>
      <span className="citation-evidence-meta">
        <small>证据强度：{evidenceStrength(retrievalResult)}</small>
        <small>{retrievalLabel(retrievalResult)}</small>
      </span>
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
  indexStatus,
  items,
  duplicateBusyId,
  summary,
  onBuildIndex,
  onCollapse,
  onDeleteIndex,
  onRefresh,
  onResolveDuplicate,
  onRebuildIndex,
}: {
  busy: boolean;
  error: string;
  indexBusy: boolean;
  indexError: string;
  indexStatus: BuildIndexResponse | null;
  items: ParseCheckItem[];
  duplicateBusyId: string;
  summary: ParseCheckSummary;
  onBuildIndex: () => void;
  onCollapse: () => void;
  onDeleteIndex: () => void;
  onRefresh: () => void;
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
    </section>
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
  onClose,
  onDelete,
  onFormChange,
  onReload,
  onSave,
  onValidate,
}: {
  busy: boolean;
  error: string;
  form: { name: string; apiKey: string };
  status: SeedCredentialStatus | null;
  onClose: () => void;
  onDelete: () => void;
  onFormChange: (next: { name: string; apiKey: string }) => void;
  onReload: () => void;
  onSave: () => void;
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

function citationsForParagraph(
  citations: AnswerCitation[],
  paragraphIndex: number,
  evidenceChunkIds: string[],
): AnswerCitation[] {
  const evidenceIds = new Set(evidenceChunkIds);
  return citations.filter(
    (citation) =>
      citation.paragraphIndex === paragraphIndex ||
      evidenceIds.has(citation.chunkId),
  );
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
  return `${sourceTypeLabel(source.sourceType)} · ${sourceStatusLabel(source.status)}${version}${chunks}`;
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

function sourceStatusLine(sourcesByStatus: Record<string, number>): string {
  const entries = Object.entries(sourcesByStatus);
  if (entries.length === 0) {
    return "暂无来源状态";
  }
  return entries
    .map(([status, count]) => `${sourceStatusLabel(status)} ${count}`)
    .join(" · ");
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
