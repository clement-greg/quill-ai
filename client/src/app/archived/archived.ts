import { Component, inject, signal, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { SeriesService } from '../series/series.service';
import { BookService } from '../book/book.service';
import { EntityService } from '../services/entity.service';
import { ChapterService } from '../chapter/chapter.service';
import { HeaderService } from '../services/header.service';
import { AiAssistantService } from '../services/ai-assistant.service';
import { Series } from '@shared/models/series.model';
import { Book } from '@shared/models/book.model';
import { Chapter } from '@shared/models/chapter.model';
import { Entity } from '@shared/models/entity.model';
import { ChatSessionSummary } from '@shared/models';
import { forkJoin } from 'rxjs';

@Component({
  selector: 'app-archived',
  imports: [
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatTooltipModule,
  ],
  templateUrl: './archived.html',
  styleUrl: './archived.scss',
})
export class ArchivedComponent implements OnInit {
  private seriesService = inject(SeriesService);
  private bookService = inject(BookService);
  private entityService = inject(EntityService);
  private chapterService = inject(ChapterService);
  private headerService = inject(HeaderService);
  private aiAssistantService = inject(AiAssistantService);
  private snackBar = inject(MatSnackBar);
  private router = inject(Router);

  loading = signal(false);
  archivedSeries = signal<Series[]>([]);
  archivedBooks = signal<Book[]>([]);
  archivedChapters = signal<Chapter[]>([]);
  archivedEntities = signal<Entity[]>([]);
  archivedChatSessions = signal<ChatSessionSummary[]>([]);

  ngOnInit(): void {
    this.headerService.set([{ label: 'Archived Items' }], []);
    this.load();
  }

  load(): void {
    this.loading.set(true);
    forkJoin({
      series: this.seriesService.getArchived(),
      books: this.bookService.getArchived(),
      chapters: this.chapterService.getArchived(),
      entities: this.entityService.getAllArchived(),
    }).subscribe({
      next: ({ series, books, chapters, entities }) => {
        this.archivedSeries.set(series);
        this.archivedBooks.set(books);
        this.archivedChapters.set(chapters);
        this.archivedEntities.set(entities);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
    this.aiAssistantService.getArchivedSessions().then(sessions => {
      this.archivedChatSessions.set(sessions);
    });
  }

  unarchiveSeries(id: string): void {
    this.seriesService.unarchive(id).subscribe({
      next: () => this.archivedSeries.update(list => list.filter(s => s.id !== id)),
    });
  }

  unarchiveBook(id: string): void {
    this.bookService.unarchive(id).subscribe({
      next: () => this.archivedBooks.update(list => list.filter(b => b.id !== id)),
    });
  }

  unarchiveChapter(id: string): void {
    this.chapterService.unarchive(id).subscribe({
      next: () => this.archivedChapters.update(list => list.filter(c => c.id !== id)),
    });
  }

  deleteChapter(chapter: Chapter): void {
    this.chapterService.delete(chapter.id).subscribe({
      next: () => {
        this.archivedChapters.update(list => list.filter(c => c.id !== chapter.id));
        this.snackBar.open(`"${chapter.title}" deleted`, undefined, { duration: 3000 });
      },
    });
  }

  unarchiveEntity(id: string): void {
    this.entityService.unarchive(id).subscribe({
      next: () => this.archivedEntities.update(list => list.filter(e => e.id !== id)),
    });
  }

  proxyUrl(url: string | undefined): string | null {
    if (!url) return null;
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }

  deleteSeries(series: Series): void {
    this.seriesService.softDelete(series.id).subscribe({
      next: () => {
        this.archivedSeries.update(list => list.filter(s => s.id !== series.id));
        const ref = this.snackBar.open(`"${series.title}" deleted`, 'Undo', { duration: 5000 });
        ref.onAction().subscribe(() => {
          this.seriesService.restoreDelete(series.id).subscribe({
            next: () => this.archivedSeries.update(list => [...list, series]),
          });
        });
      },
    });
  }

  deleteBook(book: Book): void {
    this.bookService.softDelete(book.id).subscribe({
      next: () => {
        this.archivedBooks.update(list => list.filter(b => b.id !== book.id));
        const ref = this.snackBar.open(`"${book.title}" deleted`, 'Undo', { duration: 5000 });
        ref.onAction().subscribe(() => {
          this.bookService.restoreDelete(book.id).subscribe({
            next: () => this.archivedBooks.update(list => [...list, book]),
          });
        });
      },
    });
  }

  deleteEntity(entity: Entity): void {
    this.entityService.softDelete(entity.id).subscribe({
      next: () => {
        this.archivedEntities.update(list => list.filter(e => e.id !== entity.id));
        const ref = this.snackBar.open(`"${entity.name}" deleted`, 'Undo', { duration: 5000 });
        ref.onAction().subscribe(() => {
          this.entityService.restoreDelete(entity.id).subscribe({
            next: () => this.archivedEntities.update(list => [...list, entity]),
          });
        });
      },
    });
  }

  async unarchiveChatSession(sessionId: string): Promise<void> {
    await this.aiAssistantService.unarchiveSession(sessionId);
    this.archivedChatSessions.update(list => list.filter(s => s.id !== sessionId));
  }

  async deleteChatSession(session: ChatSessionSummary): Promise<void> {
    await this.aiAssistantService.deleteChatSessionPermanent(session.id);
    this.archivedChatSessions.update(list => list.filter(s => s.id !== session.id));
    const ref = this.snackBar.open(`"${session.name}" deleted`, 'Undo', { duration: 5000 });
    ref.onAction().subscribe(async () => {
      // Re-archive (restore the soft-delete by re-archiving) — best-effort undo
      // Since permanent delete is irreversible in Cosmos, just re-fetch to reflect real state
      const sessions = await this.aiAssistantService.getArchivedSessions();
      this.archivedChatSessions.set(sessions);
    });
  }
}
