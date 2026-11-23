---
trigger: always_on
description: BiliNote Studio UI/UX 设计指导规范（融合 Apple HIG 视觉工艺与 Codex 桌面工作台交互范式）
---

# BiliNote Studio UI/UX 设计指导规范（Apple HIG × Codex 交互范式）

> 本规范是 BiliNote Studio 前端与桌面端界面开发的长期基准（**Codex 负责整体空间布局与克制细小设计，Apple HIG 负责高透毛玻璃材质与物理弹簧微交互**）。任何新增界面、阅读器增强、工作台布局调整或组件改造，均须遵循本规范中的视觉工艺红线、交互范式与设计 Token 映射约定。
> 仓库内同步留存一份说明文档：[docs/ui-design-guide.md](../../docs/ui-design-guide.md)。

---

## 一、Apple HIG 核心设计哲学与工艺红线

### 1. 设计原则落地（含八大原则核心实践）
围绕 Apple Human Interface Guidelines（Clarity、Deference、Depth、Consistency 及 Purpose、Simplicity、Agency、Familiarity、Craft、Delight）在桌面知识工作台中的落地要求：

- **Purpose（目的明确）与 Simplicity（极简去噪）**：
  - 主阅读画布仅保留高信噪比的核心结论、二维对比表与单行因果链（`A → B → C`），隐藏一切装饰性冗余标签与背景长文。
  - 遵循仓库 `AGENTS.md` 文案精简原则：能用清晰名称表达的不再附加解释，常驻说明仅保留完成当前操作所必需的一句短话。
- **Agency（用户掌控）与 Familiarity（直觉熟悉）**：
  - 遵循 macOS / Windows 原生桌面端交互直觉：支持完整的键盘操作与 `:focus-visible` 焦点环、点击外部空白处自动收起浮层与胶囊、明确的悬停/激活/禁用/判题状态反馈。
  - 尊重用户的动态效果偏好（`prefers-reduced-motion: reduce` 与 `html[data-reduced-motion="true"]`）。
- **Craft（极致工艺）与 Delight（克制愉悦）**：
  - 注重 `1px`（及高分屏 `0.75px` / `0.5px`）顶部内高光与发丝级边框。
  - 图标保持发丝级精细比例：如关闭按钮采用细圆环包细 `×` 线（原型 `0.72px` 圆环配 `1.15px` 细 `×`；生产组件 `HairlineCloseIcon` 为 `0.75` 圆环配 `1.18` 细 `×`）。
  - 句末批注锚点采用 `1:1` 正圆羽化柔光锚点（`aspect-ratio: 1 / 1`、`radial-gradient(..., transparent 74%)` 柔光晕及浅/深色毛玻璃圆片触发器）与自然弹簧阻尼动效，克制表达交互愉悦感。

### 2. 高透半透明毛玻璃材质（Materials & Depth）
- **统一毛玻璃配方**：
  - 浮窗、悬停预览气泡与展开自测胶囊统一采用苹果风半透明磨砂材质：原型配方为 `backdrop-filter: blur(16px) saturate(190%)`（`WebKit` 同步前缀 `-webkit-backdrop-filter`）+ `54%~62%` 半透明渐变底 + 顶部 `1px` 内高光（`inset 0 1px 0 rgba(255, 255, 255, 0.45)`）+ `22px` 大圆角（生产态在 `.structured-note-shell` 内浅色进一步提透至 `34%~44%`、随字号按 `em` 缩放圆角如 `1.15em` / `1.2em`；全局弹层与菜单统一引用 `accent.css` 中 `48%~70%` 半透明梯度的 `--glass-bg`、`--glass-bg-strong`、`--glass-blur`、`--glass-border`、`--glass-highlight`、`--glass-shadow`）。
  - 必须通过底层文字的柔和磨砂折射建立空间层级，**严禁叠成不透明白块/黑块硬遮挡**。
