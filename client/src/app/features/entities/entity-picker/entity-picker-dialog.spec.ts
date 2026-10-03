import { TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { of } from 'rxjs';
import { SeriesService } from '@app/features/series/series.service';
import { EntityService } from '../entity.service';
import { EntityPickerDialogComponent } from './entity-picker-dialog';

describe('EntityPickerDialogComponent', () => {
  let close: ReturnType<typeof vi.fn>;

  function create(data: unknown = { title: 'Save results to' }) {
    close = vi.fn();
    TestBed.configureTestingModule({
      imports: [EntityPickerDialogComponent],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
        { provide: SeriesService, useValue: { getAll: () => of([]) } },
        { provide: EntityService, useValue: { getBySeries: () => of([]) } },
      ],
    });
    const fixture = TestBed.createComponent(EntityPickerDialogComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('shows the title it was given', () => {
    const el = create().nativeElement as HTMLElement;
    expect(el.querySelector('h2')?.textContent).toContain('Save results to');
  });

  it('falls back to a default title', () => {
    const el = create(null).nativeElement as HTMLElement;
    expect(el.querySelector('h2')?.textContent).toContain('Choose an entity');
  });

  it('closes with the pick, and not without one', () => {
    const { componentInstance: dialog } = create();
    dialog.confirm();
    expect(close).not.toHaveBeenCalled();

    dialog.selected.set({ id: 'e-1', name: 'Janet' });
    dialog.confirm();
    expect(close).toHaveBeenCalledWith({ id: 'e-1', name: 'Janet' });
  });
});
