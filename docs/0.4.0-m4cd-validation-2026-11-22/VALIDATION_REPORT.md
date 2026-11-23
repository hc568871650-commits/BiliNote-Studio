# BiliNote Studio `0.4.0` Milestone 4C + 4D 综合验收报告

- 验收日期：2026-11-22
- 验收范围：
  - **Milestone 4C（学习内化闭环）**：读者自建批注 + 助手回答「一键沉淀为正文批注」、复习本轻量 SRS（`1→3→7→21天`）、专题综合自测与库内相关笔记推荐
  - **Milestone 4D（桌面原生效率与资产管理）**：Tauri 全局快捷捕获（托盘「从剪贴板一键蒸馏」+ Win32 全局热键）、`Ctrl+K` 全局苹果风毛玻璃命令面板、低码率本地视频回看缓存策略、空间统计清理 + 整库 `.zip` 脱敏备份与预备份恢复 + 「关于」页轻量检查更新
- 隔离环境：后端 `127.0.0.1:19486`、前端 `127.0.0.1:21486`、数据目录 `.BiliNote-dev\m4cd-validation-data`（均已停止释放，正式版 `E:\AI-Tools\BiliNote` 未被触碰）

## 1. 静态检查、构建与性能守卫

| 检查项 | 结果 | 实测指标 |
| --- | --- | --- |
| 后端冷启动与重型依赖零预载 | PASS | `create_app(None)` 耗时 **`1.053s`**（`< 1.2s`），`routes=139`，`heavy=[]`（`chromadb/bs4/lxml/pypdf/related_notes/system_maintenance` 等均 0 预载） |
| 后端核心回归套件（7 套件含 4A/4B/4C/4D） | PASS | **`63 passed, 13 subtests passed`**（`test_m4d_maintenance.py`、`test_m4c_learning.py`、`test_m4b_sources.py`、`test_x_platform.py`、`test_note_folders.py`、`test_note_library.py`、`test_url_normalize.py`） |
| 前端 TypeScript 检查 & `pnpm test:release` | PASS | 全部 26 项发布回归检查通过 |
| 前端生产构建 & 首屏直载 JS 体积守卫 | PASS | 首屏直载 JS **`1329.7 KB / 预算 1350 KB`**；`CommandPalette`（`7.61 KB`）、`Storage`（`8.05 KB`）、`TopicQuizDialog`（`10.58 KB`）、`ReviewBankDialog`（`14.40 KB`）均拆分为懒加载 chunk |
| Tauri Rust 编译与单元测试 | PASS | `cargo test --lib --offline`（配合隔离资源配置）编译零新增警告，单元测试 `1 passed; 0 failed` |

## 2. 隔离端到端实机界面验收（`http://127.0.0.1:21486/`）

主机核验访问来源：`http://127.0.0.1:21486`（无拦截来源）。

1. **库内相关笔记推荐（4C）— PASS**：打开《PostgreSQL 连接池与超时调优实战》，文末「库内相关笔记」展示《PostgreSQL 索引与连接池瓶颈排查》（`共同标签：PostgreSQL · 数据库`），自动过滤无关笔记《法式可颂折叠温度控制指南》。
2. **划词自建批注与毛玻璃详注（4C）— PASS**：正文拖拽选中文字后浮条展示「记批注」，保存后句末生成独立个人批注锚点，点击弹出高透毛玻璃详注卡片，支持查看、编辑与删除，数据原子写入 `_meta/learning_state.json`。
3. **复习本轻量 SRS 与专题综合自测（4C）— PASS**：顶栏「复习库」显示到期微徽标 `4`；弹窗默认优先选中「今日到期 (4)」；通过「专题小测」按「学习视频」文件夹抽题并作答，三级判题视觉与解析正常展示，作答后自动回写各篇笔记 `learning_state.json` 且顶栏到期徽标实时更新为 `3`。
4. **`Ctrl+K` 全局命令面板（4D）— PASS**：按 `Control+k` 呼出苹果风高透毛玻璃命令面板，搜索「存储」并回车直达 `/settings/storage`。
5. **存储清理 / 回看缓存 / 关于检查更新（4D）— PASS**：
   - `/settings/storage` 分类统计准确（临时音视频 `16.0 KB`、笔记正文 `9.0 KB` 等），点击「一键清理 -> 确认清理」后临时缓存归零且笔记与配置完好无损；
   - `/settings/general` 正确呈现「全局快捷捕获」与「保留低码率本地视频回看缓存」设置行；
   - `/settings/about` 展示 `v0.4.0` 与「检查更新」只读按钮。

## 3. 未验证范围与说明

- Tauri 托盘菜单点击「从剪贴板一键蒸馏」与 Windows 系统级全局热键 `Alt+Shift+B` 依赖完整 Tauri 桌面进程运行，已在 Rust 编译与单元层核验通过，将在桌面端打包安装后做最终实机快捷键核验。
- 实机浏览器验收环境使用只读测试 Python（未装 `langgraph`），因此设置页既有项 `/api/organizer/retention` 在该环境报错，与 4C/4D 改动无关；正式打包完整版依赖包含 `langgraph`。
- 「检查更新」按钮已完成 `httpx` mock 单测与 SemVer 对比校验，未在本次隔离验证中实际外联 GitHub API。
