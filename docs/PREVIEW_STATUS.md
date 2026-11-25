# 开发预览状态

## 当前活跃预览

- 无（`0.4.0` 静态配图视觉分块与失败/顶栏状态机修复隔离验收已完成，所有本次临时隔离前后端服务均已按任务 ID 与 PID 精确停止释放）。

## 已停止历史预览

- **`127.0.0.1:21487/`**（`task-59`，PID `22660`；原 `task-46` PID `2324` 因 API 前缀调整已先期停止）：`0.4.0` 修复隔离真实验收前端（直连 `http://127.0.0.1:19487/api`），已于 2026-11-25 核对进程归属后精确停止，不再可访问；验收记录见 `docs/0.4.0-fix-validation-2026-11-25/VALIDATION_REPORT.md`。
- **`127.0.0.1:19487`**（`task-49`，PID `33960`）：`0.4.0` 修复隔离真实验收后端（数据目录 `.BiliNote-dev\v040-fix-validation-20261125`），已于 2026-11-25 核对无在途任务及进程归属后精确停止，不再可访问。
- **`127.0.0.1:21486/`**（`task-681`）：`0.4.0` Milestone 4C+4D 隔离验收前端（直连 `19486`），已于 2026-11-22 按任务 ID 精确停止，不再可访问。
- **`127.0.0.1:19486`**（`task-680` / `task-693`）：`0.4.0` Milestone 4C+4D 隔离验收后端（数据目录 `.BiliNote-dev\m4cd-validation-data`），已于 2026-11-22 按任务 ID 精确停止，不再可访问。
- **`127.0.0.1:21485/`**（`task-377`，PID `32608`）：`0.4.0` Milestone 4B 隔离验收前端（直连 `19485`），已于 2026-11-22 按任务 ID 精确停止，不再可访问。
- **`127.0.0.1:19485`**（`task-376` / `task-396`，PID `8168` / `484`）：`0.4.0` Milestone 4B 隔离验收后端（数据目录 `.BiliNote-dev\m4b-validation-data`），已于 2026-11-22 按任务 ID 精确停止，不再可访问。
- **`127.0.0.1:21484/`**（`task-211`，PID `36048`）：`0.4.0` Milestone 4A 隔离验收前端（直连 `19484`），已于 2026-11-22 按任务 ID 精确停止，不再可访问。
- **`127.0.0.1:19484`**（`task-210` / `task-244`，PID `17576` / `37124`）：`0.4.0` Milestone 4A 隔离验收后端（数据目录 `.BiliNote-dev\m4a-validation-data`），已于 2026-11-22 按任务 ID 精确停止，不再可访问。
- **`127.0.0.1:21483/ui-preview.html`**（`task-769`，PID `34180`）：`0.3.0` Phase 4 与悬浮播放器深浅双模全量验收完成，已于 2026-11-21 按任务 ID 精确停止，不再可访问。
- **`127.0.0.1:19483`**（`task-726`，PID `38412`）：`0.3.0` 隔离后端验收服务，已于 2026-11-21 按任务 ID 精确停止，不再可访问。
- **`127.0.0.1:21483/ui-preview.html`**（`task-257`，PID `11896`）：Phase 1~3 热预览服务，已停止并由 `task-769` 替代。
- **`127.0.0.1:19483`**（`task-545`，PID `30440`）：Phase 3 隔离后端服务，已停止并由 `task-726` 替代。
- **`127.0.0.1:21483/ui-preview.html`**（`task-381`，PID `37504`）：`0.3.0` 规划前置 UI 精修隔离预览，已停止释放。
- **`127.0.0.1:21483/ui-preview.html`**（`task-156`，原 `task-106`）：历史细节优化隔离预览，已停止释放。
- **`127.0.0.1:21484/ui-preview.html`**（`task-702`）：`0.2.0` 交互动效预览，已停止释放。

## 正式安装环境

- **正式安装**：`E:\AI-Tools\BiliNote` 经用户明确授权已于 2026-11-25 原子热更新实装至 **`0.4.1`**（`local-release-0.4.1`，桌面 `0.4.1` + 后端 `0.4.1` + 内置纯 Python BSD 许可 `pypdf 7.1.1`，默认 `127.0.0.1:8483`；经 `Shell.Application` 脱离命令会话 Job Object 拉起常驻运行 `BiliNoteStudio.exe` 与 `BiliNoteStudioBackend.exe`，独立搜索服务 `BiliNote-Search` 未受影响，动态进程 PID 以实时系统查询为准）。已完成跨会话存活与启动核验：`GET /api/sys_health`（`backend/ffmpeg/db` 全部 `ok`）、`GET /api/system/check-update` 返回 `current_version: "0.4.1"`、`_internal/build-info.json` 为 `"0.4.1"` 且 `pypdf_bundled: true`、**`13/13` 篇**既有笔记全部可读无损、`/api/jobs` / `/api/learning/review-bank?status=due` / `/api/ai_purposes` / `/api/system/storage` / `/api/system/playback-cache` / `/api/organizer/sessions` 均在线、全部 **`3,153` 个受保护文件**（含 `_internal/.env`）SHA256 零变动、SQLite `PRAGMA integrity_check` 为 `ok`。
- **回滚备份**：
  - 本次 `0.4.0 → 0.4.1` 全量实装备份与一键回滚脚本：`e:\agy work\bilinote studio\.BiliNote-dev\local-release-0.4.1\backup`（及经 PowerShell 语法校验通过的 `Rollback.ps1`）。
  - 历史 `0.3.0 → 0.4.0` 实装备份留存：`e:\agy work\bilinote studio\.BiliNote-dev\local-release-0.4.0\backup`（及 `Rollback.ps1`）。
- 后续开发未经另行明确授权仍不得修改、停止、重启或覆盖 `E:\AI-Tools\BiliNote`。
