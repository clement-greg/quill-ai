import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { TaskSummary } from '@shared/models/task.model';
import { TasksService, dueLabel, localToday } from './tasks.service';

/** Home-screen tile: how many tasks are open, and the most pressing few. */
@Component({
  selector: 'app-open-tasks-tile',
  imports: [RouterLink, MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="ott" aria-labelledby="ott-heading">
      <div class="ott-header">
        <h2 id="ott-heading" class="ott-heading">
          Open tasks
          @if (summary(); as s) { <span class="ott-count">{{ s.open }}</span> }
        </h2>
        <a class="ott-link" routerLink="/tasks">
          All tasks <mat-icon aria-hidden="true">chevron_right</mat-icon>
        </a>
      </div>

      @if (summary(); as s) {
        @if (s.open === 0) {
          <div class="ott-empty">
            <mat-icon aria-hidden="true">task_alt</mat-icon>
            <span>No open tasks.</span>
            <a class="ott-add" routerLink="/tasks" [queryParams]="{ new: 1 }">Add one</a>
          </div>
        } @else {
          @if (s.overdue || s.dueThisWeek) {
            <p class="ott-stats">
              @if (s.overdue) { <span class="ott-stat overdue">{{ s.overdue }} overdue</span> }
              @if (s.dueThisWeek) { <span class="ott-stat">{{ s.dueThisWeek }} due this week</span> }
            </p>
          }
          <ul class="ott-list">
            @for (task of s.next; track task.id) {
              <li>
                <a class="ott-item" routerLink="/tasks" [queryParams]="{ open: task.id }">
                  <mat-icon class="ott-icon" [class.overdue]="!!task.dueDate && task.dueDate < today" aria-hidden="true">
                    {{ !!task.dueDate && task.dueDate < today ? 'error' : 'radio_button_unchecked' }}
                  </mat-icon>
                  <span class="ott-text">
                    <span class="ott-title">{{ task.title }}</span>
                    <span class="ott-sub">
                      {{ task.bookTitle }}@if (task.dueDate) { · <span [class.overdue]="task.dueDate < today">{{ due(task.dueDate) }}</span> }
                    </span>
                  </span>
                </a>
              </li>
            }
          </ul>
          @if (s.open > s.next.length) {
            <a class="ott-more" routerLink="/tasks">+{{ s.open - s.next.length }} more</a>
          }
        }
      } @else if (failed()) {
        <p class="ott-empty">Couldn’t load tasks.</p>
      } @else {
        <div class="ott-skeleton" aria-hidden="true"></div>
      }
    </section>
  `,
  styles: [`
    .ott {
      margin: 0 0 28px;
      padding: 16px;
      border-radius: 16px;
      background: var(--mat-sys-surface-container);
    }
    .ott-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .ott-heading { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 1.125rem; font-weight: 600; }
    .ott-count {
      min-width: 24px; height: 24px; padding: 0 8px; border-radius: 12px;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--mat-sys-primary); color: var(--mat-sys-on-primary); font-size: 0.8125rem;
    }
    .ott-link, .ott-more, .ott-add {
      display: inline-flex; align-items: center; color: var(--mat-sys-primary);
      text-decoration: none; font-size: 0.875rem; font-weight: 500;
    }
    .ott-link mat-icon { font-size: 20px; width: 20px; height: 20px; }
    .ott-link:hover, .ott-more:hover, .ott-add:hover { text-decoration: underline; }
    .ott-stats { display: flex; gap: 12px; margin: 8px 0 0; font-size: 0.8125rem; color: var(--mat-sys-on-surface-variant); }
    .ott-stat.overdue, .overdue { color: var(--mat-sys-error); font-weight: 500; }
    .ott-list { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 2px; }
    .ott-item {
      display: flex; align-items: flex-start; gap: 10px; padding: 8px; border-radius: 10px;
      color: inherit; text-decoration: none;
    }
    .ott-item:hover, .ott-item:focus-visible { background: var(--mat-sys-surface-container-high); }
    .ott-icon { flex: none; font-size: 20px; width: 20px; height: 20px; color: var(--mat-sys-on-surface-variant); }
    .ott-icon.overdue { color: var(--mat-sys-error); }
    .ott-text { display: flex; flex-direction: column; min-width: 0; }
    .ott-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ott-sub { font-size: 0.8125rem; color: var(--mat-sys-on-surface-variant); }
    .ott-more { margin: 4px 0 0 38px; }
    .ott-empty {
      display: flex; align-items: center; gap: 8px; margin: 12px 0 0;
      color: var(--mat-sys-on-surface-variant); font-size: 0.875rem;
    }
    .ott-skeleton { height: 96px; margin-top: 12px; border-radius: 10px; background: var(--mat-sys-surface-container-high); }
  `],
})
export class OpenTasksTileComponent {
  private tasksService = inject(TasksService);

  readonly summary = signal<TaskSummary | null>(null);
  readonly failed = signal(false);
  readonly today = localToday();

  constructor() {
    // Load now, and again whenever a task changes elsewhere in the app.
    effect(() => {
      this.tasksService.changes();
      this.load();
    });
  }

  private load(): void {
    this.tasksService.summary(5).subscribe({
      next: s => {
        this.summary.set(s);
        this.failed.set(false);
      },
      error: () => this.failed.set(true),
    });
  }

  due(date: string): string {
    return dueLabel(date, this.today);
  }
}