- **Chromium / WebView2 合成组避坑红线**：
  - 固定占位外层容器（如 `.quiz-anchor-slot`）**严禁设置 `z-index`**。
  - 动态膨胀浮层（如 `.morph-quiz`）**严禁添加 `will-change: width, height`**。
  - 原因：防止 Chromium / Tauri WebView2 创建隔离合成组（Isolated Stacking/Compositing Context），导致 `backdrop-filter` 无法采样下方兄弟章节文字而退化为纯色假玻璃。

### 3. 物理阻尼动效与零排版跳动（Zero Layout Shift）
- **Apple 弹簧阻尼曲线**：
  - 胶囊/浮层展开与收起动画统一采用 Apple 阻尼曲线 `cubic-bezier(0.32, 0.72, 0, 1)`（约 `0.4s`，如宽高/圆角 `0.44s`、解析展开 `0.4s`，对应全局 Token `--ease-spring`）；轻量微交互采用 `--ease-apple: cubic-bezier(0.22, 1, 0.36, 1)`。
- **零排版挤压跳动方案**：
  - 所有交互式详注浮窗与自测胶囊均采用**固定占位槽 + 原位绝对定位膨胀（`position: absolute; top: 0; left: 0; transform-origin: top left`）**方案。
  - 展开时从左上角原点向右、向下丝滑推开，覆盖下方局部区域（配合毛玻璃折射），对下方正文与表格实现 **0 像素排版挤压跳动**。

### 4. 全界面动态强调色与深浅色自适应
- **动态强调色派生**：
  - 所有高亮底纹（`.emp-hl`）、重点实线下划线（`.emp-ul`）、波浪线（`.emp-wave`）、时间点胶囊（`.ts-pill` / `.ts-pill-group`）与状态圆标（`.anno-dot` / `.bubble-dot`）均通过 `color-mix(in srgb, var(--app-accent) ...)`（或生产态 `color-mix(in oklab, var(--app-accent) ...)`）动态跟随当前主题强调色（`--reading-accent` / `--primary`）。
- **深浅色与语义 Token 红线**：
  - 原型采用 CSS `light-dark(...)` 自适应；生产环境考虑 Tauri WebView2 / 主题切换一致性，通过 `html[data-accent]`（浅色）与 `html.dark[data-accent]` / `.dark .structured-note-shell`（深色）双态 Token 同步映射。
  - **严禁写死固定红色波浪线**（波浪线必须使用 `--app-accent-wave` 跟随强调色）。
  - **严禁局部缺失语义 Token**：所有包含判题、状态指示的组件作用域必须完整声明 `--ui-ok`、`--ui-err`、`--ui-err-soft` 等语义变量，防止回退失败。

---

## 二、Codex 桌面客户端交互范式借鉴

### 1. 高专注度三栏工作台与分栏防挤压保护
- **清晰的工作台分区**：
  - 借鉴 Codex 桌面端布局：左侧导航与项目/大纲区（`workspace-rail` + 可折叠 `workspace-sidebar` + 阅读页大纲 `reading-navigation`）+ 中间高信噪比主阅读画布（`workspace-main` / `reading-chat-layout-reader`）+ 右侧按需对话助手（`reading-chat-layout-chat`，支持关闭 / 并排 / 全屏切换与 `reading-chat-layout-handle` 拖拽调节）。
- **表格分区防挤压保护**：
  - 在多栏并排导致主阅读区变窄时，结构化表格严格执行分区防挤压策略：
    - 对象/参数名、行内代码胶囊（`.code-pill`）、数值+单位（`.nowrap-cell` / `.unit-nowrap`）强制 `white-space: nowrap` 不断裂；
    - 中文说明列（`.wrap-cell`）设 `min-width: 150px~180px`（`structured-note.css` 中按 `em` 设为 `min-width: 10em`）自然折行；
    - 外层包裹 `.note-table-wrap`（`overflow-x: auto`）平滑横向滚动兜底，绝不撑破主栏宽度。

