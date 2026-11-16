# BiliNote Studio：Agent 接手说明

整理日期：2026-11-15（America/Los_Angeles）。

## 当前仓库状态与版本口径

- **双同步工作区**：`E:\codex\bilinote` 与 `e:\agy work\bilinote studio` 已同步为同一份精简且完整的最新源码工程（Git 分支 `main`）。
- **完整代码对齐**：源码底座基于已发布的 `v0.1.0-preview.31`（提交 `9eabee072e88e29fc290bda50b546d073a5b6f3c`），并完整合入了本地实装 `0.1.0-preview.32`（长笔记滚动优化、IndexedDB `records-v2` 按会话/消息原子持久化、历史消息缓存、`--storage-maintenance` 维护入口）与 `0.1.0-preview.33`（数位板笔尖拖动正文 `readerPan.ts` 及直接拖动期布局延后）。
- **版本字段一致**：`BillNote_frontend/package.json`、`BillNote_frontend/package-lock.json`、`BillNote_frontend/src-tauri/Cargo.toml`、`BillNote_frontend/src-tauri/Cargo.lock`、`BillNote_frontend/src-tauri/tauri.conf.json` 与 `tools/build_editions.py` 均已统一为 `0.1.0-preview.33`。
- **历史冗余清理与本地备份**：已从工作区移除 `.BiliNote-dev`、`.tmp`、`.cache`、旧构建产物 `dist` 与按日期归档的旧交付目录。精简前的完整工作区快照与 `.BiliNote-dev/secrets` 测试配置已单独保存于 `E:\codex\bilinote-backup-20261115`。

## 必须先读的文件

1. [AGENTS.md](../AGENTS.md)：开发权限、正式版保护、文案、预览收尾与真实调用授权。
2. [DEVELOPMENT.md](../DEVELOPMENT.md)：仓库结构与本地开发基础说明。
3. [代码与测试导航](AGENT_MAP.md)：按模块与任务查找前后端代码入口。
4. [preview.33 变更说明](releases/0.1.0-preview.33.md) 与 [preview.31 预发行说明](releases/0.1.0-preview.31.md)。
5. 需要运行时核对 [PREVIEW_STATUS.md](PREVIEW_STATUS.md)；涉及模型或生成时读 [REAL_FLOW_VALIDATION.md](REAL_FLOW_VALIDATION.md)。

## 正式环境与运行边界

- **受保护正式安装**：`E:\AI-Tools\BiliNote`（当前运行桌面 `0.1.0-preview.33` + 后端 `0.1.0-preview.31`，默认 `8483` 端口，含真实数据库 `bili_note.db`、`data`、`note_results`、`uploads`、`WebView2` 等）绝对受保护，未经明确授权不得修改、停止、重启或覆盖。
- **其他外部保护目录**：`E:\AI-Tools\BiliNote-Learning-Preview`、`E:\AI-Tools\_Launchers`、`E:\AI-Tools\BiliNote-build`、`E:\codex\github仓库管理和发布` 与 `E:\codex\bilinote-backup-20261115`。
- **开发必须完全隔离**：不要直接运行未隔离的 `pnpm dev`、`backend/main.py` 或 Tauri 桌面端（默认指向 `8483` 正式端口）；开发或真实业务验收必须同时隔离前后端端口、`VITE_API_BASE_URL`、应用标识、数据库、笔记/截图/上传目录、缓存目录及浏览器 origin。

## 必须保留的核心契约

- **资料库整理**：遵循 [代理约束](../backend/ORGANIZER_AGENT.md)、[会话契约](../backend/ORGANIZER_SESSION_CONTRACT.md) 与 [保留/撤销契约](../backend/ORGANIZER_RETENTION_CONTRACT.md)。写操作必须先生成计划并由用户确认，禁止静默扩大只读权限或永久删除笔记。
- **阅读与存储**：保留 `records-v2` 分记录原子存储及 `--storage-maintenance` 维护回退模式；草稿、引用、附件与工作过程同最终正文分离。
- **生成与能力**：未知提交先核对请求身份；部分分段结果不冒充完整版本；仅保存恢复与重新生成分开。
