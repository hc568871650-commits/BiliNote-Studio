# BiliNote Studio 新增 X（原 Twitter）网站链接支持规划

编制日期：2026-11-22  
归属总规划：[BiliNote Studio `0.4.0` 总升级规划（Milestone 4A）](2026-11-22-studio-0.4.0-master-plan.md)  
适用版本：`0.4.0`（面向本地正式版与公开 Windows 安装包共同可用）

---

## 一、背景与现状盘点

当前 BiliNote Studio 已具备良好的平台可扩展骨架：

- **URL 解析与校验**：[url_parser.py](../../backend/app/utils/url_parser.py)（分享文本提取、平台识别、追踪参数剥离、ID 提取、规范化）与 [video_url_validator.py](../../backend/app/validators/video_url_validator.py)（`SUPPORTED_PLATFORMS`）。
- **懒加载下载器注册表**：[constant.py](../../backend/app/services/constant.py) 中的 `_PLATFORM_FACTORIES`，新增平台不会拖慢后端 `create_app` 冷启动。
- **代理与 Cookie 复用**：
  - [ProxyConfigManager](../../backend/app/services/proxy_config_manager.py) 已为 YouTube 提供全局代理注入，可直接复用于 X；
  - [CookieConfigManager](../../backend/app/services/cookie_manager.py) 与前端 [DownloaderForm/Options.tsx](../../BillNote_frontend/src/components/Form/DownloaderForm/Options.tsx) 自动遍历 `videoPlatforms` 渲染「平台凭据」卡片；
  - 本机与打包环境的 `yt-dlp`（`2026.08.19`）已内置 `twitter`、`twitter:amplify`、`twitter:broadcast`、`twitter:card`、`twitter:shortener`、`twitter:spaces` 6 个官方提取器。
- **免转写直出管线**：[note.py](../../backend/app/services/note.py) 与 [runner.py](../../backend/app/domains/pipeline/runner.py) 已支持「命中预置字幕/文本（`download_subtitles()` / `prefetched_transcript`）即跳过下载与语音转写，直接进入结构化笔记生成」。

---

## 二、X 网站的 4 类链接形态与处理策略

X 与 B 站 / YouTube 的核心差异在于**大量高价值技术与学习内容并非纯视频**，因此需要按形态分流处理：

| 形态 | 典型链接 | 推荐处理策略 | 阶段 |
| --- | --- | --- | --- |
| **1. 视频推文 / Broadcast / Spaces** | `x.com/<user>/status/<id>`（含原生视频/GIF/音频空间）、`x.com/i/broadcasts/<id>`、`x.com/i/spaces/<id>` | 走 `yt-dlp`（透传全局代理 + 可选 X Cookie）提取音轨/视频 → 优先抓内嵌字幕或语音转写 → **合并推文正文作为背景上下文** → 生成结构化笔记（支持截图与本地悬浮播放器回看） | Phase 1 |
| **2. 纯图文推文 / X 长文（Article）** | `x.com/<user>/status/<id>`（无视频）、`x.com/<user>/article/<id>` | 自动检测无视频流后无缝降级为**图文/长文提取**（抓取正文 + 引用推文 + 作者/时间 + 可选配图说明），构造 `TranscriptResult` 直接跳过下载与转写，直出结构化笔记 | Phase 1 |
| **3. 追踪/镜像/移动端/短链** | `twitter.com/...`、`mobile.twitter.com/...`、`fxtwitter.com/...`、`vxtwitter.com/...`、`t.co/...`、`?s=20&t=...` | 自动解析/规范化为标准 `https://x.com/<user>/status/<id>` 并剥离 `s`、`t`、`ref_src`、`ref_url` 等追踪参数 | Phase 1 |
| **4. Thread 串推 & 书签批量导入** | 同作者连续多条自回复串推、X 列表/书签页 | 沿回复链拼接同作者完整串推正文与配图；书签/列表复用 `CollectionImportPanel` 批量入队 | Phase 2 |

---

## 三、关键技术设计

### 1. 网络代理与认证凭据（Cookie）
- **全局代理透传**：`XDownloader` 统一复用 `ProxyConfigManager().get_proxy_url()`，同时作用于 `yt-dlp`（`ydl_opts['proxy']`）与文本抓取 HTTP 客户端（`httpx` / `requests`）。
- **X Cookie 支持（可选，针对登录墙 / NSFW / 长文 / 高清流）**：
  - 在「设置 → 视频下载 → 平台凭据」自动新增 `X (Twitter)` 项，沿用 `CookieConfigManager`。
  - 后端支持解析用户粘贴的浏览器 `Cookie` 请求头（提取 `auth_token`、`ct0` 等核心字段），在执行 `yt-dlp` 前于临时文件生成标准 Netscape `cookies.txt` 并在 `finally` 中销毁，绝不将明文写入日志、诊断 JSON 或仓库。
- **清晰可操作的错误提示**：严格区分以下失败原因并给出一步操作指引：
  - 连接超时/被重置 → 提示检查「设置 → 视频下载 → 全局代理」；
  - 需登录/年龄受限/受保护账号 → 提示在「设置 → 视频下载 → 平台凭据 → X (Twitter)」配置 Cookie；
  - 推文已删除或不存在 → 明确告知链接失效，不进行无意义重试。

