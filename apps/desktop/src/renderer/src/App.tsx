import { useCallback, useEffect, useState } from "react";
import type {
  ModelCapabilityStatus,
  ModelValidationStatus,
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
  | "sparkle";

interface Source {
  id: number;
  title: string;
  meta: string;
  selected: boolean;
  tone: "amber" | "blue" | "violet" | "green";
}

const INITIAL_SOURCES: Source[] = [
  {
    id: 1,
    title: "RAG 产品与架构方案",
    meta: "Markdown · 722 行",
    selected: true,
    tone: "amber",
  },
  {
    id: 2,
    title: "可信引用设计笔记",
    meta: "PDF · 18 页",
    selected: true,
    tone: "blue",
  },
  {
    id: 3,
    title: "Seed 模型能力清单",
    meta: "网页快照 · 今天",
    selected: true,
    tone: "violet",
  },
  {
    id: 4,
    title: "混合检索实验记录",
    meta: "DOCX · 6 个章节",
    selected: false,
    tone: "green",
  },
];

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
  const [sources, setSources] = useState(INITIAL_SOURCES);
  const [query, setQuery] = useState("");
  const [evidenceOpen, setEvidenceOpen] = useState(true);
  const [systemOpen, setSystemOpen] = useState(false);
  const [sentQuestion, setSentQuestion] = useState("");
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

  useEffect(() => {
    void checkHealth();
    void loadSeedStatus();
  }, [checkHealth, loadSeedStatus]);

  const online = worker.kind === "online";
  const selectedCount = sources.filter((source) => source.selected).length;

  const toggleSource = (id: number): void => {
    setSources((items) =>
      items.map((source) =>
        source.id === id ? { ...source, selected: !source.selected } : source,
      ),
    );
  };

  const submitQuestion = (): void => {
    const value = query.trim();
    if (!value) return;
    setSentQuestion(value);
    setQuery("");
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
          <button className="notebook-switcher" type="button">
            产品与架构资料库 <Icon name="chevron" size={15} />
          </button>
        </div>
        <label className="global-search">
          <Icon name="search" size={17} />
          <input aria-label="搜索知识库" placeholder="搜索知识库中的资料" />
          <kbd>⌘ K</kbd>
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
          <button className="button primary" type="button">
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
            <button className="button add-source" type="button">
              <Icon name="add" /> 添加来源
            </button>
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
                setSources((items) =>
                  items.map((source) => ({ ...source, selected: true })),
                )
              }
            >
              全选
            </button>
          </div>
          <div className="source-list">
            {sources.map((source) => (
              <button
                className={`source-item ${source.selected ? "selected" : ""}`}
                key={source.id}
                type="button"
                onClick={() => toggleSource(source.id)}
              >
                <span className={`source-icon ${source.tone}`}>
                  <Icon name="document" size={17} />
                </span>
                <span className="source-copy">
                  <strong>{source.title}</strong>
                  <small>{source.meta}</small>
                </span>
                <span className="source-check">
                  {source.selected && <Icon name="check" size={14} />}
                </span>
              </button>
            ))}
          </div>
          <button className="source-footer" type="button">
            <Icon name="book" size={17} />
            管理全部来源
            <Icon name="chevron" size={15} />
          </button>
        </aside>

        <section className="panel chat-panel">
          <PanelHeader
            icon="chat"
            title="对话"
            subtitle={`${selectedCount} 个来源参与检索`}
          />
          <div className="chat-scroll">
            <div className="welcome-block">
              <span className="welcome-icon">
                <Icon name="sparkle" size={25} />
              </span>
              <p className="eyebrow">产品与架构资料库</p>
              <h1>从资料中获得可验证的答案</h1>
              <p className="welcome-summary">
                当前知识库聚焦 citeMind
                的产品需求与技术架构。回答将基于已选择来源生成，并在右侧展示经过校验的引用证据。
              </p>
              <div className="overview-metrics">
                <span>
                  <strong>{sources.length}</strong> 个来源
                </span>
                <span>
                  <strong>{selectedCount}</strong> 个已选择
                </span>
                <span>
                  <strong>可信引用</strong> 已启用
                </span>
              </div>
            </div>

            {sentQuestion && (
              <div className="message-flow">
                <p className="user-message">{sentQuestion}</p>
                <article className="assistant-message">
                  <div className="assistant-heading">
                    <span className="mini-mark">
                      <Icon name="sparkle" size={15} />
                    </span>
                    <strong>citeMind</strong>
                  </div>
                  <p>
                    这是布局演示状态。问答管线接入后，这里将展示基于知识库检索结果生成的回答，并关联可定位的证据片段。
                  </p>
                  <button
                    className="citation-chip"
                    type="button"
                    onClick={() => setEvidenceOpen(true)}
                  >
                    [1] RAG 产品与架构方案 · 证据优先
                  </button>
                </article>
              </div>
            )}

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
                    submitQuestion();
                  }
                }}
              />
              <span className="composer-meta">{selectedCount} 个来源</span>
              <button
                aria-label="发送问题"
                className="send-button"
                disabled={!query.trim()}
                type="button"
                onClick={submitQuestion}
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
            <div className="evidence-empty">
              <span className="evidence-illustration">
                <Icon name="evidence" size={26} />
              </span>
              <h2>可信证据会显示在这里</h2>
              <p>点击回答中的引用，即可查看原始片段、定位信息与检索相关度。</p>
            </div>
            <article className="evidence-card">
              <div className="evidence-card-heading">
                <span className="source-icon amber">
                  <Icon name="document" size={16} />
                </span>
                <div>
                  <strong>RAG 产品与架构方案</strong>
                  <small>核心产品原则 · 证据优先</small>
                </div>
              </div>
              <blockquote>
                模型只能引用本次检索得到且经过后端校验的文本块。证据不足时，系统应明确说明知识库中没有足够信息。
              </blockquote>
              <div className="evidence-stats">
                <span>证据强度：高</span>
                <span>关键词命中：4</span>
              </div>
              <button className="button evidence-action" type="button">
                打开原文位置 <Icon name="chevron" size={15} />
              </button>
            </article>
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
    </main>
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

export default App;
