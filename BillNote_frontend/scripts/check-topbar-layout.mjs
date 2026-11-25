import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(root, 'src')

const browserCandidates = [
  process.env.EDGE_PATH,
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean)

const browserPath = browserCandidates.find(candidate => existsSync(candidate))
if (!browserPath) {
  throw new Error('未找到可用的本地 Edge/Chrome 浏览器，无法运行顶栏几何布局检查')
}

const css = [
  'layouts/workspace.css',
  'layouts/topbar.css',
  'components/interface.css',
]
  .map(file => readFileSync(path.join(srcDir, file), 'utf8'))
  .join('\n')

const reset = `*{box-sizing:border-box}html,body{margin:0}body{line-height:1.5}
button{appearance:none;border:0;padding:0;margin:0;background:transparent;color:inherit;font:inherit}#root{overflow:hidden}
.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.shrink-0{flex-shrink:0}
.utility-select{display:flex;align-items:center;justify-content:space-between;border:1px solid transparent;white-space:nowrap}
.utility-badge{display:inline-flex;align-items:center;width:fit-content;flex-shrink:0;border:1px solid #aaa;border-radius:6px;font-size:12px;font-weight:500;padding:2px 8px}
.utility-count{display:inline-flex;align-items:center;justify-content:center;min-width:16px;margin-left:2px;padding:0 4px;font-size:10px;font-weight:600;line-height:15px;font-variant-numeric:tabular-nums}
svg{width:16px;height:16px;flex-shrink:0}`

const cases = {
  'first-failed': { failed: true },
  'first-failed-cancelled': { failed: true, cancelled: true },
  running: { running: true },
  'success-multi': { reader: true, multi: true },
  'failed-single': { reader: true, failed: true },
  'failed-multi': { reader: true, multi: true, failed: true },
  'failed-multi-archived': { reader: true, multi: true, failed: true, archived: true },
  'failed-multi-map': { multi: true, failed: true, map: true },
  'failed-multi-running': { reader: true, multi: true, running: true },
}

const icon = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="currentColor"/></svg>'
const title = '这是用于验证长标题截断和顶栏各组按钮边界的示例笔记标题，一直延伸到允许的最大宽度'
const button = (label, extra = '', disabled = false) =>
  `<button data-control="${label || 'display'}" ${disabled ? 'disabled' : ''} aria-label="${label || '阅读显示'}" class="workspace-topbar-btn">${icon}${label ? `<span class="topbar-btn-label">${label}</span>` : ''}${extra}</button>`

function buildHtml(config, sidebar, font) {
  const { reader, multi, failed, cancelled, archived, map, running } = config
  const hasAnyReadable = Boolean(reader || map || multi)
  const showCompactPill = hasAnyReadable && Boolean(failed || running)
  const pillHtml = !showCompactPill
    ? ''
    : failed
      ? `<button type="button" data-control="status-pill" class="workspace-topbar-status-pill is-failed" aria-label="${cancelled ? '已取消生成，诊断与恢复' : '本次生成未完成，诊断与恢复'}">${icon}<span class="topbar-pill-label"><span class="topbar-pill-extra">${cancelled ? '已取消 · ' : '生成未完成 · '}</span><span>恢复</span></span></button>`
      : `<button type="button" data-control="status-pill" class="workspace-topbar-status-pill is-running" aria-label="正在后台重新生成，查看进度与详情">${icon}<span class="topbar-pill-label">生成中…</span></button>`

  const readerControls = reader
    ? `${button('目录')}${button('')}<span class="reader-progress">100%</span>`
    : ''
  const primary = `<div role="group" class="workspace-topbar-group">
    ${button(map ? '正文' : '思维导图', '', !hasAnyReadable)}
    ${button('原文参照', '', !hasAnyReadable)}
    ${button('AI 问答', '', !hasAnyReadable)}
    ${button('复习库', '<span class="utility-count">99+</span>')}
    ${button('生成设置')}
  </div>`

  return `<!doctype html><meta charset="utf-8"><html lang="zh-CN" data-reduced-motion="true"><style>${reset}\n${css}\n.workspace{--ui-font-size:${font}px}</style><body><div id="root"><div class="workspace ${sidebar ? '' : 'workspace--collapsed'}">
    <nav class="workspace-rail"></nav><aside class="workspace-sidebar"></aside><main class="workspace-main"><header class="workspace-topbar" data-mode="read">
    <div class="workspace-tab"><span class="workspace-tab-label is-inactive">新建笔记</span><span class="workspace-tab-label is-active">${title}</span></div>
    <div class="workspace-topbar-left">${archived ? '<span data-control="archived" class="utility-badge shrink-0">已归档</span>' : ''}${multi ? `<button data-control="version" class="note-version-trigger utility-select" data-slot="select-trigger"><span class="truncate">版本 12 · 2024-11-25 21:30</span>${icon}</button>` : ''}<div class="workspace-topbar-status">${reader ? `<button data-control="status" class="reader-status-choice choice-trigger utility-select" data-slot="select-trigger"><span data-slot="select-value">阅读中</span>${icon}</button>` : ''}</div>${pillHtml}</div>
    <div class="workspace-topbar-right"><div role="toolbar" class="workspace-topbar-toolbar"><div class="workspace-topbar-group" ${reader ? '' : 'hidden'}>${readerControls}</div>${primary}</div></div>
  </header></main></div></div>`
}

