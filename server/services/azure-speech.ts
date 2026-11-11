import { createHash } from 'crypto';
import config from '../config';

/** Jane, the voice the read-aloud player uses until the reader picks another. */
export const DEFAULT_AZURE_VOICE = 'en-US-JaneNeural';

/** Most text one synthesize request accepts (a long paragraph is a few thousand). */
export const MAX_SYNTHESIS_CHARS = 20_000;

/** Text sent to Azure per call; longer paragraphs are spoken in pieces and joined. */
const PIECE_CHARS = 3_000;

/** MP3 at a constant bitrate, so pieces can be joined back to back. */
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

const VOICE_LIST_TTL_MS = 24 * 60 * 60 * 1000;
const AUDIO_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export interface AzureVoice {
  /** Azure's short name, e.g. "en-US-JaneNeural". */
  id: string;
  name: string;
  /** BCP 47 locale, e.g. "en-US". */
  lang: string;
  gender: string;
}

/** The fields of Azure's voices/list entries that the player uses. */
interface AzureVoiceListEntry {
  ShortName: string;
  DisplayName: string;
  Locale: string;
  Gender: string;
  VoiceType: string;
  Status?: string;
}

export class SpeechServiceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function speechConfigured(): boolean {
  return Boolean(config.speechService?.apiKey);
}

function endpoint(path: string): string {
  return `https://${config.speechService?.region}.tts.speech.microsoft.com${path}`;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { 'Ocp-Apim-Subscription-Key': config.speechService?.apiKey ?? '', 'User-Agent': 'quill-ai', ...extra };
}

let voiceCache: { at: number; voices: AzureVoice[] } | null = null;

/** Azure's neural voices, cached for a day. */
export async function listVoices(): Promise<AzureVoice[]> {
  if (voiceCache && Date.now() - voiceCache.at < VOICE_LIST_TTL_MS) return voiceCache.voices;
  const res = await fetch(endpoint('/cognitiveservices/voices/list'), { headers: headers() });
  if (!res.ok) throw new SpeechServiceError(`Azure Speech voice list failed (${res.status})`, 502);
  const entries = (await res.json()) as AzureVoiceListEntry[];
  const voices = entries
    .filter(v => v.VoiceType?.startsWith('Neural') && v.Status !== 'Deprecated')
    .map(v => ({ id: v.ShortName, name: v.DisplayName, lang: v.Locale, gender: v.Gender }));
  voiceCache = { at: Date.now(), voices };
  return voices;
}

/** Reader speed (1 = normal) as an SSML prosody rate. */
export function prosodyRate(rate: number): string {
  const percent = Math.round((rate - 1) * 100);
  return `${percent >= 0 ? '+' : ''}${percent}%`;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The locale a voice speaks: "en-US" for "en-US-JaneNeural". */
export function voiceLocale(voice: string): string {
  return voice.split('-').slice(0, 2).join('-');
}

export function buildSsml(text: string, voice: string, rate: number): string {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(voiceLocale(voice))}">`
    + `<voice name="${escapeXml(voice)}"><prosody rate="${prosodyRate(rate)}">${escapeXml(text)}</prosody></voice></speak>`;
}

/** Splits text into pieces of at most `max` characters, at sentence (else word) breaks. */
export function splitForSynthesis(text: string, max = PIECE_CHARS): string[] {
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '), window.lastIndexOf('\n'));
    if (cut < max / 2) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max - 1;
    pieces.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** Recently spoken paragraphs, so replaying or seeking back doesn't pay twice. */
const audioCache = new Map<string, Buffer>();
let audioCacheBytes = 0;

function remember(key: string, audio: Buffer): void {
  audioCache.set(key, audio);
  audioCacheBytes += audio.length;
  for (const [oldKey, old] of audioCache) {
    if (audioCacheBytes <= AUDIO_CACHE_MAX_BYTES) break;
    audioCache.delete(oldKey);
    audioCacheBytes -= old.length;
  }
}

/** For tests. */
export function clearSpeechCaches(): void {
  audioCache.clear();
  audioCacheBytes = 0;
  voiceCache = null;
}

async function synthesizePiece(text: string, voice: string, rate: number): Promise<Buffer> {
  const res = await fetch(endpoint('/cognitiveservices/v1'), {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': OUTPUT_FORMAT }),
    body: buildSsml(text, voice, rate),
  });
  if (!res.ok) {
    const status = res.status === 400 ? 400 : res.status === 429 ? 429 : 502;
    throw new SpeechServiceError(`Azure Speech synthesis failed (${res.status})`, status);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Speaks `text` with an Azure neural voice and returns MP3 audio. */
export async function synthesize(text: string, voice: string, rate: number): Promise<Buffer> {
  const key = createHash('sha256').update(`${voice}\n${rate}\n${text}`).digest('hex');
  const cached = audioCache.get(key);
  if (cached) {
    // Refresh its place so the most recently heard paragraphs are kept longest.
    audioCache.delete(key);
    audioCache.set(key, cached);
    return cached;
  }
  const parts: Buffer[] = [];
  for (const piece of splitForSynthesis(text)) parts.push(await synthesizePiece(piece, voice, rate));
  const audio = Buffer.concat(parts);
  remember(key, audio);
  return audio;
}
