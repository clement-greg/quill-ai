import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import {
  Task,
  TaskFulfillmentCandidate,
  TaskListItem,
  TaskPage,
  TaskStatusFilter,
  TaskSummary,
} from '@shared/models/task.model';

export interface TaskPageQuery {
  status: TaskStatusFilter;
  bookId?: string;
  q?: string;
  offset?: number;
  limit?: number;
}

/** Fields the task editor sends. A null dueDate clears it. */
export interface TaskDraft {
  title: string;
  body?: string;
  bookId: string;
  dueDate?: string | null;
}

/** The browser's IANA time zone, so "today" and "overdue" match the author's calendar. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

@Injectable({ providedIn: 'root' })
export class TasksService {
  private http = inject(HttpClient);

  /** Bumped after any change, so views showing tasks elsewhere (the home tile) can refresh. */
  readonly changes = signal(0);

  private changed = <T>() => tap<T>(() => this.changes.update(n => n + 1));

  getPage(query: TaskPageQuery): Observable<TaskPage> {
    let params = new HttpParams().set('status', query.status);
    if (query.bookId) params = params.set('bookId', query.bookId);
    if (query.q?.trim()) params = params.set('q', query.q.trim());
    if (query.offset !== undefined) params = params.set('offset', query.offset);
    if (query.limit !== undefined) params = params.set('limit', query.limit);
    return this.http.get<TaskPage>('/api/tasks', { params });
  }

  summary(limit = 5): Observable<TaskSummary> {
    const params = new HttpParams().set('tz', localTimeZone()).set('limit', limit);
    return this.http.get<TaskSummary>('/api/tasks/summary', { params });
  }

  get(id: string): Observable<TaskListItem> {
    return this.http.get<TaskListItem>(`/api/tasks/${encodeURIComponent(id)}`);
  }

  create(draft: TaskDraft): Observable<TaskListItem> {
    return this.http.post<TaskListItem>('/api/tasks', draft).pipe(this.changed());
  }

  update(id: string, draft: Partial<TaskDraft>): Observable<TaskListItem> {
    return this.http.put<TaskListItem>(`/api/tasks/${encodeURIComponent(id)}`, draft).pipe(this.changed());
  }

  setCompleted(id: string, completed: boolean, chapterId?: string): Observable<Task> {
    return this.http
      .patch<Task>(`/api/tasks/${encodeURIComponent(id)}/complete`, { completed, ...(chapterId ? { chapterId } : {}) })
      .pipe(this.changed());
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`/api/tasks/${encodeURIComponent(id)}`).pipe(this.changed());
  }

  restore(id: string): Observable<Task> {
    return this.http.patch<Task>(`/api/tasks/${encodeURIComponent(id)}/restore`, {}).pipe(this.changed());
  }

  /** Asks which open tasks a chapter save may have finished. */
  checkChapter(
    chapterId: string,
    previousContent: string,
    content: string,
    excludeTaskIds: string[] = [],
  ): Observable<{ candidates: TaskFulfillmentCandidate[] }> {
    return this.http.post<{ candidates: TaskFulfillmentCandidate[] }>('/api/tasks/check-chapter', {
      chapterId,
      previousContent,
      content,
      excludeTaskIds,
    });
  }
}

/** Today's local date as `YYYY-MM-DD`. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** "Overdue", "Due today", "Due tomorrow", or "Due Mar 4" for an open task. */
export function dueLabel(dueDate: string | undefined, today: string): string {
  if (!dueDate) return '';
  if (dueDate < today) return `Overdue · ${formatTaskDate(dueDate)}`;
  if (dueDate === today) return 'Due today';
  const [y, m, d] = today.split('-').map(Number);
  const tomorrow = localToday(new Date(y, m - 1, d + 1));
  if (dueDate === tomorrow) return 'Due tomorrow';
  return `Due ${formatTaskDate(dueDate)}`;
}

export function formatTaskDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const value = new Date(y, m - 1, d);
  const sameYear = value.getFullYear() === new Date().getFullYear();
  return value.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}
