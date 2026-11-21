# BiliNote Studio：Agent 接手说明

整理日期：2026-11-21（America/Los_Angeles）。

## 当前仓库状态与版本口径

- **主开发工作区与本地正式版**：`e:\agy work\bilinote studio` 已完成 **`0.3.0` 全四阶段（Phase 1 ~ Phase 4，Task 1 ~ Task 14）+ 单实体卷帘悬浮音视频播放器深浅双模打磨与验收**，并经用户明确授权已将 **`0.3.0`（桌面 `0.3.0` + 后端 `0.3.0`）安全实装至 `E:\AI-Tools\BiliNote`** 且通过真实启动核验（尚未同步至 `E:\codex\bilinote` 或提交新 Git 提交）。
- **`0.3.0` 已落地核心能力与验收结论**：
  - **Phase 1（极速启动 + 后端领域重构 + 统一任务队列 SSE）**：后端 `create_app` 冷启动降至 `0.998s`（9 项重型库 0 预载）；前端首屏拆包瘦身至 `1307.4 KB / 1350 KB`；Tauri 异步 FFmpeg 检测；`backend/app/jobs/` + `/api/jobs/events` SSE 与 `domains/`、`llm/`、`enums/` 100% 兼容老数据落地。
  - **Phase 2（蒸馏队列无感体验）**：导轨动态「新建笔记」随动镂空遮罩笔动画 + 强调色数字球（阅读页悬停静默、点击小球展开，新建页支持悬停预览与顶栏「队列」图标切换）+ 三档完成提醒状态机（默认 `all_done`）；已给 `distillQueueStore` / `services/jobs` 加 `globalThis` 单例守卫根除 Windows 盘符大小写双实例问题。
  - **Phase 3 & 悬浮播放器定稿（沉浸复习与知识外带）**：单实体卷帘悬浮音视频播放器（默认 `248×36px` 影院黑玻璃音频条与一体凹弧顶耳、贴顶字幕自动下翻、抓顶耳上拉卷展 16:9 视频且拉满无缝转全向拖框、触底续拉压扁收起、近边高阻尼防越界墙与无过冲落点、四角 16:9 缩放）+ 原文参照三向联动；结构化现代思维导图；错题与避坑整卡点击展开原位重练/翻卡自检/掌握流转/跨路由 1.6s 脉冲锚点直达；Obsidian 增强 Markdown & Anki `.tsv` 4 格式导出；精简笔记内置「生成设置」弹窗与对称分段滑块。
  - **Phase 4（课程级批量导入与多源生产）**：多 P 合集 / 播放列表懒加载解析 + 去重标记 + 自动建同名文件夹 + 费用确认批量入队（`CollectionImportPanel` + `/api/ingestion/*`）；本地 `.srt/.vtt` 字幕 UTF-8/BOM/GBK 解析与免下载免转写直出；旧版 Markdown 笔记多选批量结构化升级 + 原生 `<dialog>` 费用确认弹窗（`/api/notes/batch-upgrade-structured`）。
  - **全量验证与真实流程报告**：见 [0.3.0 隔离环境真实流程验收报告](0.3.0-real-flow-validation-2026-11-20/VALIDATION_REPORT.md) 与 [实施计划（全部 14 项已勾选）](plans/2026-11-20-studio-0.3.0-implementation-plan.md)。
- **版本字段现状**：`BillNote_frontend/package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`tools/build_editions.py` 与 `CHANGELOG.md` 均已统一升级为 `0.3.0`。
- **本地回滚备份**：本次 `0.3.0` 全量实装备份与一键回滚脚本保存在 `e:\agy work\bilinote studio\.BiliNote-dev\local-release-0.3.0`（内含 `backup/`、`Rollback.ps1`、`install-verification.json`、`post-start-verification.json`）；历史 `0.2.0` 备份仍保留。

## 必须先读的文件

1. [AGENTS.md](../AGENTS.md)：开发权限、正式版保护、文案、预览收尾与真实调用授权。
2. [DEVELOPMENT.md](../DEVELOPMENT.md)：仓库结构与本地开发基础说明。
3. [代码与测试导航](AGENT_MAP.md)：按模块与任务查找前后端代码入口。
4. [preview.33 变更说明](releases/0.1.0-preview.33.md) 与 [preview.31 预发行说明](releases/0.1.0-preview.31.md)。
5. 需要运行时核对 [PREVIEW_STATUS.md](PREVIEW_STATUS.md)；涉及模型或生成时读 [REAL_FLOW_VALIDATION.md](REAL_FLOW_VALIDATION.md)。

## 正式环境与运行边界

- **受保护正式安装**：`E:\AI-Tools\BiliNote`（当前运行桌面 `0.2.0` + 后端 `0.2.0`，默认 `8483` 端口，含真实数据库 `bili_note.db`、`data`、`note_results`、`uploads`、`WebView2` 等）绝对受保护，后续开发未经另行明确授权不得修改、停止、重启或覆盖。
- **其他外部保护目录**：`E:\AI-Tools\BiliNote-Learning-Preview`、`E:\AI-Tools\_Launchers`、`E:\AI-Tools\BiliNote-build`、`E:\codex\github仓库管理和发布` 与 `E:\codex\bilinote-backup-20261115`。
- **开发必须完全隔离**：不要直接运行未隔离的 `pnpm dev`、`backend/main.py` 或 Tauri 桌面端（默认指向 `8483` 正式端口）；开发或真实业务验收必须同时隔离前后端端口、`VITE_API_BASE_URL`、应用标识、数据库、笔记/截图/上传目录、缓存目录及浏览器 origin。

## 必须保留的核心契约

- **资料库整理**：遵循 [代理约束](../backend/ORGANIZER_AGENT.md)、[会话契约](../backend/ORGANIZER_SESSION_CONTRACT.md) 与 [保留/撤销契约](../backend/ORGANIZER_RETENTION_CONTRACT.md)。写操作必须先生成计划并由用户确认，禁止静默扩大只读权限或永久删除笔记。
- **阅读与存储**：保留 `records-v2` 分记录原子存储及 `--storage-maintenance` 维护回退模式；草稿、引用、附件与工作过程同最终正文分离。
- **生成与能力**：未知提交先核对请求身份；部分分段结果不冒充完整版本；仅保存恢复与重新生成分开。
