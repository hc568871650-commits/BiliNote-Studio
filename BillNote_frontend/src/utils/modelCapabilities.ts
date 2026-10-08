/** Audio-only models cannot answer chat/completion requests. Preserve multimodal chat models. */
export function isTranscriptionModel(name: string): boolean {
  return /(?:^|[/_.-])(?:whisper|distil-whisper|faster-whisper|transcribe|transcription)(?:$|[/_.-])|^gpt-4o(?:-mini)?-transcribe(?:$|-)|^scribe(?:$|[_-])/i.test(name.trim())
}
