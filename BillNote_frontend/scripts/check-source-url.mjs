import assert from 'node:assert/strict'
import {
  cleanExtractedUrl,
  extractShareInput,
  inferPlatform,
  isDocumentSourceName,
  LINK_PLATFORMS,
  looksLikeCollectionUrl,
} from '../src/utils/sourceUrl.ts'

// 1. X / Twitter / 镜像 / 短链识别与规范化
assert.equal(inferPlatform('https://x.com/karpathy/status/1894099637218545984?s=20&t=abc'), 'x')
assert.equal(inferPlatform('https://twitter.com/OpenAI/status/1758192957386342435'), 'x')
assert.equal(inferPlatform('https://mobile.twitter.com/a/statuses/123456'), 'x')
assert.equal(inferPlatform('https://fxtwitter.com/karpathy/status/1894099637218545984'), 'x')
assert.equal(inferPlatform('https://vxtwitter.com/karpathy/status/1894099637218545984'), 'x')
assert.equal(inferPlatform('https://fixupx.com/karpathy/article/1894099637218545999'), 'x')
assert.equal(inferPlatform('https://t.co/AbCdEf1234'), 'x')

assert.equal(
  cleanExtractedUrl('https://twitter.com/karpathy/status/1894099637218545984?s=20&t=xyz&ref_src=twsrc'),
  'https://x.com/karpathy/status/1894099637218545984',
)
assert.equal(
  cleanExtractedUrl('https://fxtwitter.com/karpathy/status/1894099637218545984/?s=46&t=999'),
  'https://x.com/karpathy/status/1894099637218545984',
)

// 2. YouTube ?t= 参数必须保留，不被 X 清洗规则误删
const ytCleaned = cleanExtractedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=125s&si=abc')
assert.ok(ytCleaned.includes('t=125s'), `YouTube t= should be preserved, got ${ytCleaned}`)
assert.ok(!ytCleaned.includes('si='), `YouTube si= should be stripped, got ${ytCleaned}`)

// 3. 分享文案提取与平台联动
const shared = extractShareInput('推荐这篇帖子 https://twitter.com/OpenAI/status/1758192957386342435?s=20&t=abc，值得收藏！')
assert.equal(shared.platform, 'x')
assert.equal(shared.url, 'https://x.com/OpenAI/status/1758192957386342435')
assert.equal(shared.extracted, true)

// 4. X / 小宇宙 / 网页链接不误触发合集解析
assert.equal(looksLikeCollectionUrl('https://x.com/i/lists/123456'), false)
assert.equal(looksLikeCollectionUrl('https://www.bilibili.com/video/BV1xx411c7mD?p=2'), true)
assert.ok(LINK_PLATFORMS.some(p => p.value === 'x' && p.label === 'X (Twitter)'))
assert.ok(LINK_PLATFORMS.some(p => p.value === 'xiaoyuzhou' && p.label === '小宇宙播客'))
assert.ok(LINK_PLATFORMS.some(p => p.value === 'web' && p.label === '网页文章'))

// 5. 小宇宙播客与通用网页文章识别 + 私有地址拦截
assert.equal(inferPlatform('https://www.xiaoyuzhoufm.com/episode/67a1b2c3d4e5f6a7b8c9d0e1?s=eyJ1IjoiIn0'), 'xiaoyuzhou')
assert.equal(
  cleanExtractedUrl('https://m.xiaoyuzhoufm.com/episode/67a1b2c3d4e5f6a7b8c9d0e1?utm_source=share'),
  'https://www.xiaoyuzhoufm.com/episode/67a1b2c3d4e5f6a7b8c9d0e1',
)
assert.equal(inferPlatform('https://mp.weixin.qq.com/s/abcdef123456'), 'web')
assert.equal(inferPlatform('https://github.com/fastapi/fastapi'), 'web')
assert.equal(inferPlatform('http://127.0.0.1:8080/admin'), null)
assert.equal(inferPlatform('http://localhost:3000/test'), null)
assert.equal(looksLikeCollectionUrl('https://docs.example.com/guide?p=2'), false)

// 6. 本地文档扩展名识别
assert.equal(isDocumentSourceName('guide.pdf'), true)
assert.equal(isDocumentSourceName('README.md'), true)
assert.equal(isDocumentSourceName('notes.markdown'), true)
assert.equal(isDocumentSourceName('draft.txt'), true)
assert.equal(isDocumentSourceName('lesson.mp4'), false)

console.log('sourceUrl: X, Xiaoyuzhou, Web article, local document, and YouTube t= preservation checks passed')
