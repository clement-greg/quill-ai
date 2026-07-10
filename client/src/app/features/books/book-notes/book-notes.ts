import {
  Component, inject, signal, input, OnInit, OnDestroy,
  ElementRef, ViewChild, HostListener, effect, NgZone, ChangeDetectorRef,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { BookNote } from '@shared/models/book-note.model';
import { Entity, EntityReference } from '@shared/models/entity.model';
import { EntityService } from '@app/features/entities/entity.service';
import { v4 as uuidv4 } from 'uuid';

@Component({
  selector: 'app-book-notes',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    DragDropModule,
  ],
  templateUrl: './book-notes.html',
  styleUrl: './book-notes.scss',
})
export class BookNotesComponent implements OnInit, OnDestroy {
  @ViewChild('noteEditorEl') noteEditorRef!: ElementRef<HTMLDivElement>;

  private http = inject(HttpClient);
  private sanitizer = inject(DomSanitizer);
  private entityService = inject(EntityService);
  private zone = inject(NgZone);
  private cdr = inject(ChangeDetectorRef);

  bookId = input.required<string>();
  seriesId = input.required<string>();

  notes = signal<BookNote[]>([]);
  loading = signal(false);
  saving = signal(false);
  editingNoteId = signal<string | null>(null);
  editContent = signal('');

  entities = signal<Entity[]>([]);

  // Speech-to-text (push-to-talk)
  speechSupported = signal(false);
  pttActive = signal(false);
  pttDisplayText = signal('');
  sttConnected = signal(false);
  private speechRecognition: any;
  private pttTranscript = '';
  private pttSessionGen = 0;
  private pttAudioCtx: AudioContext | null = null;

  // Autocomplete
  autocompleteItems = signal<{ entity: Entity; text: string; isPreferred: boolean }[]>([]);
  autocompleteIndex = signal(0);
  autocompleteTop = signal(0);
  autocompleteLeft = signal(0);
  private currentWordRange: Range | null = null;

  // Inline editor content
  private editorContent = '';

  constructor() {
    effect(() => {
      const sid = this.seriesId();
      if (sid) {
        this.entityService.getBySeries(sid).subscribe({
          next: (e) => {
            this.entities.set(e);
            const currentNotes = this.notes();
            if (currentNotes.length > 0) {
              const synced = currentNotes.map(note => ({
                ...note,
                content: this.syncEntityReferences(note.content, e),
              }));
              if (synced.some((n, i) => n.content !== currentNotes[i].content)) {
                this.notes.set(synced);
              }
            }
          },
        });
      }
    });
  }

  ngOnInit(): void {
    this.loadNotes();
    this.initializeSpeechToText();
  }

  ngOnDestroy(): void {
    this.pttActive.set(false);
    try { this.speechRecognition?.stop(); } catch { /* ok */ }
  }

