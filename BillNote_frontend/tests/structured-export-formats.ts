import assert from 'node:assert/strict'
import {
  renderObsidianMarkdown,
  renderAnkiTsv,
} from '../src/utils/structuredExport.ts'
import type { StructuredNoteDocument } from '../src/types/structuredNote.ts'

const sampleDoc: StructuredNoteDocument = {
  schema_version: 1,
  note_style: 'knowledge',
  title: '数据库连接池调优：实战避坑',
  source_url: 'https://www.bilibili.com/video/BV1demo12345',
  platform: 'bilibili',
  video_id: 'BV1demo12345',
  sections: [
    {
      id: 'sec-1',
      title: '连接池上限公式',
      level: 2,
      time_ranges: [{ start: 728, end: 760, label: '12:08' }],
      core_takeaways: [
        {
          spans: [
            { text: '公式：', emphasis: 'plain' },
            { text: 'CPU核数 × 2 + 1', emphasis: 'hl' },
          ],
        },
      ],
      blocks: [
        {
          type: 'flow_chain',
          steps: [
            [{ text: '连接数过高', emphasis: 'plain' }],
            [{ text: '上下文切换雪崩', emphasis: 'wave' }],
          ],
        },
        {
          type: 'table',
          columns: ['参数', '建议值'],
          rows: [
            [[{ text: 'maximumPoolSize', emphasis: 'code' }], [{ text: '16 ~ 20', emphasis: 'plain' }]],
          ],
        },
      ],
      annotations: [
        {
          id: 'a-why',
          kind: 'why',
          short_hint: '单核同刻只跑单线程',
          full_detail: '过多线程会导致内核频繁调度。',
          timestamp: 728,
          timestamp_label: '12:08',
        },
        {
          id: 'a-pit',
          kind: 'pit',
          short_hint: 'maxLifetime\t必须小于\nwait_timeout <script>',
          full_detail: '至少短 60 秒\n避免半开连接\t报错 & 断连',
          timestamp: 2055,
          timestamp_label: '34:15',
        },
      ],
      quiz: {
        short_prompt: '8 核服务上限？',
        full_question: '8 核 OLTP 服务连接池上限\t建议设多少？\n<tag>',
        options: [
          { key: 'A', text: '200' },
          { key: 'B', text: '16~20' },
        ],
        correct_key: 'B',
        explanation: '避免上下文切换雪崩\n并控制锁竞争。',
      },
    },
  ],
}

// 1. Obsidian 增强 Markdown 验证：YAML Frontmatter + Callout + 时间戳外链
const obsidian = renderObsidianMarkdown(sampleDoc, '# fallback', {
  title: '数据库连接池调优：实战避坑',
  sourceUrl: 'https://www.bilibili.com/video/BV1demo12345',
  modelName: 'gpt-5.4',
  createdAt: '2026-11-20T10:00:00Z',
  tags: ['数据库', '性能调优'],
})
assert(obsidian.startsWith('---\n'), 'Obsidian 导出应以 YAML Frontmatter 开头')
assert(obsidian.includes('source: "https://www.bilibili.com/video/BV1demo12345"'))
assert(obsidian.includes('model: "gpt-5.4"'))
assert(obsidian.includes('  - 数据库'))
assert(obsidian.includes('> [!tip]- 底层原理：单核同刻只跑单线程'))
assert(obsidian.includes('> [!warning]- 高频避坑细节：'))
assert(obsidian.includes('> [!question]- 自测：'))
assert(obsidian.includes('[12:08](https://www.bilibili.com/video/BV1demo12345?t=728)'))
assert(obsidian.includes('连接数过高 → **上下文切换雪崩**'))

// 2. Obsidian 空结构降级（旧版纯 Markdown）仍应输出合法 Frontmatter + 原文
const obsidianFallback = renderObsidianMarkdown(null, '# 旧版标题\n\n原始正文内容', {
  title: '旧版笔记',
  modelName: 'gpt-4o',
})
assert(obsidianFallback.startsWith('---\n'))
assert(obsidianFallback.includes('原始正文内容'))

// 3. Anki 闪卡 TSV 验证：UTF-8 BOM + 卡片数 + 制表符/换行/HTML 实体转义
const anki = renderAnkiTsv(sampleDoc, '数据库连接池调优')
assert.equal(anki.cardCount, 2, '1 道自测题 + 1 条高频避坑应生成 2 张闪卡')
assert(anki.content.startsWith('\uFEFF'), 'Anki TSV 必须带 UTF-8 BOM 以兼容中文导入')
const bodyLines = anki.content.slice(1).trim().split('\n')
assert.equal(bodyLines.length, 2, '每张卡必须严格占 1 行，原始换行应转为 <br>')
for (const line of bodyLines) {
  const cols = line.split('\t')
  assert.equal(cols.length, 3, `TSV 每行必须严格为 3 列（正面/背面/标签），实际: ${cols.length}`)
  assert(!line.includes('<script>'), '原始 HTML 标签必须被转义')
  assert(!line.includes('<tag>'), '原始 HTML 标签必须被转义')
}
assert(bodyLines[0].includes('BiliNote::Quiz'))
assert(bodyLines[1].includes('BiliNote::Pit'))
assert(bodyLines[1].includes('&lt;script&gt;'))
assert(bodyLines[1].includes('&amp;'))

// 4. 无结构化数据时 Anki 安全降级为 0 张卡
const emptyAnki = renderAnkiTsv(null, '纯文本笔记')
assert.equal(emptyAnki.cardCount, 0)
assert.equal(emptyAnki.content, '')

console.log('structured-export-formats: ALL PASSED')
