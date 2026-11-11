import request from 'supertest';
import config from '../config';
import speechRoutes from './speech.routes';
import { makeTestApp } from '../testing/test-app';
import { buildSsml, clearSpeechCaches, prosodyRate, splitForSynthesis } from '../services/azure-speech';

const app = makeTestApp('/api/speech', speechRoutes);
const cfg = config as typeof config & { speechService?: { apiKey?: string; region?: string } };

function audioResponse(bytes: number[]): Response {
  return new Response(Buffer.from(bytes), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
}

describe('speech routes', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    clearSpeechCaches();
    cfg.speechService = { apiKey: 'test-key', region: 'westus' };
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
    delete cfg.speechService;
  });

  it('reports Azure as off when no key is configured', async () => {
    delete cfg.speechService;
    const res = await request(app).get('/api/speech/voices');
    expect(res.body).toEqual({ enabled: false, defaultVoice: null, voices: [] });
    const synth = await request(app).post('/api/speech/synthesize').send({ text: 'Hi' });
    expect(synth.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists neural voices with Jane as the default', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([
      { ShortName: 'en-US-JaneNeural', DisplayName: 'Jane', Locale: 'en-US', Gender: 'Female', VoiceType: 'Neural', Status: 'GA' },
      { ShortName: 'en-US-OldStandard', DisplayName: 'Old', Locale: 'en-US', Gender: 'Male', VoiceType: 'Standard' },
    ]), { status: 200 }));
    const res = await request(app).get('/api/speech/voices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      defaultVoice: 'en-US-JaneNeural',
      voices: [{ id: 'en-US-JaneNeural', name: 'Jane', lang: 'en-US', gender: 'Female' }],
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://westus.tts.speech.microsoft.com/cognitiveservices/voices/list');
    expect(init.headers['Ocp-Apim-Subscription-Key']).toBe('test-key');
  });

  it('synthesizes MP3 with the requested voice and speed, and caches it', async () => {
    fetchMock.mockImplementation(async () => audioResponse([1, 2, 3]));
    const body = { text: 'Tom & Jerry <ran>.', voice: 'en-GB-SoniaNeural', rate: 1.25 };
    const res = await request(app).post('/api/speech/synthesize').send(body);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect([...res.body]).toEqual([1, 2, 3]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://westus.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(init.headers['X-Microsoft-OutputFormat']).toBe('audio-24khz-48kbitrate-mono-mp3');
    expect(init.body).toContain('<voice name="en-GB-SoniaNeural">');
    expect(init.body).toContain('xml:lang="en-GB"');
    expect(init.body).toContain('<prosody rate="+25%">Tom &amp; Jerry &lt;ran&gt;.</prosody>');

    await request(app).post('/api/speech/synthesize').send(body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('defaults to Jane at normal speed', async () => {
    fetchMock.mockImplementation(async () => audioResponse([9]));
    await request(app).post('/api/speech/synthesize').send({ text: 'Hello' });
    expect(fetchMock.mock.calls[0]![1].body).toContain('<voice name="en-US-JaneNeural"><prosody rate="+0%">');
  });

  it('rejects bad input', async () => {
    const post = (b: object) => request(app).post('/api/speech/synthesize').send(b);
    expect((await post({ text: '  ' })).status).toBe(400);
    expect((await post({ text: 'x'.repeat(20_001) })).status).toBe(400);
    expect((await post({ text: 'Hi', voice: 'en-US"><evil' })).status).toBe(400);
    expect((await post({ text: 'Hi', rate: 10 })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes on Azure being rate limited', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 429 }));
    const res = await request(app).post('/api/speech/synthesize').send({ text: 'Hi' });
    expect(res.status).toBe(429);
  });

  it('speaks a very long paragraph in pieces and joins them', async () => {
    fetchMock.mockImplementation(async () => audioResponse([7]));
    const text = 'A sentence that goes on. '.repeat(300);
    const res = await request(app).post('/api/speech/synthesize').send({ text });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(res.body.length).toBe(fetchMock.mock.calls.length);
  });
});

describe('azure speech helpers', () => {
  it('maps reader speed onto SSML rates', () => {
    expect(prosodyRate(1)).toBe('+0%');
    expect(prosodyRate(0.75)).toBe('-25%');
    expect(prosodyRate(2)).toBe('+100%');
  });

  it('splits at sentence breaks and keeps every word', () => {
    const text = 'One two three. Four five six. Seven eight nine.';
    const pieces = splitForSynthesis(text, 20);
    expect(pieces.every(p => p.length <= 20)).toBe(true);
    expect(pieces.join(' ')).toBe(text);
  });

  it('escapes quotes in the voice name', () => {
    expect(buildSsml('x', `a'b`, 1)).toContain(`name="a&apos;b"`);
  });
});