  loadNotes(): void {
    const id = this.bookId();
    if (!id) return;
    this.loading.set(true);
    this.http.get<BookNote[]>(`/api/book-notes/book/${id}`).subscribe({
      next: (data) => {
        const sorted = [...data].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        const entities = this.entities();
        const synced = entities.length > 0
          ? sorted.map(note => ({ ...note, content: this.syncEntityReferences(note.content, entities) }))
          : sorted;
        this.notes.set(synced);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  addNote(): void {
    const rawHtml = this.editorContent.trim();
    if (!rawHtml || rawHtml === '<br>') return;
    const note: BookNote = {
      id: uuidv4(),
      bookId: this.bookId(),
      content: rawHtml,
      sortOrder: this.notes().length,
    };
    this.saving.set(true);
    this.http.post<BookNote>('/api/book-notes', note).subscribe({
      next: (created) => {
        this.notes.update((list) => [...list, created]);
        this.saving.set(false);
        this.clearEditor();
      },
      error: () => this.saving.set(false),
    });
  }

  startEdit(note: BookNote): void {
    this.editingNoteId.set(note.id);
    this.editContent.set(note.content);
    setTimeout(() => {
      const el = document.querySelector<HTMLDivElement>('.note-edit-editor');
      if (el) {
        el.innerHTML = note.content;
        el.focus();
        // Move cursor to end
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    });
  }

  saveEdit(note: BookNote): void {
    const el = document.querySelector<HTMLDivElement>('.note-edit-editor');
    const content = el ? el.innerHTML : this.editContent();
    this.saving.set(true);
    this.http.put<BookNote>(`/api/book-notes/${note.id}`, { ...note, content }).subscribe({
      next: (updated) => {
        this.notes.update((list) => list.map((n) => (n.id === updated.id ? updated : n)));
        this.editingNoteId.set(null);
        this.saving.set(false);
      },
      error: () => this.saving.set(false),
    });
  }

  cancelEdit(): void {
    this.editingNoteId.set(null);
    this.autocompleteItems.set([]);
    this.currentWordRange = null;
  }

  deleteNote(note: BookNote): void {
    this.http.delete(`/api/book-notes/${note.id}`).subscribe({
      next: () => this.notes.update((list) => list.filter((n) => n.id !== note.id)),
    });
  }

  onDrop(event: CdkDragDrop<BookNote[]>): void {
    const list = [...this.notes()];
    moveItemInArray(list, event.previousIndex, event.currentIndex);
    this.notes.set(list);
    const reordered = list.map((n, i) => ({ id: n.id, sortOrder: i }));
    this.http.patch('/api/book-notes/reorder', reordered).subscribe();
  }

  safeHtml(html: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  proxyUrl(url: string | undefined): string | null {
    if (!url) return null;
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }

  // ── Speech-to-text (push-to-talk) ──────────────────────────────────────

  private initializeSpeechToText(): void {
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    this.speechSupported.set(!!Ctor);
  }

  pttPress(): void {
    if (this.pttActive() || !this.speechSupported()) return;
    this.pttActive.set(true);
    this.sttConnected.set(false);
    this.pttTranscript = '';
    this.pttDisplayText.set('');
    this.pttSessionGen++;
    const gen = this.pttSessionGen;

    this.playPttStartTone();

    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onaudiostart = () => {
      if (gen !== this.pttSessionGen) return;
      this.zone.run(() => { this.sttConnected.set(true); });
    };

    recognition.onresult = (event: any) => {
      if (gen !== this.pttSessionGen) return;
      this.zone.run(() => {
        let finalText = '';
        let interim = '';
        for (let i = 0; i < event.results.length; i++) {
          const text = event.results[i][0]?.transcript || '';
          if (event.results[i].isFinal) finalText += text;
          else interim += text;
        }
        this.pttTranscript = finalText;
        this.pttDisplayText.set((finalText + ' ' + interim).trim());
      });
    };

    recognition.onerror = (event: any) => {
      console.warn('[STT] error:', event.error, event.message);
    };

    recognition.onend = () => {
      if (gen !== this.pttSessionGen) return;
      this.zone.run(() => {
        this.sttConnected.set(false);
        if (this.pttActive()) {
          try { this.pttPress(); } catch { /* ok */ }
        }
      });
    };

    this.speechRecognition = recognition;
    try {
      recognition.start();
    } catch (e) {
      console.error('[STT] Failed to start:', e);
      this.pttActive.set(false);
    }
  }

  pttRelease(): void {
    if (!this.pttActive()) return;
    this.pttActive.set(false);
    this.playPttStopTone();

    const gen = this.pttSessionGen;
    setTimeout(() => {
      if (gen !== this.pttSessionGen) return;
      this.pttSessionGen++;
      this.sttConnected.set(false);
      try { this.speechRecognition?.stop(); } catch { /* ok */ }

      const text = (this.pttDisplayText() || this.pttTranscript || '').trim();
      if (text) {
        this.zone.run(() => {
          this.pttDisplayText.set('');
          this.editorContent = text;
          if (this.noteEditorRef?.nativeElement) {
            this.noteEditorRef.nativeElement.innerHTML = text;
          }
          this.addNote();
        });
      } else {
        this.zone.run(() => { this.pttDisplayText.set(''); });
      }
    }, 1500);
  }

  private playPttStartTone(): void {
    try {
      const ctx = this.ensurePttAudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 600;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.12);
    } catch { /* ok */ }
  }

  private playPttStopTone(): void {
    try {
      const ctx = this.ensurePttAudioContext();
      const playTone = (freq: number, startTime: number, dur: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.12, startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(startTime);
        osc.stop(startTime + dur);
      };
      playTone(520, ctx.currentTime, 0.08);
      playTone(780, ctx.currentTime + 0.09, 0.1);
    } catch { /* ok */ }
  }

  private ensurePttAudioContext(): AudioContext {
    if (!this.pttAudioCtx || this.pttAudioCtx.state === 'closed') {
      this.pttAudioCtx = new AudioContext();
    }
    if (this.pttAudioCtx.state === 'suspended') {
      this.pttAudioCtx.resume().catch(() => { /* ok */ });
    }
    return this.pttAudioCtx;
  }

  // ── Contenteditable entry box ──────────────────────────

  onEditorInput(event: Event, isEdit = false): void {
    const el = event.target as HTMLDivElement;
    if (isEdit) {
      this.editContent.set(el.innerHTML);
    } else {
      this.editorContent = el.innerHTML;
    }
    this.checkAutocomplete(el);
  }

  onEditorKeyDown(event: KeyboardEvent, isEdit = false): void {
    const items = this.autocompleteItems();

    if (items.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.autocompleteIndex.set(Math.min(this.autocompleteIndex() + 1, items.length - 1));
        return;
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.autocompleteIndex.set(Math.max(this.autocompleteIndex() - 1, 0));
        return;
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const item = items[this.autocompleteIndex()];
        this.selectAutocomplete(item.entity, item.text);
        return;
      } else if (event.key === 'Escape') {
        this.autocompleteItems.set([]);
        this.currentWordRange = null;
        return;
      }
    }

    // Ctrl+Enter submits (add mode only)
    if (!isEdit && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.addNote();
      return;
    }

    // Eject cursor from entity-reference span
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
        const { startContainer } = sel.getRangeAt(0);
        const node = startContainer.nodeType === Node.TEXT_NODE
          ? startContainer.parentElement
          : startContainer as HTMLElement;
        if (node?.classList.contains('entity-reference')) {
          event.preventDefault();
          const textNode = document.createTextNode(event.key);
          node.after(textNode);
          const newRange = document.createRange();
          newRange.setStartAfter(textNode);
          newRange.collapse(true);
          sel.removeAllRanges();
          sel.addRange(newRange);
          const editorEl = event.target as HTMLDivElement;
          if (isEdit) this.editContent.set(editorEl.innerHTML);
          else this.editorContent = editorEl.innerHTML;
          this.checkAutocomplete(editorEl);
          return;
        }
      }
    }

    // Backspace removes entity span
    if (event.key === 'Backspace') {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        const { startContainer, startOffset } = range;
        let spanToDelete: HTMLElement | null = null;
        const node = startContainer.nodeType === Node.TEXT_NODE ? startContainer.parentElement : startContainer as HTMLElement;
        if (node?.classList.contains('entity-reference')) spanToDelete = node;
        if (!spanToDelete && startContainer.nodeType === Node.TEXT_NODE && startOffset === 0) {
          const prev = startContainer.previousSibling;
          if (prev instanceof HTMLElement && prev.classList.contains('entity-reference')) spanToDelete = prev;
        }
        if (!spanToDelete && startContainer.nodeType === Node.ELEMENT_NODE && startOffset > 0) {
          const prevNode = (startContainer as Element).childNodes[startOffset - 1];
          if (prevNode instanceof HTMLElement && prevNode.classList.contains('entity-reference')) spanToDelete = prevNode;
        }
        if (spanToDelete) {
          event.preventDefault();
          const newRange = document.createRange();
          newRange.setStartBefore(spanToDelete);
          newRange.collapse(true);
          spanToDelete.remove();
          sel.removeAllRanges();
          sel.addRange(newRange);
          const editorEl = event.target as HTMLDivElement;
          if (isEdit) this.editContent.set(editorEl.innerHTML);
          else this.editorContent = editorEl.innerHTML;
          return;
        }
      }
    }
  }

  selectAutocomplete(entity: Entity, text: string): void {
    if (!this.currentWordRange) return;
    const range = this.currentWordRange;
    this.currentWordRange = null;
    this.autocompleteItems.set([]);

    range.deleteContents();
    const span = document.createElement('span');
    span.setAttribute('data-id', entity.id);
    span.setAttribute('data-reference-type', this.getReferenceType(entity, text));
    span.className = 'entity-reference';
    span.textContent = text;
    range.insertNode(span);
    const space = document.createTextNode('\u00A0');
    span.after(space);
    const newRange = document.createRange();
    newRange.setStartAfter(space);
    newRange.collapse(true);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(newRange); }

    // Update stored content from whichever editor is active
    const activeEl = document.activeElement as HTMLDivElement | null;
    if (activeEl?.classList.contains('note-entry-editor') || activeEl?.classList.contains('note-edit-editor')) {
      if (activeEl.classList.contains('note-edit-editor')) this.editContent.set(activeEl.innerHTML);
      else this.editorContent = activeEl.innerHTML;
    }
  }

