import { AzureVoice } from '@app/core/read-aloud/azure-speech-client';

/** "mine": the reader's language (e.g. every English accent); "all"; or one locale such as "en-GB". */
export type LanguageFilter = 'mine' | 'all' | string;
export type GenderFilter = 'any' | AzureVoice['gender'];
export type TypeFilter = 'any' | 'hd' | 'standard';

export interface VoiceFilter {
  search: string;
  language: LanguageFilter;
  gender: GenderFilter;
  type: TypeFilter;
  /** Every one must match: a personality ("Warm"), a scenario ("Audiobook"), or MULTILINGUAL_TAG. */
  tags: readonly string[];
}

/** Tag chip for voices that speak other languages too. */
export const MULTILINGUAL_TAG = 'Multilingual';

/** Where the gallery starts (and "Clear filters" returns): standard voices in the reader's language.
 *  HD voices sound richer but take seconds to start speaking, so they're one click away. */
export const DEFAULT_FILTER: VoiceFilter = { search: '', language: 'mine', gender: 'any', type: 'standard', tags: [] };

/** The voice's tags as the filter chips name them. */
export function voiceTags(voice: AzureVoice): string[] {
  return [...voice.scenarios, ...voice.personalities, ...(voice.multilingual ? [MULTILINGUAL_TAG] : [])];
}

function baseLanguage(locale: string): string {
  return locale.toLowerCase().split('-')[0] ?? '';
}

function matchesLanguage(voice: AzureVoice, language: LanguageFilter, myLanguage: string): boolean {
  if (language === 'all') return true;
  if (language === 'mine') return baseLanguage(voice.lang) === baseLanguage(myLanguage);
  return voice.lang.toLowerCase() === language.toLowerCase();
}

/** Everything but the tag chips, so the chips can show what's left to narrow by. */
function matchesBasics(voice: AzureVoice, filter: VoiceFilter, myLanguage: string): boolean {
  if (!matchesLanguage(voice, filter.language, myLanguage)) return false;
  if (filter.gender !== 'any' && voice.gender !== filter.gender) return false;
  if (filter.type === 'hd' && !voice.hd) return false;
  if (filter.type === 'standard' && voice.hd) return false;
  const search = filter.search.trim().toLowerCase();
  if (search) {
    const haystack = [voice.name, voice.localeName, voice.lang, voice.gender, ...voiceTags(voice)].join(' ').toLowerCase();
    if (!search.split(/\s+/).every(word => haystack.includes(word))) return false;
  }
  return true;
}

/**
 * The voices matching `filter`: pinned ones first, then the reader's own
 * locale (en-US for an American reader), then HD voices, then by name.
 */
export function filterVoices(
  voices: readonly AzureVoice[], filter: VoiceFilter, myLanguage: string, pinned: readonly string[] = [],
): AzureVoice[] {
  const exact = myLanguage.toLowerCase();
  const isPinned = (v: AzureVoice) => Number(pinned.includes(v.id));
  return voices
    .filter(v => matchesBasics(v, filter, myLanguage))
    .filter(v => {
      const tags = voiceTags(v);
      return filter.tags.every(t => tags.includes(t));
    })
    .sort((a, b) =>
      isPinned(b) - isPinned(a) ||
      Number(b.lang.toLowerCase() === exact) - Number(a.lang.toLowerCase() === exact) ||
      Number(b.hd) - Number(a.hd) ||
      a.name.localeCompare(b.name));
}

/**
 * Tags to offer as chips: the most common among voices matching the other
 * filters (selected tags always stay listed so they can be cleared).
 */
export function tagOptions(voices: readonly AzureVoice[], filter: VoiceFilter, myLanguage: string, limit = 16): string[] {
  const counts = new Map<string, number>();
  for (const voice of voices) {
    if (!matchesBasics(voice, filter, myLanguage)) continue;
    for (const tag of voiceTags(voice)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag]) => tag);
  return [...filter.tags.filter(t => !top.includes(t)), ...top];
}

/** One option per locale, by name, for the language picker. */
export function languageOptions(voices: readonly AzureVoice[]): { value: string; label: string }[] {
  const byLocale = new Map<string, string>();
  for (const v of voices) if (!byLocale.has(v.lang)) byLocale.set(v.lang, v.localeName);
  return [...byLocale.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** A voice's name without Azure's model words: "Ava Dragon HD Latest" → "Ava" (the HD badge says the rest). */
export function displayName(voice: Pick<AzureVoice, 'name'>): string {
  const short = voice.name.replace(/\b(Dragon\s+HD|Latest)\b/gi, '').replace(/\s+/g, ' ').trim();
  return short || voice.name;
}

/** What a voice says when previewed. */
export function previewText(voice: Pick<AzureVoice, 'name'>): string {
  const first = voice.name.split(/\s+/)[0] || 'your narrator';
  return `Hi, I'm ${first}. This is how your story will sound when I read it aloud.`;
}

export function filterIsDefault(filter: VoiceFilter): boolean {
  return !filter.search.trim() && filter.language === DEFAULT_FILTER.language && filter.gender === DEFAULT_FILTER.gender
    && filter.type === DEFAULT_FILTER.type && !filter.tags.length;
}
