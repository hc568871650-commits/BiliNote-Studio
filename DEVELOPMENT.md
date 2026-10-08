# 开发与构建

本仓库是基于 JefferyHcool/BiliNote v2.4.5 的独立维护源码快照。上游 MIT 版权声明保留；不包含维护者工作区历史、运行数据、密钥或本机部署脚本。

## 前端预览

需要 Node.js 22 和 pnpm。进入 BillNote_frontend 后安装依赖，执行 `pnpm dev:warm`，访问 http://127.0.0.1:21483/ui-preview.html 。该预览使用模拟 API 和示例数据，不会发起模型请求。

## 后端开发

建议 Python 3.11 独立虚拟环境。安装 `backend/requirements.txt` 和 `backend/requirements-agent.txt`；安装系统 FFmpeg 后，将 `backend/.env.example` 复制为本地 `.env` 并按需填写。

运行前明确设置独立数据目录、数据库、截图目录与端口，并保持前端 API 地址一致。不要连接已有 BiliNote 的 8483 服务，不要复用旧数据库。密钥和 Cookie 仅保存在本机，不提交到仓库。

## 检查

- 前端：`pnpm test:reading`、`pnpm test:stream`、`pnpm test:organizer`。
- 后端：`python tools/test_reading_isolated.py --dependencies <独立依赖目录>`，使用临时数据库和模拟模型传输。
- 安装构建：见 `tools/build_studio_installer.py --help`（如脚本名称变更，以 tools 中安装构建入口为准）。需要 Windows Rust/MSVC、Node.js、Python 3.11 与 PyInstaller。

安装包冻结后端、构建 Tauri 桌面和 NSIS 安装程序；FFmpeg 与本地模型权重不内置。构建环境与用户运行数据必须分开。公开版本的验证事实见 VALIDATION.md。
