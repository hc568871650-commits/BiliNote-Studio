# BiliNote Studio 0.1.0-preview.1

基于 JefferyHcool/BiliNote v2.4.5 独立维护，非上游官方发行。首发为单一 Windows x64 安装版。

## 安装

1. 从 [项目 Releases](https://github.com/hc568871650-commits/BiliNote-Studio/releases) 下载安装程序及 SHA256SUMS.txt。
2. 可用 PowerShell `Get-FileHash <安装程序路径> -Algorithm SHA256` 核对文件。
3. 安装程序尚未做代码签名，Windows 可能提示未知发布者。核对下载来源与哈希后，运行安装程序，为当前用户安装。运行环境需要 Microsoft Edge WebView2；安装器按配置处理缺失的 WebView2，可能需要联网。
4. 启动 BiliNote Studio，在设置中配置模型与转写。没有预置密钥、Cookie 或付费账户。

## FFmpeg

首发不随安装包分发 FFmpeg。视频音频处理前，从 [FFmpeg 官方下载入口](https://ffmpeg.org/download.html#build-windows) 选择 Windows 构建，自行阅读该构建的许可。

将 `ffmpeg.exe` 和 `ffprobe.exe` 放入 `%LOCALAPPDATA%\BiliNoteStudio\bin`，或将所在目录加入用户 PATH，然后重启 Studio。系统检测页可检查是否可用。缺少 FFmpeg 时不要提交视频任务；阅读笔记和配置模型不依赖它。

## 数据与更新

- 笔记、数据库、缓存和设置保存在 `%LOCALAPPDATA%\BiliNoteStudio`，与程序安装目录分离。
- 更新前备份整个数据目录；安装新版程序不应覆盖用户数据。
- 不支持与原版共享数据库，也不承诺自动迁移旧版笔记。
- 卸载前保留重要数据备份；不要手动删除数据目录，除非确定不再需要。

## 使用

配置生成模型和转写器后，新建视频笔记；生成结束后在笔记库中阅读、分类和引用提问。阅读与整理可分别选择模型。整理操作需在计划卡片中确认执行。

首发只提供在线转写（Groq、剪映、快手），不内置本地 Whisper。首发不支持抖音链接下载；已下载的视频仍可作为本地视频导入。Markdown 导出保留，内置 PDF 导出不随首发提供。外部模型和在线转写可能产生服务商费用，相关内容会发送给你配置的服务商。

## 预览边界

未穷尽验证所有平台、供应商、GPU 和本地模型组合。Windows 验证详情见 [VALIDATION.md](../../VALIDATION.md)。出现问题时请在本仓库提交 Issue，并在日志中遮盖密钥、Cookie、个人笔记和路径。
