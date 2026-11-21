# 开发预览状态

## 当前活跃预览

- 无（`0.3.0` 全部预览验证已完成并实装至本地正式版，所有开发预览服务已按任务 ID 精确停止释放）。

## 已停止历史预览

- **`127.0.0.1:21483/ui-preview.html`**（`task-769`，PID `34180`）：`0.3.0` Phase 4 与悬浮播放器深浅双模全量验收完成，已于 2026-11-21 按任务 ID 精确停止，不再可访问。
- **`127.0.0.1:19483`**（`task-726`，PID `38412`）：`0.3.0` 隔离后端验收服务，已于 2026-11-21 按任务 ID 精确停止，不再可访问。
- **`127.0.0.1:21483/ui-preview.html`**（`task-257`，PID `11896`）：Phase 1~3 热预览服务，已停止并由 `task-769` 替代。
- **`127.0.0.1:19483`**（`task-545`，PID `30440`）：Phase 3 隔离后端服务，已停止并由 `task-726` 替代。
- **`127.0.0.1:21483/ui-preview.html`**（`task-381`，PID `37504`）：`0.3.0` 规划前置 UI 精修隔离预览，已停止释放。
- **`127.0.0.1:21483/ui-preview.html`**（`task-156`，原 `task-106`）：历史细节优化隔离预览，已停止释放。
- **`127.0.0.1:21484/ui-preview.html`**（`task-702`）：`0.2.0` 交互动效预览，已停止释放。

## 正式安装环境

- **正式安装**：`E:\AI-Tools\BiliNote` 经用户明确授权已实装升级至 **`0.3.0`**（`local-release-0.3.0`，桌面 `0.3.0` + 后端 `0.3.0`，默认 `8483` 端口），已完成启动核验（`backend/ffmpeg/db` 全部 `ok`、`11` 篇既有笔记与 `8` 个资料库会话无损、`/api/jobs` / `/api/learning/review-bank` / `/api/ai_purposes` 均在线、`3082` 个受保护文件零变动）。
- **回滚与历史备份**：
  - 本次 `0.3.0` 全量实装备份与一键回滚脚本：`e:\agy work\bilinote studio\.BiliNote-dev\local-release-0.3.0\backup`（及 `Rollback.ps1`）。
  - 历史 `0.2.0` 桌面精修备份：`e:\agy work\bilinote studio\.BiliNote-dev\local-release-0.2.0-ui-polish-20261119\backup`；原 `0.2.0` 基线备份：`e:\agy work\bilinote studio\.BiliNote-dev\local-release-0.2.0\backup`。
- 后续开发未经另行明确授权仍不得修改、停止、重启或覆盖 `E:\AI-Tools\BiliNote`。
