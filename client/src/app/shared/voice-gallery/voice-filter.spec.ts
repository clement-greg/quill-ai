import { AzureVoice } from '@app/core/read-aloud/azure-speech-client';
import {
  DEFAULT_FILTER, displayName, filterIsDefault, filterVoices, languageOptions, MULTILINGUAL_TAG, previewText, tagOptions, VoiceFilter, voiceTags,
} from './voice-filter';

function voice(id: string, over: Partial<AzureVoice> = {}): AzureVoice {
  return {
    id: `azure:${id}`, name: id, lang: 'en-US', localeName: 'English (United States)', quality: 'premium', provider: 'azure',
    gender: 'Female', hd: false, multilingual: false, personalities: [], scenarios: [], ...over,
  };
}

const VOICES = [
  voice('Jane', { scenarios: ['Audiobook'], personalities: ['Warm'] }),
  voice('Ava HD', { hd: true, multilingual: true, scenarios: ['Narration'], personalities: ['Warm', 'Bright'] }),
  voice('Andrew', { gender: 'Male', scenarios: ['Audiobook', 'Narration'] }),
  voice('Sonia', { lang: 'en-GB', localeName: 'English (United Kingdom)', personalities: ['Calm'] }),
  voice('Denise', { lang: 'fr-FR', localeName: 'French (France)', scenarios: ['Audiobook'] }),
  voice('Sky', { gender: 'Neutral' }),
];

const names = (vs: AzureVoice[]) => vs.map(v => v.name);
/** No filtering at all (the gallery's default also limits to standard voices). */
const ANY: VoiceFilter = { ...DEFAULT_FILTER, type: 'any' };
const f = (over: Partial<VoiceFilter>): VoiceFilter => ({ ...ANY, ...over });

describe('voice filters', () => {
  it('shows the reader\'s language by default, own accent first, then HD, then by name', () => {
    expect(names(filterVoices(VOICES, ANY, 'en-US'))).toEqual(['Ava HD', 'Andrew', 'Jane', 'Sky', 'Sonia']);
    expect(names(filterVoices(VOICES, ANY, 'en-GB'))[0]).toBe('Sonia');
  });

  it('starts with standard voices only', () => {
    expect(DEFAULT_FILTER.type).toBe('standard');
    expect(names(filterVoices(VOICES, DEFAULT_FILTER, 'en-US'))).not.toContain('Ava HD');
  });

  it('puts pinned voices first', () => {
    expect(names(filterVoices(VOICES, ANY, 'en-US', ['azure:Sonia', 'azure:Jane']))).toEqual(['Jane', 'Sonia', 'Ava HD', 'Andrew', 'Sky']);
  });

  it('filters by language: all, or one locale', () => {
    expect(filterVoices(VOICES, f({ language: 'all' }), 'en-US')).toHaveLength(6);
    expect(names(filterVoices(VOICES, f({ language: 'fr-FR' }), 'en-US'))).toEqual(['Denise']);
  });

  it('filters by gender and type', () => {
    expect(names(filterVoices(VOICES, f({ gender: 'Male' }), 'en-US'))).toEqual(['Andrew']);
    expect(names(filterVoices(VOICES, f({ gender: 'Neutral' }), 'en-US'))).toEqual(['Sky']);
    expect(names(filterVoices(VOICES, f({ type: 'hd' }), 'en-US'))).toEqual(['Ava HD']);
    expect(names(filterVoices(VOICES, f({ type: 'standard' }), 'en-US'))).not.toContain('Ava HD');
  });

  it('needs every selected tag, including Multilingual', () => {
    expect(names(filterVoices(VOICES, f({ tags: ['Audiobook'] }), 'en-US'))).toEqual(['Andrew', 'Jane']);
    expect(names(filterVoices(VOICES, f({ tags: ['Audiobook', 'Narration'] }), 'en-US'))).toEqual(['Andrew']);
    expect(names(filterVoices(VOICES, f({ tags: [MULTILINGUAL_TAG] }), 'en-US'))).toEqual(['Ava HD']);
  });

  it('searches names, accents and tags, every word', () => {
    expect(names(filterVoices(VOICES, f({ search: 'kingdom' }), 'en-US'))).toEqual(['Sonia']);
    expect(names(filterVoices(VOICES, f({ search: 'warm bright' }), 'en-US'))).toEqual(['Ava HD']);
    expect(filterVoices(VOICES, f({ search: 'zzz' }), 'en-US')).toEqual([]);
  });

  it('offers the most common tags among what the other filters leave, keeping selected ones', () => {
    expect(tagOptions(VOICES, ANY, 'en-US').slice(0, 3)).toEqual(['Audiobook', 'Narration', 'Warm']);
    expect(tagOptions(VOICES, f({ gender: 'Male' }), 'en-US')).toEqual(['Audiobook', 'Narration']);
    expect(tagOptions(VOICES, f({ gender: 'Male', tags: ['Calm'] }), 'en-US')).toEqual(['Calm', 'Audiobook', 'Narration']);
    expect(tagOptions(VOICES, ANY, 'en-US', 1)).toEqual(['Audiobook']);
  });

  it('lists each locale once, by name', () => {
    expect(languageOptions(VOICES)).toEqual([
      { value: 'en-GB', label: 'English (United Kingdom)' },
      { value: 'en-US', label: 'English (United States)' },
      { value: 'fr-FR', label: 'French (France)' },
    ]);
  });

  it('drops Azure\'s model words from HD names', () => {
    expect(displayName({ name: 'Ava Dragon HD Latest' })).toBe('Ava');
    expect(displayName({ name: 'Ava Dragon HD Omni Latest' })).toBe('Ava Omni');
    expect(displayName({ name: 'Andrew Multilingual' })).toBe('Andrew Multilingual');
    expect(displayName({ name: 'Latest' })).toBe('Latest');
  });

  it('builds tags, preview text and knows an empty filter', () => {
    expect(voiceTags(VOICES[1]!)).toEqual(['Narration', 'Warm', 'Bright', MULTILINGUAL_TAG]);
    expect(previewText({ name: 'Ava Dragon HD Latest' })).toMatch(/^Hi, I'm Ava\./);
    expect(filterIsDefault(DEFAULT_FILTER)).toBe(true);
    expect(filterIsDefault({ ...DEFAULT_FILTER, search: ' ' })).toBe(true);
    expect(filterIsDefault({ ...DEFAULT_FILTER, gender: 'Male' })).toBe(false);
    expect(filterIsDefault(ANY)).toBe(false);
  });
});
