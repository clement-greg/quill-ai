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
// The model is scripted per test: the first turn calls propose_entity with
// `toolArgs`, every later turn answers with plain text.
jest.mock('openai', () => {
  const create = jest.fn();
  return { AzureOpenAI: jest.fn(() => ({ chat: { completions: { create } } })), __create: create };
});

import chatSessionRoutes from './chat-sessions.routes';
import { makeTestApp, USER_A, USER_B } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const create = jest.requireMock('openai').__create as jest.Mock;
const app = makeTestApp('/api/chat-sessions', chatSessionRoutes);

async function* chunks(...deltas: object[]) {
  for (const delta of deltas) yield { choices: [{ delta }] };
}

function scriptToolCall(toolArgs: object, toolName = 'propose_entity'): void {
  create.mockImplementation(async (body: { messages: { role: string }[] }) => {
    const isFirstTurn = !body.messages.some(m => m.role === 'tool');
    return isFirstTurn
      ? chunks({ tool_calls: [{ index: 0, id: 'call-1', function: { name: toolName, arguments: JSON.stringify(toolArgs) } }] })
      : chunks({ content: 'The form is open for you to review.' });
  });
}

/** The tool result the route fed back to the model on the second turn. */
function toolResult(): Record<string, unknown> {
  const second = create.mock.calls[1]![0] as { messages: { role: string; content: string }[] };
  return JSON.parse(second.messages.find(m => m.role === 'tool')!.content);
}

function sseEvents(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter(l => l.startsWith('data: ') && l !== 'data: [DONE]')
    .map(l => JSON.parse(l.slice(6)));
}

async function quickChat(body: object = {}) {
  const res = await request(app)
    .post('/api/chat-sessions/quick-chat')
    .set('x-test-user', USER_A)
    .send({ messages: [{ role: 'user', content: 'Create an entity for him' }], ...body });
  return { res, events: sseEvents(res.text) };
}

const proposalOf = (events: Record<string, unknown>[]) =>
  events.find(e => e['proposeEntity'])?.['proposeEntity'] as
    | { entityId?: string; seriesId: string; seriesTitle: string; entity: Record<string, unknown>; chatImages?: unknown[] }
    | undefined;

type ToolDef = { function: { name: string; parameters: { properties: Record<string, unknown> } } };
const firstTurn = () => create.mock.calls[0]![0] as { messages: { role: string; content: string }[]; tools: ToolDef[] };
const toolNamed = (name: string) => firstTurn().tools.find(t => t.function.name === name);

const BLOB = 'https://acct.blob.core.windows.net/images';
const genImage = (id: string, prompt?: string) => ({
  url: `${BLOB}/${id}.png`,
  thumbnailUrl: `${BLOB}/${id}_thumb.webp`,
  ...(prompt ? { prompt } : {}),
});
const IMG1 = genImage('11111111-1111-1111-1111-111111111111', 'Malik in desert robes');
const IMG2 = genImage('22222222-2222-2222-2222-222222222222', 'Malik with a falcon');
const IMG3 = genImage('33333333-3333-3333-3333-333333333333');

beforeEach(() => {
  fake.reset();
  create.mockReset();
  fake.container('series').seed({ id: 's-sands', title: 'Sands of Time', owner: USER_A });
});