### 2. 「视频 + 推文正文融合」与「纯图文自动降级 + 配图本地化/视觉理解」
- **混合提取器（`backend/app/downloaders/x_downloader.py`）**：
  1. **元信息与文本抓取**（`fetch_x_post_payload()`）：优先请求公开轻量元数据通道（如 `api.fxtwitter.com` / X Syndication API `cdn.syndication.twimg.com/tweet-result`，走同一代理与严格超时）；若遇受限且用户已配 Cookie，则回退带 Cookie 请求。返回结构化字段：`tweet_id`、`author`、`text`、`quoted_tweet`、`article_text`、`media_type`（`video` / `audio` / `text_image`）、`images`（原图 URL 列表）、`has_video`。
  2. **有音视频流时**：
     - `download()` 用 `yt-dlp` 提取最佳音轨（`bestaudio[ext=m4a]/bestaudio/best`）与元数据；支持 `download_video()` 供自动截图与本地悬浮播放器回看；
     - 将推文正文与引用推文内容写入 `AudioDownloadResult.raw_info["post_context"]`，在总结阶段作为背景补充注入，避免「原视频只有演示画面/BGM、核心说明写在推文里」导致信息丢失。
  3. **无音视频流（纯图文 / X 长文）时**：
     - **文本直出**：`download_subtitles()` / 文本直出分支将推文正文（+ 引用推文 + X Article 正文 + 配图索引说明）按段落组装为 `TranscriptResult`（`duration=0`、合理分段），并在 `AudioDownloadResult.raw_info` 标记 `media_kind="text_post"`；
     - **配图本地化**：通过同一代理下载推文配图（单篇上限默认 `6` 张、单张超时与体积校验，防墙外图链失效），落盘至 `IMAGE_OUTPUT_DIR`（`static/screenshots/x_<tweet_id>_<idx>.<ext>`），生成站内永久相对链接 `/static/screenshots/x_<tweet_id>_<idx>.<ext>`；
     - **视觉理解与插图复用**：
       - 当用户开启「视觉理解（`video_understanding`）」时，将本地配图编码压缩为 Data URL 直接复用注入 `self.video_img_urls` 传给多模态总结模型（无需走 FFmpeg 视频抽帧）；
       - 当开启「自动配图（`screenshot`）」时，将本地化配图作为结构化笔记 `image` 块或图文附录安全插入（不再触发 FFmpeg 视频截图报错），确保无 FFmpeg 环境下纯图文 X 笔记同样可带图生成。

### 3. 阅读页回看与外链映射
- **时间戳与来源链接**（[note_helper.py](../../backend/app/utils/note_helper.py)）：`prepend_source_link()` 写入规范化 `https://x.com/<user>/status/<id>`；`replace_content_markers()` 为 `platform == "x"` 生成原推文外链 `[原片 @ MM:SS](https://x.com/i/status/<id>)`。
- **悬浮播放器策略**（[mediaTranscriptSync.ts](../../BillNote_frontend/src/utils/mediaTranscriptSync.ts)）：
  - X 官方 iframe 嵌入存在登录墙、反爬限制且不支持秒级 `t=` 精准跳转；
  - 因此约定：**本地已缓存/下载的视频推文 → 直接走本地媒体流 + 单实体卷帘悬浮播放器回看**；未下载视频或纯图文推文 → 点击来源按钮直接系统浏览器打开原推文。

---

## 四、逐文件改动清单（Phase 1）

### 后端（`backend/`）
1. `backend/app/utils/url_parser.py`
   - `_TRACKING_PARAM_EXACT` 新增 `s`、`t`、`ref_src`、`ref_url`、`src`（仅针对 X 链接，避免误伤 YouTube `t=` 参数！）；
   - `detect_video_platform()` 识别 `x.com`、`twitter.com`、`mobile.twitter.com`、`fxtwitter.com`、`vxtwitter.com`、`fixupx.com`、`t.co`（短链按需解析）；
   - `extract_video_id(url, "x")` 提取 `status/<id>`、`article/<id>`、`broadcasts/<id>`、`spaces/<id>`；
   - `normalize_video_url()` 统一规范化为 `https://x.com/<user>/status/<id>`（或对应标准路径）。
2. `backend/app/validators/video_url_validator.py`
   - `SUPPORTED_PLATFORMS["x"]` 覆盖 `x.com` / `twitter.com` / 常见镜像域名的 `status`、`article`、`i/status`、`i/broadcasts`、`i/spaces` 与 `t.co` 短链。
3. `backend/app/downloaders/x_downloader.py`（新增）
   - 实现 `XDownloader(Downloader)`、`fetch_x_post_payload()`、Cookie 串转临时 Netscape cookiefile 工具、代理注入、`download()`、`download_video()`、`download_subtitles()`（含无视频自动降级为正文直出）。
