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
const ANN = person('ann', 'Ann', { sortOrder: 1, voiceId: 'azure:Ann' });
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

  it('colors each line by speaker, narration and not-yet-attributed', () => {
    const { update } = setup({ [key(0)]: ['ann', null] });
    const groups = update.mock.calls.at(-1)![1] as Map<string, Range[]>;
    expect(groups.get('dialogue-0')!.map(r => r.toString())).toEqual(['"Hi,"']);
    expect(groups.get('dialogue-none')!.map(r => r.toString())).toEqual(['"Yo,"']);
    expect(groups.get('dialogue-pending')!.map(r => r.toString())).toEqual(['"New line,"']);
  });

  it('paints nothing when speaker colors are off', () => {
    const { update, remove } = setup({ [key(0)]: ['ann', null] }, false);
    expect(update).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
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
    expect(options.map(o => o.textContent!.trim())).toEqual(['Ann', 'Bob', 'No speaker (narration voice)check']);
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