  @HostListener('document:mousedown', ['$event'])
  onDocumentMouseDown(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (!target.closest('.autocomplete-dropdown')) {
      this.autocompleteItems.set([]);
      this.currentWordRange = null;
    }
  }

  private clearEditor(): void {
    this.editorContent = '';
    if (this.noteEditorRef?.nativeElement) {
      this.noteEditorRef.nativeElement.innerHTML = '';
    }
  }

  private checkAutocomplete(el: HTMLDivElement): void {
    const result = this.getCurrentWordAtCursor();
    if (!result || result.word.length < 2) {
      this.autocompleteItems.set([]);
      this.currentWordRange = null;
      return;
    }
    const lower = result.word.toLowerCase();
    const flat: { entity: Entity; text: string; isPreferred: boolean }[] = [];
    for (const entity of this.entities()) {
      if (!this.entityMatchesWord(entity, lower)) continue;
      const preferred = this.getPreferredText(entity);
      const seen = new Set<string>([preferred]);
      flat.push({ entity, text: preferred, isPreferred: true });
      for (const v of this.allRefsFor(entity)) {
        if (!seen.has(v)) { seen.add(v); flat.push({ entity, text: v, isPreferred: false }); }
      }
    }
    if (flat.length === 0) {
      this.autocompleteItems.set([]);
      this.currentWordRange = null;
      return;
    }
    this.currentWordRange = result.range;
    this.autocompleteIndex.set(0);
    this.autocompleteItems.set(flat);
    const rect = this.getCursorRect();
    if (rect) {
      const itemHeight = 44; // approx px per item
      const estimatedHeight = Math.min(flat.length * itemHeight + 8, 240);
      const dropdownWidth = 320;
      const margin = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Clamp left so dropdown doesn't overflow the right edge
      const clampedLeft = Math.max(margin, Math.min(rect.left, vw - dropdownWidth - margin));

      // Show below cursor unless there isn't enough space, then flip above
      const spaceBelow = vh - rect.bottom;
      const top = spaceBelow >= estimatedHeight + margin
        ? rect.bottom + 4
        : rect.top - estimatedHeight - 4;

      this.autocompleteTop.set(top);
      this.autocompleteLeft.set(clampedLeft);
    }
  }

