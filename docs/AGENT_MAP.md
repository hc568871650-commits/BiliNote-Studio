# Agent 代码与测试导航

与 [接手说明](AGENT_HANDOFF.md) 配合使用。路径相对仓库根目录；下面是查阅入口，不是默认执行清单。先检查脚本的副作用与运行隔离。本次没有重跑列出的测试。

## 总体结构

| 层 | 入口与职责 |
| --- | --- |
| Web/桌面界面 | [main.tsx](../BillNote_frontend/src/main.tsx)、[App.tsx](../BillNote_frontend/src/App.tsx)、[layouts](../BillNote_frontend/src/layouts)；React 19 / TypeScript / Vite / Zustand |
| 桌面壳 | [src-tauri/src](../BillNote_frontend/src-tauri/src)、[Tauri配置](../BillNote_frontend/src-tauri/tauri.conf.json)；窗口、启动与后端生命周期 |
| 后端 | [main.py](../backend/main.py)、[路由注册](../backend/app/__init__.py)；FastAPI，路由→服务→存储/转写/模型 |
| 持久化 | [数据库](../backend/app/db)、[note_storage.py](../backend/app/services/note_storage.py)、[前端store](../BillNote_frontend/src/store)；数据库/文件与浏览器存储并存 |
| 辅助扩展 | [BillNote_extension](../BillNote_extension)；浏览器扩展，不是当前桌面功能主入口 |
| 历史/发行 | [RELEASING.md](../RELEASING.md)、[tools](../tools)、[docs/project-history](project-history)；发行与归档不可当作安全开发启动器 |

## 按任务找代码

| 任务 | 前端入口（BillNote_frontend/src 下） | 后端入口（backend/app 下） |
| --- | --- | --- |
| 新建/重新生成、受理与轮询 | `pages/HomePage/components/NoteForm.tsx`、`store/taskStore/index.ts`、`hooks/useTaskPolling.ts`、`utils/noteGeneration.ts` | `routers/note.py`、`services/note.py`、`services/note_storage.py` |
| 转写/取帧/生成参数 | `components/GenerationOptionsFields.tsx`、`pages/SettingPage/transcriber.tsx` | `transcriber/`、`downloaders/`、`utils/dynamic_frames.py`、`gpt/universal_gpt.py`、`gpt/request_chunker.py` |
| 用量/对照/局部重做 | `pages/HomePage/components/GenerationDetailsDialog.tsx`、`RefineNoteDialog.tsx`、`services/generationRuns.ts` | `services/generation_usage.py`、`generation_comparisons.py`、`note_refinement.py` |
| 任务诊断/仅保存恢复 | `pages/HomePage/components/NoteDiagnosticsPanel.tsx`、`services/noteDiagnostics.ts` | `services/note_diagnostics.py`、`note_storage.py`、`routers/note.py` |
| 全文查找/定位 | `pages/HomePage/components/LibrarySearch.tsx`、`store/librarySearchStore.ts`、`utils/searchLocation.ts` | `routers/library_search.py`、`services/library_search.py` |
| 阅读布局/目录/位置 | `pages/HomePage/components/ReaderPane.tsx`、`MarkdownViewer.tsx`、`ReadingChatLayout.tsx`、`ReadingOutline.tsx`、`utils/prepareReadingRestore.ts` | `services/note_storage.py`（版本读取） |
| 阅读聊天/图片/恢复 | `pages/HomePage/components/ChatPanel.tsx`、`store/readingAssistantStore.ts`、`utils/readingRecovery.ts`、`readingAttachments.ts`、`noteImageAttachment.ts` | `routers/chat.py`、`services/chat_service.py`、`reading_stream.py`、`protocol_clients.py` |
| 流式事件/工作过程 | `services/chatStream.ts`、`utils/eventStream.ts`、`components/WorkProgress.tsx` | `services/reading_stream.py`、`organizer.py`、`organizer_sessions.py` |
| 资料库问答/计划执行 | `pages/OrganizerPage/`、`store/organizerStore.ts`、`services/organizer.ts` | `routers/organizer.py`、`services/organizer.py`、`organizer_sessions.py`、`chat_tools.py` |
| 模型协议/视觉检测 | `components/ModelCapabilitiesPanel.tsx`、`ReadingVisionStatus.tsx`、`hooks/useModelCapabilities.ts`、`services/providerProtocol.ts` | `services/model_capabilities.py`、`protocol_clients.py`、`gemini_client.py`、`routers/model_capabilities.py` |
| 原生/外部联网 | `components/WebSearchSettings.tsx`、`AssistantChatSettings.tsx`、`hooks/useModelWebSearchSettings.ts`、`store/modelWebSearchStore.ts` | `services/native_search.py`、`web_search.py`、`search_tool.py`、`web_page.py`、`tavily_usage.py` |
| 上下文预算/压缩 | `components/ModelContextSettings.tsx`、`hooks/useModelContext.ts`、`services/modelContext.ts` | `services/model_context.py`、`context_compaction.py` |
| 标题栏/后端入口 | `components/DesktopChrome.tsx`、`components/BackendHealth/BackendStatusButton.tsx`、对应CSS | 桌面壳 `src-tauri/src/` 与健康接口；纯布局变更不需要启动正式后端 |

