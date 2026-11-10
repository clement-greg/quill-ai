import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { TaskFulfillmentDialogComponent } from './task-fulfillment-dialog';

describe('TaskFulfillmentDialogComponent', () => {
  function create() {
    const close = vi.fn();
    TestBed.configureTestingModule({
      imports: [TaskFulfillmentDialogComponent],
      providers: [
        {
          provide: MAT_DIALOG_DATA,
          useValue: {
            candidates: [
              { taskId: 'a', title: 'Find the letter', reason: 'Dale finds it.' },
              { taskId: 'b', title: 'Cut the dream', reason: '' },
            ],
          },
        },
        { provide: MatDialogRef, useValue: { close } },
      ],
    });
    const fixture = TestBed.createComponent(TaskFulfillmentDialogComponent);
    fixture.detectChanges();
    return { fixture, close, el: fixture.nativeElement as HTMLElement };
  }

  it('preselects every candidate and shows the reasons', () => {
    const { fixture, el } = create();
    expect(fixture.componentInstance.confirmLabel()).toBe('Complete 2 tasks');
    expect(el.textContent).toContain('Dale finds it.');
  });

  it('closes with only the tasks still checked', () => {
    const { fixture, close } = create();
    fixture.componentInstance.toggle('b');
    expect(fixture.componentInstance.confirmLabel()).toBe('Complete task');
    fixture.componentInstance.complete();
    expect(close).toHaveBeenCalledWith(['a']);
  });
});
