import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { CdkTextareaAutosize, TextFieldModule } from '@angular/cdk/text-field';
import {
  MAX_TASK_BODY_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  TaskBookOption,
  TaskListItem,
  TaskStatusFilter,
} from '@shared/models/task.model';
import { HeaderService } from '@app/core/services/header.service';
import { SlideOutPanelContainer } from '@app/shared/slide-out-panel-container/slide-out-panel-container';
import { TasksService, dueLabel, formatTaskDate, localToday } from './tasks.service';
import { TaskBodyComponent } from './task-body';

/** Remembers the last book a task was filed under, as the default for the next one. */
const LAST_BOOK_KEY = 'quill.tasks.lastBookId';

@Component({
  selector: 'app-tasks',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatCheckboxModule,
    MatDividerModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    TextFieldModule,
    SlideOutPanelContainer,
    TaskBodyComponent,
  ],
  templateUrl: './tasks.html',
  styleUrl: './tasks.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TasksComponent implements OnInit {
  private tasksService = inject(TasksService);
  private headerService = inject(HeaderService);
  private fb = inject(FormBuilder);
  private snackBar = inject(MatSnackBar);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  static readonly SEARCH_DEBOUNCE_MS = 300;
  static readonly PAGE_LIMIT = 500;

  readonly maxTitle = MAX_TASK_TITLE_LENGTH;
  readonly maxBody = MAX_TASK_BODY_LENGTH;

  tasks = signal<TaskListItem[]>([]);
  total = signal(0);
  books = signal<TaskBookOption[]>([]);
  status = signal<TaskStatusFilter>('open');
  bookFilter = signal<string>('');
  searchText = signal('');
  appliedSearch = signal('');
  loading = signal(false);
  loaded = signal(false);
  /** Tasks whose checkbox is mid-request, so a double click can't send two. */
  toggling = signal<ReadonlySet<string>>(new Set());

  showPanel = signal(false);
  editing = signal<TaskListItem | null>(null);
  isNew = signal(false);
  saving = signal(false);

  readonly today = signal(localToday());
  readonly filtered = computed(() => !!this.bookFilter() || !!this.appliedSearch());

  form = this.fb.nonNullable.group({
    title: ['', [Validators.required, Validators.maxLength(MAX_TASK_TITLE_LENGTH)]],
    bookId: ['', Validators.required],
    dueDate: [''],
    body: ['', Validators.maxLength(MAX_TASK_BODY_LENGTH)],
  });

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private requestSeq = 0;
  private bodyAutosize = viewChild(CdkTextareaAutosize);

  /** The details box measures itself while the panel is hidden; re-measure once it slides in. */
  private resizeBody(): void {
    setTimeout(() => this.bodyAutosize()?.resizeToFitContent(true));
  }

  ngOnInit(): void {
    this.headerService.clearAll();
    this.load();
    this.destroyRef.onDestroy(() => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
    });
    // ?open=<id> (a link from chat, the home tile, or a notification) opens that task.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
      const id = params.get('open');
      if (id) this.openById(id);
      else if (params.get('new') === '1') {
        this.openNew();
        this.router.navigate([], { relativeTo: this.route, queryParams: { new: null }, queryParamsHandling: 'merge', replaceUrl: true });
      }
    });
  }

  private openById(id: string): void {
    this.tasksService.get(id).subscribe({
      next: task => this.openEdit(task),
      error: () => this.snackBar.open('That task could not be found', undefined, { duration: 4000 }),
    });
    this.router.navigate([], { relativeTo: this.route, queryParams: { open: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  load(): void {
    const seq = ++this.requestSeq;
    this.loading.set(true);
    this.today.set(localToday());
    this.tasksService
      .getPage({
        status: this.status(),
        bookId: this.bookFilter() || undefined,
        q: this.appliedSearch(),
        limit: TasksComponent.PAGE_LIMIT,
      })
      .subscribe({
        next: page => {
          if (seq !== this.requestSeq) return;
          this.tasks.set(page.items);
          this.total.set(page.total);
          this.books.set(page.books);
          this.loading.set(false);
          this.loaded.set(true);
        },
        error: () => {
          if (seq !== this.requestSeq) return;
          this.loading.set(false);
          this.loaded.set(true);
          this.snackBar.open('Couldn’t load tasks', 'Retry', { duration: 6000 }).onAction().subscribe(() => this.load());
        },
      });
  }

  // ── Filters ────────────────────────────────────────────────────────────────

  setStatus(status: TaskStatusFilter): void {
    if (status === this.status()) return;
    this.status.set(status);
    this.load();
  }

  setBookFilter(bookId: string): void {
    this.bookFilter.set(bookId);
    this.load();
  }

  onSearchInput(value: string): void {
    this.searchText.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.applySearch(), TasksComponent.SEARCH_DEBOUNCE_MS);
  }

  applySearch(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    const q = this.searchText().trim();
    if (q === this.appliedSearch()) return;
    this.appliedSearch.set(q);
    this.load();
  }

  clearFilters(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchText.set('');
    this.appliedSearch.set('');
    this.bookFilter.set('');
    this.load();
  }

  // ── Display helpers ────────────────────────────────────────────────────────

  dueText(task: TaskListItem): string {
    if (task.completed) return task.completedAt ? `Done ${formatTaskDate(task.completedAt.slice(0, 10))}` : 'Done';
    return dueLabel(task.dueDate, this.today());
  }

  isOverdue(task: TaskListItem): boolean {
    return !task.completed && !!task.dueDate && task.dueDate < this.today();
  }

  isDueSoon(task: TaskListItem): boolean {
    return !task.completed && !!task.dueDate && task.dueDate === this.today();
  }

  emptyMessage(): string {
    if (this.filtered()) return 'No tasks match your filters.';
    if (this.status() === 'completed') return 'No completed tasks yet.';
    if (this.status() === 'open') return 'Nothing to do — no open tasks.';
    return 'No tasks yet.';
  }

  // ── Completing ─────────────────────────────────────────────────────────────

  toggleComplete(task: TaskListItem): void {
    if (this.toggling().has(task.id)) return;
    const completed = !task.completed;
    this.toggling.update(s => new Set([...s, task.id]));
    // Optimistic: flip it in place; the list reorders on the next load.
    this.tasks.update(list => list.map(t => (t.id === task.id ? { ...t, completed } : t)));
    this.tasksService.setCompleted(task.id, completed).subscribe({
      next: () => {
        this.toggling.update(s => new Set([...s].filter(id => id !== task.id)));
        if (completed) {
          this.snackBar
            .open(`Completed “${task.title}”`, 'Undo', { duration: 5000 })
            .onAction()
            .subscribe(() => this.tasksService.setCompleted(task.id, false).subscribe({ next: () => this.load() }));
        }
        // Give the checkmark a moment before the task leaves the filtered list.
        setTimeout(() => this.load(), 400);
      },
      error: () => {
        this.toggling.update(s => new Set([...s].filter(id => id !== task.id)));
        this.tasks.update(list => list.map(t => (t.id === task.id ? { ...t, completed: task.completed } : t)));
        this.snackBar.open('Couldn’t update the task', undefined, { duration: 4000 });
      },
    });
  }

  // ── Editing ────────────────────────────────────────────────────────────────

  private defaultBookId(): string {
    const books = this.books();
    if (this.bookFilter()) return this.bookFilter();
    let remembered = '';
    try {
      remembered = localStorage.getItem(LAST_BOOK_KEY) ?? '';
    } catch {
      // Storage unavailable: fall through.
    }
    if (books.some(b => b.id === remembered)) return remembered;
    return books.length === 1 ? books[0].id : '';
  }

  openNew(): void {
    this.isNew.set(true);
    this.editing.set(null);
    this.form.reset({ title: '', bookId: this.defaultBookId(), dueDate: '', body: '' });
    this.showPanel.set(true);
    this.resizeBody();
  }

  openEdit(task: TaskListItem): void {
    this.isNew.set(false);
    this.editing.set(task);
    this.form.reset({ title: task.title, bookId: task.bookId, dueDate: task.dueDate ?? '', body: task.body ?? '' });
    this.showPanel.set(true);
    this.resizeBody();
  }

  onPanelChanged(open: boolean): void {
    this.showPanel.set(open);
    if (!open) this.editing.set(null);
  }

  closePanel(): void {
    this.showPanel.set(false);
    this.editing.set(null);
  }

  save(): void {
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }
    const { title, bookId, dueDate, body } = this.form.getRawValue();
    const draft = { title: title.trim(), bookId, dueDate: dueDate || null, body: body.trim() };
    this.saving.set(true);
    try {
      localStorage.setItem(LAST_BOOK_KEY, bookId);
    } catch {
      // Not essential.
    }
    const existing = this.editing();
    const request = this.isNew() || !existing ? this.tasksService.create(draft) : this.tasksService.update(existing.id, draft);
    request.subscribe({
      next: saved => {
        this.saving.set(false);
        this.load();
        if (this.isNew()) {
          this.closePanel();
          this.snackBar.open(saved.links?.length ? `Task added · linked ${this.linkCount(saved)}` : 'Task added', undefined, { duration: 3000 });
        } else {
          // Stay open so the author sees the refreshed links.
          this.editing.set(saved);
          this.snackBar.open('Task saved', undefined, { duration: 2500 });
        }
      },
      error: err => {
        this.saving.set(false);
        this.snackBar.open(err?.error?.error ?? 'Couldn’t save the task', undefined, { duration: 4000 });
      },
    });
  }

  linkCount(task: TaskListItem): string {
    const n = task.links?.length ?? 0;
    return `${n} reference${n === 1 ? '' : 's'}`;
  }

  /** The panel's view of the saved body is stale once the author edits the text. */
  bodyChanged(): boolean {
    return (this.editing()?.body ?? '') !== this.form.controls.body.value.trim();
  }

  delete(task: TaskListItem): void {
    this.tasksService.delete(task.id).subscribe({
      next: () => {
        this.load();
        if (this.editing()?.id === task.id) this.closePanel();
        this.snackBar
          .open('Task deleted', 'Undo', { duration: 5000 })
          .onAction()
          .subscribe(() => this.tasksService.restore(task.id).subscribe({ next: () => this.load() }));
      },
      error: () => this.snackBar.open('Couldn’t delete the task', undefined, { duration: 4000 }),
    });
  }
}
