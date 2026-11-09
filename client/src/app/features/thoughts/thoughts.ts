import {
  Component,
  inject,
  signal,
  computed,
  OnInit,
  ChangeDetectionStrategy,
  ElementRef,
  viewChild,
} from '@angular/core';
import { COMMA, ENTER } from '@angular/cdk/keycodes';
import { MatAutocompleteModule, MatAutocompleteSelectedEvent } from '@angular/material/autocomplete';
import { MatChipInputEvent } from '@angular/material/chips';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TextFieldModule } from '@angular/cdk/text-field';
import { ThoughtsService } from './thoughts.service';
import { HeaderService } from '@app/core/services/header.service';
import { UserSettingsService } from '@app/core/services/user-settings.service';
import {
  Thought,
  ThoughtTagCount,
  THOUGHT_PAGE_SIZE_OPTIONS,
  normalizeThoughtTags,
} from '@shared/models/thought.model';
import { v4 as uuidv4 } from 'uuid';
import { SlideOutPanelContainer } from '@app/shared/slide-out-panel-container/slide-out-panel-container';

@Component({
  selector: 'app-thoughts',
  imports: [
    FormsModule,
    ReactiveFormsModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
    MatProgressSpinnerModule,
    MatChipsModule,
    MatDividerModule,
    TextFieldModule,
    MatAutocompleteModule,
    MatPaginatorModule,
    MatTooltipModule,
    SlideOutPanelContainer,
  ],
  templateUrl: './thoughts.html',
  styleUrl: './thoughts.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThoughtsComponent implements OnInit {
  private thoughtsService = inject(ThoughtsService);
  private headerService = inject(HeaderService);
  private userSettings = inject(UserSettingsService);
  private fb = inject(FormBuilder);
  private snackBar = inject(MatSnackBar);

  readonly pageSizeOptions = [...THOUGHT_PAGE_SIZE_OPTIONS];
  readonly separatorKeys = [ENTER, COMMA] as const;

  /** The current page of thoughts, newest first (the server sorts). */
  thoughts = signal<Thought[]>([]);
  /** Thoughts matching the tag filter, across all pages. */
  total = signal(0);
  /** Every tag on the user's thoughts, with counts. */
  allTags = signal<ThoughtTagCount[]>([]);
  /** Filter: show only thoughts carrying every one of these tags. */
  selectedTags = signal<string[]>([]);
  pageIndex = signal(0);
  readonly pageSize = this.userSettings.thoughtsPageSize;

  loading = signal(false);
  /** True once the first page has arrived, so later reloads don't flash "Loading…". */
  loaded = signal(false);
  showPanel = signal(false);
  editingThought = signal<Thought | null>(null);
  isNew = signal(false);
  saving = signal(false);

  /** Tags on the thought in the edit panel. */
  editTags = signal<string[]>([]);
  tagQuery = signal('');
  private tagInputEl = viewChild<ElementRef<HTMLInputElement>>('tagInput');
  private listTop = viewChild<ElementRef<HTMLElement>>('listTop');

  form: FormGroup = this.fb.group({
    title: [''],
    content: ['', Validators.required],
  });

  /** Filter chips: every known tag, plus any selected tag no thought carries any more. */
  filterTags = computed<ThoughtTagCount[]>(() => {
    const known = this.allTags();
    const keys = new Set(known.map((t) => t.tag.toLowerCase()));
    const orphans = this.selectedTags()
      .filter((t) => !keys.has(t.toLowerCase()))
      .map((tag) => ({ tag, count: 0 }));
    return [...known, ...orphans];
  });

  /** Autocomplete for the tag editor: known tags not already on the thought, matching the typed text. */
  tagSuggestions = computed(() => {
    const typed = this.tagQuery().trim().toLowerCase();
    const current = new Set(this.editTags().map((t) => t.toLowerCase()));
    return this.allTags()
      .map((t) => t.tag)
      .filter((t) => !current.has(t.toLowerCase()) && (!typed || t.toLowerCase().includes(typed)))
      .slice(0, 20);
  });

  /** Number of the last request sent, so a slow stale response can't overwrite a newer one. */
  private requestSeq = 0;

  ngOnInit(): void {
    this.headerService.clearAll();
    this.load();
  }

  private load(): void {
    const seq = ++this.requestSeq;
    this.loading.set(true);
    this.thoughtsService
      .getPage({
        tags: this.selectedTags(),
        offset: this.pageIndex() * this.pageSize(),
        limit: this.pageSize(),
      })
      .subscribe({
        next: (page) => {
          if (seq !== this.requestSeq) return;
          // The page we were on emptied out (e.g. its last thought was deleted): step back.
          if (page.items.length === 0 && page.total > 0 && this.pageIndex() > 0) {
            this.pageIndex.set(Math.max(0, Math.ceil(page.total / this.pageSize()) - 1));
            this.load();
            return;
          }
          this.thoughts.set(page.items);
          this.total.set(page.total);
          this.allTags.set(page.tags);
          this.loading.set(false);
          this.loaded.set(true);
        },
        error: () => {
          if (seq === this.requestSeq) this.loading.set(false);
        },
      });
  }

  // ── Filter & paging ────────────────────────────────────────────────────────

  isTagSelected(tag: string): boolean {
    const key = tag.toLowerCase();
    return this.selectedTags().some((t) => t.toLowerCase() === key);
  }

  toggleFilterTag(tag: string): void {
    const key = tag.toLowerCase();
    this.selectedTags.update((list) =>
      this.isTagSelected(tag) ? list.filter((t) => t.toLowerCase() !== key) : [...list, tag],
    );
    this.pageIndex.set(0);
    this.load();
  }

  clearFilter(): void {
    if (!this.selectedTags().length) return;
    this.selectedTags.set([]);
    this.pageIndex.set(0);
    this.load();
  }

  onPage(event: PageEvent): void {
    if (event.pageSize !== this.pageSize()) {
      // Keep the first thought currently shown on screen in view at the new size.
      const firstShown = this.pageIndex() * this.pageSize();
      this.userSettings.setThoughtsPageSize(event.pageSize);
      this.pageIndex.set(Math.floor(firstShown / event.pageSize));
    } else {
      this.pageIndex.set(event.pageIndex);
    }
    this.load();
    this.listTop()?.nativeElement.scrollIntoView({ block: 'start' });
  }

  // ── Tag editor ─────────────────────────────────────────────────────────────

  addTag(event: MatChipInputEvent): void {
    this.addTags(event.value.split(','));
    event.chipInput.clear();
    this.tagQuery.set('');
  }

  onTagSelected(event: MatAutocompleteSelectedEvent): void {
    this.addTags([event.option.value as string]);
    const input = this.tagInputEl()?.nativeElement;
    if (input) input.value = '';
    this.tagQuery.set('');
  }

  private addTags(raw: string[]): void {
    // Reuse the spelling of a tag that already exists, so "plot" joins "Plot".
    const known = new Map(this.allTags().map((t) => [t.tag.toLowerCase(), t.tag]));
    const incoming = normalizeThoughtTags(raw).map((t) => known.get(t.toLowerCase()) ?? t);
    this.editTags.update((list) => normalizeThoughtTags([...list, ...incoming]));
  }

  removeTag(tag: string): void {
    this.editTags.update((list) => list.filter((t) => t !== tag));
  }

  openNew(): void {
    this.isNew.set(true);
    this.editingThought.set(null);
    this.form.reset({ title: '', content: '' });
    // A new thought starts with the tags being filtered on, so it shows up in the current view.
    this.editTags.set([...this.selectedTags()]);
    this.tagQuery.set('');
    this.showPanel.set(true);
  }

  openEdit(thought: Thought): void {
    this.isNew.set(false);
    this.editingThought.set(thought);
    this.form.setValue({ title: thought.title ?? '', content: thought.content });
    this.editTags.set([...(thought.tags ?? [])]);
    this.tagQuery.set('');
    this.showPanel.set(true);
  }

  onPanelChanged(open: boolean): void {
    this.showPanel.set(open);
    if (!open) this.editingThought.set(null);
  }

  closePanel(): void {
    this.showPanel.set(false);
    this.editingThought.set(null);
  }

  save(): void {
    if (this.form.invalid || this.saving()) return;

    // Keep a tag that was typed but not yet committed with Enter.
    const pending = this.tagInputEl()?.nativeElement;
    if (pending?.value.trim()) {
      this.addTags(pending.value.split(','));
      pending.value = '';
      this.tagQuery.set('');
    }

    const { title, content } = this.form.getRawValue() as { title: string; content: string };
    this.saving.set(true);

    if (this.isNew()) {
      const thought: Partial<Thought> = {
        id: uuidv4(),
        title: title.trim() || undefined,
        content: content.trim(),
        tags: this.editTags(),
      };
      this.thoughtsService.create(thought).subscribe({
        next: () => {
          this.pageIndex.set(0);
          this.load();
          this.saving.set(false);
          this.closePanel();
        },
        error: () => this.saving.set(false),
      });
    } else {
      const existing = this.editingThought();
      if (!existing) return;
      this.thoughtsService
        .update(existing.id, {
          title: title.trim() || undefined,
          content: content.trim(),
          tags: this.editTags(),
        })
        .subscribe({
          next: () => {
            // Reload rather than patch: the edit moves it to the top and may change
            // whether it matches the filter, and the tag counts.
            this.load();
            this.saving.set(false);
            this.closePanel();
          },
          error: () => this.saving.set(false),
        });
    }
  }

  delete(thought: Thought): void {
    this.thoughtsService.delete(thought.id).subscribe({
      next: () => {
        this.load();
        if (this.editingThought()?.id === thought.id) this.closePanel();

        const ref = this.snackBar.open('Thought deleted', 'Undo', { duration: 5000 });
        ref.onAction().subscribe(() => {
          this.thoughtsService.restore(thought.id).subscribe({
            next: () => this.load(),
          });
        });
      },
    });
  }

  formatDate(iso: string | undefined): string {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
}
