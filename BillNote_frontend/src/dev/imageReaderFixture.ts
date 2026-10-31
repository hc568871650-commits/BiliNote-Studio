import imageFixture from './reader-image-fixture.svg?url&no-inline'
const fixtureUrl = (frame: number) => { const url = new URL(imageFixture, location.origin); url.searchParams.set('frame', String(frame)); return url.href }

export const imageReaderContent = '# 看图与阅读位置\n\n用于验收的合成笔记。\n\n' + Array.from({ length: 18 }, (_, index) => `## ${index + 1}. ${['画面与细节', '阅读与定位', '检查与复习'][index % 3]}\n\n${'这段合成正文用于检查阅读位置。切换笔记或重新打开后，可以继续上次进度，也可以从头阅读。'.repeat(5)}\n\n${index % 5 === 0 ? `![示例画面 ${index / 5 + 1}](${fixtureUrl(index)})\n\n` : ''}`).join('\n')


