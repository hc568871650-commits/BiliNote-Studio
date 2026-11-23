# BiliNote Studio `0.4.0` Milestone 4B 真实流程与回归验收报告

验收日期：2026-11-22  
验收范围：Milestone 4B（小宇宙播客全链路支持、通用网页技术文章免转写直出、本地 PDF / Markdown / TXT 拖入直出）  
隔离环境：
- 隔离后端：`http://127.0.0.1:19485`（独立数据目录 `.BiliNote-dev\m4b-validation-data`，`BILINOTE_LOCAL_WHISPER=0`，已停止释放）
- 隔离前端：`http://127.0.0.1:21485`（直连 `19485/api`，已停止释放）
- 正式安装 `E:\AI-Tools\BiliNote` 与外部受保护目录全程未触碰。

---

## 一、静态检查、冷启动与体积守卫

| 检查项 | 结果 | 关键数据 |
| --- | --- | --- |
| 后端冷启动与零预载 | **PASS** | `create_app(None)` 耗时 **`0.916s`**（`< 1.2s` 门禁），`routes=123`，`heavy_loaded=[]`（含 `bs4 / lxml / pypdf / x_downloader / xiaoyuzhoufm_download / web_downloader` 均 0 预载） |
| 后端 4B 与全链路回归单元测试 | **PASS** | `test_m4b_sources.py` 等 8 个套件 **`57 passed, 3 subtests passed`**；`test_media_io.py` 与 `test_web_*` 6 个既有安全套件 **`99 passed, 74 subtests passed`** |
| 前端类型检查与发布自检 | **PASS** | `tsc --noEmit` 0 报错；`pnpm test:release`（含更新后的 `check-source-url.mjs`）全绿 |
| 前端构建与首屏 JS 体积预算 | **PASS** | 首屏直载 JS **`1310.6 KB / 预算 1350 KB`** |
| 开源许可与安全合规 | **PASS** | PDF 优先使用 BSD-3-Clause `pypdf>=5.0.0` + 零依赖兜底解析，零 `PyMuPDF / fitz` 引用 |

---

## 二、真实业务流程验收结果（脱敏）

使用隔离库内既有模型配置：`provider_id="official-deepseek"`、`model_name="deepseek-flash"`（默认 `output_language="zh-CN"`）。

### 1. 公开网页技术文章直出（成功路径：`val-web-0567a3c4`）
- **输入**：`https://fastapi.tiangolo.com/features/?utm_source=m4b_test`（故意传入 `platform="bilibili"` 测试自动纠偏）
- **流程核验**：
  - 自动剥离 `utm_source` 追踪参数，自动纠偏 `platform="web"`；
  - 复用带公网 IP/SSRF 校验的 `read_article_page` 抓取并提取正文，清洗标题锚点 `¶` 后保留干净标题 `Features - FastAPI`；
  - 归类 `media_kind="text_post"`、`source_kind="web_article"`，跳过音视频下载与语音转写；
  - 真实调用 `official-deepseek / deepseek-flash` 1 次（`chunk-0/root`，`duration=64.93s`，`input_tokens=3507`，`output_tokens=14473`，`thinking_tokens=8031`，`total_tokens=17980`）；
  - 任务状态收敛为 **`SUCCESS`**，产出 **8 章节**全简体中文结构化笔记（标题：`FastAPI 特性总览：开放标准、现代 Python 与生态能力`），成功落盘并由前端阅读页完整渲染。

### 2. 本地文档上传与 PDF 直出（成功路径：`val-pdf-c5bb297f`）
- **上传契约验证**：
  - `POST /api/upload` 上传 `quick_guide.md` → `200 OK`，返回 `is_document: true`；
  - `POST /api/upload` 上传 `DB_Pool_Sizing_Guide.pdf` → `200 OK`，返回 `is_document: true`。