const matrix = []
for (const [state, config] of Object.entries(cases)) {
  for (const sidebar of [true, false]) {
    for (const font of [14, 20]) {
      matrix.push([state, sidebar, font, buildHtml(config, sidebar, font)])
    }
  }
}

const widths = [760, 761, 800, 880, 881, 900, 950, 960, 1000, 1001, 1020, 1100, 1120, 1150, 1160, 1200, 1240, 1280, 1320, 1400, 1440]

const probeScript = `
const table = [];
const all = ${JSON.stringify(matrix).replaceAll('</script', '<\\/script')};
const widths = ${JSON.stringify(widths)};
for (const [state, sidebar, font, html] of all) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'border:0;height:140px;display:block';
  document.body.append(frame);
  const doc = frame.contentDocument;
  doc.open(); doc.write(html); doc.close();
  const header = doc.querySelector('header');
  const titleEl = doc.querySelector('.workspace-tab');
  for (const width of widths) {
    frame.width = width;
    const h = header.getBoundingClientRect();
    const t = titleEl.getBoundingClientRect();
    const cs = frame.contentWindow.getComputedStyle(header);
    const query = Math.round(h.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    const hit = [];
    const visibleControls = [];
    for (const ctl of doc.querySelectorAll('[data-control]')) {
      const rects = ctl.getClientRects();
      if (!rects.length) {
        hit.push('hidden:' + ctl.dataset.control);
        continue;
      }
      const b = ctl.getBoundingClientRect();
      if (b.width < 12 || b.height < 12) hit.push('collapsed:' + ctl.dataset.control);
      if (b.left < h.left - 1 || b.right > h.right + 1 || b.top < h.top - 1 || b.bottom > h.bottom + 1) {
        hit.push('clip:' + ctl.dataset.control);
      }
      visibleControls.push({ name: ctl.dataset.control, b });
    }
    const boxes = [{ name: 'title', b: t }, ...visibleControls];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].b;
        const b = boxes[j].b;
        const overlapX = a.left < b.right - 0.8 && b.left < a.right - 0.8;
        const overlapY = a.top < b.bottom - 0.8 && b.top < a.bottom - 0.8;
        if (overlapX && overlapY) {
          hit.push('overlap:' + boxes[i].name + '+' + boxes[j].name);
        }
      }
    }
    table.push([state, sidebar, font, width, query, Math.round(h.height), hit.join(',')]);
  }
  frame.remove();
}
document.body.replaceChildren(Object.assign(document.createElement('pre'), { id: 'topbar-layout-result', textContent: JSON.stringify(table) }));
`

const dir = mkdtempSync(path.join(tmpdir(), 'bilinote-topbar-layout-'))
try {
  const htmlPath = path.join(dir, 'probe.html')
  writeFileSync(
    htmlPath,
    `<!doctype html><meta charset="utf-8"><body><script>${probeScript}</script></body>`,
  )

  const proc = spawn(
    browserPath,
    [
      '--headless',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${path.join(dir, 'profile')}`,
      '--dump-dom',
      pathToFileURL(htmlPath).href,
    ],
    { windowsHide: true },
  )

  let out = ''
  let err = ''
  proc.stdout.setEncoding('utf8').on('data', chunk => { out += chunk })
  proc.stderr.setEncoding('utf8').on('data', chunk => { err += chunk })

  const code = await new Promise((resolve, reject) => {
    proc.on('close', resolve)
    proc.on('error', reject)
  })

  const match = out.match(/<pre id="topbar-layout-result">([\s\S]*?)<\/pre>/)
  if (code || !match) {
    throw new Error(`Topbar layout probe failed (exit ${code}): ${err.slice(-2000)}\n${out.slice(-1600)}`)
  }

  const decoded = match[1]
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
  const rows = JSON.parse(decoded)
  const failures = rows.filter(row => row[6])

  if (failures.length > 0) {
    console.error(`Topbar layout violations (${failures.length}/${rows.length}):`)
    for (const item of failures.slice(0, 30)) {
      console.error(`  state=${item[0]} sidebar=${item[1]} font=${item[2]}px win=${item[3]}px query=${item[4]}px h=${item[5]}px issues=${item[6]}`)
    }
    throw new Error(`Topbar layout check failed with ${failures.length} violations`)
  }

  console.log(`PASS: topbar-layout (${rows.length} matrix cases, 0 clip/overlap/hidden violations)`)
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 })
}
