import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { dialogueBlocks } from '@app/core/read-aloud/dialogue-paragraphs';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { DialogueTaggingService } from '@app/features/chapters/dialogue-tagging.service';
import { ChapterDialogue } from '@shared/models/dialogue.model';
import { Entity } from '@shared/models/entity.model';
import { DialogueHighlightsService } from './dialogue-highlights';
import { DialogueSpeakersComponent, speakingCharacters } from './dialogue-speakers';

const person = (id: string, name: string, over: Partial<Entity> = {}) =>
  ({ id, name, type: 'PERSON', seriesId: 's', ...over }) as Entity;
const ANN = person('ann', 'Ann', { sortOrder: 1, voiceId: 'azure:Ann', thumbnailUrl: 'https://blob/x/ann_thumb.webp' });
const BOB = person('bob', 'Bob', { sortOrder: 2 });
const HTML = '<p>"Hi," Ann said. "Yo," said Bob.</p><p>"New line," someone said.</p>';

describe('speakingCharacters', () => {
  it('keeps live characters in a stable order', () => {
    const list = speakingCharacters([
      person('z', 'Zed'), BOB, ANN, person('gone', 'Gone', { archived: true }), { ...person('p', 'Town'), type: 'PLACE' } as Entity,
    ]);
    expect(list.map(e => e.id)).toEqual(['ann', 'bob', 'z']);
  });
});

