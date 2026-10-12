# Studio 源码同步与发行流程

更新日期：2026-10-12。发行目标为 [hc568871650-commits/BiliNote-Studio](https://github.com/hc568871650-commits/BiliNote-Studio)。本仓库源码、版本和独立安装包已完成 `0.1.0-preview.8` 发行准备及安装/旧包升级验收，GitHub公开发布尚在流程中。累计内容见 [preview.8 发布说明](docs/releases/0.1.0-preview.8.md)，本次实测见[验证记录](docs/releases/0.1.0-preview.8-validation.md)。

## 源码同步边界

公开仓库从清理后的源码快照建立，不导入开发工作区的私人 Git 历史。后续在独立发布 checkout 逐文件对比应用源码、新增模块、依赖锁文件、必要测试和合成预览入口，不能整目录覆盖。

保留公开用户指南、首发验证资料、MIT 与上游版权声明、完整许可原文及 `licenses/`。本轮公共配图位于 `doc/showcase/studio-20261012/`，来源说明随图片保留。

不同步配置、Cookie、密钥、数据库、真实笔记、上传文件、缓存、日志、WebView2 数据、备份、构建产物、内部历史和本机部署截图。忽略规则不会移除已跟踪文件；检查实际 `BillNote_frontend` 拼写、已跟踪和新增文件。

执行前核对实际目录的 `git remote -v`、`git status --short --untracked-files=all` 和 `git diff --stat`。推送源码、标签或创建 Release 需要明确发布授权；发布说明草稿本身不是授权。

## 版本、身份与构建

以下应用入口统一为 `0.1.0-preview.8`，只更新应用自身版本，不能全局替换第三方版本：

- `BillNote_frontend/package.json` 及 `package-lock.json` 的根包。
- `BillNote_frontend/src-tauri/Cargo.toml` 和 `Cargo.lock` 的 `app` 包。
- `BillNote_frontend/src-tauri/tauri.conf.json`。
- `tools/build_editions.py` 的 `VERSION`；安装构建工具从此导入。

公开发行提供单一 Windows x64 安装版，入口为 `tools/build_studio_installer.py`。按 `--help` 提供专用依赖、工具链和 Node 路径；公共脚本不使用维护者机器的绝对路径。安装配置覆盖为 `com.bilinote.studio`、后端端口 38484，用户数据为 `%LOCALAPPDATA%\BiliNoteStudio`。普通源码默认 `.full` 身份不能代替安装配置。

不分发 Quick/Full 双版本或便携版，不内置 FFmpeg、PDF 导出/PyMuPDF、本地 Whisper或抖音链接下载。构建时重新核对冻结包裁剪；前端设置 `VITE_BILINOTE_DISTRIBUTION=installer` 和 `VITE_BILINOTE_LOCAL_WHISPER=0`。本机兼容部署工具不属于公开安装流程。

公开 `.github/workflows/checks.yml` 仅运行源码检查，不按标签自动发布。新增专项检查由 `pnpm test:release` 统一运行；后端专项回归需要独立依赖和临时数据。全仓 TypeScript/lint 的既有问题须如实记录，构建通过不代表全仓无错误。

## 验证和公开发布

1. 从最终发布快照构建，记录提交 SHA、工具链、依赖、构建参数及源码摘要；运行必要前后端回归和 Tauri 构建。
2. 验证新安装、首次启动、FFmpeg 缺失提示、退出和后端停止；确认程序/数据分离及与原版隔离。
3. 用实际公开 `preview.1` 安装包升级到新包，核对笔记、配置、阅读和聊天存储。模拟旧版本元数据不能替代实际旧包升级。
4. 检查最终快照和附件的敏感信息、个人数据、素材来源与实际随包依赖许可，生成真实 `SHA256SUMS.txt`。
5. 独立保存新版本验证记录。根目录 `VALIDATION.md` 和 `VALIDATION.json` 属于 `preview.1`，不能改标题或旧哈希冒充新验收。
6. 核对授权、目标仓库、提交与工作流，再推送、创建 `v0.1.0-preview.8` 标签和预发行版，上传实际附件。
7. 匿名下载附件，检查大小和 SHA-256、tag 对应提交、安装包版本及页面状态；通过后更新 README 和发布说明的状态与下载链接。

本次源码同步、版本统一、独立安装包构建与验收已经完成；推送、标签、公开附件和匿名下载结果仍需分别记录。各阶段以本版本新验证记录及发行结果为准。
