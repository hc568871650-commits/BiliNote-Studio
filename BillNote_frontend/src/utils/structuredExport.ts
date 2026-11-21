import {
  buildOriginTimeUrl,
  formatSeconds,
  spansPlainText,
  type AnnotationKind,
  type InlineSpan,
  type StructuredNoteDocument,
} from '../types/structuredNote.ts'

export interface ExportNoteMetadata {
  title?: string
  sourceUrl?: string
  platform?: string
  videoId?: string
  modelName?: string
  createdAt?: string
  tags?: string[]
}

export interface AnkiExportResult {
  content: string
  cardCount: number
}

const KIND_LABELS: Record<AnnotationKind, string> = {
  why: '底层原理',
  case: '原片实测案例',
  pit: '高频避坑细节',
}

const OBSIDIAN_CALLOUTS: Record<AnnotationKind, string> = {
  why: 'tip',
  case: 'example',
  pit: 'warning',
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeYamlScalar(raw: string): string {
  return JSON.stringify((raw || '').replace(/\r?\n/g, ' ').trim())
}

function renderSpansMd(spans: readonly InlineSpan[] | undefined): string {
  if (!Array.isArray(spans)) return ''
  return spans
    .map(span => {
      const t = span.text
      if (!t) return ''
      const emp = span.emphasis
      if (emp === 'hl') return `==${t}==`
      if (emp === 'ul') return `**${t}**`
      if (emp === 'wave') return `**${t}**`
      if (emp === 'code') return `\`${t}\``
      return t
    })
    .join('')
}

function renderSpansHtml(spans: readonly InlineSpan[] | undefined): string {
  if (!Array.isArray(spans)) return ''
  return spans
    .map(span => {
      const safe = escapeHtml(span.text || '')
      if (!safe) return ''
      const emp = span.emphasis
      if (emp === 'hl') return `<mark class="emp-hl">${safe}</mark>`
      if (emp === 'ul') return `<strong class="emp-ul">${safe}</strong>`
      if (emp === 'wave') return `<span class="emp-wave">${safe}</span>`
      if (emp === 'code') return `<code>${safe}</code>`
      return safe
    })
    .join('')
}

function sanitizeAnkiField(raw: string): string {
  // 先转义 HTML 特殊字符，再把制表符归一为空格、换行转为 <br>，确保单卡严格 1 行 3 列
  return escapeHtml(raw || '')
    .replace(/\t+/g, ' ')
    .replace(/\r\n|\r|\n/g, '<br>')
    .trim()
}

function sanitizeAnkiTag(raw: string): string {
  const cleaned = (raw || '')
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_:-]/gu, '')
    .slice(0, 48)
  return cleaned || 'Note'
}

export function renderEnhancedMarkdown(doc: StructuredNoteDocument, titleFallback: string): string {
  const lines: string[] = [`# ${doc.title || titleFallback}`, '']
  for (const section of doc.sections || []) {
    const heading = section.level === 3 ? '###' : '##'
    const ts = (section.time_ranges || []).map(tr => tr.label || formatSeconds(tr.start)).filter(Boolean).join(' · ')
    lines.push(`${heading} ${section.title}${ts ? `（${ts}）` : ''}`, '')

    for (const tk of section.core_takeaways || []) {
      const text = renderSpansMd(tk.spans).trim()
      if (text) lines.push(`- ${text}`)
    }
    if (section.core_takeaways?.length) lines.push('')

    for (const block of section.blocks || []) {
      if (block.type === 'paragraph') {
        lines.push(renderSpansMd(block.spans), '')
      } else if (block.type === 'table') {
        const headers = block.columns || []
        if (headers.length) {
          lines.push(`| ${headers.join(' | ')} |`)
          lines.push(`| ${headers.map(() => '---').join(' | ')} |`)
          for (const row of block.rows || []) {
            lines.push(`| ${row.map(cell => renderSpansMd(cell).replace(/\|/g, '\\|')).join(' | ')} |`)
          }
          lines.push('')
        }
      } else if (block.type === 'flow_chain') {
        const chain = (block.steps || []).map(step => renderSpansMd(step).trim()).filter(Boolean).join(' → ')
        if (chain) lines.push(chain, '')
      } else if (block.type === 'list') {
        ;(block.items || []).forEach((item, idx) => {
          const text = renderSpansMd(item).trim()
          if (text) lines.push(`${block.ordered ? `${idx + 1}.` : '-'} ${text}`)
        })
        if (block.items?.length) lines.push('')
      } else if (block.type === 'checklist') {
        if (block.title) lines.push(`**${block.title}**`, '')
        for (const item of block.items || []) {
          lines.push(`- [${item.checked ? 'x' : ' '}] ${spansPlainText(item.spans)}`)
        }
        lines.push('')
      } else if (block.type === 'code_block') {
        lines.push(`\`\`\`${block.language || ''}`, block.code, '```', '')
      }
    }

    for (const anno of section.annotations || []) {
      const label = KIND_LABELS[anno.kind] || anno.kind
      const tsTag = anno.timestamp_label ? ` [${anno.timestamp_label}]` : ''
      lines.push(`> **${label}${tsTag} · ${anno.short_hint}**：${anno.full_detail}`)
    }
    if (section.annotations?.length) lines.push('')

    if (section.quiz) {
      lines.push(`> **自测题**：${section.quiz.full_question}`)
      for (const opt of section.quiz.options || []) {
        lines.push(`> - ${opt.key}. ${opt.text}`)
      }
      lines.push(`> - **答案**：${section.quiz.correct_key} — ${section.quiz.explanation}`, '')
    }
  }
  return lines.join('\n').trim() + '\n'
}

