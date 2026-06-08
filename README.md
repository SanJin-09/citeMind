# citeMind

<p align="center">
  <strong>本地优先的可信个人知识库助手</strong>
</p>

<p align="center">
  <a href="https://github.com/SanJin-09/citeMind"><img alt="repo" src="https://img.shields.io/badge/repo-SanJin--09%2FciteMind-24292f?style=flat-square"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-black?style=flat-square">
  <img alt="desktop" src="https://img.shields.io/badge/desktop-Electron%20%2B%20React-47848f?style=flat-square">
  <img alt="worker" src="https://img.shields.io/badge/worker-Python%203.12-3776ab?style=flat-square">
  <img alt="status" src="https://img.shields.io/badge/status-MVP%20in%20progress-f59e0b?style=flat-square">
</p>

> citeMind 是一个桌面端个人知识库助手。首版面向 macOS Apple Silicon，用户使用自己的火山方舟 Ark API Key，将 PDF、DOCX、图片和网页导入为可检索、可追踪来源的本地知识库。

<details>
<summary><strong>当前阶段一句话说明</strong></summary>

已完成工程底座、Ark/Seed API 配置、知识库管理、后台任务、四类来源导入解析、结构化分块、FTS5 与 LanceDB 索引写入。可信检索、带引用问答和 Markdown 导出仍在后续 TODO 阶段。

</details>

## 功能状态

| 模块 | 当前状态 | 说明 |
|---|---:|---|
| 桌面端工程 | 已完成 | Electron、React、TypeScript、Vite、受限 Preload IPC |
| Python Worker | 已完成 | JSON-RPC over stdio、健康检查、统一错误结构 |
| 本地存储 | 已完成 | SQLite 迁移、FTS5、LanceDB、系统应用数据目录 |
| Ark / Seed API | 已完成 | safeStorage 加密保存 Key，内置 3 个 Seed 模型并验证权限 |
| 知识库管理 | 已完成 | 新建、重命名、切换、删除确认、来源状态汇总 |
| 后台任务 | 已完成 | 任务状态机、进度、检查点、恢复、暂停、取消、重试入口 |
| 导入解析 | 已完成 | PDF、DOCX、图片、网页，失败原因可见 |
| 分块与索引 | 已完成 | 结构化 Chunk、SQLite 元数据、FTS5、Ark Embedding、LanceDB |
| 混合检索 | 待实现 | 限定知识库和有效索引版本的关键词与向量检索 |
| 可信问答 | 待实现 | 流式回答、引用校验、点击引用跳转原文 |
| 导出 | 待实现 | Markdown 导出和后续 Word 导出 |

## 技术架构

```text
+--------------------------- Electron Desktop ----------------------------+
| React Renderer                                                           |
| - NotebookLM 风格三栏工作区                                               |
| - Seed API 设置页、知识库管理、导入检查、索引状态                          |
|                                                                          |
| Secure Preload IPC                                                       |
| - 白名单接口                                                              |
| - Renderer 不直接读取文件系统和 Ark API Key                               |
|                                                                          |
| Electron Main                                                            |
| - 窗口管理、文件选择、safeStorage 密钥读写                                 |
| - Python Worker 生命周期管理                                              |
+-----------------------------------+--------------------------------------+
                                    | JSON-RPC over stdio
+-----------------------------------v--------------------------------------+
| Python Worker                                                            |
| - Docling 优先解析 PDF / DOCX / 图片                                      |
| - 网页正文提取，Playwright 作为动态网页兜底                                |
| - BackgroundJob 持久化状态机                                              |
| - Ark Model Gateway / Embedding                                           |
| - SQLite + FTS5 + LanceDB                                                 |
+--------------------------------------------------------------------------+
```

## 首批平台与模型

首批只正式支持：

- macOS Apple Silicon
- Electron 原生二进制 `darwin-arm64`
- Python `>=3.12,<3.13`
- pnpm `10.3.0`

内置 Seed 模型目录：

| 角色 | 模型 ID | 用途 |
|---|---|---|
| 默认对话 | `doubao-seed-2-0-lite-260428` | 常规问答和轻量生成 |
| 高质量对话 | `doubao-seed-2-0-pro-260215` | 高质量回答与复杂生成 |
| Embedding | `doubao-embedding-vision-251215` | 文本与视觉向量化，当前按 2048 维处理 |

<blockquote>
Ark API Key 只在 Electron Main 中通过 <code>safeStorage</code> 加密保存。React Renderer 只接收掩码、配置状态和模型验证结果，不暴露明文 Key。
</blockquote>

## 本地数据

应用默认使用系统应用数据目录，不写死绝对路径：

```text
app.getPath("userData")
+-- credentials/
|   +-- seed-api-key.json
+-- originals/
+-- snapshots/
+-- parse-artifacts/
+-- backups/
+-- indexes/
|   +-- lancedb/
+-- metadata.sqlite3
```

