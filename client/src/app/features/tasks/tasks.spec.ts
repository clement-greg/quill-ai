import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { ActivatedRoute, convertToParamMap, ParamMap, Router, provideRouter } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TasksComponent } from './tasks';
import { TasksService, TaskPageQuery } from './tasks.service';
import { HeaderService } from '@app/core/services/header.service';
import { TaskListItem, TaskPage } from '@shared/models/task.model';

const task = (id: string, over: Partial<TaskListItem> = {}): TaskListItem => ({
  id,
  docType: 'task',
  bookId: 'b1',
  bookTitle: 'Lithium',
  title: `Task ${id}`,
  completed: false,
  ...over,
});

describe('TasksComponent', () => {
  let service: Record<string, ReturnType<typeof vi.fn>>;
  let queryParams: BehaviorSubject<ParamMap>;
  let router: { navigate: ReturnType<typeof vi.fn> };
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let page: TaskPage;

  function create() {
    service = {
      getPage: vi.fn((_q: TaskPageQuery) => of(page)),
      get: vi.fn((id: string) => of(task(id, { body: 'Ask Dale', links: [{ kind: 'entity', id: 'e1', text: 'Dale' }] }))),
      create: vi.fn(d => of(task('new', d))),
      update: vi.fn((id: string, d) => of(task(id, d))),
      setCompleted: vi.fn(() => of({})),
      delete: vi.fn(() => of(undefined)),
      restore: vi.fn(() => of({})),
    };
    router = { navigate: vi.fn() };
    snackBar = { open: vi.fn(() => ({ onAction: () => of() })) };
    TestBed.configureTestingModule({
      imports: [TasksComponent],
      providers: [
        provideRouter([]),
        { provide: TasksService, useValue: service },
        { provide: HeaderService, useValue: { clearAll: vi.fn() } },
        { provide: ActivatedRoute, useValue: { queryParamMap: queryParams } },
        { provide: Router, useValue: router },
        { provide: MatSnackBar, useValue: snackBar },
      ],
    });
    const fixture = TestBed.createComponent(TasksComponent);
    fixture.detectChanges();
    return fixture;
  }

  const lastQuery = (): TaskPageQuery => service['getPage'].mock.lastCall![0];
  const el = (fixture: { nativeElement: unknown }) => fixture.nativeElement as HTMLElement;

  beforeEach(() => {
    queryParams = new BehaviorSubject(convertToParamMap({}));
    page = {
      items: [task('late', { dueDate: '2000-01-01' }), task('plain', { body: 'See Dale', links: [{ kind: 'entity', id: 'e1', text: 'Dale' }] })],
      total: 2,
      books: [{ id: 'b1', title: 'Lithium' }, { id: 'b2', title: 'Cobalt' }],
    };
  });

  it('loads open tasks and marks overdue ones', () => {
    const fixture = create();
    expect(lastQuery()).toMatchObject({ status: 'open', q: '' });
    const cards = el(fixture).querySelectorAll('.task-card');
    expect(cards.length).toBe(2);
    expect(cards[0].classList).toContain('overdue');
    expect(cards[0].textContent).toContain('Overdue');
  });

  it('links entity references in the body', () => {
    const fixture = create();
    const link = el(fixture).querySelector('.task-link') as HTMLAnchorElement;
    expect(link.textContent).toBe('Dale');
  });

  it('reloads when the status or book filter changes', () => {
    const fixture = create();
    fixture.componentInstance.setStatus('completed');
    expect(lastQuery().status).toBe('completed');
    fixture.componentInstance.setBookFilter('b2');
    expect(lastQuery().bookId).toBe('b2');
    fixture.componentInstance.clearFilters();
    expect(lastQuery().bookId).toBeUndefined();
  });

  it('completes a task optimistically and rolls back on failure', () => {
    const fixture = create();
    const c = fixture.componentInstance;
    service['setCompleted'].mockReturnValueOnce(throwError(() => new Error('nope')));
    c.toggleComplete(c.tasks()[1]);
    expect(service['setCompleted']).toHaveBeenCalledWith('plain', true);
    expect(c.tasks()[1].completed).toBe(false);
    expect(snackBar.open).toHaveBeenCalledWith('Couldn’t update the task', undefined, expect.anything());
  });

  it('requires a title and a book before saving', () => {
    const fixture = create();
    const c = fixture.componentInstance;
    c.openNew();
    c.save();
    expect(service['create']).not.toHaveBeenCalled();

    c.form.setValue({ title: ' Fix the flood ', bookId: 'b2', dueDate: '', body: '' });
    c.save();
    expect(service['create']).toHaveBeenCalledWith({ title: 'Fix the flood', bookId: 'b2', dueDate: null, body: '' });
    expect(c.showPanel()).toBe(false);
  });

  it('defaults a new task to the filtered book', () => {
    const fixture = create();
    const c = fixture.componentInstance;
    c.setBookFilter('b2');
    c.openNew();
    expect(c.form.controls.bookId.value).toBe('b2');
  });

  it('opens a task from ?open= and drops the param', () => {
    queryParams.next(convertToParamMap({ open: 't7' }));
    const fixture = create();
    expect(service['get']).toHaveBeenCalledWith('t7');
    expect(fixture.componentInstance.editing()?.id).toBe('t7');
    expect(router.navigate).toHaveBeenCalled();
  });

  it('shows a create-a-book hint when there are no books', () => {
    page = { items: [], total: 0, books: [] };
    const fixture = create();
    expect(el(fixture).textContent).toContain('Create a book first');
  });
});
