import { TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { PhotoGenDialogComponent } from './photo-gen-dialog';
import { DEFAULT_IMAGE_COUNT, PhotoGenFormComponent } from './photo-gen-form';

describe('PhotoGenFormComponent', () => {
  function create() {
    const fixture = TestBed.createComponent(PhotoGenFormComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('defaults to the generator batch and starts invalid', () => {
    const form = create().componentInstance;
    expect(form.count.value).toBe(DEFAULT_IMAGE_COUNT);
    expect(form.invalid()).toBe(true);
    expect(form.result()).toBeNull();
  });

  it('leaves out every advanced setting that was not filled in', () => {
    const form = create().componentInstance;
    form.prompt.setValue('  a portrait  ');
    form.advanced.controls.negativePrompt.setValue('   ');
    expect(form.result()).toEqual({ prompt: 'a portrait', count: DEFAULT_IMAGE_COUNT });
  });

  it('includes the advanced settings that were filled in', () => {
    const form = create().componentInstance;
    form.prompt.setValue('a portrait');
    form.count.setValue(6);
    form.advanced.setValue({ negativePrompt: ' blurry ', width: 768, height: 1024, steps: 30, cfg: 4.5, seed: 7 });
    expect(form.result()).toEqual({
      prompt: 'a portrait',
      count: 6,
      negativePrompt: 'blurry',
      width: 768,
      height: 1024,
      steps: 30,
      cfg: 4.5,
      seed: 7,
    });
  });

  it('is invalid while an advanced number is out of range', () => {
    const form = create().componentInstance;
    form.prompt.setValue('a portrait');
    form.advanced.controls.width.setValue(32);
    expect(form.invalid()).toBe(true);
    expect(form.result()).toBeNull();
  });

  it('shows the advanced fields only once asked', () => {
    const fixture = create();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.advanced')).toBeNull();
    fixture.componentInstance.toggleAdvanced();
    fixture.detectChanges();
    expect(el.querySelector('.advanced')).not.toBeNull();
  });
});

describe('PhotoGenDialogComponent', () => {
  it('closes with what the form asked for, and not before', () => {
    const close = vi.fn();
    TestBed.configureTestingModule({
      imports: [PhotoGenDialogComponent],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: { thumbnailUrl: 't.jpg' } },
        { provide: MatDialogRef, useValue: { close } },
      ],
    });
    const fixture = TestBed.createComponent(PhotoGenDialogComponent);
    fixture.detectChanges();
    const dialog = fixture.componentInstance;

    dialog.confirm();
    expect(close).not.toHaveBeenCalled();

    dialog.form().prompt.setValue('a portrait');
    dialog.confirm();
    expect(close).toHaveBeenCalledWith({ prompt: 'a portrait', count: DEFAULT_IMAGE_COUNT });
  });
});
