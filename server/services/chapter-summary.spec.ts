import { Chapter } from '../../shared/models/chapter.model';

jest.mock('openai', () => {
  const create = jest.fn();
  return {
    AzureOpenAI: jest.fn(() => ({ chat: { completions: { create } } })),
    __create: create,
  };
});

jest.mock('./cosmos', () => {
  const item = { read: jest.fn(), replace: jest.fn() };
  return {
    getContainer: jest.fn(() => ({ item: jest.fn(() => item) })),
    __item: item,
  };
});

jest.mock('./content-sanitize', () => ({
  sanitizeForModeration: jest.fn(async (text: string) => text),
}));

import {
  generateChapterSummary,
  summaryIsStale,
  refreshChapterSummary,
  ensureChapterSummary,
} from './chapter-summary';

const createMock = jest.requireMock('openai').__create as jest.Mock;
const itemMock = jest.requireMock('./cosmos').__item as { read: jest.Mock; replace: jest.Mock };

const filterError = Object.assign(new Error('filtered'), { code: 'content_filter' });

// Comfortably past the 200-character plain-text minimum.
const PARA_A = 'Arthur walks the ridge at dawn and finds the village gate broken open. '.repeat(3).trim();
const PARA_B = 'Ford argues they should turn back before the storm, but Arthur refuses. '.repeat(3).trim();
const LONG_CONTENT = `<p>${PARA_A}</p><p>${PARA_B}</p>`;

function makeChapter(overrides: Partial<Chapter>): Chapter {
  return { id: 'ch-1', bookId: 'b-1', title: 'One', content: LONG_CONTENT, ...overrides } as Chapter;
}

/** The user-message input of the nth chat-completion call. */
function inputOfCall(n: number): string {
  const messages = createMock.mock.calls[n][0].messages as { role: string; content: string }[];
  return messages[messages.length - 1].content;
}

function stubSummary(text = 'A tidy summary.'): void {
  createMock.mockResolvedValue({ choices: [{ message: { content: text } }] });
}

