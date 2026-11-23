# BiliNote Studio：Agent 接手说明

整理日期：2026-11-23（America/Los_Angeles）。

## 当前仓库状态与版本口径

- **主开发工作区与本地正式版**：`e:\agy work\bilinote studio` 已完成 **`0.4.0` 全四阶段（Milestone 4A ~ 4D）及桌面端深度体验打磨**，并经用户明确授权已无损实装并热更新至 **`E:\AI-Tools\BiliNote`**（桌面 `0.4.0` + 后端 `0.4.0` + 内置纯 Python BSD `pypdf 7.1.1`，默认 `8483` 端口），已完成全量自动化测试与真实运行核验。
- **`0.4.0` 已落地核心能力与验收结论**：
  - **Milestone 4A（URL 解耦 + 默认简体中文 + X/Twitter 双通道与多视频无缝拼接）**：URL 识别解耦；默认简体中文输出（支持“跟随原视频语言”切换）；X/Twitter 图文+视频双通道与短多视频/引用视频 FFmpeg 无缝拼接及音轨零网络秒抽。
  - **Milestone 4B（多源输入扩展）**：新增小宇宙播客单集、通用技术文章网页（`bs4`/`lxml`）与本地 PDF/MD/TXT 文档（零 AGPL 依赖，使用 BSD-3-Clause `pypdf`）解析直出。
  - **Milestone 4C（深度阅读与学习闭环）**：正文划词句末个人/助手批注持久化、复习库 SRS 间隔重复调度、专题综合自测（`TopicQuizDialog`）与相关笔记语义推荐（`RelatedNotesSection`）。
  - **Milestone 4D（桌面原生效率与数据主权）**：全局快捷键捕获 + 托盘一键蒸馏、`Ctrl+K` 命令面板、存储占用 macOS 风格自适应分布条与临时缓存（含 `.clips.json`）清理、整库 `.zip` 备份恢复与 GitHub Releases 检查更新。
  - **体验打磨与排障增强**：外语双语字幕自动/手动翻译（含专用翻译模型 `purpose_preferences.translation`、增量补译防锁死、二分拆批防截断与原文面板/播放器一键重译）、拼接进度条可点击截断白点、播放器默认展开首帧零飞移、底座与靠边侧 0px 静止纯对角缩放、左下角毛玻璃速开圆钮、右上角零重叠关闭钮、收起态双语自然折行悬浮字幕，以及鼠标移出播放器 2 秒自动淡出悬浮播放栏（不收起视频画面）。
  - **全量验证报告**：见 [4A 验收报告](0.4.0-m4a-validation-2026-11-22/VALIDATION_REPORT.md)、[4B 验收报告](0.4.0-m4b-validation-2026-11-22/VALIDATION_REPORT.md)、[4C+4D 验收报告](0.4.0-m4cd-validation-2026-11-22/VALIDATION_REPORT.md) 与 [0.4.0 总计划](plans/2026-11-22-studio-0.4.0-master-plan.md)。
- **版本字段现状**：`BillNote_frontend/package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`backend/app/__init__.py`、`tools/build_editions.py` 均已统一对齐为 `0.4.0`。
- **本地回滚备份**：原始 `0.3.0 → 0.4.0` 全量实装备份与一键回滚脚本保存在 `e:\agy work\bilinote studio\.BiliNote-dev\local-release-0.4.0`（保留 `backup/`、`Rollback.ps1`、`deploy_helper.py`、`extra-deps/` 与验收回执 JSON；过期历史构建缓存与中间热更新备份已清理）。

## 必须先读的文件

1. [AGENTS.md](../AGENTS.md)：开发权限、正式版保护、文案、预览收尾与真实调用授权。
2. [DEVELOPMENT.md](../DEVELOPMENT.md)：仓库结构与本地开发基础说明。
3. [代码与测试导航](AGENT_MAP.md)：按模块与任务查找前后端代码入口。
4. [UI/UX 设计规范](ui-design-guide.md)（同步镜像于 `.agent/rules/bilinote-ui-guide.md`）。
5. 需要运行时核对 [PREVIEW_STATUS.md](PREVIEW_STATUS.md)；涉及模型或生成时读 [REAL_FLOW_VALIDATION.md](REAL_FLOW_VALIDATION.md)。

## 正式环境与运行边界

- **受保护正式安装**：`E:\AI-Tools\BiliNote`（当前运行桌面 `0.4.0` + 后端 `0.4.0`，默认 `8483` 端口，含真实数据库 `bili_note.db`、`data`、`note_results`、`uploads`、`WebView2` 等）绝对受保护，后续开发未经另行明确授权不得修改、停止、重启或覆盖。
- **其他外部保护目录**：`E:\AI-Tools\BiliNote-Learning-Preview`、`E:\AI-Tools\_Launchers`、`E:\AI-Tools\BiliNote-build`、`E:\codex\github仓库管理和发布` 与 `E:\codex\bilinote-backup-20261115`。
- **开发必须完全隔离**：不要直接运行未隔离的 `pnpm dev`、`backend/main.py` 或 Tauri 桌面端（默认指向 `8483` 正式端口）；开发或真实业务验收必须同时隔离前后端端口、`VITE_API_BASE_URL`、应用标识、数据库、笔记/截图/上传目录、缓存目录及浏览器 origin。

## 必须保留的核心契约

- **资料库整理**：遵循 [代理约束](../backend/ORGANIZER_AGENT.md)、[会话契约](../backend/ORGANIZER_SESSION_CONTRACT.md) 与 [保留/撤销契约](../backend/ORGANIZER_RETENTION_CONTRACT.md)。写操作必须先生成计划并由用户确认，禁止静默扩大只读权限或永久删除笔记。
- **阅读与存储**：保留 `records-v2` 分记录原子存储及 `--storage-maintenance` 维护回退模式；草稿、引用、附件与工作过程同最终正文分离。
- **生成与能力**：未知提交先核对请求身份；部分分段结果不冒充完整版本；仅保存恢复与重新生成分开。