  private entityMatchesWord(entity: Entity, lower: string): boolean {
    return this.allRefsFor(entity).some((v) => v.toLowerCase().includes(lower));
  }

  private getReferenceType(entity: Entity, text: string): EntityReference {
    if (text === entity.name) return 'full-name';
    const refs = this.resolvedRefs(entity);
    if (refs.title) {
      if (text === `${refs.title} ${entity.name}`) return 'title-full-name';
      if (refs.lastName && text === `${refs.title} ${refs.lastName}`) return 'title-last-name';
    }
    if (refs.firstName && text === refs.firstName) return 'first-name';
    if (refs.lastName && text === refs.lastName) return 'last-name';
    if (refs.nickname && text === refs.nickname) return 'nickname';
    return 'other';
  }

  private getTextForReferenceType(entity: Entity, refType: EntityReference): string {
    const refs = this.resolvedRefs(entity);
    switch (refType) {
      case 'first-name': return refs.firstName || entity.name;
      case 'last-name': return refs.lastName || entity.name;
      case 'nickname': return refs.nickname || entity.name;
      case 'title-full-name': return refs.title ? `${refs.title} ${entity.name}` : entity.name;
      case 'title-last-name': return refs.title && refs.lastName ? `${refs.title} ${refs.lastName}` : entity.name;
      case 'other': return '';
      default: return entity.name;
    }
  }

