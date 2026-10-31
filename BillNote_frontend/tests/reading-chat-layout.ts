import assert from 'node:assert/strict'
import { constrainedReaderPercent, DEFAULT_READER_PERCENT, MIN_CHAT_WIDTH, MIN_READER_WIDTH, readingChatConstraints, readReaderPreference, saveReaderPreference } from '../src/pages/HomePage/components/readingChatLayoutState'

for (const raw of [null, '', 'null', 'NaN', 'true', '"65"', '{}', '[63]', '1e999', '0', '19.99', '80.01', 'x'.repeat(81)]) {
  assert.equal(readReaderPreference({ getItem: () => raw }), DEFAULT_READER_PERCENT, `invalid preference: ${raw}`)
}
assert.equal(readReaderPreference({ getItem: () => '47.5' }), 47.5)
assert.equal(readReaderPreference({ getItem: () => { throw new Error('blocked') } }), DEFAULT_READER_PERCENT)
assert.equal(readReaderPreference(), DEFAULT_READER_PERCENT)
let stored = ''
const storage = { setItem: (_: string, value: string) => { stored = value } }
saveReaderPreference(57.123456, storage)
assert.equal(stored, '57.12')
for (const invalid of [NaN, Infinity, -1, 19, 81]) saveReaderPreference(invalid, storage)
assert.equal(stored, '57.12', 'invalid values never overwrite preference')
assert.doesNotThrow(() => saveReaderPreference(63, { setItem: () => { throw new Error('quota') } }))
assert.doesNotThrow(() => saveReaderPreference(63))
for (const width of [708, 720, 800, 1024, 1280, 1600, 1920, 2560]) {
  assert.equal(readingChatConstraints(width).narrow, false)
  for (const preference of [20, 37, 63, 80]) {
    const percent = constrainedReaderPercent(preference, width)
    assert.ok((width - 8) * percent / 100 >= MIN_READER_WIDTH - 0.01, `reader at width ${width}`)
    assert.ok((width - 8) * (100 - percent) / 100 >= MIN_CHAT_WIDTH - 0.01, `chat at width ${width}`)
    assert.ok(percent >= 20 && percent <= 80)
  }
}
for (const width of [320, 480, 640, 707]) assert.equal(readingChatConstraints(width).narrow, true)
assert.equal(readingChatConstraints(0).narrow, false, 'unmeasured layout is not treated as narrow')
assert.equal(constrainedReaderPercent(70, 1600), 70, 'large window restores preference')
assert.ok(constrainedReaderPercent(70, 800) < 70, 'small window temporarily constrains preference')
console.log('PASS reading/chat layout storage and width boundaries')
