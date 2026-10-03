import { TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { VideoGenDialogComponent } from './video-gen-dialog';
import { DEFAULT_VIDEO_SECONDS, MAX_VIDEO_PROMPT_LENGTH, VideoGenFormComponent } from './video-gen-form';

describe('VideoGenFormComponent', () => {
  function create() {
    const fixture = TestBed.createComponent(VideoGenFormComponent);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  it('defaults to the generator length and starts invalid', () => {
    const form = create();
    expect(form.duration.value).toBe(DEFAULT_VIDEO_SECONDS);
    expect(form.invalid()).toBe(true);
    expect(form.result()).toBeNull();
  });

  it('gives the trimmed prompt and the length', () => {
    const form = create();
    form.prompt.setValue('  she waves  ');
    form.duration.setValue(2.5);
    expect(form.result()).toEqual({ prompt: 'she waves', durationSeconds: 2.5 });
  });

  it('labels the length to one decimal place', () => {
    expect(create().formatSeconds(3)).toBe('3.0s');
  });

  it('rejects an empty or overlong prompt', () => {
    const form = create();
    form.prompt.setValue('  ');
    expect(form.result()).toBeNull();
    form.prompt.setValue('x'.repeat(MAX_VIDEO_PROMPT_LENGTH + 1));
    expect(form.result()).toBeNull();
  });
});

describe('VideoGenDialogComponent', () => {
  it('closes with what the form asked for, and not before', () => {
    const close = vi.fn();
    TestBed.configureTestingModule({
      imports: [VideoGenDialogComponent],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: { thumbnailUrl: 't.jpg' } },
        { provide: MatDialogRef, useValue: { close } },
      ],
    });
    const fixture = TestBed.createComponent(VideoGenDialogComponent);
    fixture.detectChanges();
    const dialog = fixture.componentInstance;

    dialog.confirm();
    expect(close).not.toHaveBeenCalled();

    dialog.form().prompt.setValue('she waves');
    dialog.confirm();
    expect(close).toHaveBeenCalledWith({ prompt: 'she waves', durationSeconds: DEFAULT_VIDEO_SECONDS });
  });
});
