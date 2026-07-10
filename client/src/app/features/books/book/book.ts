import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatListModule } from '@angular/material/list';
import { MatCardModule } from '@angular/material/card';
import { MatSelectModule } from '@angular/material/select';
import { BookService } from '../book.service';
import { SeriesService } from '@app/features/series/series.service';
import { Book } from '@shared/models/book.model';
import { Series } from '@shared/models/series.model';
import { v4 as uuidv4 } from 'uuid';

@Component({
  selector: 'app-book',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
    MatListModule,
    MatCardModule,
    MatSelectModule,
  ],
  templateUrl: './book.html',
  styleUrl: './book.scss',
})
export class BookComponent implements OnInit {
  private bookService = inject(BookService);
  private seriesService = inject(SeriesService);

  bookList = signal<Book[]>([]);
  seriesList = signal<Series[]>([]);
  editingBook = signal<Book | null>(null);
  newTitle = signal('');
  newSeriesId = signal('');
  filterSeriesId = signal('');
  loading = signal(false);

  ngOnInit(): void {
    this.loadSeries();
    this.loadBooks();
  }

  loadSeries(): void {
    this.seriesService.getAll().subscribe({
      next: (data) => this.seriesList.set(data),
    });
  }

  loadBooks(): void {
    this.loading.set(true);
    this.bookService.getAll().subscribe({
      next: (data) => {
        this.bookList.set(data);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  filterBySeries(seriesId: string): void {
    this.filterSeriesId.set(seriesId);
    this.loading.set(true);
    if (seriesId) {
      this.bookService.getBySeries(seriesId).subscribe({
        next: (data) => {
          this.bookList.set(data);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
    } else {
      this.bookService.getAll().subscribe({
        next: (data) => {
          this.bookList.set(data);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
    }
  }

  addBook(): void {
    const title = this.newTitle().trim();
    const seriesId = this.newSeriesId();
    if (!title || !seriesId) return;

    const book: Book = { id: uuidv4(), title, seriesId };
    this.bookService.create(book).subscribe({
      next: (created) => {
        this.bookList.update((list) => [...list, created]);
        this.newTitle.set('');
      },
    });
  }

  startEdit(book: Book): void {
    this.editingBook.set({ ...book });
  }

  cancelEdit(): void {
    this.editingBook.set(null);
  }

  saveEdit(): void {
    const editing = this.editingBook();
    if (!editing || !editing.title.trim() || !editing.seriesId) return;

    this.bookService.update(editing).subscribe({
      next: (updated) => {
        this.bookList.update((list) =>
          list.map((b) => (b.id === updated.id ? updated : b))
        );
        this.editingBook.set(null);
      },
    });
  }

  deleteBook(id: string): void {
    this.bookService.delete(id).subscribe({
      next: () => {
        this.bookList.update((list) => list.filter((b) => b.id !== id));
      },
    });
  }

  getSeriesTitle(seriesId: string): string {
    return this.seriesList().find((s) => s.id === seriesId)?.title ?? 'Unknown';
  }
}
