import { Component, computed, inject, signal, OnInit, OnDestroy, ElementRef, Injector, afterNextRender, effect } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { forkJoin, Subscription } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTabsModule } from '@angular/material/tabs';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { BookService } from '../book.service';
import { ChapterService } from '@app/features/chapters/chapter.service';
import { SeriesService } from '@app/features/series/series.service';
import { EntityService } from '@app/features/entities/entity.service';
import { Book } from '@shared/models/book.model';
import { Chapter } from '@shared/models/chapter.model';
import { Entity } from '@shared/models/entity.model';
import { UserSettingsService } from '@app/core/services/user-settings.service';
import { v4 as uuidv4 } from 'uuid';
import { HeaderService } from '@app/core/services/header.service';
import { SeriesContextService } from '@app/core/services/series-context.service';
import { SlideOutPanelContainer } from '@app/shared/slide-out-panel-container/slide-out-panel-container';
import { BookNotesComponent } from '../book-notes/book-notes';
import { AiStatsComponent } from './ai-stats/ai-stats';
import { ChapterOutlineComponent } from '@app/features/chapters/chapter-edit/chapter-outline/chapter-outline';
import { OutlineItem } from '@shared/models/chapter.model';
import { BookAudioService } from '../book-audio/book-audio.service';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';

