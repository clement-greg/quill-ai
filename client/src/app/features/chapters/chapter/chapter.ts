import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatListModule } from '@angular/material/list';
import { MatCardModule } from '@angular/material/card';
import { MatSelectModule } from '@angular/material/select';
import { ChapterService } from '../chapter.service';
import { BookService } from '@app/features/books/book.service';
import { Chapter } from '@shared/models/chapter.model';
import { Book } from '@shared/models/book.model';
import { v4 as uuidv4 } from 'uuid';

@Component({
  selector: 'app-chapter',
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
  templateUrl: './chapter.html',
  styleUrl: './chapter.scss',
})
export class ChapterComponent implements OnInit {
  private chapterService = inject(ChapterService);
  private bookService = inject(BookService);

  chapterList = signal<Chapter[]>([]);
  bookList = signal<Book[]>([]);
  editingChapter = signal<Chapter | null>(null);
  newTitle = signal('');
  newBookId = signal('');
  filterBookId = signal('');
  loading = signal(false);

  ngOnInit(): void {
    this.loadBooks();
    this.loadChapters();
  }

  loadBooks(): void {
    this.bookService.getAll().subscribe({
      next: (data) => this.bookList.set(data),
    });
  }

  loadChapters(): void {
    this.loading.set(true);
    this.chapterService.getAll().subscribe({
      next: (data) => {
        this.chapterList.set(data);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  filterByBook(bookId: string): void {
    this.filterBookId.set(bookId);
    this.loading.set(true);
    if (bookId) {
      this.chapterService.getByBook(bookId).subscribe({
        next: (data) => {
          this.chapterList.set(data);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
    } else {
      this.chapterService.getAll().subscribe({
        next: (data) => {
          this.chapterList.set(data);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
    }
  }

  addChapter(): void {
    const title = this.newTitle().trim();
    const bookId = this.newBookId();
    if (!title || !bookId) return;

    const chapter: Chapter = { id: uuidv4(), title, bookId };
    this.chapterService.create(chapter).subscribe({
      next: (created) => {
        this.chapterList.update((list) => [...list, created]);
        this.newTitle.set('');
      },
    });
  }

  startEdit(chapter: Chapter): void {
    this.editingChapter.set({ ...chapter });
  }

  cancelEdit(): void {
    this.editingChapter.set(null);
  }

  saveEdit(): void {
    const editing = this.editingChapter();
    if (!editing || !editing.title.trim() || !editing.bookId) return;

    this.chapterService.update(editing).subscribe({
      next: (updated) => {
        this.chapterList.update((list) =>
          list.map((c) => (c.id === updated.id ? updated : c))
        );
        this.editingChapter.set(null);
      },
    });
  }

  deleteChapter(id: string): void {
    this.chapterService.delete(id).subscribe({
      next: () => {
        this.chapterList.update((list) => list.filter((c) => c.id !== id));
      },
    });
  }

  getBookTitle(bookId: string): string {
    return this.bookList().find((b) => b.id === bookId)?.title ?? 'Unknown';
  }
}