describe('propose_entity tool (quick chat)', () => {
  it('streams a normalized draft for review without saving an entity', async () => {
    scriptToolCall({
      name: 'Malik Rashid al-Harbi',
      type: 'PERSON',
      firstName: 'Malik',
      lastName: 'al-Harbi',
      nickname: 'Rashid',
      aliases: ['Malik Rashid', 'rashid', 'Malik Rashid al-Harbi', 'Malik Rashid'],
      preferredReference: 'title-last-name', // no title → rejected
      biography: 'A Bedouin sheikh.',
      gender: 'male',
      race: 'Martian',
    });

    const { res, events } = await quickChat({ entityOptions: { gender: ['Male', 'Female'], race: ['Arab', 'Other'] } });

    expect(res.status).toBe(200);
    expect(proposalOf(events)).toEqual({
      seriesId: 's-sands',
      seriesTitle: 'Sands of Time',
      entity: {
        name: 'Malik Rashid al-Harbi',
        type: 'PERSON',
        firstName: 'Malik',
        lastName: 'al-Harbi',
        nickname: 'Rashid',
        aliases: ['Malik Rashid'],
        biography: 'A Bedouin sheikh.',
        gender: 'Male',
      },
    });
    expect(toolResult()).toMatchObject({ ok: true, series: 'Sands of Time', droppedValues: ['race "Martian"'] });
    expect(fake.container('entities').all()).toEqual([]);
  });

  it('offers the author\'s options as enums in the tool schema', async () => {
    scriptToolCall({ name: 'X', type: 'THING' });
    await quickChat({ entityOptions: { gender: ['Male', 'Female'] } });

    const tools = (create.mock.calls[0]![0] as { tools: { function: { name: string; parameters: { properties: Record<string, { enum?: string[] }> } } }[] }).tools;
    const props = tools.find(t => t.function.name === 'propose_entity')!.function.parameters.properties;
    expect(props['gender']!.enum).toEqual(['Male', 'Female']);
    expect(props['race']!.enum).toBeUndefined();
  });

  it('drops person-only fields for places', async () => {
    scriptToolCall({ name: 'The Silver Oasis', type: 'PLACE', firstName: 'Silver', gender: 'Female', nickname: 'the Oasis' });
    const { events } = await quickChat();
    expect(proposalOf(events)!.entity).toEqual({ name: 'The Silver Oasis', type: 'PLACE', nickname: 'the Oasis' });
  });

  it('asks which series when the author has several and none is in context', async () => {
    fake.container('series').seed({ id: 's-other', title: 'Northern Lights', owner: USER_A });
    scriptToolCall({ name: 'Malik', type: 'PERSON' });

    const { events } = await quickChat();

    expect(proposalOf(events)).toBeUndefined();
    expect(toolResult()).toMatchObject({ ok: false, needSeries: true });
    expect((toolResult()['availableSeries'] as string[]).sort()).toEqual(['Northern Lights', 'Sands of Time']);
  });

  it('uses the series the client has in view, but a named series wins', async () => {
    fake.container('series').seed({ id: 's-other', title: 'Northern Lights', owner: USER_A });

    scriptToolCall({ name: 'Malik', type: 'PERSON' });
    expect(proposalOf((await quickChat({ seriesId: 's-other' })).events)!.seriesId).toBe('s-other');

    create.mockReset();
    scriptToolCall({ name: 'Malik', type: 'PERSON', seriesName: 'sands of time' });
    expect(proposalOf((await quickChat({ seriesId: 's-other' })).events)!.seriesId).toBe('s-sands');
  });

  it('ignores a series hint the user cannot access', async () => {
    fake.container('series').seed(
      { id: 's-other', title: 'Northern Lights', owner: USER_A },
      { id: 's-bob', title: 'Bob Series', owner: USER_B },
    );
    scriptToolCall({ name: 'Malik', type: 'PERSON' });
    const { events } = await quickChat({ seriesId: 's-bob' });
    expect(proposalOf(events)).toBeUndefined();
    expect(toolResult()).toMatchObject({ needSeries: true });
  });

  it('derives the series from the chapter being edited', async () => {
    fake.container('series').seed({ id: 's-other', title: 'Northern Lights', owner: USER_A });
    fake.container('books').seed({ id: 'b-1', title: 'Book One', seriesId: 's-other', owner: USER_A });
    fake.container('chapters').seed({ id: 'c-1', title: 'Ch 1', bookId: 'b-1', owner: USER_A, content: '' });
    const { buildChapterContextPrompt } = jest.requireMock('../services/chapter-ai-context');
    buildChapterContextPrompt.mockResolvedValue({ chapterTitle: 'Ch 1', contextSuffix: '', citations: [] });
    scriptToolCall({ name: 'Malik', type: 'PERSON' });

    const { events } = await quickChat({ chapterContext: { chapterId: 'c-1' } });

    expect(proposalOf(events)!.seriesId).toBe('s-other');
  });

  it('flags an existing entity with the same name, unless the author confirmed', async () => {
    fake.container('entities').seed({ id: 'e-1', name: 'Malik Rashid al-Harbi', type: 'PERSON', seriesId: 's-sands', owner: USER_A });

    scriptToolCall({ name: 'malik rashid al-harbi', type: 'PERSON' });
    const first = await quickChat();
    expect(proposalOf(first.events)).toBeUndefined();
    expect(toolResult()).toMatchObject({ ok: false, possibleDuplicate: { id: 'e-1', name: 'Malik Rashid al-Harbi' } });

    create.mockReset();
    scriptToolCall({ name: 'Malik Rashid al-Harbi', type: 'PERSON', confirmedNew: true });
    expect(proposalOf((await quickChat()).events)).toBeDefined();
  });
});