  private syncEntityReferences(html: string, entities: Entity[]): string {
    if (!html) return html;
    const div = document.createElement('div');
    div.innerHTML = html;
    div.querySelectorAll<HTMLElement>('span[data-id][data-reference-type]').forEach(span => {
      const entity = entities.find(e => e.id === span.getAttribute('data-id'));
      if (!entity) return;
      const refType = span.getAttribute('data-reference-type') as EntityReference;
      if (refType === 'other') return;
      const expected = this.getTextForReferenceType(entity, refType);
      if (span.textContent !== expected) span.textContent = expected;
    });
    return div.innerHTML;
  }

  private getPreferredText(entity: Entity): string {
    const refs = this.resolvedRefs(entity);
    switch (entity.preferredReference) {
      case 'first-name': return refs.firstName || entity.name;
      case 'last-name': return refs.lastName || entity.name;
      case 'nickname': return refs.nickname || entity.name;
      case 'title-full-name': return refs.title ? `${refs.title} ${entity.name}` : entity.name;
      case 'title-last-name': return refs.title && refs.lastName ? `${refs.title} ${refs.lastName}` : entity.name;
      default: return entity.name;
    }
  }

  private resolvedRefs(entity: Entity): { title?: string; firstName?: string; lastName?: string; nickname?: string } {
    if (entity.type !== 'PERSON') return { nickname: entity.nickname };
    const parts = entity.name.trim().split(/\s+/);
    return {
      title: entity.title,
      firstName: entity.firstName || (parts.length >= 2 ? parts[0] : undefined),
      lastName: entity.lastName || (parts.length >= 2 ? parts[parts.length - 1] : undefined),
      nickname: entity.nickname,
    };
  }

  private allRefsFor(entity: Entity): string[] {
    const refs = this.resolvedRefs(entity);
    const titleFullName = refs.title ? `${refs.title} ${entity.name}` : undefined;
    const titleLastName = refs.title && refs.lastName ? `${refs.title} ${refs.lastName}` : undefined;
    return [entity.name, refs.firstName, refs.lastName, refs.nickname, titleFullName, titleLastName].filter((v): v is string => !!v);
  }

  private getCurrentWordAtCursor(): { word: string; range: Range } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null;
    const container = range.startContainer;
    if (container.nodeType !== Node.TEXT_NODE) return null;
    const text = container.textContent ?? '';
    const offset = range.startOffset;
    let start = offset;
    while (start > 0 && !/[\s\n]/.test(text[start - 1])) start--;
    const word = text.substring(start, offset);
    if (!word) return null;
    const wordRange = range.cloneRange();
    wordRange.setStart(container, start);
    wordRange.setEnd(container, offset);
    return { word, range: wordRange };
  }

  private getCursorRect(): DOMRect | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);
    return range.getBoundingClientRect();
  }
}
