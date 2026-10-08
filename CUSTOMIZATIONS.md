# BiliNote Studio · 二次开发升级总览

整理日期：2026-10-08。本文描述当前源码与已交付能力，不等于公开发行公告。

BiliNote Studio 基于 **JefferyHcool/BiliNote v2.4.5**，本地基线提交为 `be3889395afb5346aa4339ae933d3ba2e08f25a8`。保留原项目名称中的 BiliNote、上游历史、MIT 许可证和 Jeffery Huang 的版权声明，属于独立维护的二次开发版本，不是上游官方版本。

项目名称已确定为 **BiliNote Studio**，拟用仓库名 `BiliNote-Studio`。最新本地正式版本是 `2.4.5-ai.6`；这是已有本地版本序列，尚未定义 Studio 首个公开发布版本。当前文档先采用新名称，桌面产品名、程序标识、数据目录与安装入口尚未迁移。

## 一、升级定位与原版边界

保留原版“视频来源 → 下载/字幕或音频转写 → 模型总结 → Markdown、截图、脑图”的主流程，升级重点是生成之后的知识管理、阅读、引用问答与可确认的整理操作。

| 范围 | 归属 |
| --- | --- |
| 多平台视频与本地视频、转写器、模型服务商、Markdown、截图、脑图、导出 | 上游已有基础能力，本版保留并修复相关问题 |
| 基础问答/RAG、后端健康检查、桌面 sidecar 生命周期、任务线程池 | 上游已有基础；本版扩展交互与可靠性，不把它们全部记为原创新增 |
| 逻辑文件夹、学习信息、阅读工作台、引用式聊天、持久整理会话、分用途模型、阅读协议与上下文压缩 | 二创新增或实质扩展的重点 |
| Codex 风格配色、两档文字、精简启动页、紧凑输入区与统一工具栏 | 本版交互设计与后续迭代 |

任务线程池并发实现不属于本轮新增；基础能力的存在也不代表所有平台、模型或运行环境均已验证。

## 二、笔记存储与生命周期

- 从零散结果文件扩展为按任务 ID 管理的教程目录：Markdown、配图、版本与元数据分别保存；兼容旧平铺结果读取。
- 正常笔记与归档区分离；归档仍可阅读正文、历史版本和图片，支持恢复。
- 手动永久删除仅面向已归档、已终态的笔记，限制到任务专属数据；旧入口不能绕过限制。
- 旧浏览器记录导入以服务端状态为准，删除标记防止历史缓存把已删除记录重新导入。
- 抽帧、拼图和截图使用任务/运行级临时目录；成功后清理自己的临时文件，失败保留诊断。重启后识别中断任务。
- 提供旧数据清点和隔离副本迁移演练；不能据此承诺任意旧库直接升级均无损。

源码：[note_storage.py](backend/app/services/note_storage.py)、[笔记路由](backend/app/routers/note.py)、[迁移工具](backend/tools/legacy_migration.py)。

原版共享截图目录、前端历史版本与当前兼容限制另见（内部历史记录未随公开源码分发）。物理资源归档与应用内逻辑分类是两件事；现有复制演练不等于完整一键迁移。

## 三、文件夹与学习型笔记库

- 新建、重命名、删除逻辑文件夹；单篇与批量移动。逻辑分类不移动或改写教程正文、图片与磁盘目录。
- 默认文件夹受保护；删除自定义文件夹时笔记回默认归属，归档状态与分类独立。
- 收藏、置顶、标签、备注、组合搜索、筛选、排序与批量学习状态操作。
- 学习状态分为待读、阅读中、已读完。打开页面不等于读完；滚动开始阅读，完成需用户确认，重开不会覆盖已完成状态。
- 文件夹区域可折叠，笔记采用紧凑行，搜索常驻、筛选按需展开。
- 早期“全部笔记”虚拟入口已移除，旧选择兼容到默认文件夹；不删除实际笔记。

源码：[note_folders.py](backend/app/services/note_folders.py)、[note_library.py](backend/app/services/note_library.py)、[History.tsx](BillNote_frontend/src/pages/HomePage/components/History.tsx)、[libraryStore.ts](BillNote_frontend/src/store/libraryStore.ts)。

## 四、工作区与阅读体验

- 窄导航栏、可折叠笔记侧栏与主内容区替代三栏常驻；新建、阅读、生成设置和独立设置页分工更清楚。
- 记忆阅读/新建侧栏偏好、最近阅读笔记、设置分类与阅读位置；切换页面保留未提交的新建草稿。
- 章节目录、字号、舒适/铺满宽度、专注阅读、回到顶部、进度和继续阅读。
- 正文标题生成唯一导航目标，正文目录与顶部目录统一跳转；旧错误锚点在渲染时修正，不改写原始 Markdown、复制或导出内容。
- 向下阅读时可收起完整工具栏，留下目录、进度与问答；支持手动展开及位置补偿。
- 阅读与思维导图工具栏统一高度、字号选择和目录控件，修复小字号标签裁切。
- 并排问答、原文参照与侧栏支持开合过渡、焦点恢复、窄屏适配和减少动态效果。