## 快速开始

### 1. 准备环境

- macOS Apple Silicon
- Node.js 与 pnpm
- Python 3.12
- uv
- 可用的火山方舟 Ark API Key

### 2. 安装依赖

```bash
pnpm setup
```

如果 Electron 下载失败，可以手动下载 `electron-v42.3.3-darwin-arm64.zip`，解压到当前 pnpm 安装的 Electron 包目录，并写入 `path.txt`。此前遇到 macOS 隔离属性时，需要移除下载文件或解压后 App 的 `com.apple.quarantine` 属性。

### 3. 启动开发版

```bash
pnpm dev
```

### 4. 配置 Ark API

在应用右上角进入：

```text
设置 -> 配置火山方舟 Ark API -> 填写 Ark API Key -> 保存并验证
```

验证通过后，应用会展示默认对话、高质量对话和 Embedding 模型的权限状态。

### 5. 导入并索引资料

```text
来源资料 -> 添加文件 / 添加网页 -> 查看解析检查 -> 开始建立索引
```

当前支持：

- PDF：页码 + bounding box 高亮信息
- DOCX：标题路径 + 段落锚点
- 网页：标题路径 + 快照文本块
- 图片：图片预览 + OCR 区域高亮信息

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm setup` | 安装 JS 依赖、同步 Python Worker、安装 Electron |
| `pnpm dev` | 启动 Electron 开发环境 |
| `pnpm build` | 构建桌面端 |
| `pnpm build:mac` | 生成 macOS arm64 安装包 |
| `pnpm format` | 格式化 TypeScript 与 Python 代码 |
| `pnpm lint` | 运行 ESLint 与 Ruff |
| `pnpm typecheck` | 运行 TypeScript 与 mypy 类型检查 |
| `pnpm test` | 运行 Vitest 与 pytest |
| `pnpm check` | 运行格式检查、lint、类型检查、测试和构建 |

## 开发目录

```text
.
+-- apps/
|   +-- desktop/                 # Electron + React 桌面端
|       +-- src/main/            # Electron Main，密钥与 Worker 管理
|       +-- src/preload/         # 受限 IPC 暴露
|       +-- src/renderer/        # React UI
|       +-- src/shared/          # 前后端共享契约
+-- worker/
|   +-- src/citemind_worker/     # Python Worker
|   +-- tests/                   # Worker 单元与集成测试
+-- TODO.md                      # 阶段任务清单
+-- rag-personal-knowledge-base-product-and-architecture.md
```

## 导入与索引策略

- 解析失败必须可见，不允许静默跳过。
- PDF、DOCX、图片以 Docling 为主。
- 网页优先正文提取，动态网页失败时使用 Playwright 兜底。
- 文档完整索引前保持“处理中”，不会进入正式检索结果。
- Chunk 会保存来源、来源版本、页码、bounding box、标题路径、锚点、原文、标准化正文和内容 Hash。
- 索引完成后才原子更新文档版本为可检索。

## 安全边界

- [x] `contextIsolation` 开启。
- [x] `nodeIntegration` 关闭。
- [x] Renderer 只能访问白名单 IPC。
- [x] Renderer 无法直接读取 Ark API Key。
- [x] Ark API Key 使用 Electron `safeStorage` 加密保存。
- [x] 日志脱敏 Ark/API Key。
- [x] 本地数据默认保存在系统应用数据目录。

## 测试覆盖

当前测试覆盖方向：

- JSON-RPC 请求、响应、错误与超时
- Worker 健康检查
- SQLite 迁移与快照
- FTS5 与 LanceDB 最小读写
- Seed 模型目录、Key 隔离与能力验证状态
- 知识库管理
- BackgroundJob 状态机与恢复
- PDF / DOCX / 图片 / 网页导入解析
- 分块、Embedding、FTS5、LanceDB 索引写入

运行完整检查：

```bash
pnpm check
```

## Roadmap

- [x] P0 工程底座
- [x] P0 本地存储
- [x] P0 Seed API 配置与模型网关
- [x] P0 知识库管理
- [x] P0 持久化任务基础
- [x] P0 文档解析与检查
- [x] P0 分块与索引
- [ ] P0 混合检索
- [ ] P0 对话、引用校验与可信回答
- [ ] P0 问答界面引用跳转
- [ ] P1 重复检测增强
- [ ] P1 模型切换与索引版本生命周期
- [ ] P1 Markdown 导出与 macOS arm64 交付
- [ ] P2 网页维护、自动分类、关联与写作工作流

## 项目边界

暂不实现：

- 多人协作与复杂权限
- 本地大语言模型推理
- 移动端应用
- 插件市场
- 完整笔记编辑器
- 复杂知识图谱编辑器
- 应用关闭后的常驻网页更新服务
- 任意 OpenAI-compatible API

## License

当前仓库尚未声明开源许可证。正式公开分发前应补充 `LICENSE`。