4. `backend/app/services/constant.py`
   - `_PLATFORM_FACTORIES` 注册 `"x": ("app.downloaders.x_downloader", "XDownloader")`。
5. `backend/app/services/note.py` & `backend/app/utils/note_helper.py`
   - 兼容 `media_kind="text_post"`（纯图文/长文跳过视频截图与音频文件强校验）与 `raw_info["post_context"]` 融合；
   - `replace_content_markers()` 增加 `platform == "x"` 分支。
6. `backend/tests/test_x_platform.py`（新增）
   - 覆盖 URL 校验/清洗/ID 提取、YouTube `t=` 不受影响回归、Cookie 转 Netscape 格式、视频推文/纯图文推文/X 长文/代理超时/登录墙报错全场景单元测试。

### 前端（`BillNote_frontend/`）
1. `BillNote_frontend/src/components/Icons/platform.tsx`
   - 新增 `XLogo` 极简矢量图标（自动适配浅/深色 `currentColor`）。
2. `BillNote_frontend/src/constant/note.ts`
   - `videoPlatforms` 增加 `{ label: 'X (Twitter)', value: 'x', logo: XLogo }`（自动接入「设置 → 视频下载 → 平台凭据」）。
3. `BillNote_frontend/src/pages/HomePage/components/NoteForm.tsx`
   - `platforms`、`platformLabels`、`inferPlatform()` 补齐 X 识别；
   - 清洗 X 专属追踪参数（`s`、`t`、`ref_src`、`ref_url`）同时保留 YouTube 的 `t=`；
   - 识别到 X 链接时自动切至 `X (Twitter)`，不增加冗余常驻解释文字。
4. `BillNote_frontend/src/types/structuredNote.ts` & `BillNote_frontend/src/dev/previewMock.ts`
   - 同步平台类型枚举并在隔离交互预览中提供 X 视频/图文模拟样例。

### 构建与打包（`tools/`）
- `tools/build_editions.py`：`hidden` 增加 `app.downloaders.x_downloader`（零新增外部二进制或受限许可依赖，公开安装包与本地版均可直接支持）。

---

## 五、分阶段验收标准

1. **静态与单元测试**：
   - `pytest backend/tests/test_x_platform.py` + `test_url_normalize.py` + `test_video_url_support.py` 全部通过；
   - 前端 `tsc --noEmit`、`pnpm test:release`（含首屏包体积预算 `<= 1350 KB`）全部通过。
2. **隔离环境真实业务流程验收**（独立端口与数据目录，不触碰 `E:\AI-Tools\BiliNote`）：
   - 实测 1 条公开 X **视频推文**：验证代理拉流 → 音轨下载/转写 → 结构化笔记落盘 → 阅读页本地悬浮播放器回看；
   - 实测 1 条公开 X **纯图文 / 长文推文**：验证无视频自动降级 → 跳过下载与转写 → 直出结构化笔记与来源链接跳转；
   - 实测 1 条无效/受限 X 链接：验证返回清晰下一步提示（代理/Cookie 指引）且任务状态收敛为可诊断 `FAILED`。

---

## 六、已确认决策（2026-11-22 拍板定稿）

1. **Phase 1 支持范围**：同步覆盖 **视频推文 / Broadcast / Spaces + 纯图文推文 / X Article 长文**。
2. **推文配图处理**：自动通过代理下载配图至本地静态目录（`/static/screenshots/x_<id>_<idx>.*`），永久防裂图；支持笔记自动插图，且在开启视觉理解时复用 `video_img_urls` 传给多模态模型一起总结（全程不依赖 FFmpeg）。
3. **Thread 串推与批量导入节奏**：Phase 1 聚焦**单条推文 / 长文**全链路高质量闭环；同作者 Thread 串推自动拼接与书签/列表批量导入作为 Phase 2 增量迭代。

## 七、分步实施顺序（开工路线图）

1. **Step 1（URL 识别与校验底座）**：改造 `url_parser.py`、`video_url_validator.py`、`note_helper.py`，补齐 X 域名/短链/追踪参数清洗（保护 YouTube `t=`），写首批单测。
2. **Step 2（`XDownloader` 双通道提取器 + 配图本地化）**：新增 `backend/app/downloaders/x_downloader.py` 并懒加载注册进 `constant.py`（含代理透传、Cookie 转临时 Netscape 文件、视频推文 `yt-dlp`、纯图文/长文元数据降级与配图落盘）。
3. **Step 3（`note.py` 管线融合）**：接入 `media_kind="text_post"` 跳过音频/FFmpeg 截图、`post_context` 背景注入、本地配图接入 `video_img_urls` 视觉理解与笔记插图。
4. **Step 4（前端识别、图标、Cookie 设置与预览 Mock）**：新增 `XLogo`，接入 `constant/note.ts`、`NoteForm.tsx`、`structuredNote.ts`、`previewMock.ts` 与 `tools/build_editions.py`。
5. **Step 5（全量测试与隔离环境真实流程验收）**：运行 `pytest` + 前端 `tsc / test:release / bundle-budget`，在隔离端口实测真实 X 视频推文与纯图文推文生成闭环。
