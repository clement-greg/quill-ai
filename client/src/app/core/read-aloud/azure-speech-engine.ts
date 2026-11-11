import { ReadAloudVoice, SpeechEngine, SpeechEngineListener, SpeechPlayRequest } from './read-aloud.model';
import { splitIntoChunks } from './read-aloud-segments';

/** Fetches a paragraph's audio: MP3 of `text` in `voiceId` at `rate`. */
export type AzureAudioSource = (text: string, voiceId: string, rate: number, signal: AbortSignal) => Promise<Blob>;

/** Piece audio kept around (upcoming pieces are fetched while one plays). */
const MAX_CACHED = 16;
/**
 * Text per request. Azure's HD voices take about as long to generate as the
 * audio lasts, so a whole paragraph can mean 15+ seconds of silence before it
 * plays; a sentence or two arrives in a couple of seconds.
 */
export const AZURE_PIECE_CHARS = 250;
/** Pieces fetched ahead of the one playing. */
const LOOKAHEAD = 3;
/** Gap after a paragraph, and a longer one after a chapter title. */
const PARAGRAPH_GAP_MS = 250;
const TITLE_GAP_MS = 600;

const NOOP_LISTENER: SpeechEngineListener = { progress: () => {}, state: () => {}, error: () => {} };

interface CachedAudio {
  url: Promise<string>;
  controller: AbortController;
}

/**
 * Plays Microsoft Azure neural voices in the browser: each paragraph is split
 * into sentence-sized pieces, the server turns each into MP3, and they play in
 * turn through one <audio> element. The next few pieces are fetched while one
 * plays, so slow (HD) voices don't leave gaps.
 */
export class AzureSpeechEngine implements SpeechEngine {
  readonly kind = 'web' as const;
  readonly supportsAzure = true;
  private listener = NOOP_LISTENER;
  private request: SpeechPlayRequest | null = null;
  private index = 0;
  /** The current paragraph's pieces, and which one is playing. */
  private pieces: string[] = [];
  private piece = 0;
  /** Bumped on every jump/stop so late fetches and events from older paragraphs are ignored. */
  private generation = 0;
  /** The current paragraph's audio is loaded into the element (resume can just play it). */
  private loaded = false;
  private advanceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cache = new Map<string, CachedAudio>();

  constructor(
    private readonly audio: HTMLAudioElement,
    private readonly source: AzureAudioSource,
    private readonly urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL,
  ) {}

  setListener(listener: SpeechEngineListener): void {
    this.listener = listener;
  }

  /** The voice list comes from the server (see ReadAloudService). */
  async getVoices(): Promise<ReadAloudVoice[]> {
    return [];
  }

  /** Safari only lets a click start audio: play silence on the element now so later
   *  play() calls on it are allowed once the paragraph's audio arrives. */
  prime(): void {
    if (this.request || !this.audio.paused) return;
    this.audio.src = silentWavUrl(this.urls);
    this.audio.play()?.catch(() => {});
  }

  play(request: SpeechPlayRequest): void {
    const changed = !this.request || this.request.voiceId !== request.voiceId || this.request.rate !== request.rate;
    this.halt();
    if (changed) this.clearCache();
    this.request = request;
    void this.speakSegment(request.startIndex);
  }

  pause(): void {
    if (!this.request) return;
    if (this.loaded) {
      this.audio.pause();
    } else {
      // Still fetching (or between paragraphs): resume restarts this paragraph.
      this.generation++;
      this.clearAdvance();
    }
    this.listener.state('paused');
  }

  resume(): void {
    if (!this.request) return;
    if (!this.loaded) {
      if (this.piece >= this.pieces.length) this.speakSegment(this.index + 1);
      else void this.speakPiece();
      return;
    }
    const generation = this.generation;
    this.audio.play()?.then(
      () => { if (generation === this.generation) this.listener.state('playing'); },
      err => this.fail(generation, err),
    );
  }

  stop(): void {
    this.halt();
    this.clearCache();
    this.request = null;
    this.listener.state('idle');
  }

  private halt(): void {
    this.generation++;
    this.loaded = false;
    this.clearAdvance();
    this.audio.onended = null;
    this.audio.pause();
  }

  private clearAdvance(): void {
    if (this.advanceTimer !== null) clearTimeout(this.advanceTimer);
    this.advanceTimer = null;
  }

