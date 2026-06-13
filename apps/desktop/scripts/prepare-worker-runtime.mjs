import { cp, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(desktopRoot, "..", "..");
const workerRoot = path.join(repositoryRoot, "worker");
const workerPython = path.join(workerRoot, ".venv", "bin", "python");
const stagingRoot = path.join(desktopRoot, "staging", "worker");
const runtimeRoot = path.join(stagingRoot, "runtime");
const basePrefix = execFileSync(
  workerPython,
  ["-c", "import sys; print(sys.base_prefix)"],
  { encoding: "utf8" },
).trim();
const sitePackages = path.join(
  workerRoot,
  ".venv",
  "lib",
  "python3.12",
  "site-packages",
);
const runtimeSitePackages = path.join(
  runtimeRoot,
  "lib",
  "python3.12",
  "site-packages",
);

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });
await cp(basePrefix, runtimeRoot, {
  recursive: true,
  filter: (source) => !source.includes(`${path.sep}__pycache__${path.sep}`),
});
await cp(sitePackages, runtimeSitePackages, {
  recursive: true,
  filter: (source) => !isDevelopmentDependency(source),
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

execFileSync(
  path.join(runtimeRoot, "bin", "python3.12"),
  [
    "-c",
    "import citemind_worker, jieba, lancedb, pypdf, pyarrow; print('worker runtime ready')",
  ],
  {
    env: {
      ...process.env,
      PYTHONPATH: path.join(stagingRoot, "src"),
    },
    stdio: "inherit",
  },
);

function isDevelopmentDependency(source) {
  const relative = path.relative(sitePackages, source);
  if (!relative || relative.startsWith("..")) {
    return false;
  }
  const first = relative.split(path.sep)[0].toLowerCase();
  return (
    first === "__pycache__" ||
    first === "pytest" ||
    first.startsWith("pytest-") ||
    first === "_pytest" ||
    first === "mypy" ||
    first.startsWith("mypy-") ||
    first === "mypyc" ||
    first.startsWith("ruff")
  );
}
