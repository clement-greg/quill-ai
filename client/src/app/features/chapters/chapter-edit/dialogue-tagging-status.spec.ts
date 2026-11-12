import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DialogueTaggingService, TaggingProgress } from '../dialogue-tagging.service';
import { DialogueTaggingStatusComponent } from './dialogue-tagging-status';

describe('DialogueTaggingStatusComponent', () => {
  function setup() {
    const progress = signal<Record<string, TaggingProgress>>({});
    TestBed.configureTestingModule({
      imports: [DialogueTaggingStatusComponent],
      providers: [{ provide: DialogueTaggingService, useValue: { progress } }],
    });
    const fixture = TestBed.createComponent(DialogueTaggingStatusComponent);
    fixture.detectChanges();
    const text = () => { fixture.detectChanges(); return (fixture.nativeElement as HTMLElement).textContent!.replace(/\s+/g, ' ').trim(); };
    return { progress, text };
  }

  afterEach(() => vi.useRealTimers());

  it('shows nothing until dialogue is being attributed', () => {
    const { text } = setup();
    expect(text()).toBe('');
  });

  it('counts every chapter being attributed, then says when it\'s done', () => {
    vi.useFakeTimers();
    const { progress, text } = setup();
    progress.set({ a: { done: 20, total: 40 }, b: { done: 0, total: 4 } });
    TestBed.tick();
    expect(text()).toBe('Working out who says each line… 20 of 44');
    progress.set({});
    TestBed.tick();
    expect(text()).toContain('Speakers updated');
    vi.advanceTimersByTime(3000);
    expect(text()).toBe('');
  });

  it('ignores a run with nothing new to attribute', () => {
    const { progress, text } = setup();
    progress.set({ a: { done: 0, total: 0 } });
    TestBed.tick();
    progress.set({});
    TestBed.tick();
    expect(text()).toBe('');
  });
});
