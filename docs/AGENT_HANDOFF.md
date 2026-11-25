# BiliNote Studio：Agent 接手说明

整理日期：2026-11-25（America/Los_Angeles）。

## 当前仓库状态与版本口径

- **主开发工作区与本地正式版**：`e:\agy work\bilinote studio` 已定版 **`0.4.1`**（在 `0.4.0` 全四阶段能力基础上完成静态配图多模态视觉分块修复、阅读/失败状态机加固、顶栏单行防裁切与付费重生成确认守卫），并经用户明确授权已无损实装并热更新至 **`E:\AI-Tools\BiliNote`**（桌面 `0.4.1` + 后端 `0.4.1` + 内置纯 Python BSD `pypdf 7.1.1`，默认 `8483` 端口），已完成全量自动化回归与真实运行核验。
- **`0.4.1` 核心修复与验收结论**：
  - **静态配图视觉分块与有时轴视频双通道修复**：`_prepare_local_image_evidence` 对无时间轴静态配图将 `video_image_ranges` 置 `None` 改走预算顺序分块（落盘规范化为 `[]`），彻底消除带图 X Article 开启画面理解时的错配报错；有时轴视频 `VideoReader` 动态抽帧与时间范围对齐完整保留。
  - **阅读/失败状态机、顶栏防裁切与确认守卫**：首次无正文失败态与有历史可读正文重生成失败态状态机加固、顶栏 `1000px~1280px` 零裁切零重叠（756 组矩阵通过）、单入口恢复与 `save_recovery` 零模型请求重试保存、新增 `RegenerateConfirmDialog` 与蒸馏队列付费/取消确认守卫。
  - **真实验收报告**：见 [0.4.1 发布说明](releases/0.4.1.md) 与 [隔离环境真实验收报告](0.4.0-fix-validation-2026-11-25/VALIDATION_REPORT.md)；`0.4.0` 历史分阶段验收报告仍保留于 [4A](0.4.0-m4a-validation-2026-11-22/VALIDATION_REPORT.md) / [4B](0.4.0-m4b-validation-2026-11-22/VALIDATION_REPORT.md) / [4C+4D](0.4.0-m4cd-validation-2026-11-22/VALIDATION_REPORT.md)。
- **版本字段现状**：`BillNote_frontend/package.json`、`BillNote_frontend/package-lock.json`（根包）、`BillNote_frontend/src-tauri/Cargo.toml`、`BillNote_frontend/src-tauri/Cargo.lock`（`app` 包）、`BillNote_frontend/src-tauri/tauri.conf.json`、`BillNote_frontend/src/pages/SettingPage/about.tsx`、`backend/app/services/system_maintenance.py`、`tools/build_editions.py` 均已统一对齐为 `0.4.1`。
- **本地回滚备份**：本次 `0.4.0 → 0.4.1` 全量实装备份与一键回滚脚本保存在 `e:\agy work\bilinote studio\.BiliNote-dev\local-release-0.4.1`（含 `backup/`、`Rollback.ps1`、`deploy_helper.py`、`extra-deps/` 与验收回执 JSON）；历史 `0.3.0 → 0.4.0` 备份仍保留于 `.BiliNote-dev\local-release-0.4.0`。

## 必须先读的文件

1. [AGENTS.md](../AGENTS.md)：开发权限、正式版保护、文案、预览收尾与真实调用授权。
2. [DEVELOPMENT.md](../DEVELOPMENT.md)：仓库结构与本地开发基础说明。
3. [代码与测试导航](AGENT_MAP.md)：按模块与任务查找前后端代码入口。
4. [UI/UX 设计规范](ui-design-guide.md)（同步镜像于 `.agent/rules/bilinote-ui-guide.md`）。
5. 需要运行时核对 [PREVIEW_STATUS.md](PREVIEW_STATUS.md)；涉及模型或生成时读 [REAL_FLOW_VALIDATION.md](REAL_FLOW_VALIDATION.md)。

## 正式环境与运行边界

- **受保护正式安装**：`E:\AI-Tools\BiliNote`（当前运行桌面 `0.4.1` + 后端 `0.4.1`，默认 `8483` 端口，含真实数据库 `bili_note.db`、`data`、`note_results`、`uploads`、`WebView2` 等）绝对受保护，后续开发未经另行明确授权不得修改、停止、重启或覆盖。
- **其他外部保护目录**：`E:\AI-Tools\BiliNote-Learning-Preview`、`E:\AI-Tools\_Launchers`、`E:\AI-Tools\BiliNote-build`、`E:\codex\github仓库管理和发布` 与 `E:\codex\bilinote-backup-20261115`。
- **开发必须完全隔离**：不要直接运行未隔离的 `pnpm dev`、`backend/main.py` 或 Tauri 桌面端（默认指向 `8483` 正式端口）；开发或真实业务验收必须同时隔离前后端端口、`VITE_API_BASE_URL`、应用标识、数据库、笔记/截图/上传目录、缓存目录及浏览器 origin。

## 必须保留的核心契约

- **资料库整理**：遵循 [代理约束](../backend/ORGANIZER_AGENT.md)、[会话契约](../backend/ORGANIZER_SESSION_CONTRACT.md) 与 [保留/撤销契约](../backend/ORGANIZER_RETENTION_CONTRACT.md)。写操作必须先生成计划并由用户确认，禁止静默扩大只读权限或永久删除笔记。
- **阅读与存储**：保留 `records-v2` 分记录原子存储及 `--storage-maintenance` 维护回退模式；草稿、引用、附件与工作过程同最终正文分离。
- **生成与能力**：未知提交先核对请求身份；部分分段结果不冒充完整版本；仅保存恢复与重新生成分开。