源码：[HomeLayout.tsx](BillNote_frontend/src/layouts/HomeLayout.tsx)、[ReaderPane.tsx](BillNote_frontend/src/pages/HomePage/components/ReaderPane.tsx)、[noteOutline.ts](BillNote_frontend/src/utils/noteOutline.ts)、[sidebarTransition.ts](BillNote_frontend/src/utils/sidebarTransition.ts)。

## 五、思维导图增强

- 深浅主题与强调色同步到导图，正文与导图重点文字、行内代码标记保持一致。
- 导图目录可展开祖先节点、居中并高亮目标；内部锚点不再误跳到应用404页面。
- 默认拖动文字即可平移导图；右键可切换文字选择，保留节点圆点的折叠行为。
- 双击以当前位置放大，再次双击恢复放大前的位置与比例；文字选择模式保留双击选词。

源码：[MarkmapComponent.tsx](BillNote_frontend/src/pages/HomePage/components/MarkmapComponent.tsx)、[reader.css](BillNote_frontend/src/pages/HomePage/components/reader.css)、[accent.css](BillNote_frontend/src/accent.css)。

## 六、阅读助手与临时聊天

- 基于当前笔记的常驻问答，支持划词引用、多段引用以及并排/扩展阅读布局。
- 临时聊天与常驻聊天隔离；显式转入时合并消息、引用、附件与草稿，保留适用的模型设置。
- 图片、TXT、Markdown 附件可粘贴、拖入或选择，并可预览、移除；PDF 附件尚不支持。图片理解依赖模型能力。
- 引用保留来源和版本快照；最新引用布局为4列2行、最多8条，可独立移除。
- 输入区集中附件、上下文、模型/思考与发送操作；内容增多时增高，到上限后内部滚动。
- Enter / Ctrl+Enter 两种发送习惯，输入法确认不误发送。
- 阅读与临时聊天默认流式输出，仍可在常规设置切回完整回复；中止保留已接收内容并明确标记。取消本地等待不保证供应商已接收的请求停止计费。
- 慢请求、等待用时、每条回复总耗时、折叠参考与错误详情可见。耗时不等同供应商内部推理时长。
- 空回复、重复工具调用、提前断流与错误都有明确处理；失败保留或恢复问题、附件，不伪造答案或无限重试。

源码：[ChatPanel.tsx](BillNote_frontend/src/pages/HomePage/components/ChatPanel.tsx)、[ReadingSelection.tsx](BillNote_frontend/src/pages/HomePage/components/ReadingSelection.tsx)、[readingAssistantStore.ts](BillNote_frontend/src/store/readingAssistantStore.ts)、[chat_service.py](backend/app/services/chat_service.py)、[reading_stream.py](backend/app/services/reading_stream.py)。

## 七、AI 整理助手与持久会话

- 自然语言查询、讨论、澄清、提出计划、确认执行及撤销；以 LangGraph 和持久会话承接连续交互。
- 范围可限定全部、指定文件夹或选定笔记；实际目标与可检索上限分开，空目标/未知目标不回退成全库操作。
- 允许创建/重命名逻辑文件夹、移动归属、标签、归档和恢复。**整理助手没有永久删除笔记、改正文或任意文件操作权限**；这与手动归档区删除是不同入口。
- 模型只获得允许的笔记元数据，不将正文、备注、凭据或本地文件路径作为整理工具上下文。
- 计划确认绑定会话、版本和计划ID；修改要求使旧审批失效，文字“确认”不会替代计划按钮。
- 取消、重复执行、过期计划、迟到模型结果、并发及中断恢复均有状态约束；撤销不覆盖后来的冲突修改。
- 默认保留最近10个整理会话，可设1–100；清理前展示受影响名单并确认，运行或待恢复会话受保护。
- 同一后端进程可恢复当前会话；新进程默认打开空白会话，历史保留可手动打开；空对话禁止重复新建。
- 整理助手仍展示完整结构化计划，不把阅读聊天的流式输出或三协议选择直接套用到审批流程。
- 当前以单进程/单worker运行约束为基础，不宣称跨数据库崩溃事务的全局原子性；中断恢复与删除标记用于阻止失效审批。

源码：[organizer.py](backend/app/services/organizer.py)、[organizer_sessions.py](backend/app/services/organizer_sessions.py)、（内部历史记录未随公开源码分发）、（内部历史记录未随公开源码分发）、[OrganizerPage](BillNote_frontend/src/pages/OrganizerPage/index.tsx)。