beforeEach(() => {
  createMock.mockReset();
  itemMock.read.mockReset();
  itemMock.replace.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('generateChapterSummary', () => {
  it('returns null for empty or too-short content', async () => {
    expect(await generateChapterSummary(undefined)).toBeNull();
    expect(await generateChapterSummary('<p>Short scene.</p>')).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('returns the summary and a hash of the source content', async () => {
    stubSummary('Arthur finds the gate broken.');
    const result = await generateChapterSummary(LONG_CONTENT);
    expect(result?.summary).toBe('Arthur finds the gate broken.');
    expect(result?.sourceHash).toMatch(/^[0-9a-f]{40}$/);
    expect(inputOfCall(0)).toContain('Arthur walks the ridge');
  });

  it('truncates very long chapters, keeping the head and tail', async () => {
    stubSummary();
    const paragraph = `<p>${'Words of the middle chapters flow onward. '.repeat(20).trim()}</p>`;
    await generateChapterSummary(paragraph.repeat(40));
    const input = inputOfCall(0);
    expect(input).toContain('[...]');
    expect(input.length).toBeLessThan(17000);
  });

  it('returns null on a non-filter AI error', async () => {
    createMock.mockRejectedValue(new Error('service down'));
    expect(await generateChapterSummary(LONG_CONTENT)).toBeNull();
  });

  it('drops the filtered paragraph and summarizes the rest when the filter trips', async () => {
    createMock.mockImplementation(async (req: { messages: { content: string }[]; max_tokens?: number }) => {
      const input = req.messages[req.messages.length - 1].content;
      const isProbe = req.max_tokens === 1;
      if (isProbe) {
        if (input.includes('Ford argues')) throw filterError;
        return {};
      }
      // Any full summary request containing the offending paragraph is blocked.
      if (input.includes('Ford argues')) throw filterError;
      return { choices: [{ message: { content: 'Summary without Ford.' } }] };
    });

    const result = await generateChapterSummary(LONG_CONTENT);
    expect(result?.summary).toBe('Summary without Ford.');
    // The final summary request only carried the surviving paragraph.
    const lastInput = inputOfCall(createMock.mock.calls.length - 1);
    expect(lastInput).toContain('Arthur walks the ridge');
    expect(lastInput).not.toContain('Ford argues');
  });

  it('returns null when the filtered chapter has only one paragraph', async () => {
    createMock.mockRejectedValue(filterError);
    expect(await generateChapterSummary(`<p>${PARA_A} ${PARA_B}</p>`)).toBeNull();
    // Full attempt only — nothing to isolate, so no probes.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when every paragraph is filtered', async () => {
    createMock.mockRejectedValue(filterError);
    expect(await generateChapterSummary(LONG_CONTENT)).toBeNull();
  });

  it('keeps a paragraph when its filter probe fails for an unrelated reason', async () => {
    createMock.mockImplementation(async (req: { max_tokens?: number }) => {
      if (req.max_tokens === 1) throw new Error('probe timeout');
      if (createMock.mock.calls.filter(c => c[0].max_tokens !== 1).length === 1) throw filterError;
      return { choices: [{ message: { content: 'Full summary after all.' } }] };
    });

    const result = await generateChapterSummary(LONG_CONTENT);
    expect(result?.summary).toBe('Full summary after all.');
    const lastInput = inputOfCall(createMock.mock.calls.length - 1);
    expect(lastInput).toContain('Arthur walks the ridge');
    expect(lastInput).toContain('Ford argues');
  });
});

describe('summaryIsStale', () => {
  it('is false for content too short to summarize', () => {
    expect(summaryIsStale(makeChapter({ content: '<p>Short.</p>' }))).toBe(false);
  });

  it('is true when a summarizable chapter has no summary', () => {
    expect(summaryIsStale(makeChapter({ summary: undefined }))).toBe(true);
  });

  it('is false when the stored hash matches the current content', async () => {
    stubSummary();
    const { summary, sourceHash } = (await generateChapterSummary(LONG_CONTENT))!;
    expect(summaryIsStale(makeChapter({ summary, summarySourceHash: sourceHash }))).toBe(false);
  });

  it('is true when the content changed since the summary was generated', async () => {
    stubSummary();
    const { summary, sourceHash } = (await generateChapterSummary(LONG_CONTENT))!;
    const edited = makeChapter({
      summary,
      summarySourceHash: sourceHash,
      content: LONG_CONTENT.replace('Arthur', 'Trillian'),
    });
    expect(summaryIsStale(edited)).toBe(true);
  });

  it('ignores markup-only changes that leave the plain text identical', async () => {
    stubSummary();
    const { summary, sourceHash } = (await generateChapterSummary(LONG_CONTENT))!;
    const reformatted = LONG_CONTENT.replace(/<p>/g, '<div>').replace(/<\/p>/g, '</div>');
    expect(
      summaryIsStale(makeChapter({ summary, summarySourceHash: sourceHash, content: reformatted })),
    ).toBe(false);
  });
});

describe('refreshChapterSummary', () => {
  it('does nothing when the summary is current', async () => {
    stubSummary();
    const { summary, sourceHash } = (await generateChapterSummary(LONG_CONTENT))!;
    createMock.mockClear();

    const chapter = makeChapter({ summary, summarySourceHash: sourceHash });
    expect(await refreshChapterSummary(chapter)).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
    expect(itemMock.replace).not.toHaveBeenCalled();
  });

  it('persists a regenerated summary onto a freshly re-read document', async () => {
    stubSummary('New summary.');
    // The stored doc was edited concurrently; the write must preserve that edit.
    const freshDoc = { id: 'ch-1', content: '<p>Edited elsewhere.</p>', title: 'Renamed' };
    itemMock.read.mockResolvedValue({ resource: freshDoc });

    const result = await refreshChapterSummary(makeChapter({ summary: undefined }));
    expect(result).toBe('New summary.');
    expect(itemMock.replace).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Renamed', content: '<p>Edited elsewhere.</p>', summary: 'New summary.' }),
    );
    expect(itemMock.replace.mock.calls[0][0].summarySourceHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('writes nothing when the chapter no longer exists', async () => {
    stubSummary();
    itemMock.read.mockResolvedValue({ resource: undefined });
    expect(await refreshChapterSummary(makeChapter({ summary: undefined }))).toBeNull();
    expect(itemMock.replace).not.toHaveBeenCalled();
  });

  it('never throws, even when persistence fails', async () => {
    stubSummary();
    itemMock.read.mockRejectedValue(new Error('cosmos down'));
    await expect(refreshChapterSummary(makeChapter({ summary: undefined }))).resolves.toBeNull();
  });
});

describe('ensureChapterSummary', () => {
  it('returns the existing summary when it is current', async () => {
    stubSummary();
    const { summary, sourceHash } = (await generateChapterSummary(LONG_CONTENT))!;
    createMock.mockClear();

    const chapter = makeChapter({ summary, summarySourceHash: sourceHash });
    expect(await ensureChapterSummary(chapter)).toBe(summary);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('returns the refreshed summary when stale', async () => {
    stubSummary('Fresher summary.');
    itemMock.read.mockResolvedValue({ resource: { id: 'ch-1' } });
    expect(await ensureChapterSummary(makeChapter({ summary: 'old', summarySourceHash: 'stale' }))).toBe(
      'Fresher summary.',
    );
  });

  it('falls back to the stale summary when regeneration fails', async () => {
    createMock.mockRejectedValue(new Error('service down'));
    expect(await ensureChapterSummary(makeChapter({ summary: 'old', summarySourceHash: 'stale' }))).toBe('old');
  });
});
