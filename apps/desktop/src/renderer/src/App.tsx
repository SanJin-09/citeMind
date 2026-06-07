import { useCallback, useEffect, useState } from "react";
import type { WorkerHealth } from "../../shared/contracts";

type WorkerState =
  | { kind: "checking" }
  | { kind: "online"; health: WorkerHealth }
  | { kind: "offline"; message: string };

function getDesktopApi(): Window["citeMind"] {
  if (!window.citeMind) {
    throw new Error("Preload IPC 未加载，请检查桌面端启动日志");
  }
  return window.citeMind;
}

function App(): React.JSX.Element {
  const [state, setState] = useState<WorkerState>({ kind: "checking" });

  const checkHealth = useCallback(async () => {
    setState({ kind: "checking" });
    try {
      const health = await getDesktopApi().system.checkWorkerHealth();
      setState({ kind: "online", health });
    } catch (error) {
      setState({
        kind: "offline",
        message: error instanceof Error ? error.message : "Worker 状态检查失败",
      });
    }
  }, []);

  const restart = useCallback(async () => {
    setState({ kind: "checking" });
    try {
      const health = await getDesktopApi().system.restartWorker();
      setState({ kind: "online", health });
    } catch (error) {
      setState({
        kind: "offline",
        message: error instanceof Error ? error.message : "Worker 重启失败",
      });
    }
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  const online = state.kind === "online";
  const statusText =
    state.kind === "checking" ? "检查中" : online ? "运行中" : "不可用";

  return (
    <main className="shell">
      <section className="status-card">
        <header>
          <p className="eyebrow">citeMind</p>
          <h1>本地优先的可信知识库助手</h1>
          <p className="summary">
            工程底座已就绪，当前页面用于验证桌面端与 Python Worker。
          </p>
        </header>

        <div className="status-row">
          <span>Python Worker</span>
          <strong className={online ? "online" : "offline"}>
            {statusText}
          </strong>
        </div>
        <div className="status-row">
          <span>JSON-RPC</span>
          <strong>
            {online ? `已连接 · PID ${state.health.pid}` : "未连接"}
          </strong>
        </div>
        <div className="status-row">
          <span>本地存储</span>
          <strong
            className={
              online && state.health.storage?.ready ? "online" : "offline"
            }
          >
            {online && state.health.storage?.ready
              ? `就绪 · Schema v${state.health.storage.schemaVersion} · FTS5 · Vector ${state.health.storage.vectorDimension}`
              : "未就绪"}
          </strong>
        </div>

        {state.kind === "offline" && (
          <p className="error-message">{state.message}</p>
        )}

        <footer>
          <button
            type="button"
            onClick={() => void checkHealth()}
            disabled={state.kind === "checking"}
          >
            重新检查状态
          </button>
          <button
            className="primary"
            type="button"
            onClick={() => void restart()}
            disabled={state.kind === "checking"}
          >
            重启 Worker
          </button>
        </footer>
      </section>
    </main>
  );
}

export default App;