### 2. 上下文锚定批注与零成本局部追问（Context-Anchored Refinement）
- **所见即所得元素批注与内联追问**：
  - 借鉴 Codex 的「元素批注（Annotate）」与「内联审查（Inline Comments）」交互哲学，让用户无需手动复制大段文本或截图描述即可精准追问：
    - **句末柔光批注锚点**：原型 `19×19px` 正圆锚点（生产态 `--anno-size: 1.14em`，`0.5cap` 光学对齐），悬停出现单行 `.hover-bubble` 预览气泡，点击展开 `.apple-popover` 毛玻璃详注卡片，并支持点击正文左右两侧空白快速收起（不保留旧版右侧页边栏 `.margin-rail`）。
    - **划词引用**：正文划词后可直接作为紧凑引用胶囊注入聊天上下文（`ReadingSelection`）。
    - **自测题一键追问**：展开自测胶囊底部的「去问助手」（`.ask-pill` / `onAskAssistant`）按钮，自动将 **【题干 + 用户误选项 + 正确解析 + 当前章节正文 + 原片时间戳】** 一键打包注入右侧助手输入框。

### 3. 渐进披露与主动自测闭环（Progressive Disclosure & Active Recall）
- **默认折叠轻量胶囊**：
  - 借鉴 Sensecape 多层信息探索与 NoteIt / NoTeeline 交互笔记研究：默认只展示精干主干；重难点详情（底层原理 `why` / 原片实测案例 `case` / 高频避坑细节 `pit`）与核心章节末尾的实战自测题默认折叠为轻量胶囊。
  - **前置图标位动态收缩**：未作答时前置状态圆标（`.mini-dot`）自动收缩为 `width: 0; margin-right: 0; opacity: 0`，题干提示文字顶格左对齐；作答后平滑展开为绿色对勾或红色叉号状态圆标（`.mini-dot.is-pass` / `.mini-dot.is-fail`）。
- **三级判题视觉层次**：
  - 用户作答后立即锁定选项并平滑展开解析区（`.quiz-answer-wrap.is-open`），选项严格呈现三级视觉区分：
    1. **正确答案**：淡强调色铺底（`.is-answer-right`，`color-mix(..., var(--app-accent) 18%, transparent)`）；
    2. **用户误选项**：柔红底纹 + 标叉（`.is-picked-wrong`，`--ui-err-soft` + `--ui-err`）；
    3. **未选干扰项**：置灰 + 删除线弱化（`.is-crossed-out`，`opacity: 0.38` + `text-decoration: line-through`）。

---

## 三、现有设计基线与 Token 映射清单

进行 UI 改造前，优先复用以下已有文件与设计能力（不要重复造轮子或另起冲突变量）：

### 1. 设计技能与参考原型
- **Impeccable 设计 Skill**：已安装于用户全局配置 `C:\Users\Administrator\.gemini\config\skills\impeccable\SKILL.md`（仓库内 `.agent/skills/` 暂无独立副本），进行界面审校、视觉打磨与可访问性检查时可按需调用。
- **高透毛玻璃原位胶囊参考样板**：`G:\我的云端硬盘\Agy-Handoff\BiliNote-Studio\ui-reference-prototype.html`（完整展示了 `light-dark()`、`color-mix(in srgb, ...)`、`19×19px` `.anno-dot` 柔光锚点、`.hover-bubble`、`.apple-popover`、`0.72px/1.15px` `.close-circle`、`.morph-quiz` 原位膨胀及 `.clean-table` 防挤压参考实现）。

### 2. 项目前端样式文件与 CSS 变量映射

