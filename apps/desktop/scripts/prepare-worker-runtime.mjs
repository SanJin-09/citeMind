import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PYTHON_VERSION = "python3.12";
const ARK_RUNTIME_PACKAGES = new Set([
  "volcenginesdkark",
  "volcenginesdkarkruntime",
  "volcenginesdkcore",
]);
const PRUNED_RUNTIME_DIRECTORIES = [
  "include",
  "share",
  path.join("lib", "itcl4.3.5"),
  path.join("lib", "tcl9"),
  path.join("lib", "tcl9.0"),
  path.join("lib", "thread3.0.4"),
  path.join("lib", "tk9.0"),
  path.join("lib", PYTHON_VERSION, "ensurepip"),
  path.join("lib", PYTHON_VERSION, "idlelib"),
  path.join("lib", PYTHON_VERSION, "tkinter"),
  path.join("lib", PYTHON_VERSION, "turtledemo"),
];
const PRUNED_RUNTIME_FILES = [
  path.join("lib", "libtcl9.0.dylib"),
  path.join("lib", "libtcl9tk9.0.dylib"),
];
const PRUNED_JIEBA_DIRECTORIES = ["analyse", "lac_small", "posseg"];
const PRUNED_DIRECTORY_NAMES = new Set(["__pycache__", "test", "tests"]);
const PRUNED_FILE_EXTENSIONS = new Set([
  ".a",
  ".h",
  ".pxd",
  ".pyc",
  ".pyi",
  ".pyx",
]);

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(desktopRoot, "..", "..");
const workerRoot = path.join(repositoryRoot, "worker");
const productionEnvironment = path.join(
  desktopRoot,
  "staging",
  "worker-production-venv",
);
const workerPython = path.join(productionEnvironment, "bin", "python");
const stagingRoot = path.join(desktopRoot, "staging", "worker");
const runtimeRoot = path.join(stagingRoot, "runtime");
const runtimePython = path.join(runtimeRoot, "bin", PYTHON_VERSION);
const productionSitePackages = path.join(
  productionEnvironment,
  "lib",
  PYTHON_VERSION,
  "site-packages",
);
const runtimeSitePackages = path.join(
  runtimeRoot,
  "lib",
  PYTHON_VERSION,
  "site-packages",
);

await rm(productionEnvironment, { recursive: true, force: true });
try {
  execFileSync(
    "uv",
    [
      "sync",
      "--project",
      workerRoot,
      "--no-dev",
      "--no-install-project",
      "--frozen",
      "--python",
      "3.12",
    ],
    {
      env: {
        ...process.env,
        UV_PROJECT_ENVIRONMENT: productionEnvironment,
      },
      stdio: "inherit",
    },
  );

  const basePrefix = execFileSync(
    workerPython,
    ["-c", "import sys; print(sys.base_prefix)"],
    { encoding: "utf8" },
  ).trim();

  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  await cp(basePrefix, runtimeRoot, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}__pycache__${path.sep}`),
  });
  await cp(productionSitePackages, runtimeSitePackages, {
    recursive: true,
  });
  await cp(path.join(workerRoot, "src"), path.join(stagingRoot, "src"), {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}__pycache__${path.sep}`),
  });
  await cp(
    path.join(workerRoot, "pyproject.toml"),
    path.join(stagingRoot, "pyproject.toml"),
  );
  await cp(path.join(workerRoot, "uv.lock"), path.join(stagingRoot, "uv.lock"));

  await pruneRuntime();

  execFileSync(
    runtimePython,
    [
      "-c",
      [
        "from tempfile import TemporaryDirectory",
        "from pathlib import Path",
        "import jieba",
        "import lancedb",
        "import pyarrow as pa",
        "from docx import Document",
        "from langgraph.graph import StateGraph",
        "from pypdf import PdfReader",
        "from volcenginesdkarkruntime import Ark",
        "from citemind_worker.storage import StorageRuntime",
        "from citemind_worker.writing_workflow_service import WritingWorkflowService",
        "assert list(jieba.cut_for_search('中文知识库检索'))",
        "assert pa.array([1]).to_pylist() == [1]",
        "assert Document is not None",
        "assert StateGraph is not None",
        "assert PdfReader is not None",
        "assert WritingWorkflowService is not None",
        "client = Ark(api_key='delivery-probe', base_url='https://example.invalid/api/v3')",
        "assert client.responses is not None",
        "assert client.multimodal_embeddings is not None",
        "with TemporaryDirectory() as root:",
        "    storage = StorageRuntime(Path(root), vector_dimension=3)",
        "    storage.initialize()",
        "    assert storage.status()['ready'] is True",
        "print('worker runtime ready')",
      ].join("\n"),
    ],
    {
      env: {
        ...process.env,
        PYTHONPATH: path.join(stagingRoot, "src"),
      },
      stdio: "inherit",
    },
  );

  await pruneTree(runtimeRoot);

  const workerSize = await directorySize(stagingRoot);
  process.stdout.write(
    `${JSON.stringify(
      {
        workerRuntime: stagingRoot,
        workerSizeBytes: workerSize,
        workerSizeMiB: toMiB(workerSize),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(productionEnvironment, { recursive: true, force: true });
}

async function pruneRuntime() {
  for (const relative of PRUNED_RUNTIME_DIRECTORIES) {
    await rm(path.join(runtimeRoot, relative), {
      recursive: true,
      force: true,
    });
  }
  for (const relative of PRUNED_RUNTIME_FILES) {
    await rm(path.join(runtimeRoot, relative), { force: true });
  }
  for (const directory of PRUNED_JIEBA_DIRECTORIES) {
    await rm(path.join(runtimeSitePackages, "jieba", directory), {
      recursive: true,
      force: true,
    });
  }

  for (const entry of await readdir(runtimeSitePackages, {
    withFileTypes: true,
  })) {
    if (
      entry.isDirectory() &&
      entry.name.startsWith("volcenginesdk") &&
      !ARK_RUNTIME_PACKAGES.has(entry.name)
    ) {
      await rm(path.join(runtimeSitePackages, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }

  await pruneTree(runtimeRoot);
}

async function pruneTree(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (PRUNED_DIRECTORY_NAMES.has(entry.name)) {
        await rm(target, { recursive: true, force: true });
        continue;
      }
      if (entry.name.endsWith(".dist-info")) {
        await rm(path.join(target, "RECORD"), { force: true });
      }
      await pruneTree(target);
      continue;
    }
    if (
      entry.isFile() &&
      PRUNED_FILE_EXTENSIONS.has(path.extname(entry.name))
    ) {
      await rm(target, { force: true });
    }
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