@Component({
  selector: 'app-book-detail',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatListModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    DragDropModule,
    MatMenuModule,
    MatTabsModule,
    SlideOutPanelContainer,
    BookNotesComponent,
    AiStatsComponent,
    ChapterOutlineComponent,
  ],
  templateUrl: './book-detail.html',
  styleUrl: './book-detail.scss',
})
export class BookDetailComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private userSettings = inject(UserSettingsService);
  private bookService = inject(BookService);
  private chapterService = inject(ChapterService);
  private seriesService = inject(SeriesService);
  private headerService = inject(HeaderService);
  private seriesContext = inject(SeriesContextService);
  private entityService = inject(EntityService);

  private http = inject(HttpClient);
  private readAloud = inject(ReadAloudService);
  readonly audio = inject(BookAudioService);

  /** Where the reader left off listening to this book, if anywhere. */
  readonly listenPosition = computed(() => {
    const id = this.book()?.id;
    const pos = id ? this.audio.positionFor(id) : null;
    return pos && !pos.finished ? pos : null;
  });
  readonly listenPercent = computed(() => Math.round((this.listenPosition()?.progress ?? 0) * 100));
  private readonly listenLoaded = computed(() => {
    const id = this.book()?.id;
    return !!id && this.audio.isLoaded(id);
  });
  readonly listenIcon = computed(() => (this.listenLoaded() && this.readAloud.state() === 'playing' ? 'headphones' : 'play_arrow'));
  readonly listenLabel = computed(() => {
    if (this.listenLoaded()) return this.readAloud.state() === 'playing' ? 'Now playing' : 'Continue';
    return this.listenPosition() ? 'Resume' : 'Listen';
  });

  /** Plays the book from where the reader left off (or from the start). */
  listen(fromStart = false): void {
    const id = this.book()?.id;
    if (id) void this.audio.listen(id, { fromStart });
  }

  book = signal<Book | null>(null);
  chapterList = signal<Chapter[]>([]);
  loading = signal(false);
  showPanel = signal(false);
  editingBook = signal<Book | null>(null);
  uploading = signal(false);
  thumbnailPreview = signal<string | null>(null);
  exporting = signal(false);
  /** The slide-out is only used for editing the book's title and cover now. */
  panelMode = signal<'edit' | null>(null);
  bookOutline = signal<OutlineItem[]>([]);
  /** Active series entities, shared by the Outline and AI Insights tabs. */
  seriesEntities = signal<Entity[]>([]);
  seriesId = signal<string>('');

  /** Side panel tab: 0 Outline, 1 Notes, 2 AI Insights. Remembered per browser. */
  static readonly SIDE_TAB_KEY = 'book-detail-side-tab';
  sideTab = signal(BookDetailComponent.loadSideTab());

  private static loadSideTab(): number {
    try {
      const n = Number(localStorage.getItem(BookDetailComponent.SIDE_TAB_KEY));
      return n >= 0 && n <= 2 ? n : 0;
    } catch {
      return 0;
    }
  }

  /** Side panel height: from its top to the bottom of the window, so the
   *  whole panel (e.g. the note composer at its foot) is always reachable,
   *  growing as the cover scrolls away. Null when it stacks (narrow screens). */
  sidePanelHeight = signal<number | null>(null);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private scroller: HTMLElement | null = null;
  private sizeFrame: number | null = null;
  private readonly scheduleSidePanelSize = (): void => {
    if (this.sizeFrame !== null) return;
    this.sizeFrame = requestAnimationFrame(() => {
      this.sizeFrame = null;
      this.updateSidePanelSize();
    });
  };

  private injector = inject(Injector);

  constructor() {
    // The cover image arrives with the book and pushes the panel down: re-measure.
    effect(() => {
      this.book();
      afterNextRender({ read: () => this.updateSidePanelSize() }, { injector: this.injector });
    });
    afterNextRender(() => {
      this.scroller = this.host.nativeElement.querySelector<HTMLElement>('[main-content]');
      this.scroller?.addEventListener('scroll', this.scheduleSidePanelSize, { passive: true });
      window.addEventListener('resize', this.scheduleSidePanelSize);
      this.updateSidePanelSize();
    });
  }

  private updateSidePanelSize(): void {
    const panel = this.host.nativeElement.querySelector<HTMLElement>('.book-side-panel');
    if (!panel || window.innerWidth < 1100) { this.sidePanelHeight.set(null); return; }
    const top = Math.max(panel.getBoundingClientRect().top, this.scroller?.getBoundingClientRect().top ?? 0);
    this.sidePanelHeight.set(Math.max(360, Math.round(window.innerHeight - top - 16)));
  }

  selectSideTab(index: number): void {
    this.sideTab.set(index);
    try { localStorage.setItem(BookDetailComponent.SIDE_TAB_KEY, String(index)); } catch { /* storage unavailable */ }
  }
  private routeSub?: Subscription;

  private outlineSaveTimer: ReturnType<typeof setTimeout> | null = null;

  readonly rightPanelWidth = 420;

  ngOnInit(): void {
    void this.audio.loadPositions();
    this.routeSub = this.route.paramMap.subscribe(params => {
      const id = params.get('id')!;
      this.loadBook(id);
      this.loadChapters(id);
    });
  }

  loadBook(id: string): void {
    this.bookService.getById(id).subscribe({
      next: (data) => {
        this.book.set(data);
        this.bookOutline.set(data.outline ?? []);
        forkJoin({
          series: this.seriesService.getById(data.seriesId),
          allSeries: this.seriesService.getAll(),
          booksInSeries: this.bookService.getBySeries(data.seriesId),
        }).subscribe({
          next: ({ series, allSeries, booksInSeries }) => {
            this.seriesId.set(series.id);
            this.seriesContext.set(series.id);
            this.entityService.getBySeries(series.id).subscribe({
              next: entities => this.seriesEntities.set(entities.filter(e => !e.archived && !e.deleted)),
            });
            const filteredSeries = allSeries.filter(s => !s.archived && !s.deleted);
            const filteredBooks = booksInSeries.filter(b => !b.archived && !b.deleted)
              .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
            this.headerService.set([
              {
                label: series.title,
                link: '/series/' + series.id,
                dropdownItems: filteredSeries.map(s => ({ label: s.title, link: '/series/' + s.id, isCurrent: s.id === series.id })),
              },
              {
                label: data.title,
                dropdownItems: filteredBooks.map(b => ({ label: b.title, link: '/books/' + b.id, isCurrent: b.id === data.id })),
              },
            ]);
          },
        });
      },
    });
  }

  loadChapters(id: string): void {
    this.loading.set(true);
    this.chapterService.getByBook(id).subscribe({
      next: (data) => {
        const sorted = [...data].sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
        this.chapterList.set(sorted);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  openEditBook(): void {
    const b = this.book();
    if (!b) return;
    this.editingBook.set({ ...b });
    this.thumbnailPreview.set(this.proxyUrl(b.thumnailUrl));
    this.panelMode.set('edit');
    this.showPanel.set(true);
  }

  onBookOutlineChange(items: OutlineItem[]): void {
    this.bookOutline.set(items);
    if (this.outlineSaveTimer) clearTimeout(this.outlineSaveTimer);
    this.outlineSaveTimer = setTimeout(() => {
      const book = this.book();
      if (!book) return;
      const updated = { ...book, outline: items };
      this.bookService.update(updated).subscribe({
        next: (saved) => this.book.set(saved),
      });
    }, 800);
  }

  onPanelChanged(open: boolean): void {
    if (open) this.showPanel.set(true);
    else this.closePanel();
  }

  closePanel(): void {
    this.showPanel.set(false);
    this.editingBook.set(null);
    this.thumbnailPreview.set(null);
    this.panelMode.set(null);
  }

  updateTitle(value: string): void {
    const current = this.editingBook();
    if (current) {
      this.editingBook.set({ ...current, title: value });
    }
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => this.thumbnailPreview.set(reader.result as string);
    reader.readAsDataURL(file);

    this.uploading.set(true);
    this.bookService.uploadThumbnail(file).subscribe({
      next: ({ url, thumbnailUrl }) => {
        const current = this.editingBook();
        if (current) {
          this.editingBook.set({ ...current, thumnailUrl: thumbnailUrl, originalUrl: url });
        }
        this.thumbnailPreview.set(this.proxyUrl(thumbnailUrl));
        this.uploading.set(false);
      },
      error: () => this.uploading.set(false),
    });
  }

  saveEdit(): void {
    const editing = this.editingBook();
    if (!editing || !editing.title.trim()) return;
    this.bookService.update(editing).subscribe({
      next: (updated) => {
        this.book.set(updated);
        this.closePanel();
      },
    });
  }

  archiveBook(): void {
    const b = this.book();
    if (!b) return;
    this.bookService.archive(b.id).subscribe({
      next: () => this.goBack(),
    });
  }

  openChapter(chapter: Chapter): void {
    this.router.navigate(['/chapters', chapter.id, 'edit']);
  }

  /** Opens the whole book in the paginated full-book editor, at its first chapter. */
  editBook(): void {
    const first = this.chapterList()[0];
    if (!first) return;
    this.userSettings.setFullBookEditing(true);
    void this.router.navigate(['/chapters', first.id, 'edit']);
  }

  addChapter(): void {
    const book = this.book();
    if (!book) return;
    const newChapter: Chapter = { id: uuidv4(), title: 'New Chapter', bookId: book.id, sortOrder: this.chapterList().length };
    this.chapterService.create(newChapter).subscribe({
      next: (created) => {
        this.chapterList.update((list) => [...list, created]);
        this.router.navigate(['/chapters', created.id, 'edit']);
      },
    });
  }

  onDrop(event: CdkDragDrop<Chapter[]>): void {
    const list = [...this.chapterList()];
    moveItemInArray(list, event.previousIndex, event.currentIndex);
    this.chapterList.set(list);
    const reordered = list.map((c, i) => ({ id: c.id, sortOrder: i }));
    this.chapterService.reorder(reordered).subscribe();
  }

  ngOnDestroy(): void {
    this.scroller?.removeEventListener('scroll', this.scheduleSidePanelSize);
    window.removeEventListener('resize', this.scheduleSidePanelSize);
    if (this.sizeFrame !== null) cancelAnimationFrame(this.sizeFrame);
    this.routeSub?.unsubscribe();
    this.headerService.clear();
    if (this.outlineSaveTimer) clearTimeout(this.outlineSaveTimer);
  }

  proxyUrl(azureUrl: string | undefined): string | null {
    if (!azureUrl) return null;
    const filename = azureUrl.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }

  exportAs(format: 'docx' | 'pdf' | 'html'): void {
    const book = this.book();
    if (!book) return;
    this.exporting.set(true);
    this.http.get(`/api/export/books/${book.id}/${format}`, { responseType: 'blob' }).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${book.title}.${format}`;
        a.click();
        URL.revokeObjectURL(url);
        this.exporting.set(false);
      },
      error: () => this.exporting.set(false),
    });
  }

  goBack(): void {
    const book = this.book();
    if (book?.seriesId) {
      this.router.navigate(['/series', book.seriesId]);
    } else {
      this.router.navigate(['/series']);
    }
  }
}