| 领域 | 仓库文件路径 | 核心 Token / 类名与落地说明 |
| --- | --- | --- |
| **全局强调色与毛玻璃底座** | `BillNote_frontend/src/accent.css` | 定义 9 组 `data-accent`（`blue` / `slate` / `indigo` / `custom` / `violet` / `green` / `teal` / `orange` / `rose`）；通过 `html[data-accent]` 与 `html.dark[data-accent]` 映射 `--primary`、`--reading-accent`、`--reading-spot`、`--surface-*`、`--glass-bg`、`--glass-bg-strong`、`--glass-blur`、`--glass-border`、`--glass-highlight`、`--glass-shadow`、`--ease-apple`、`--ease-spring` |
| **基础语义与 Tailwind v4 主题** | `BillNote_frontend/src/index.css` | 定义 `:root` / `.dark` 与 `@theme inline` 基础变量（`--background`、`--foreground`、`--card`、`--popover`、`--muted`、`--accent`、`--destructive`、`--border`、`--ring`、`--sidebar*`） |
| **Codex 三栏工作台外壳** | `BillNote_frontend/src/layouts/workspace.css` | `.workspace`、`.workspace-rail`、`.workspace-sidebar`、`.workspace-main`、`.workspace-topbar`、`.workspace-composer` |
| **阅读导航与并排聊天布局** | `BillNote_frontend/src/pages/HomePage/components/reader.css`<br>`BillNote_frontend/src/pages/HomePage/components/reading-chat-layout.css` | `.reading-navigation`、`.reading-outline-shell`、`.reading-outline-rail-preview`（复用 `--glass-*`）、`.reading-chat-layout`、`.reading-chat-layout-reader`、`.reading-chat-layout-handle`、`.reading-chat-layout-chat` |
| **结构化阅读与胶囊核心实现** | `BillNote_frontend/src/pages/HomePage/components/StructuredNoteReader/structured-note.css`<br>`StructuredNoteReader.tsx` / `MorphingQuizCapsule.tsx` / `AnnotationIcons.tsx` | `.structured-note-shell` 内派生 `--app-accent`（继承 `--reading-accent`）、`--app-accent-spot`、`--app-accent-soft`、`--app-accent-mid`、`--app-accent-wave`、`--ui-bg`、`--ui-dim`、`--ui-ink`、`--ui-muted`、`--ui-ok`、`--ui-err`、`--ui-err-soft`、`--ui-mono`；实现 `.glass-surface`、`.anno-dot`、`.hover-bubble`、`.apple-popover`、`.note-table-wrap`、`.clean-table`、`.nowrap-cell`、`.wrap-cell`、`.flow-chain`、`.quiz-anchor-slot`、`.morph-quiz`、`.ask-pill` |
| **结构化笔记数据契约** | `BillNote_frontend/src/types/structuredNote.ts` | `StructuredNoteDocument`、`StructuredSection`、`StructuredAnnotation`（`why` / `case` / `pit`）、`StructuredQuiz`、`InlineSpan`（`plain` / `hl` / `ul` / `wave` / `code`）、`ColumnWrapMode`（`nowrap` / `wrap`） |

### 3. 原型与生产样式的衔接注意点
1. **颜色空间与深浅模式写法**：参考样板使用 `light-dark(...)` 与 `color-mix(in srgb, ...)`；生产代码在 `accent.css` 中统一通过 `html[data-accent]` / `html.dark[data-accent]`（及 `.dark .structured-note-shell`）切换浅/深色值，并在 `structured-note.css` 中使用 `color-mix(in oklab, ...)`（与 `accent.css` 的 `color-mix(in srgb, ...)` 共同遵循动态强调色派生原则）。新增组件时必须接入 `--reading-accent` / `--primary` 与 `--glass-*` / `--ui-*` 变量，不得硬编码十六进制色值。
2. **字号自适应**：主阅读区内组件优先使用相对字号 `em`（参考 `structured-note.css`），确保用户切换阅读字号档位时，`.anno-dot`、`.ts-pill-group`、`.morph-quiz` 与表格说明列能够等比协调缩放。
