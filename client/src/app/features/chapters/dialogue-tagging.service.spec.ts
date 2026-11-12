import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { dialogueBlocks } from '@app/core/read-aloud/dialogue-paragraphs';
import { Chapter } from '@shared/models/chapter.model';
import { DialogueTaggingService, dialogueTagRequest } from './dialogue-tagging.service';

const CONTENT = '<p>Night fell.</p><p>"Hi," Ann said.</p><p>"Hello," said Bob.</p>';
const keys = () => dialogueBlocks(CONTENT).filter(b => b.key).map(b => b.key!);

describe('dialogueTagRequest', () => {
  it('sends every untagged paragraph with its lead-up', () => {
    const req = dialogueTagRequest({ content: CONTENT })!;
    expect(req.keys).toEqual(keys());
    expect(req.pending.map(p => p.text)).toEqual(['"Hi," Ann said.', '"Hello," said Bob.']);
    expect(req.pending[0]!.context).toBe('Night fell.');
    expect(req.pending[1]!.context).toBe('Night fell. "Hi," Ann said.');
  });

  it('is null when every paragraph is already tagged', () => {
    const [a, b] = keys();
    expect(dialogueTagRequest({ content: CONTENT, dialogue: { [a!]: ['ann'], [b!]: ['bob'] } })).toBeNull();
  });

  it('sends only the edited paragraph, and asks to drop its old tag', () => {
    const [a, b] = keys();
    const edited = CONTENT.replace('Hello', 'Hey there');
    const req = dialogueTagRequest({ content: edited, dialogue: { [a!]: ['ann'], [b!]: ['bob'] } })!;
    expect(req.pending.map(p => p.text)).toEqual(['"Hey there," said Bob.']);
    expect(req.keys).toContain(a!);
    expect(req.keys).not.toContain(b!);
  });

  it('asks to drop tags of deleted dialogue even when nothing is new', () => {
    const [a] = keys();
    const req = dialogueTagRequest({ content: '<p>"Hi," Ann said.</p>', dialogue: { [a!]: ['ann'], gone: ['bob'] } })!;
    expect(req).toEqual({ keys: [a], pending: [] });
  });

  it('is null for a chapter without dialogue', () => {
    expect(dialogueTagRequest({ content: '<p>Just narration.</p>' })).toBeNull();
    expect(dialogueTagRequest({})).toBeNull();
  });
});

describe('DialogueTaggingService', () => {
  let service: DialogueTaggingService;
  let http: HttpTestingController;
  const chapter: Chapter = { id: 'ch-1', title: 'One', bookId: 'b', content: CONTENT };

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(DialogueTaggingService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('posts the request, then skips the next save once the reply covers it', async () => {
    service.tag(chapter);
    const req = http.expectOne('/api/chapters/ch-1/dialogue');
    expect(req.request.body.pending.length).toBe(2);
    const [a, b] = keys();
    req.flush({ dialogue: { [a!]: ['ann'], [b!]: ['bob'] } });
    await Promise.resolve();
    await new Promise(r => setTimeout(r));
    // The save response still carries no dialogue, but the service remembers the reply.
    service.tag(chapter);
    http.expectNone('/api/chapters/ch-1/dialogue');
  });

  it('runs a save that arrives mid-request after it, not alongside it', async () => {
    service.tag(chapter);
    service.tag({ ...chapter, content: CONTENT + '<p>"Bye," Ann said.</p>' });
    const first = http.expectOne('/api/chapters/ch-1/dialogue');
    const [a, b] = keys();
    first.flush({ dialogue: { [a!]: ['ann'], [b!]: ['bob'] } });
    await new Promise(r => setTimeout(r));
    const second = http.expectOne('/api/chapters/ch-1/dialogue');
    expect(second.request.body.pending.map((p: { text: string }) => p.text)).toEqual(['"Bye," Ann said.']);
    second.flush({ dialogue: {} });
  });

  it('swallows errors so a save never fails', async () => {
    service.tag(chapter);
    http.expectOne('/api/chapters/ch-1/dialogue').flush('no', { status: 500, statusText: 'Server Error' });
    await new Promise(r => setTimeout(r));
    service.tag(chapter);
    http.expectOne('/api/chapters/ch-1/dialogue').flush({ dialogue: {} });
  });

  it('keeps the latest speakers per chapter, from loads and tagging', async () => {
    service.seed({ id: 'ch-1', dialogue: { a: ['ann'] } });
    expect(service.dialogue()['ch-1']).toEqual({ a: ['ann'] });
    service.tag(chapter);
    expect(service.tagging().has('ch-1')).toBe(true);
    // A load mid-tagging doesn't overwrite what tagging will report.
    service.seed({ id: 'ch-1', dialogue: {} });
    expect(service.dialogue()['ch-1']).toEqual({ a: ['ann'] });
    http.expectOne('/api/chapters/ch-1/dialogue').flush({ dialogue: { b: ['bob'] } });
    await new Promise(r => setTimeout(r));
    expect(service.dialogue()['ch-1']).toEqual({ b: ['bob'] });
    expect(service.tagging().has('ch-1')).toBe(false);
  });

  it('changes one line\'s speaker right away and keeps the server\'s answer', async () => {
    service.seed({ id: 'ch-1', dialogue: { k: ['ann', 'bob'] } });
    const done = service.setSpeaker('ch-1', 'k', 1, null);
    expect(service.dialogue()['ch-1']).toEqual({ k: ['ann', null] });
    const req = http.expectOne('/api/chapters/ch-1/dialogue');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ key: 'k', index: 1, entityId: null });
    req.flush({ dialogue: { k: ['ann', null] } });
    expect(await done).toBeNull();
  });

  it('rolls back a change the server refuses, with its reason', async () => {
    service.seed({ id: 'ch-1', dialogue: { k: ['ann'] } });
    const done = service.setSpeaker('ch-1', 'k', 0, 'bob');
    http.expectOne('/api/chapters/ch-1/dialogue').flush({ error: 'That line has changed' }, { status: 409, statusText: 'Conflict' });
    expect(await done).toBe('That line has changed');
    expect(service.dialogue()['ch-1']).toEqual({ k: ['ann'] });
  });

  it('won\'t change a line that has no speakers yet', async () => {
    service.seed({ id: 'ch-1', dialogue: {} });
    expect(await service.setSpeaker('ch-1', 'k', 0, 'bob')).toContain('Save the chapter first');
    http.expectNone('/api/chapters/ch-1/dialogue');
  });
});