export function renderObsidianMarkdown(
  doc: StructuredNoteDocument | null,
  markdownFallback: string,
  meta: ExportNoteMetadata = {},
): string {
  const title = (doc?.title || meta.title || 'BiliNote 导出笔记').trim()
  const sourceUrl = (doc?.source_url || meta.sourceUrl || '').trim()
  const platform = doc?.platform || meta.platform
  const videoId = doc?.video_id || meta.videoId
  const createdAt = (meta.createdAt || new Date().toISOString()).trim()
  const tags = Array.from(
    new Set(
      [
        'BiliNote',
        doc?.note_style === 'knowledge' ? '知识笔记' : doc?.note_style === 'tutorial' ? '教程笔记' : null,
        ...(meta.tags || []),
      ]
        .filter((item): item is string => Boolean(item && item.trim()))
        .map(item => item.trim().replace(/^#/, '')),
    ),
  )

  const frontmatter: string[] = [
    '---',
    `title: ${escapeYamlScalar(title)}`,
  ]
  if (sourceUrl) frontmatter.push(`source: ${escapeYamlScalar(sourceUrl)}`)
  if (meta.modelName?.trim()) frontmatter.push(`model: ${escapeYamlScalar(meta.modelName)}`)
  frontmatter.push(`created: ${escapeYamlScalar(createdAt)}`)
  frontmatter.push('tags:')
  for (const tag of tags) {
    frontmatter.push(`  - ${tag}`)
  }
  frontmatter.push('---', '')

  if (!doc) {
    return `${frontmatter.join('\n')}\n${(markdownFallback || '').trim()}\n`
  }

  const lines: string[] = [...frontmatter, `# ${title}`, '']

  for (const section of doc.sections || []) {
    const heading = section.level === 3 ? '###' : '##'
    const tsLinks = (section.time_ranges || [])
      .map(tr => {
        const label = tr.label || formatSeconds(tr.start)
        const jumpUrl = buildOriginTimeUrl(platform, videoId, sourceUrl, tr.start)
        return jumpUrl ? `[${label}](${jumpUrl})` : `\`${label}\``
      })
      .filter(Boolean)
    lines.push(`${heading} ${section.title}${tsLinks.length ? ` · ${tsLinks.join(' / ')}` : ''}`, '')

    for (const tk of section.core_takeaways || []) {
      const text = renderSpansMd(tk.spans).trim()
      if (text) lines.push(`- ${text}`)
    }
    if (section.core_takeaways?.length) lines.push('')

    for (const block of section.blocks || []) {
      if (block.type === 'paragraph') {
        lines.push(renderSpansMd(block.spans), '')
      } else if (block.type === 'flow_chain') {
        const chain = (block.steps || []).map(step => renderSpansMd(step).trim()).filter(Boolean).join(' → ')
        if (chain) lines.push(`> [!abstract] 因果链`, `> ${chain}`, '')
      } else if (block.type === 'table') {
        const headers = block.columns || []
        if (headers.length) {
          lines.push(`| ${headers.join(' | ')} |`)
          lines.push(`| ${headers.map(() => '---').join(' | ')} |`)
          for (const row of block.rows || []) {
            lines.push(`| ${row.map(cell => renderSpansMd(cell).replace(/\|/g, '\\|')).join(' | ')} |`)
          }
          lines.push('')
        }
      } else if (block.type === 'list') {
        ;(block.items || []).forEach((item, idx) => {
          const text = renderSpansMd(item).trim()
          if (text) lines.push(`${block.ordered ? `${idx + 1}.` : '-'} ${text}`)
        })
        if (block.items?.length) lines.push('')
      } else if (block.type === 'checklist') {
        if (block.title) lines.push(`**${block.title}**`, '')
        for (const item of block.items || []) {
          lines.push(`- [${item.checked ? 'x' : ' '}] ${spansPlainText(item.spans)}`)
        }
        lines.push('')
      } else if (block.type === 'code_block') {
        lines.push(`\`\`\`${block.language || ''}`, block.code, '```', '')
      }
    }

    for (const anno of section.annotations || []) {
      const calloutType = OBSIDIAN_CALLOUTS[anno.kind] || 'note'
      const kindLabel = KIND_LABELS[anno.kind] || anno.kind
      const tsSuffix = anno.timestamp_label
        ? (() => {
            const jumpUrl = typeof anno.timestamp === 'number'
              ? buildOriginTimeUrl(platform, videoId, sourceUrl, anno.timestamp)
              : null
            return jumpUrl ? ` ([${anno.timestamp_label}](${jumpUrl}))` : ` (${anno.timestamp_label})`
          })()
        : ''
      const cleanHint = (anno.short_hint || '').replace(/\r?\n/g, ' ').trim()
      lines.push(`> [!${calloutType}]- ${kindLabel}：${cleanHint}${tsSuffix}`)
      for (const detailLine of (anno.full_detail || '').split(/\r?\n/)) {
        lines.push(`> ${detailLine}`)
      }
      lines.push('')
    }

    if (section.quiz) {
      const cleanPrompt = (section.quiz.short_prompt || '章节自测').replace(/\r?\n/g, ' ').trim()
      lines.push(`> [!question]- 自测：${cleanPrompt}`)
      lines.push(`> ${section.quiz.full_question.replace(/\r?\n/g, ' ')}`)
      for (const opt of section.quiz.options || []) {
        lines.push(`> - **${opt.key}.** ${opt.text}`)
      }
      lines.push(`>> [!success]- 查看答案（${section.quiz.correct_key}）`)
      lines.push(`>> ${section.quiz.explanation.replace(/\r?\n/g, ' ')}`)
      lines.push('')
    }
  }

  return lines.join('\n').trim() + '\n'
}

export function renderAnkiTsv(
  doc: StructuredNoteDocument | null,
  titleFallback: string,
): AnkiExportResult {
  if (!doc || !Array.isArray(doc.sections) || doc.sections.length === 0) {
    return { content: '', cardCount: 0 }
  }

  const deckTag = `BiliNote::${sanitizeAnkiTag(doc.title || titleFallback)}`
  const rows: string[] = []

  for (const section of doc.sections) {
    const secTitle = (section.title || '未命名章节').trim()

    if (section.quiz && section.quiz.full_question?.trim()) {
      const optLines = (section.quiz.options || [])
        .map(opt => `${opt.key}. ${opt.text}`)
        .join('\n')
      const frontRaw = optLines
        ? `[${secTitle}]\n${section.quiz.full_question}\n\n${optLines}`
        : `[${secTitle}]\n${section.quiz.full_question}`
      const backRaw = `正确答案：${section.quiz.correct_key}\n${section.quiz.explanation || ''}`
      rows.push(
        [
          sanitizeAnkiField(frontRaw),
          sanitizeAnkiField(backRaw),
          `${deckTag} BiliNote::Quiz`,
        ].join('\t'),
      )
    }

    for (const anno of section.annotations || []) {
      if (anno.kind !== 'pit') continue
      const hint = (anno.short_hint || '').trim()
      const detail = (anno.full_detail || '').trim()
      if (!hint && !detail) continue
      const frontRaw = `[避坑 · ${secTitle}]\n${hint || detail}`
      const tsNote = anno.timestamp_label ? `\n原片时间点：${anno.timestamp_label}` : ''
      const backRaw = `${detail || hint}${tsNote}`
      rows.push(
        [
          sanitizeAnkiField(frontRaw),
          sanitizeAnkiField(backRaw),
          `${deckTag} BiliNote::Pit`,
        ].join('\t'),
      )
    }
  }

  if (rows.length === 0) {
    return { content: '', cardCount: 0 }
  }

  return {
    content: `\uFEFF${rows.join('\n')}\n`,
    cardCount: rows.length,
  }
}

export function renderInteractiveHtml(
  doc: StructuredNoteDocument | null,
  markdownFallback: string,
  titleFallback: string,
): string {
  const title = escapeHtml(doc?.title || titleFallback || 'BiliNote 导出笔记')
  const sectionsHtml = doc
    ? (doc.sections || [])
        .map((section, secIdx) => {
          const tsBadges = (section.time_ranges || [])
            .map(tr => `<span class="ts-pill">${escapeHtml(tr.label || formatSeconds(tr.start))}</span>`)
            .join('')
          const takeaways = (section.core_takeaways || [])
            .map(tk => `<li><div class="takeaway-line">${renderSpansHtml(tk.spans)}</div></li>`)
            .join('')

          const blocks = (section.blocks || [])
            .map(block => {
              if (block.type === 'paragraph') {
                return `<p>${renderSpansHtml(block.spans)}</p>`
              }
              if (block.type === 'flow_chain') {
                return `<div class="flow-chain">${(block.steps || []).map(step => `<span class="flow-node">${renderSpansHtml(step)}</span>`).join('<span class="flow-arrow">→</span>')}</div>`
              }
              if (block.type === 'table') {
                const head = (block.columns || []).map(col => `<th>${escapeHtml(col)}</th>`).join('')
                const rows = (block.rows || [])
                  .map(row => `<tr>${row.map(cell => `<td>${renderSpansHtml(cell)}</td>`).join('')}</tr>`)
                  .join('')
                return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
              }
              if (block.type === 'list') {
                const tag = block.ordered ? 'ol' : 'ul'
                const items = (block.items || []).map(item => `<li>${renderSpansHtml(item)}</li>`).join('')
                return `<${tag}>${items}</${tag}>`
              }
              if (block.type === 'checklist') {
                const items = (block.items || [])
                  .map(item => `<label class="check-row"><input type="checkbox"${item.checked ? ' checked' : ''} /><span>${renderSpansHtml(item.spans)}</span></label>`)
                  .join('')
                return `<div class="checklist">${block.title ? `<h4>${escapeHtml(block.title)}</h4>` : ''}${items}</div>`
              }
              if (block.type === 'code_block') {
                return `<pre><code>${escapeHtml(block.code)}</code></pre>`
              }
              return ''
            })
            .join('')

          const annosHtml = (section.annotations || [])
            .map(
              anno => `<details class="anno-card"><summary><span class="anno-tag">${escapeHtml(KIND_LABELS[anno.kind] || anno.kind)}</span> ${escapeHtml(anno.short_hint)}</summary><p>${escapeHtml(anno.full_detail)}</p></details>`,
            )
            .join('')

          const quizHtml = section.quiz
            ? `<div class="quiz-box" data-correct="${escapeHtml(section.quiz.correct_key)}">
                <div class="quiz-head">自测 · ${escapeHtml(section.quiz.short_prompt || '检验掌握度')}</div>
                <p class="quiz-q">${escapeHtml(section.quiz.full_question)}</p>
                <div class="quiz-opts">${section.quiz.options
                  .map(
                    opt => `<button type="button" class="quiz-opt" data-key="${escapeHtml(opt.key)}"><strong>${escapeHtml(opt.key)}</strong><span>${escapeHtml(opt.text)}</span></button>`,
                  )
                  .join('')}</div>
                <div class="quiz-ans" hidden><strong>正确答案 ${escapeHtml(section.quiz.correct_key)}</strong>：${escapeHtml(section.quiz.explanation)}</div>
              </div>`
            : ''

          return `<section class="note-sec" id="sec-${secIdx}">
            <div class="sec-head"><h2>${escapeHtml(section.title)}</h2><div class="ts-group">${tsBadges}</div></div>
            ${takeaways ? `<ul class="takeaways">${takeaways}</ul>` : ''}
            ${blocks}
            ${annosHtml}
            ${quizHtml}
          </section>`
        })
        .join('\n')
    : `<article class="plain-md"><pre>${escapeHtml(markdownFallback)}</pre></article>`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
:root { color-scheme: light dark; --accent: #1a62d6; --bg: #ffffff; --shell: #f5f5f7; --ink: #1d1d1f; --muted: #6e6e73; --hairline: rgba(15,23,42,0.09); --ok: #1b7f4b; --err: #d12f5d; }
@media (prefers-color-scheme: dark) { :root { --accent: #6cb6ff; --bg: #191a1d; --shell: #131416; --ink: #eceef2; --muted: #a3a9b5; --hairline: rgba(255,255,255,0.10); --ok: #5cd68d; --err: #ff7aa2; } }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.75 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; background: var(--shell); color: var(--ink); padding: 32px 16px 64px; }
main { max-width: 780px; margin: 0 auto; background: var(--bg); border-radius: 20px; padding: 36px clamp(20px, 4vw, 48px); box-shadow: 0 12px 36px -14px rgba(0,0,0,0.18); }
h1 { margin: 0 0 18px; font-size: 26px; letter-spacing: -0.025em; line-height: 1.3; }
.note-sec { margin-top: 28px; padding-top: 22px; border-top: 1px solid var(--hairline); }
.note-sec:first-of-type { margin-top: 0; padding-top: 0; border-top: 0; }
.sec-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.sec-head h2 { margin: 0; font-size: 19px; font-weight: 600; }
.ts-group { display: flex; gap: 6px; flex-wrap: wrap; }
.ts-pill { font-size: 12px; padding: 2px 9px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); font-variant-numeric: tabular-nums; }
.takeaways { padding-left: 20px; margin: 0 0 14px; }
.takeaways li { margin: 8px 0; }
mark.emp-hl { background: color-mix(in srgb, var(--accent) 16%, transparent); color: inherit; border-radius: 4px; padding: 0 4px; }
.emp-ul { text-decoration: underline; text-decoration-color: var(--accent); text-underline-offset: 4px; }
.emp-wave { text-decoration: underline wavy var(--accent); text-underline-offset: 4px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; padding: 1px 5px; border-radius: 5px; background: color-mix(in srgb, var(--ink) 7%, transparent); }
pre { overflow: auto; padding: 14px; border-radius: 12px; background: color-mix(in srgb, var(--ink) 5%, transparent); }
.anno-card { margin: 6px 0 4px; padding: 8px 12px; border-radius: 12px; background: color-mix(in srgb, var(--ink) 4%, transparent); border: 1px solid var(--hairline); font-size: 13px; }
.anno-card summary { cursor: pointer; color: var(--muted); font-weight: 500; }
.anno-tag { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); margin-right: 4px; }
.anno-card p { margin: 8px 0 0; color: var(--ink); }
.table-wrap { overflow-x: auto; margin: 14px 0; }
table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--hairline); }
th { color: var(--muted); font-weight: 600; }
.flow-chain { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 12px 0; font-size: 13.5px; }
.flow-node { padding: 3px 10px; border-radius: 999px; background: color-mix(in srgb, var(--ink) 6%, transparent); }
.flow-arrow { color: var(--muted); }
.checklist { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
.check-row { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
.check-row input:checked + span { text-decoration: line-through; opacity: 0.55; }
.quiz-box { margin-top: 16px; padding: 16px; border-radius: 16px; border: 1px solid var(--hairline); background: color-mix(in srgb, var(--ink) 3%, transparent); }
.quiz-head { font-size: 12px; color: var(--accent); font-weight: 600; margin-bottom: 6px; }
.quiz-q { margin: 0 0 10px; font-weight: 500; }
.quiz-opts { display: flex; flex-direction: column; gap: 7px; }
.quiz-opt { display: flex; align-items: center; gap: 10px; text-align: left; padding: 9px 12px; border-radius: 11px; border: 1px solid var(--hairline); background: var(--bg); color: var(--ink); cursor: pointer; font: inherit; }
.quiz-opt:hover:not(:disabled) { border-color: var(--accent); }
.quiz-opt.is-right { background: color-mix(in srgb, var(--accent) 16%, transparent); border-color: var(--accent); }
.quiz-opt.is-wrong { background: color-mix(in srgb, var(--err) 14%, transparent); border-color: var(--err); }
.quiz-opt.is-dim { opacity: 0.4; text-decoration: line-through; }
.quiz-ans { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--hairline); font-size: 13.5px; color: var(--muted); }
.plain-md pre { white-space: pre-wrap; font: inherit; }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
${sectionsHtml}
</main>
<script>
document.querySelectorAll('.quiz-box').forEach(box => {
  const correct = box.dataset.correct;
  const opts = Array.from(box.querySelectorAll('.quiz-opt'));
  const ans = box.querySelector('.quiz-ans');
  opts.forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const picked = btn.dataset.key;
      opts.forEach(o => {
        o.disabled = true;
        if (o.dataset.key === correct) o.classList.add('is-right');
        else if (o.dataset.key === picked) o.classList.add('is-wrong');
        else o.classList.add('is-dim');
      });
      if (ans) ans.hidden = false;
    });
  });
});
</script>
</body>
</html>`
}
