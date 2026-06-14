import {
  access,
  cp,
  lstat,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const MAX_DMG_SIZE = 220 * 1024 * 1024;
const MAX_WORKER_SIZE = 380 * 1024 * 1024;
const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const releaseRoot = path.join(desktopRoot, "release");
const appPath = await findBySuffix(releaseRoot, ".app");
const dmgPath = await findBySuffix(releaseRoot, ".dmg");
const packagedWorkerPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "worker",
);
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "citemind-delivery-"));
const installedApp = path.join(temporaryRoot, "Applications", "citeMind.app");
const dataRoot = path.join(temporaryRoot, "Application Support", "citeMind");
const samplePdf = path.join(temporaryRoot, "delivery-sample.pdf");

try {
  const sizes = {
    dmgBytes: (await lstat(dmgPath)).size,
    appBytes: await directorySize(appPath),
    workerBytes: await directorySize(packagedWorkerPath),
  };
  assertMaxSize("DMG", sizes.dmgBytes, MAX_DMG_SIZE);
  assertMaxSize("Worker", sizes.workerBytes, MAX_WORKER_SIZE);

  await cp(appPath, installedApp, { recursive: true });
  await assertPackagedWorker(installedApp);
  await assertRuntimeDependencies(installedApp);
  await writeTextPdf(samplePdf, "citeMind delivery PDF");

  const first = createWorker(installedApp, dataRoot);
  await first.call("system.health");
  const created = await first.call("knowledge_bases.create", {
    name: "交付验证样例",
  });
  const imported = await first.call("sources.import_file", {
    knowledgeBaseId: created.id,
    filePath: samplePdf,
  });
  if (imported.parseCheck?.status !== "success") {
    throw new Error("PDF 导入验证失败");
  }
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
        sizes: {
          dmgBytes: sizes.dmgBytes,
          dmgMiB: toMiB(sizes.dmgBytes),
          appBytes: sizes.appBytes,
          appMiB: toMiB(sizes.appBytes),
          workerBytes: sizes.workerBytes,
          workerMiB: toMiB(sizes.workerBytes),
        },
        limits: {
          dmgMiB: toMiB(MAX_DMG_SIZE),
          workerMiB: toMiB(MAX_WORKER_SIZE),
        },
        checks: [
          "packaged-worker",
          "runtime-dependencies",
          "size-limits",
          "install",
          "pdf-import",
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

async function assertRuntimeDependencies(applicationPath) {
  const workerRoot = path.join(
    applicationPath,
    "Contents",
    "Resources",
    "worker",
  );
  const python = path.join(workerRoot, "runtime", "bin", "python3.12");
  const smokeTest = [
    "import jieba",
    "import lancedb",
    "import pyarrow as pa",
    "from pypdf import PdfReader",
    "from volcenginesdkarkruntime import Ark",
    "assert list(jieba.cut_for_search('中文知识库检索'))",
    "assert pa.array([1]).to_pylist() == [1]",
    "assert PdfReader is not None",
    "client = Ark(api_key='delivery-probe', base_url='https://example.invalid/api/v3')",
    "assert client.responses is not None",
    "assert client.multimodal_embeddings is not None",
    "print('runtime dependencies ready')",
  ].join("\n");
  await execFileAsync(python, ["-c", smokeTest], {
    cwd: workerRoot,
    env: {
      ...process.env,
      PYTHONPATH: path.join(workerRoot, "src"),
    },
    timeout: 30_000,
  });
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
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Worker timeout: ${method}\n${stderr}`));
        }, 30_000);
        pending.set(id, {
          resolve(value) {
            clearTimeout(timeout);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timeout);
            reject(error);
          },
        });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });
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

async function writeTextPdf(target, text) {
  const stream = Buffer.from(
    `BT /F1 24 Tf 100 700 Td (${text.replaceAll(/[()\\]/g, "\\$&")}) Tj ET`,
    "latin1",
  );
  const objects = [
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    Buffer.from(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
        "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    ),
    Buffer.concat([
      Buffer.from(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n`),
      stream,
      Buffer.from("\nendstream\nendobj\n"),
    ]),
    Buffer.from(
      "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    ),
  ];
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [];
  let length = chunks[0].length;
  for (const object of objects) {
    offsets.push(length);
    chunks.push(object);
    length += object.length;
  }
  const xrefOffset = length;
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n`));
  chunks.push(Buffer.from("0000000000 65535 f \n"));
  for (const offset of offsets) {
    chunks.push(Buffer.from(`${String(offset).padStart(10, "0")} 00000 n \n`));
  }
  chunks.push(
    Buffer.from(
      `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\n` +
        `startxref\n${xrefOffset}\n%%EOF\n`,
    ),
  );
  await writeFile(target, Buffer.concat(chunks));
}

function assertMaxSize(label, actual, maximum) {
  if (actual > maximum) {
    throw new Error(
      `${label} 体积 ${toMiB(actual)} MiB 超过限制 ${toMiB(maximum)} MiB`,
    );
  }
}

async function directorySize(root) {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(target);
    } else if (entry.isFile()) {
      total += (await lstat(target)).size;
    }
  }
  return total;
}

function toMiB(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(1));
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
