import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { OpenTasksTileComponent } from './open-tasks-tile';
import { TasksService } from './tasks.service';
import { TaskSummary } from '@shared/models/task.model';

describe('OpenTasksTileComponent', () => {
  const changes = signal(0);
  let summary: ReturnType<typeof vi.fn>;

  function render(result: TaskSummary | Error) {
    summary = vi.fn(() => (result instanceof Error ? throwError(() => result) : of(result)));
    TestBed.configureTestingModule({
      imports: [OpenTasksTileComponent],
      providers: [provideRouter([]), { provide: TasksService, useValue: { summary, changes } }],
    });
    const fixture = TestBed.createComponent(OpenTasksTileComponent);
    fixture.detectChanges();
    TestBed.tick();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('shows counts and links each task to the Tasks page', () => {
    const { el } = render({
      open: 7,
      overdue: 1,
      dueThisWeek: 2,
      next: [
        { id: 't1', docType: 'task', bookId: 'b', bookTitle: 'Lithium', title: 'Fix the flood', completed: false, dueDate: '2000-01-01' },
      ],
    });
    expect(el.querySelector('.ott-count')?.textContent?.trim()).toBe('7');
    expect(el.textContent).toContain('1 overdue');
    expect(el.textContent).toContain('2 due this week');
    expect(el.querySelector('.ott-item')?.getAttribute('href')).toBe('/tasks?open=t1');
    expect(el.textContent).toContain('+6 more');
  });

  it('offers to add one when nothing is open', () => {
    const { el } = render({ open: 0, overdue: 0, dueThisWeek: 0, next: [] });
    expect(el.textContent).toContain('No open tasks.');
    expect(el.querySelector('.ott-add')?.getAttribute('href')).toBe('/tasks?new=1');
  });

  it('says so when loading fails', () => {
    const { el } = render(new Error('down'));
    expect(el.textContent).toContain('Couldn’t load tasks.');
  });

  it('reloads when a task changes elsewhere', () => {
    const { fixture } = render({ open: 0, overdue: 0, dueThisWeek: 0, next: [] });
    const calls = summary.mock.calls.length;
    changes.update(n => n + 1);
    TestBed.tick();
    fixture.detectChanges();
    expect(summary.mock.calls.length).toBe(calls + 1);
  });
});