describe('chat pictures for entities', () => {
  it('drops anything that is not a generated image pair, and lists the rest for the model', async () => {
    scriptToolCall({ name: 'Malik', type: 'PERSON' });
    await quickChat({
      sessionImages: [
        IMG1,
        { url: 'https://evil.example/x.png', thumbnailUrl: 'https://evil.example/x_thumb.webp' },
        { url: IMG2.url, thumbnailUrl: IMG3.thumbnailUrl }, // mismatched pair
        { url: IMG2.url.replace('https:', 'http:'), thumbnailUrl: IMG2.thumbnailUrl.replace('https:', 'http:') },
        'nonsense',
        IMG2,
      ],
    });

    const system = firstTurn().messages[0]!.content;
    expect(system).toContain('[1] Malik in desert robes\n[2] Malik with a falcon');
    expect(system).not.toContain('[3]');
    expect(toolNamed('propose_entity')!.function.parameters.properties).toHaveProperty('profileImage');
    expect(toolNamed('propose_entity_pictures')).toBeDefined();
    expect(proposalOf(sseEvents((await quickChat()).res.text))!.chatImages).toBeUndefined();
  });

  it('offers no picture options when the chat has no pictures', async () => {
    scriptToolCall({ name: 'Malik', type: 'PERSON' });
    await quickChat();
    expect(toolNamed('propose_entity')!.function.parameters.properties).not.toHaveProperty('profileImage');
    expect(toolNamed('propose_entity_pictures')).toBeUndefined();
    expect(firstTurn().messages[0]!.content).not.toContain('PICTURES GENERATED');
  });

  it('puts the picked pictures on the draft: profile first in the gallery, no repeats', async () => {
    scriptToolCall({ name: 'Malik', type: 'PERSON', profileImage: 2, galleryImages: [1, 2, 3, 9] });

    const { events } = await quickChat({ sessionImages: [IMG1, IMG2, IMG3] });

    const proposal = proposalOf(events)!;
    expect(proposal.entity).toMatchObject({
      thumbnailUrl: IMG2.thumbnailUrl,
      originalUrl: IMG2.url,
      photos: [IMG2, IMG1, IMG3].map(({ url, thumbnailUrl }) => ({ url, thumbnailUrl })),
    });
    expect(proposal.chatImages).toEqual([IMG1, IMG2, IMG3]);
    expect(toolResult()['message']).toContain('a profile picture and 3 gallery pictures');
    expect(toolResult()['message']).toContain('Picture number(s) 9 do not exist');
    expect(fake.container('entities').all()).toEqual([]);
  });

  it('proposes pictures for an existing entity without writing anything', async () => {
    fake.container('entities').seed({ id: 'e-1', name: 'Malik Rashid al-Harbi', nickname: 'Rashid', type: 'PERSON', seriesId: 's-sands', owner: USER_A });
    scriptToolCall({ entityName: 'Rashid', profileImage: 1 }, 'propose_entity_pictures');

    const { events } = await quickChat({ sessionImages: [IMG1, IMG2] });

    expect(proposalOf(events)).toEqual({
      entityId: 'e-1',
      seriesId: 's-sands',
      seriesTitle: 'Sands of Time',
      entity: {
        name: 'Malik Rashid al-Harbi',
        type: 'PERSON',
        thumbnailUrl: IMG1.thumbnailUrl,
        originalUrl: IMG1.url,
        photos: [{ url: IMG1.url, thumbnailUrl: IMG1.thumbnailUrl }],
      },
      chatImages: [IMG1, IMG2],
    });
    expect(fake.container('entities').get('e-1')).not.toHaveProperty('thumbnailUrl');
  });

  it("will not propose pictures for someone else's entity or without valid picks", async () => {
    fake.container('entities').seed({ id: 'e-bob', name: 'Malik', type: 'PERSON', seriesId: 's-bob', owner: USER_B });
    scriptToolCall({ entityName: 'Malik', profileImage: 1 }, 'propose_entity_pictures');
    expect(proposalOf((await quickChat({ sessionImages: [IMG1] })).events)).toBeUndefined();
    expect(toolResult()).toMatchObject({ ok: false });

    create.mockReset();
    scriptToolCall({ entityName: 'Malik', profileImage: 5 }, 'propose_entity_pictures');
    await quickChat({ sessionImages: [IMG1] });
    expect(toolResult()['message']).toContain('No valid picture numbers');
  });
});
