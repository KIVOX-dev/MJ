/** Speech-to-text through Groq's Whisper endpoint. Tries each API key in turn so one rate-limited key does not stop voice. */
export class GroqTranscriber {
  constructor(
    private readonly apiKeys: string[],
    private readonly model = 'whisper-large-v3-turbo',
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async transcribe(audio: Buffer, mime: string): Promise<string> {
    const ext = /video\/mp4/i.test(mime) ? 'mp4' : /mp4|m4a|aac/i.test(mime) ? 'm4a' : /ogg/i.test(mime) ? 'ogg' : /wav/i.test(mime) ? 'wav' : /mpeg|mp3/i.test(mime) ? 'mp3' : 'webm';
    let lastErr = 'no API key';
    for (const key of this.apiKeys) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)], { type: mime || 'audio/webm' }), `voice.${ext}`);
      form.append('model', this.model);
      form.append('response_format', 'json');
      form.append('temperature', '0');
      try {
        const res = await this.fetchFn('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          body: form,
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) return String(((await res.json()) as { text?: string }).text ?? '').trim();
        lastErr = `status ${res.status}`;
        if (res.status === 400 || res.status === 413) break; // the audio itself is bad: another key will not help
      } catch (err) {
        lastErr = (err as Error).message;
      }
    }
    throw new Error(`Transcription failed (${lastErr})`);
  }
}
