import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { CdkTextareaAutosize } from '@angular/cdk/text-field';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { SeriesService } from '../series/series.service';
import { BookService } from '../book/book.service';
import { Series } from '@shared/models/series.model';
import { Book } from '@shared/models/book.model';
import { v4 as uuidv4 } from 'uuid';
import { SlideOutPanelContainer } from '../shared/slide-out-panel-container/slide-out-panel-container';
import { HeaderService } from '../services/header.service';
import { EntityPanelService } from '../services/entity-panel.service';
import { SeriesContextService } from '../services/series-context.service';

@Component({
  selector: 'app-series-detail',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatChipsModule,
    MatDividerModule,
    CdkTextareaAutosize,
    DragDropModule,
    SlideOutPanelContainer,
  ],
  templateUrl: './series-detail.html',
  styleUrl: './series-detail.scss',
})
export class SeriesDetailComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private seriesService = inject(SeriesService);
  private bookService = inject(BookService);
  private headerService = inject(HeaderService);
  private entityPanel = inject(EntityPanelService);
  private seriesContext = inject(SeriesContextService);

  series = signal<Series | null>(null);
  bookList = signal<Book[]>([]);
  loading = signal(false);
  showPanel = signal(false);
  editingBook = signal<Book | null>(null);
  isNew = signal(false);
  uploading = signal(false);
  thumbnailPreview = signal<string | null>(null);

  panelMode = signal<'book' | 'series' | 'series-edit' | null>(null);

  editingSeries = signal<Series | null>(null);

  get rightPanelWidth(): number {
    return 420;
  }

  editingSystemPrompt = signal('');
  generatingPrompt = signal(false);

  newCollaboratorEmail = signal('');
  collaboratorError = signal<string | null>(null);
  private routeSub?: Subscription;

  ngOnInit(): void {
    this.routeSub = this.route.paramMap.subscribe(params => {
      const id = params.get('id')!;
      this.loadSeries(id);
      this.loadBooks(id);
    });
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
    this.headerService.clear();
  }

  loadSeries(id: string): void {
    this.seriesService.getAll().subscribe({
      next: (allSeries) => {
        const filtered = allSeries.filter(s => !s.archived && !s.deleted);
        const current = filtered.find(s => s.id === id);
        if (!current) return;
        this.series.set(current);
        this.seriesContext.set(current.id);
        this.headerService.set(
          [{
            label: current.title,
            dropdownItems: filtered.map(s => ({ label: s.title, link: '/series/' + s.id, isCurrent: s.id === id })),
          }],
          [
            { icon: 'settings', label: 'Series Settings', action: () => this.openSeriesSettings() },
          ]
        );
      },
    });
  }

  loadBooks(id: string): void {
    this.loading.set(true);
    this.bookService.getBySeries(id).subscribe({
      next: (data) => {
        const sorted = [...data].sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
        this.bookList.set(sorted);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  openNew(): void {
    const s = this.series();
    if (!s) return;
    this.editingBook.set({ id: '', title: '', seriesId: s.id, sortOrder: this.bookList().length });
    this.isNew.set(true);
    this.thumbnailPreview.set(null);
    this.panelMode.set('book');
    this.showPanel.set(true);
  }

  openEdit(book: Book): void {
    this.editingBook.set({ ...book });
    this.isNew.set(false);
    this.thumbnailPreview.set(this.proxyUrl(book.thumnailUrl));
    this.panelMode.set('book');
    this.showPanel.set(true);
  }

  openBook(book: Book): void {
    this.router.navigate(['/books', book.id]);
  }

  onPanelChanged(open: boolean): void {
    this.showPanel.set(open);
    if (!open) {
      this.editingBook.set(null);
      this.editingSeries.set(null);
      this.thumbnailPreview.set(null);
      this.panelMode.set(null);
      this.editingSystemPrompt.set('');
      this.newCollaboratorEmail.set('');
      this.collaboratorError.set(null);
    }
  }

  closePanel(): void {
    this.showPanel.set(false);
    this.editingBook.set(null);
    this.editingSeries.set(null);
    this.thumbnailPreview.set(null);
    this.panelMode.set(null);
    this.editingSystemPrompt.set('');
    this.newCollaboratorEmail.set('');
    this.collaboratorError.set(null);
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

    if (this.isNew()) {
      const book: Book = { ...editing, id: uuidv4() };
      this.bookService.create(book).subscribe({
        next: (created) => {
          this.bookList.update((list) => [...list, created]);
          this.closePanel();
        },
      });
    } else {
      this.bookService.update(editing).subscribe({
        next: (updated) => {
          this.bookList.update((list) =>
            list.map((b) => (b.id === updated.id ? updated : b))
          );
          this.closePanel();
        },
      });
    }
  }

  proxyUrl(azureUrl: string | undefined): string | null {
    if (!azureUrl) return null;
    const filename = azureUrl.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }

  openSeriesEdit(): void {
    const s = this.series();
    if (!s) return;
    this.editingSeries.set({ ...s });
    this.thumbnailPreview.set(this.proxyUrl(s.thumnailUrl));
    this.editingBook.set(null);
    this.panelMode.set('series-edit');
    this.showPanel.set(true);
  }

  updateSeriesTitle(value: string): void {
    const current = this.editingSeries();
    if (current) {
      this.editingSeries.set({ ...current, title: value });
    }
  }

  onSeriesFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => this.thumbnailPreview.set(reader.result as string);
    reader.readAsDataURL(file);

    this.uploading.set(true);
    this.seriesService.uploadThumbnail(file).subscribe({
      next: ({ url, thumbnailUrl }) => {
        const current = this.editingSeries();
        if (current) {
          this.editingSeries.set({ ...current, thumnailUrl: thumbnailUrl, originalUrl: url });
        }
        this.thumbnailPreview.set(this.proxyUrl(thumbnailUrl));
        this.uploading.set(false);
      },
      error: () => this.uploading.set(false),
    });
  }

  saveSeriesEdit(): void {
    const editing = this.editingSeries();
    if (!editing || !editing.title.trim()) return;
    this.seriesService.update(editing).subscribe({
      next: (saved) => {
        this.series.set(saved);
        this.closePanel();
      },
    });
  }

  archiveSeries(): void {
    const s = this.series();
    if (!s) return;
    this.seriesService.archive(s.id).subscribe({
      next: () => this.router.navigate(['/series']),
    });
  }

  addCollaborator(): void {
    const s = this.editingSeries();
    const email = this.newCollaboratorEmail().trim();
    if (!s || !email) return;
    this.collaboratorError.set(null);
    this.seriesService.addCollaborator(s.id, email).subscribe({
      next: (updated) => {
        this.editingSeries.set(updated);
        this.series.set(updated);
        this.newCollaboratorEmail.set('');
      },
      error: (err) => {
        this.collaboratorError.set(err?.error?.error ?? 'Failed to add collaborator');
      },
    });
  }

  removeCollaborator(email: string): void {
    const s = this.editingSeries();
    if (!s) return;
    this.seriesService.removeCollaborator(s.id, email).subscribe({
      next: (updated) => {
        this.editingSeries.set(updated);
        this.series.set(updated);
      },
    });
  }

  openSeriesSettings(): void {
    const s = this.series();
    if (!s) return;
    this.editingSystemPrompt.set(s.systemPrompt ?? '');
    this.editingBook.set(null);
    this.thumbnailPreview.set(null);
    this.panelMode.set('series');
    this.showPanel.set(true);
  }

  saveSeriesSettings(): void {
    const s = this.series();
    if (!s) return;
    const updated: Series = { ...s, systemPrompt: this.editingSystemPrompt() };
    this.seriesService.update(updated).subscribe({
      next: (saved) => {
        this.series.set(saved);
        this.closePanel();
      },
    });
  }

  generateSystemPrompt(): void {
    const s = this.series();
    if (!s) return;
    this.generatingPrompt.set(true);
    this.seriesService.generateSystemPrompt(s.id, this.editingSystemPrompt()).subscribe({
      next: ({ systemPrompt }) => {
        this.editingSystemPrompt.set(systemPrompt);
        this.generatingPrompt.set(false);
      },
      error: () => this.generatingPrompt.set(false),
    });
  }

  onDrop(event: CdkDragDrop<Book[]>): void {
    const list = [...this.bookList()];
    moveItemInArray(list, event.previousIndex, event.currentIndex);
    this.bookList.set(list);
    const reordered = list.map((b, i) => ({ id: b.id, sortOrder: i }));
    this.bookService.reorder(reordered).subscribe();
  }

  goBack(): void {
    this.router.navigate(['/series']);
  }
}