## 八、模型用途、协议与长上下文

- 生成、阅读、整理三种用途分别设置默认 provider/model；会话可临时覆盖，不按同名模型混淆供应商。
- 服务商按实际完整端点区分官方预设、自定义、本地及未配置；官方预设可显式转为自定义编辑，不迁移原凭据。
- 阅读聊天支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages；协议偏好按服务商保存，压缩请求同步协议。
- 视频总结保持原 Chat Completions 路径；生成连接测试不冒充阅读三协议验收。
- 思考档位按模型能力显示和传参，未知模型保持自动；切换模型不携带不兼容档位。
- 当前上下文预算固定为272,000；自动压缩阈值为217,600，支持 `/compact`。保留原始会话，模型摘要只用于后续上下文，不改变整理审批授权。
- 每次实际请求前检查预算；本地token估算与服务商usage区分，不能保证所有模型都支持272K，也不把估算当计费。
- 错误可显示脱敏HTTP状态、业务码、请求ID、时间和协议；超时缺少信息时不虚构错误码，无静默换模型或换协议。

源码：[purposeModelStore.ts](BillNote_frontend/src/store/purposeModelStore.ts)、[providerProfiles.ts](BillNote_frontend/src/utils/providerProfiles.ts)、[protocol_clients.py](backend/app/services/protocol_clients.py)、[context_compaction.py](backend/app/services/context_compaction.py)、[ai_runtime.py](backend/app/services/ai_runtime.py)。

## 九、转写与长视频可靠性

- Groq长音频按实际文件大小切分，成功片段缓存供重试复用，时间戳归并回原音频坐标；避免无约束压缩和转写正文日志输出。
- 修复空转录缓存被误认为有效、跳过转写后总结空列表崩溃；三个缓存入口统一检查有效段落与时间戳。
- 普通截图按总结标记取帧；只有开启视频理解才生成网格并发送视觉输入，避免长视频无意生成大量图像请求。
- 小批尾帧不丢弃，抽帧并发和错误信息改进；FFmpeg/ffprobe定位统一，减少重复健康日志。
- 本地视频不在源文件旁写MP3/封面；保留实际时长与视频路径，缓存恢复仍可生成截图。
- 支持跨小时转写、截图和跳转标记，修复原视频链接替换与任务总结状态归属。
- Groq地址、密钥、开关和转写模型集中在音频转写设置页；音频专用模型从聊天选择中排除。
- 各转写引擎独立保存配置，切换不自动保存；密钥返回掩码、保留原存储，配置提交失败有回退。

源码：[groq.py](backend/app/transcriber/groq.py)、[local_downloader.py](backend/app/downloaders/local_downloader.py)、[note.py](backend/app/services/note.py)、[note_helper.py](backend/app/utils/note_helper.py)、[transcriber_settings.py](backend/app/services/transcriber_settings.py)。

## 十、外观、桌面与启动

- 当前深色主题按用户提供的 Codex 截图取色，替代早期灰蓝及中间暖色方案；保留浅色/跟随系统和8种强调色。
- 普通文字、说明和未选中图标采用 `#CBCBCB`，标题、输入焦点、选中与悬停采用 `#FFFFFF`；语义状态、强调色和亮底按钮反相文字各自保留。
- 阅读工具栏统一淡强调色选中背景，消除AI问答独有的白底；视频理解提示框跟随强调色。
- 首次配置页、启动等待与失败页统一主题；启动页去除多余书本图标和悬浮外观按钮。
- 启动前15秒的失败重试间隔改为500ms，之后2s；保留60s前端等待上限和5s单请求超时。桌面ready事件触发业务健康验证，退出/卸载时清理请求与订阅。
- 非首屏设置页面按需加载，使用统一加载占位；没有取消后端初始化或降低健康判断标准。
- 托盘、关闭隐藏/恢复、打开当前教程目录，以及单实例唤回与启动互斥完善。
- 后端状态入口与日志面板支持健康、筛选、重新检查、重启反馈和脱敏日志，并避让聊天输入区。

源码：[accent.css](BillNote_frontend/src/accent.css)、[BackendInitDialog.tsx](BillNote_frontend/src/components/BackendInitDialog.tsx)、[backendStartup.ts](BillNote_frontend/src/hooks/backendStartup.ts)、[desktop.rs](BillNote_frontend/src-tauri/src/desktop.rs)、[startup_gate.rs](BillNote_frontend/src-tauri/src/startup_gate.rs)、[BackendHealth](BillNote_frontend/src/components/BackendHealth/BackendLogPanel.tsx)。


## 首发范围

首发使用一个 Windows 安装包；PDF 导出不内置，FFmpeg 由用户单独安装。当前验证以 VALIDATION.md 为准。
