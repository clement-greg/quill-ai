import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TaskBodyComponent } from './task-body';
import { TaskLink } from '@shared/models/task.model';

describe('TaskBodyComponent', () => {
  function render(body: string, links: TaskLink[]) {
    TestBed.configureTestingModule({ imports: [TaskBodyComponent], providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(TaskBodyComponent);
    fixture.componentRef.setInput('body', body);
    fixture.componentRef.setInput('links', links);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('links entities to their page and chapters to the editor', () => {
    const el = render('Dale floods chapter 2.', [
      { kind: 'entity', id: 'e1', text: 'Dale', name: 'Dale Harper' },
      { kind: 'chapter', id: 'c2', text: 'chapter 2' },
    ]);
    const links = [...el.querySelectorAll('a')];
    expect(links.map(a => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Dale', '/entities/e1'],
      ['chapter 2', '/chapters/c2/edit'],
    ]);
    expect(links[0].getAttribute('title')).toBe('Dale Harper');
    expect(el.textContent).toBe('Dale floods chapter 2.');
  });

  it('renders plain text when there are no links', () => {
    const el = render('Nothing to link', []);
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toBe('Nothing to link');
  });
});