describe('DialogueSpeakersComponent', () => {
  // jsdom does no layout.
  beforeAll(() => {
    Range.prototype.getBoundingClientRect ??= () => new DOMRect(10, 10, 50, 16);
    Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  });

  function setup(dialogue: ChapterDialogue | undefined, visible = true) {
    const editor = document.createElement('div');
    editor.innerHTML = HTML;
    document.body.appendChild(editor);
    const update = vi.fn();
    const remove = vi.fn();
    const setSpeaker = vi.fn().mockResolvedValue(null);
    const tagging = {
      dialogue: signal<Record<string, ChapterDialogue>>(dialogue ? { ch: dialogue } : {}),
      tagging: signal(new Set<string>()),
      setSpeaker,
    };
    TestBed.configureTestingModule({
      imports: [DialogueSpeakersComponent],
      providers: [
        { provide: DialogueTaggingService, useValue: tagging },
        { provide: DialogueHighlightsService, useValue: { visible: signal(visible), update, remove } },
        { provide: ReadAloudService, useValue: { azureCatalog: signal([{ id: 'azure:Ann', name: 'Ann Neural' }]) } },
      ],
    });
    const fixture = TestBed.createComponent(DialogueSpeakersComponent);
    fixture.componentRef.setInput('editor', editor);
    fixture.componentRef.setInput('chapterId', 'ch');
    fixture.componentRef.setInput('entities', [BOB, ANN]);
    fixture.detectChanges();
    TestBed.tick();
    const el = fixture.nativeElement as HTMLElement;
    const caretIn = (text: string) => {
      const node = [...editor.querySelectorAll('p')].map(p => p.firstChild as Text).find(t => t.data.includes(text))!;
      const range = document.createRange();
      range.setStart(node, node.data.indexOf(text) + 1);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
    };
    return { fixture, cmp: fixture.componentInstance, el, editor, update, remove, setSpeaker, tagging, caretIn };
  }

  const key = (i: number) => dialogueBlocks(HTML)[i]!.key!;

  afterEach(() => document.body.innerHTML = '');

  /** Points at the line holding `text`, as hovering it would. */
  function hoverLine(cmp: DialogueSpeakersComponent, caretIn: (t: string) => void, text: string) {
    caretIn(text);
    (cmp as unknown as { hovered: { set(l: unknown): void } }).hovered.set(cmp.lineAtSelection());
    TestBed.tick();
  }
  const lastGroups = (update: ReturnType<typeof vi.fn>) =>
    update.mock.calls.at(-1)![1] as Map<string, Range[]>;
  const painted = (groups: Map<string, Range[]>) =>
    [...groups].map(([name, ranges]) => [name, ranges.map(r => r.toString())]);

  it('paints no dialogue until a line is pointed at', () => {
    const { update } = setup({ [key(0)]: ['ann', null] });
    expect(painted(lastGroups(update))).toEqual([]);
  });

  it('colors only the hovered line, by speaker, narration or not-yet-attributed', () => {
    const { update, cmp, caretIn } = setup({ [key(0)]: ['ann', null] });
    hoverLine(cmp, caretIn, 'Hi');
    expect(painted(lastGroups(update))).toEqual([['dialogue-0', ['"Hi,"']]]);
    hoverLine(cmp, caretIn, 'Yo');
    expect(painted(lastGroups(update))).toEqual([['dialogue-none', ['"Yo,"']]]);
    hoverLine(cmp, caretIn, 'New line');
    expect(painted(lastGroups(update))).toEqual([['dialogue-pending', ['"New line,"']]]);
    (cmp as unknown as { hovered: { set(l: unknown): void } }).hovered.set(null);
    TestBed.tick();
    expect(painted(lastGroups(update))).toEqual([]);
  });

  it('keeps the line colored while its speaker card is open', () => {
    const { update, cmp, caretIn } = setup({ [key(0)]: ['ann', null] });
    caretIn('Hi');
    cmp.openChanger(cmp.lineAtSelection()!);
    TestBed.tick();
    expect(painted(lastGroups(update))).toEqual([['dialogue-0', ['"Hi,"']]]);
  });

  it('marks a hovered line without a speaker as being worked out while tagging runs', () => {
    const { update, tagging, cmp, caretIn } = setup({ [key(0)]: ['ann', null] });
    tagging.tagging.set(new Set(['ch']));
    hoverLine(cmp, caretIn, 'New line');
    expect(painted(lastGroups(update))).toEqual([['dialogue-working', ['"New line,"']]]);
  });

  it('paints nothing when dialogue colors are off, but still finds lines for the card', () => {
    const { update, remove, cmp, caretIn } = setup({ [key(0)]: ['ann', null] }, false);
    expect(update).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
    caretIn('Hi');
    expect(cmp.lineAtSelection()?.text).toBe('"Hi,"');
  });

  it('shows each character\'s picture, or their initial when they have none', () => {
    const { fixture, cmp, el, caretIn } = setup({ [key(0)]: ['ann', null] });
    caretIn('Hi');
    cmp.openChanger(cmp.lineAtSelection()!);
    fixture.detectChanges();
    const header = el.querySelector<HTMLImageElement>('.dlg-who img.dlg-photo')!;
    expect(header.getAttribute('src')).toBe('/api/image/ann_thumb.webp');
    const options = [...el.querySelectorAll('.dlg-option')];
    expect(options[0]!.querySelector('img')?.getAttribute('src')).toBe('/api/image/ann_thumb.webp');
    expect(options[1]!.querySelector('.dlg-swatch-initial')?.textContent).toBe('B');
  });

  it('opens the speaker list from the caret and saves the choice', async () => {
    const { fixture, cmp, el, caretIn, setSpeaker } = setup({ [key(0)]: ['ann', null] });
    caretIn('Yo');
    const line = cmp.lineAtSelection()!;
    expect(line.text).toBe('"Yo,"');
    cmp.openChanger(line);
    fixture.detectChanges();
    expect(el.textContent).toContain('No speaker');
    const options = [...el.querySelectorAll<HTMLButtonElement>('.dlg-option')];
    expect(options.map(o => o.querySelector('.dlg-option-name')!.textContent)).toEqual(['Ann', 'Bob', 'No speaker (narration voice)']);
    options[1]!.click();
    await Promise.resolve();
    expect(setSpeaker).toHaveBeenCalledWith('ch', key(0), 1, 'bob');
    await new Promise(r => setTimeout(r));
    fixture.detectChanges();
    expect(el.querySelector('.dlg-card')).toBeNull();
  });

  it('names the speaker and their voice', () => {
    const { fixture, cmp, el, caretIn } = setup({ [key(0)]: ['ann', null] });
    caretIn('Hi');
    cmp.openChanger(cmp.lineAtSelection()!);
    cmp.changing.set(false);
    fixture.detectChanges();
    expect(el.querySelector('.dlg-name')!.textContent).toBe('Ann');
    expect(el.textContent).toContain('Read in Ann Neural');
  });

  it('explains a line that has no speaker yet, without offering a change', () => {
    const { fixture, cmp, el, caretIn } = setup({ [key(0)]: ['ann', null] });
    caretIn('New line');
    cmp.openChanger(cmp.lineAtSelection()!);
    fixture.detectChanges();
    expect(el.textContent).toContain('worked out when the chapter is saved');
    expect(el.querySelector('.dlg-change, .dlg-option')).toBeNull();
  });

  it('shows why a change failed', async () => {
    const { fixture, cmp, el, caretIn, setSpeaker } = setup({ [key(0)]: ['ann', null] });
    setSpeaker.mockResolvedValue('Nope');
    caretIn('Hi');
    cmp.openChanger(cmp.lineAtSelection()!);
    await cmp.choose(null);
    fixture.detectChanges();
    expect(el.querySelector('.dlg-error')!.textContent).toBe('Nope');
  });

  it('has no line at the caret outside dialogue', () => {
    const { cmp, caretIn } = setup({});
    caretIn('Ann said');
    expect(cmp.lineAtSelection()).toBeNull();
  });
});