- **PDF 端到端生成核验**：
  - 提交 `platform="local"` 与上传路径 `/uploads/949ccb9a4cba4ebc98d1f9489dc69af3.pdf`；
  - 跳过 `ffmpeg/ffprobe` 与转写门禁，解析提取 PDF 正文并真实调用 `official-deepseek / deepseek-flash`（主请求 `input=1888, output=4724, total=6612` + `json_repair` `input=735, output=2023, total=2758`）；
  - 任务收敛为 **`SUCCESS`**（`media_kind="text_post"`、`source_kind="local_document"`）。
  - *注*：本次 PDF 生成中模型偶发输出 1 处缺少双引号的 JSON 语法瑕疵，系统按既有容错策略安全降级保存；非 4B 解析代码问题。

### 3. 安全边界负向拦截（0 次模型调用）
- `http://127.0.0.1:8080/admin`（`platform="web"`）→ 请求层直接返回 `code=300101` 拒绝；
- `https://www.bilibili.com/anime/timeline`（无 BV 号）→ 请求层直接返回 `code=300101` 拒绝。

---

## 三、实机过程暴露并现场修复的问题

1. **Windows GBK 控制台导致任务永久卡在 `SAVING`**（高危存量根因修复）：
   - 原因：FastAPI 网页标题初版含 Unicode 段落符 `¶`（`\xb6`）进入笔记目录名后，`NoteGenerator._update_status` 内的裸 `print()` 在 Windows GBK 控制台抛出 `UnicodeEncodeError`，导致 `TaskStatus.SUCCESS` 写入失败。
   - 修复：移除 `note.py` `_update_status` 中的裸 `print` 改用 `logger.debug`；同时在 `web_page.py` 中优先取 `<title>` 并清理标题尾部 `¶ / # / 🔗` 锚点符号，补单测回归并复跑真实任务通过。
2. **本地文档阅读页来源横幅体验细节**：
   - 原因：实机浏览器验收发现本地文档横幅重复显示 `本地文档 · 本地文档`，且将本地路径 `/uploads/...` 渲染为「原帖」外链。
   - 修复：`local_downloader.py` 将本地文档 `uploader` 细化为具体格式（`PDF / Markdown / TXT`），`VideoBanner.tsx` 增加同名字段去重并仅对 `http(s)://` 链接渲染外链按钮，热更新后经浏览器子代理复核通过。

---

## 四、实机前端 UI 复核结果

由浏览器子代理实机访问 `http://127.0.0.1:21485` 核验：
- 新建笔记平台选择器完整包含 `小宇宙播客` 与 `网页文章`；
- 粘贴网页文章链接与小宇宙移动端链接均正确清洗/规范化、自动切换平台且隐藏「解析合集」；
- 切换「本地文件」上传区明确提示支持 `PDF、MD、TXT`；
- 网页文章阅读页来源横幅正确显示 `网页文章` 与 `原文` 外链，8 章节中文结构化笔记渲染完整，0 控制台错误、0 裂图；
- 本地文档阅读页修复后已隐藏无效 `/uploads/...` 外链按钮。

---

## 五、未验证范围说明

- **小宇宙播客实网拉流与语音转写**：小宇宙单集 HTML（`__NEXT_DATA__` / JSON-LD / OpenGraph）解析、Shownotes 清洗、`media_kind="audio"` 流式落盘及封面白名单均已通过单元测试覆盖，但本轮隔离环境未提供真实小宇宙付费/公开单集音轨执行实网下载与本地 Whisper 语音转写。
- **复杂中文字体 PDF 实机解析**：当前只读 Python 3.11 环境暂未预装 `pypdf`（已写入 `backend/requirements.txt`：`pypdf>=5.0.0`，BSD-3-Clause 许可）；本轮真实 PDF 验收运行在内置零依赖兜底解析器上，复杂 CJK 嵌字/ToUnicode CMap PDF 需在安装 `pypdf` 的环境中进一步覆盖。
