import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { WorkerHealth } from "../shared/contracts";
import { JsonRpcClient } from "./json-rpc-client";
import { logger } from "./logger";

const MAX_RESTART_ATTEMPTS = 3;

export class PythonWorkerManager {
  private workerProcess?: ChildProcessWithoutNullStreams;
  private rpc?: JsonRpcClient;
  private startPromise?: Promise<WorkerHealth>;
  private restartAttempts = 0;
  private restartTimer?: NodeJS.Timeout;

  async start(): Promise<WorkerHealth> {
    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.rpc && this.workerProcess?.exitCode === null) {
      return this.health();
    }

    this.startPromise = this.spawnAndConnect();

    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async health(): Promise<WorkerHealth> {
    if (!this.rpc) {
      throw new Error("Python Worker is not connected");
    }
    return this.rpc.call<WorkerHealth>("system.health", {}, 5_000);
  }

  async restart(): Promise<WorkerHealth> {
    this.restartAttempts = 0;
    await this.stop();
    return this.start();
  }

  async stop(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }

    const currentProcess = this.workerProcess;
    const currentRpc = this.rpc;
    this.workerProcess = undefined;
    this.rpc = undefined;

    if (!currentProcess || currentProcess.exitCode !== null) {
      currentRpc?.dispose();
      return;
    }

    try {
      await currentRpc?.call("system.shutdown", {}, 1_000);
    } catch (error) {
      logger.warn("Graceful Python Worker shutdown failed", error);
    } finally {
      currentRpc?.dispose();
    }

    if (currentProcess.exitCode === null) {
      currentProcess.kill();
    }
  }

  private async spawnAndConnect(): Promise<WorkerHealth> {
    const workerRoot = this.resolveWorkerRoot();
    const python = this.resolvePython(workerRoot);

    logger.info("Starting Python Worker", python);
    const child = spawn(python, ["-m", "citemind_worker"], {
      cwd: workerRoot,
      env: {
        ...process.env,
        CITEMIND_DATA_DIR: app.getPath("userData"),
        PYTHONPATH: path.join(workerRoot, "src"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.workerProcess = child;
    this.rpc = new JsonRpcClient(child);
    this.pipeWorkerLogs(child);
    child.once("exit", (code, signal) =>
      this.handleUnexpectedExit(child, code, signal),
    );

    try {
      const health = await this.waitForHealth();
      logger.info("Python Worker connected", `pid=${health.pid}`);
      return health;
    } catch (error) {
      child.kill();
      this.rpc?.dispose();
      this.rpc = undefined;
      this.workerProcess = undefined;
      throw error;
    }
  }

  private async waitForHealth(): Promise<WorkerHealth> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        return await this.health();
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Python Worker health check failed");
  }

  private handleUnexpectedExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.workerProcess !== child) {
      return;
    }

    this.rpc?.dispose();
    this.rpc = undefined;
    this.workerProcess = undefined;

    logger.error(
      "Python Worker exited unexpectedly",
      `code=${code}, signal=${signal}`,
    );
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      logger.error("Python Worker automatic restart limit reached");
      return;
    }

    this.restartAttempts += 1;
    const delayMs = 500 * this.restartAttempts;
    this.restartTimer = setTimeout(() => {
      void this.start().catch((error) =>
        logger.error("Python Worker restart failed", error),
      );
    }, delayMs);
  }

  private pipeWorkerLogs(child: ChildProcessWithoutNullStreams): void {
    const lines = createInterface({ input: child.stderr });
    lines.on("line", (line) => logger.info("Python Worker", line));
  }

  private resolveWorkerRoot(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, "worker");
    }
    return path.resolve(app.getAppPath(), "..", "..", "worker");
  }

  private resolvePython(workerRoot: string): string {
    if (process.env.CITEMIND_PYTHON) {
      return process.env.CITEMIND_PYTHON;
    }

    const projectPython = path.join(workerRoot, ".venv", "bin", "python");
    return existsSync(projectPython) ? projectPython : "python3.12";
  }
}