  private speakSegment(index: number): void {
    const request = this.request;
    if (!request) return;
    const segments = request.segments;
    if (index >= segments.length) {
      this.request = null;
      this.loaded = false;
      this.listener.state('idle');
      return;
    }
    this.generation++;
    this.index = index;
    this.pieces = splitIntoChunks(segments[index]!.text, AZURE_PIECE_CHARS);
    this.piece = 0;
    this.loaded = false;
    this.listener.progress(index);
    if (!this.pieces.length) { this.speakSegment(index + 1); return; }
    this.listener.state('playing');
    void this.speakPiece();
  }

  /** Plays piece `this.piece` of the current paragraph, then moves on. */
  private async speakPiece(): Promise<void> {
    const request = this.request;
    if (!request) return;
    const generation = ++this.generation;
    const { index, piece } = this;
    const segment = request.segments[index]!;
    this.loaded = false;
    this.listener.state('playing');
    const current = this.fetch(this.pieces[piece]!, request);
    // Download what comes next alongside, so slow voices stay ahead.
    for (const text of this.upcoming(request)) this.fetch(text, request).catch(() => {});
    let url: string;
    try {
      url = await current;
    } catch (err) {
      this.fail(generation, err);
      return;
    }
    if (generation !== this.generation) return;

    this.audio.onended = () => {
      if (generation !== this.generation) return;
      this.loaded = false;
      if (piece + 1 < this.pieces.length) {
        this.piece = piece + 1;
        void this.speakPiece();
        return;
      }
      // Paragraph done: a resume during the gap moves on rather than repeating it.
      this.piece = this.pieces.length;
      const isTitle = segment.blockIndex < 0;
      this.advanceTimer = setTimeout(() => {
        this.advanceTimer = null;
        if (generation === this.generation) this.speakSegment(index + 1);
      }, isTitle ? TITLE_GAP_MS : PARAGRAPH_GAP_MS);
    };
    this.audio.src = url;
    this.loaded = true;
    try {
      await this.audio.play();
    } catch (err) {
      this.fail(generation, err);
    }
  }

  /** The next LOOKAHEAD pieces after the one playing, into the following paragraphs. */
  private upcoming(request: SpeechPlayRequest): string[] {
    const out = this.pieces.slice(this.piece + 1, this.piece + 1 + LOOKAHEAD);
    for (let i = this.index + 1; out.length < LOOKAHEAD && i < request.segments.length; i++) {
      out.push(...splitIntoChunks(request.segments[i]!.text, AZURE_PIECE_CHARS).slice(0, LOOKAHEAD - out.length));
    }
    return out;
  }

  private fail(generation: number, err: unknown): void {
    if (generation !== this.generation) return;
    if (err instanceof DOMException && err.name === 'AbortError') return;
    this.halt();
    const blocked = err instanceof DOMException && err.name === 'NotAllowedError';
    this.listener.error(blocked
      ? 'The browser blocked audio. Press play again.'
      : `Microsoft voice stopped: ${err instanceof Error ? err.message : 'unknown error'}`);
    this.listener.state('paused');
  }

  /** Object URL of a piece's audio, fetched once per voice and speed. */
  private fetch(text: string, request: SpeechPlayRequest): Promise<string> {
    const voiceId = request.voiceId ?? '';
    const key = text;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.url;
    }
    const controller = new AbortController();
    const url = this.source(text, voiceId, request.rate, controller.signal).then(blob => this.urls.createObjectURL(blob));
    // A failed fetch is retried next time rather than cached.
    url.catch(() => { if (this.cache.get(key)?.url === url) this.cache.delete(key); });
    this.cache.set(key, { url, controller });
    while (this.cache.size > MAX_CACHED) {
      const [oldKey, old] = this.cache.entries().next().value!;
      this.cache.delete(oldKey);
      this.release(old);
    }
    return url;
  }

  private clearCache(): void {
    for (const entry of this.cache.values()) this.release(entry);
    this.cache.clear();
  }

  private release(entry: CachedAudio): void {
    entry.controller.abort();
    entry.url.then(u => this.urls.revokeObjectURL(u), () => {});
  }
}

let silentUrl: string | null = null;

/** A tenth of a second of silence, as a WAV object URL. */
function silentWavUrl(urls: Pick<typeof URL, 'createObjectURL'>): string {
  if (silentUrl) return silentUrl;
  const samples = 2400;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples * 2, true);
  silentUrl = urls.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  return silentUrl;
}
