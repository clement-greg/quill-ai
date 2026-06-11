import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
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
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { BookService } from '../book/book.service';
import { ChapterService } from '../chapter/chapter.service';
import { SeriesService } from '../series/series.service';
import { EntityService } from '../services/entity.service';
import { Book } from '@shared/models/book.model';
import { Chapter } from '@shared/models/chapter.model';
import { Entity } from '@shared/models/entity.model';
import { v4 as uuidv4 } from 'uuid';
import { HeaderService } from '../services/header.service';
import { SeriesContextService } from '../services/series-context.service';
import { SlideOutPanelContainer } from '../shared/slide-out-panel-container/slide-out-panel-container';
import { BookNotesComponent } from '../book-notes/book-notes';
import { AiStatsComponent } from './ai-stats/ai-stats';
import { ChapterOutlineComponent } from '../chapter-edit/chapter-outline/chapter-outline';
import { OutlineItem } from '@shared/models/chapter.model';

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
  private bookService = inject(BookService);
  private chapterService = inject(ChapterService);
  private seriesService = inject(SeriesService);
  private headerService = inject(HeaderService);
  private seriesContext = inject(SeriesContextService);
  private entityService = inject(EntityService);

  private http = inject(HttpClient);

  book = signal<Book | null>(null);
  chapterList = signal<Chapter[]>([]);
  loading = signal(false);
  showPanel = signal(false);
  editingBook = signal<Book | null>(null);
  uploading = signal(false);
  thumbnailPreview = signal<string | null>(null);
  exporting = signal(false);
  panelMode = signal<'edit' | 'notes' | 'ai-stats' | 'outline' | null>(null);
  bookOutline = signal<OutlineItem[]>([]);
  bookOutlineEntities = signal<Entity[]>([]);
  notesContent = signal<string>('');
  savingNotes = signal(false);
  seriesId = signal<string>('');
  aiStatsChapters = signal<Chapter[]>([]);
  aiStatsLoading = signal(false);
  aiStatsEntities = signal<Entity[]>([]);
  private routeSub?: Subscription;

  private outlineSaveTimer: ReturnType<typeof setTimeout> | null = null;

  get rightPanelWidth(): number {
    return this.panelMode() === 'ai-stats' ? 520 : 420;
  }

  ngOnInit(): void {
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
        forkJoin({
          series: this.seriesService.getById(data.seriesId),
          allSeries: this.seriesService.getAll(),
          booksInSeries: this.bookService.getBySeries(data.seriesId),
        }).subscribe({
          next: ({ series, allSeries, booksInSeries }) => {
            this.seriesId.set(series.id);
            this.seriesContext.set(series.id);
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

  openNotes(): void {
    this.panelMode.set('notes');
    this.showPanel.set(true);
  }

  openAiStats(): void {
    this.panelMode.set('ai-stats');
    this.showPanel.set(true);
    const book = this.book();
    if (!book) return;
    this.aiStatsLoading.set(true);
    forkJoin({
      chapters: this.chapterService.getByBook(book.id),
      entities: this.entityService.getBySeries(this.seriesId()),
    }).subscribe({
      next: ({ chapters, entities }) => {
        const sorted = [...chapters].sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
        this.aiStatsChapters.set(sorted);
        this.aiStatsEntities.set(entities.filter(e => !e.archived && !e.deleted));
        this.aiStatsLoading.set(false);
      },
      error: () => this.aiStatsLoading.set(false),
    });
  }

  openOutline(): void {
    const book = this.book();
    if (!book) return;
    this.bookOutline.set(book.outline ?? []);
    this.panelMode.set('outline');
    this.showPanel.set(true);
    if (this.bookOutlineEntities().length === 0) {
      this.entityService.getBySeries(this.seriesId()).subscribe({
        next: (entities) => this.bookOutlineEntities.set(entities.filter(e => !e.archived && !e.deleted)),
      });
    }
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
    this.showPanel.set(open);
    if (!open) {
      this.editingBook.set(null);
      this.thumbnailPreview.set(null);
      this.panelMode.set(null);
      this.aiStatsChapters.set([]);
      this.aiStatsEntities.set([]);
      this.bookOutline.set([]);
      this.bookOutlineEntities.set([]);
    }
  }

  closePanel(): void {
    this.showPanel.set(false);
    this.editingBook.set(null);
    this.thumbnailPreview.set(null);
    this.panelMode.set(null);
    this.aiStatsChapters.set([]);
    this.aiStatsEntities.set([]);
    this.bookOutline.set([]);
    this.bookOutlineEntities.set([]);
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
