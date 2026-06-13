import { access, cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const releaseRoot = path.join(desktopRoot, "release");
const appPath = await findBySuffix(releaseRoot, ".app");
const dmgPath = await findBySuffix(releaseRoot, ".dmg");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "citemind-delivery-"));
const installedApp = path.join(temporaryRoot, "Applications", "citeMind.app");
const dataRoot = path.join(temporaryRoot, "Application Support", "citeMind");

try {
  await cp(appPath, installedApp, { recursive: true });
  await assertPackagedWorker(installedApp);

  const first = createWorker(installedApp, dataRoot);
  await first.call("system.health");
  const created = await first.call("knowledge_bases.create", {
    name: "交付验证样例",
  });
  first.crash();
  await first.exited;

  const recovered = createWorker(installedApp, dataRoot);
  await recovered.call("system.health");
  const afterCrash = await recovered.call("knowledge_bases.list");
  assertKnowledgeBase(afterCrash, created.id, "异常退出恢复");
  await recovered.shutdown();

  await rm(installedApp, { recursive: true, force: true });
  await cp(appPath, installedApp, { recursive: true });
  const upgraded = createWorker(installedApp, dataRoot);
  const afterUpgrade = await upgraded.call("knowledge_bases.list");
  assertKnowledgeBase(afterUpgrade, created.id, "升级数据保留");
  await upgraded.shutdown();

  await rm(installedApp, { recursive: true, force: true });
  await access(path.join(dataRoot, "metadata.sqlite3"));
  process.stdout.write(
    `${JSON.stringify(
      {
        appPath,
        dmgPath,
        architecture: "arm64",
        checks: [
          "packaged-worker",
          "install",
          "abnormal-exit-recovery",
          "upgrade-data-retention",
          "uninstall-data-retention",
        ],
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function assertPackagedWorker(applicationPath) {
  const resources = path.join(applicationPath, "Contents", "Resources");
  await access(path.join(resources, "worker", "runtime", "bin", "python3.12"));
  await access(
    path.join(resources, "worker", "src", "citemind_worker", "main.py"),
  );
}

function createWorker(applicationPath, storagePath) {
  const workerRoot = path.join(
    applicationPath,
    "Contents",
    "Resources",
    "worker",
  );
  const child = spawn(
    path.join(workerRoot, "runtime", "bin", "python3.12"),
    ["-m", "citemind_worker"],
    {
      cwd: workerRoot,
      env: {
        ...process.env,
        CITEMIND_DATA_DIR: storagePath,
        PYTHONPATH: path.join(workerRoot, "src"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const pending = new Map();
  let nextId = 1;
  let stderr = "";
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return {
    exited,
    call(method, params = {}) {
      const id = String(nextId++);
      const response = new Promise((resolve, reject) =>
        pending.set(id, { resolve, reject }),
      );
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
      return Promise.race([
        response,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Worker timeout: ${method}\n${stderr}`)),
            30_000,
          ),
        ),
      ]);
    },
    crash() {
      child.kill("SIGKILL");
    },
    async shutdown() {
      await this.call("system.shutdown");
      await exited;
    },
  };
}

function assertKnowledgeBase(response, id, label) {
  if (!response.knowledgeBases.some((item) => item.id === id)) {
    throw new Error(`${label}失败：知识库数据丢失`);
  }
}

async function findBySuffix(root, suffix) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.name.endsWith(suffix)) return target;
    if (entry.isDirectory() && !entry.name.endsWith(".app")) {
      try {
        return await findBySuffix(target, suffix);
      } catch {
        // Continue searching sibling directories.
      }
    }
  }
  throw new Error(`未在 ${root} 找到 ${suffix} 交付物`);
}
