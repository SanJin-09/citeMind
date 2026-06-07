import { useCallback, useEffect, useState } from "react";
import type { WorkerHealth } from "../../shared/contracts";

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

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

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
          <button className="button ghost" type="button">
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
    </main>
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

export default App;
