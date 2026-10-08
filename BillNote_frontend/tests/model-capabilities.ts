import assert from 'node:assert/strict'
import { isTranscriptionModel } from '../src/utils/modelCapabilities'

const audio = ['whisper-1', 'whisper-large-v3-turbo', 'Systran/faster-whisper-large-v3', 'distil-whisper/distil-large-v3', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe-diarize', 'scribe_v1']
const chat = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gpt-4o', 'gpt-4o-mini', 'llama-3.3-70b-versatile', 'qwen2.5-omni-7b', 'gemini-live-audio']
for (const name of audio) assert.equal(isTranscriptionModel(name), true, name)
for (const name of chat) assert.equal(isTranscriptionModel(name), false, `Multimodal chat must remain available: ${name}`)
console.log(`model capability checks passed (${audio.length} audio-only, ${chat.length} chat/multimodal)`)
