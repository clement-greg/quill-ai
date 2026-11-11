import request from 'supertest';

jest.mock('../config');
jest.mock('../services/cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});
jest.mock('../services/chapter-chunks', () => ({
  searchChapterChunks: jest.fn(async () => []),
  hybridSearchChapterChunks: jest.fn(async () => []),
  reindexChapterChunks: jest.fn(async () => undefined),
}));
jest.mock('../services/timeline-event-chunks', () => ({ searchTimelineEvents: jest.fn(async () => []) }));
jest.mock('../services/image-generation', () => ({ generateImage: jest.fn() }));
jest.mock('../services/chapter-ai-context', () => ({ buildChapterContextPrompt: jest.fn() }));
jest.mock('../services/chapter-drafting-context', () => ({
  buildChapterDraftingContext: jest.fn(),
  generateChapterBeatSheet: jest.fn(),
}));
jest.mock('openai', () => {
  const create = jest.fn();
  return { AzureOpenAI: jest.fn(() => ({ responses: { create } })), __create: create };
});

import chatSessionRoutes from './chat-sessions.routes';
import { makeTestApp, USER_A, USER_B } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';
import { RECENT_LISTENING_MS } from '../services/playhead-notes';

const create = jest.requireMock('openai').__create as jest.Mock;
const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/chat-sessions', chatSessionRoutes);

const PARAGRAPH = 'The lighthouse keeper counted the ships twice, and still came up one short of the harbor log.';

async function* textStream(text: string) {
  yield { type: 'response.output_text.delta', delta: text };
  yield { type: 'response.completed', response: { output: [{ type: 'message' }] } };
}

async function* toolCallStream(name: string, args: Record<string, unknown>) {
  yield {
    type: 'response.completed',
    response: { output: [{ type: 'function_call', call_id: 'c1', name, arguments: JSON.stringify(args) }] },
  };
}

/** Saves where USER_A's player is, `ageMs` ago. */
function seedListening(ageMs: number, over: Record<string, unknown> = {}): void {
  fake.container('user-settings').seed({
    id: `listening::sub-${USER_A}`,
    books: {
      b1: {
        bookId: 'b1', bookTitle: 'Tidewater', chapterId: 'ch1', chapterTitle: 'The Count',
        blockIndex: 4, blockText: PARAGRAPH, progress: 0.3, updatedAt: Date.now() - ageMs, ...over,
      },
    },
  });
}

const nativePlayhead = {
  bookId: 'b1', bookTitle: 'Tidewater', chapterId: 'ch2', chapterTitle: 'Low Tide', blockIndex: 7, text: 'Gulls fought over the nets.',
};

const notesOf = (chapterId: string) =>
  (fake.container('chapters').get(chapterId) as { notes?: Record<string, unknown>[] }).notes ?? [];

beforeEach(() => {
  fake.reset();
  create.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  fake.container('series').seed({ id: 's1', title: 'Coast', owner: USER_A });
  fake.container('books').seed(
    { id: 'b1', title: 'Tidewater', seriesId: 's1', owner: USER_A },
    { id: 'b2', title: 'Saltmarsh', seriesId: 's1', owner: USER_A },
  );
  fake.container('chapters').seed(
    { id: 'ch1', title: 'The Count', bookId: 'b1', owner: USER_A, content: '<p>…</p>', notes: [] },
    { id: 'ch2', title: 'Low Tide', bookId: 'b1', owner: USER_A, content: '<p>…</p>' },
    { id: 'x1', title: 'Elsewhere', bookId: 'bx', owner: USER_B, content: '<p>…</p>' },
  );
});

afterEach(() => jest.restoreAllMocks());

describe('POST /voice-note', () => {
  const post = (body: Record<string, unknown>) =>
    request(app).post('/api/chat-sessions/voice-note').set('x-test-user', USER_A).send(body);

  it('pins the note to the paragraph the native player is reading', async () => {
    const res = await post({ text: 'Gulls are a motif — echo in ch 9', playerActive: true, playhead: nativePlayhead });

    expect(res.body).toEqual({ saved: true, chapter: 'Low Tide', spoken: 'Added a note to Low Tide, where you\'re listening.' });
    const [note] = notesOf('ch2');
    expect(note).toMatchObject({
      noteText: 'Gulls are a motif — echo in ch 9',
      selectedText: 'Gulls fought over the nets.',
      anchor: { blockIndex: 7, text: 'Gulls fought over the nets.' },
      createdBy: USER_A,
    });
  });

  it('uses the saved listening position when the app says a book is loaded, however old', async () => {
    seedListening(60 * 60_000);
    const res = await post({ text: 'Check the harbor log count', playerActive: true });

    expect(res.body.chapter).toBe('The Count');
    expect(notesOf('ch1')[0]).toMatchObject({ anchor: { blockIndex: 4, text: PARAGRAPH } });
  });

  it('uses a recently saved position when the caller does not say', async () => {
    seedListening(10_000);
    const res = await post({ text: 'Too slow here' });
    expect(res.body.chapter).toBe('The Count');
  });

  it('ignores an old position when the caller does not say, and asks which book', async () => {
    seedListening(RECENT_LISTENING_MS + 60_000);
    const res = await post({ text: 'Too slow here' });

    expect(res.body).toMatchObject({ saved: false, needsBook: true });
    expect(res.body.books.sort()).toEqual(['Saltmarsh', 'Tidewater']);
    expect(notesOf('ch1')).toEqual([]);
  });

  it('makes a book note when the player is not loaded, even with a fresh position', async () => {
    seedListening(1_000);
    const res = await post({ text: 'Rename the harbor', playerActive: false, bookName: 'saltmarsh' });

    expect(res.body).toEqual({ saved: true, book: 'Saltmarsh', spoken: 'Added a note to Saltmarsh.' });
    expect(notesOf('ch1')).toEqual([]);
    const bookNotes = fake.container('book-notes').all();
    expect(bookNotes).toEqual([expect.objectContaining({ bookId: 'b2', content: 'Rename the harbor' })]);
  });

  it('does not write to a chapter the user cannot reach', async () => {
    const res = await post({ text: 'sneaky', playerActive: true, playhead: { ...nativePlayhead, chapterId: 'x1' } });

    expect(res.body.needsBook).toBe(true);
    expect(notesOf('x1')).toEqual([]);
  });

  it('adds a general chapter note while the chapter title is being read', async () => {
    await post({ text: 'Better title?', playerActive: true, playhead: { ...nativePlayhead, blockIndex: -1, text: '' } });
    const [note] = notesOf('ch2');
    expect(note!['anchor']).toBeUndefined();
    expect(note!['selectedText']).toBe('');
  });

  it('drops a spoken "add a note that says" from the note', async () => {
    await post({ text: 'Add a note that says gulls are a motif', playerActive: true, playhead: nativePlayhead });
    expect(notesOf('ch2')[0]).toMatchObject({ noteText: 'Gulls are a motif' });
  });

  it('rejects an empty or oversized note', async () => {
    expect((await post({ text: '  ' })).status).toBe(400);
    expect((await post({ text: 'x'.repeat(2001) })).status).toBe(400);
  });
});

describe('add_chapter_note at the play head', () => {
  it('Siri\'s Ask Quill offers note tools and pins a note with no chapter named', async () => {
    create
      .mockResolvedValueOnce(toolCallStream('add_chapter_note', { note: 'Foreshadow the missing ship' }))
      .mockResolvedValueOnce(textStream('Added where you are listening.'));
    const res = await request(app)
      .post('/api/chat-sessions/voice')
      .set('x-test-user', USER_A)
      .send({ question: 'add a note: foreshadow the missing ship', playerActive: true, playhead: nativePlayhead });

    expect(res.body.answer).toBe('Added where you are listening.');
    const call = create.mock.calls[0][0];
    expect(call.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['add_chapter_note', 'add_book_note']));
    expect(call.input[0].content).toContain('READ-ALOUD PLAYER');
    expect(call.input[0].content).toContain('"Low Tide"');
    expect(notesOf('ch2')[0]).toMatchObject({ noteText: 'Foreshadow the missing ship', anchor: { blockIndex: 7 } });
  });

  it('quick chat pins a note to the play head the page sent', async () => {
    create
      .mockResolvedValueOnce(toolCallStream('add_chapter_note', { note: 'Count is wrong' }))
      .mockResolvedValueOnce(textStream('Done.'));
    const res = await request(app)
      .post('/api/chat-sessions/quick-chat')
      .set('x-test-user', USER_A)
      .send({
        messages: [{ role: 'user', content: 'note: count is wrong' }],
        playhead: { bookId: 'b1', bookTitle: 'Tidewater', chapterId: 'ch1', chapterTitle: 'The Count', blockIndex: 4, text: PARAGRAPH },
      });

    expect(res.text).toContain('chapterUpdated');
    expect(notesOf('ch1')[0]).toMatchObject({ noteText: 'Count is wrong', anchor: { blockIndex: 4, text: PARAGRAPH } });
  });

  it('pins a note to the play head when the named chapter is the one playing', async () => {
    create
      .mockResolvedValueOnce(toolCallStream('add_chapter_note', { chapterName: 'Low Tide', note: 'n' }))
      .mockResolvedValueOnce(textStream('Done.'));
    await request(app)
      .post('/api/chat-sessions/quick-chat')
      .set('x-test-user', USER_A)
      .send({ messages: [{ role: 'user', content: 'add a note to Low Tide' }], playhead: nativePlayhead });
    expect(notesOf('ch2')[0]).toMatchObject({ anchor: { blockIndex: 7 } });
  });

  it('adds an unpinned note to another named chapter', async () => {
    create
      .mockResolvedValueOnce(toolCallStream('add_chapter_note', { chapterName: 'The Count', note: 'n' }))
      .mockResolvedValueOnce(textStream('Done.'));
    await request(app)
      .post('/api/chat-sessions/quick-chat')
      .set('x-test-user', USER_A)
      .send({ messages: [{ role: 'user', content: 'add a note to The Count' }], playhead: nativePlayhead });
    expect(notesOf('ch1')[0]).toMatchObject({ noteText: 'n', selectedText: '' });
    expect(notesOf('ch1')[0]!['anchor']).toBeUndefined();
  });

  it('quick chat without a play head ignores a fresh saved position and asks for a chapter', async () => {
    seedListening(1_000);
    create
      .mockResolvedValueOnce(toolCallStream('add_chapter_note', { note: 'n' }))
      .mockResolvedValueOnce(textStream('Which chapter?'));
    await request(app)
      .post('/api/chat-sessions/quick-chat')
      .set('x-test-user', USER_A)
      .send({ messages: [{ role: 'user', content: 'add a note' }] });

    expect(create.mock.calls[0][0].input[0].content).not.toContain('READ-ALOUD PLAYER');
    const toolOutput = create.mock.calls[1][0].input.find((i: { type?: string }) => i.type === 'function_call_output');
    expect(JSON.parse(toolOutput.output)).toMatchObject({ added: false, needChapter: true });
    expect(notesOf('ch1')).toEqual([]);
  });
});