## 必须保留的契约

- 资料库整理：读 [代理约束](../backend/ORGANIZER_AGENT.md)、[会话契约](../backend/ORGANIZER_SESSION_CONTRACT.md)、[保留/撤销契约](../backend/ORGANIZER_RETENTION_CONTRACT.md)。读权限、计划确认、写权限与撤销冲突分别处理。
- 生成：未知提交先核对请求身份；部分输出不能冒充完整结果；保存恢复与重新生成分开。
- 阅读：草稿、引用、图片、轮次、来源版本和晚到结果绑定正确笔记；工作过程与最终正文分开。
- 能力：能力检测不是使用前强制门禁；保留协议限制、费用提示、显式检测、取消/核对与历史失效语义。
- 预算：`utils/aiSettings.ts` 中仍有272000兼容字段；有效窗口/输入预算看 `services/modelContext.ts` 和后端 `model_context.py`，不能只搜一个常量判断实际预算。
- 存储：部分后端路径相对cwd（例如 `data/model_context.json`）；前端存在IndexedDB/localStorage，不可仅隔离SQLite而共用其他状态。

## 按改动选择验证

前端脚本位于 [scripts](../BillNote_frontend/scripts)，后端测试位于 [tests](../backend/tests)。先阅读，再在独立数据环境执行；此表不承诺全仓检查已通过。

| 领域 | 前端检查入口 | 后端检查入口 |
| --- | --- | --- |
| 受理/轮询/进度 | `check-note-generation.mjs`、`check-generation-polling.mjs`、`check-generation-options.mjs` | `test_note_admission_isolated.py`、`test_note_pipeline_isolated.py`、`test_generation_observability.py` |
| 保存/诊断 | `check-desktop-experience-browser.mjs` | `test_note_save_recovery.py`、`test_note_diagnostics.py`、`test_note_diagnostics_routes.py` |
| 查找/阅读 | `check-desktop-experience-browser.mjs`、`check-reading-position.mjs`、`check-reading-outline.mjs` | `test_direct_library_search.py`、`test_library_search.py` |
| 图片/分栏/恢复 | `check-note-image-attachment.mjs`、`check-reading-chat-layout.mjs`、`check-reading-recovery.mjs`、`check-reading-recovery-browser.mjs` | `test_reading_protocols.py`、`test_reading_stream.py` |
| 能力/模型 | `check-capability-submission-browser.mjs` | `test_model_capabilities.py`、`test_native_search_protocols.py`、`test_protocol_response_validation.py` |
| 工作过程 | `check-work-progress.mjs`、`check-work-progress-browser.mjs`、`check-chat-stream.mjs` | `test_visible_tool_rounds.py`、`test_organizer_work_log.py` |
| 联网/网页 | `check-automatic-search-browser.mjs`、`check-model-search-browser.mjs`、`check-tavily-usage-browser.mjs` | `test_automatic_search.py`、`test_search_policy.py`、`test_web_page_paging.py`、`test_official_deepseek_search.py` |
| 上下文/整理 | `check-context-presets-browser.mjs`、`check-organizer-session.mjs` | `test_model_context.py`、`test_organizer_sessions.py`、`test_organizer_retention.py` |

`package.json` 已提供 `test:reading`、`test:stream`、`test:organizer`，但这三个入口不等于全量验收。浏览器脚本可能硬编码历史端口、fixture或本机依赖路径，运行前适配本轮环境。不能通过复制旧`.tmp`证据或改标题获得“本轮通过”。

涉及模型时还必须执行 [真实流程验收](REAL_FLOW_VALIDATION.md)；构建、孤立HTTP请求、替身与后台成功都不能替代实际UI到保存再读取。

## 发行工具分界

- `tools/build_formal_desktop.py`：本地兼容版构建，代码固定8483与旧identifier并使用工作区外工具链；不是开发预览配置。
- `tools/deploy_*.py`、`install-built-bilinote.py`、`migrate_local_studio_names.py`：可能写入安装目录；仅在明确对应授权、检查路径和备份后使用。
- `tools/build_studio_installer.py` 与 `backend/installed_runtime.py`：独立安装包路线；不能将本地兼容安装的通过记录当作新独立安装包验证。
- 源码发布以 [RELEASING.md](../RELEASING.md) 的独立checkout流程为入口，实时核对目标远程；不要根据 `origin`/`fork` 的名字直接推送。
