import { TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import {
  ClothesSwapDialogComponent,
  ClothesSwapDialogData,
  DEFAULT_SWAP_COUNT,
  MAX_SWAP_PROMPT_LENGTH,
} from './clothes-swap-dialog';

describe('ClothesSwapDialogComponent', () => {
  let close: ReturnType<typeof vi.fn>;

  function create(data: ClothesSwapDialogData = { thumbnailUrl: 'thumb.jpg' }) {
    close = vi.fn();
    TestBed.configureTestingModule({
      imports: [ClothesSwapDialogComponent],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    });
    const fixture = TestBed.createComponent(ClothesSwapDialogComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('defaults to one image with the face paste-back off', () => {
    const { componentInstance: dialog } = create();
    expect(dialog.count.value).toBe(DEFAULT_SWAP_COUNT);
    expect(dialog.restoreFace.value).toBe(false);
  });

  it('closes with the trimmed prompt, count and face choice', () => {
    const { componentInstance: dialog } = create();
    dialog.prompt.setValue('  a red raincoat  ');
    dialog.count.setValue(4);
    dialog.restoreFace.setValue(true);

    dialog.confirm();

    expect(close).toHaveBeenCalledWith({ prompt: 'a red raincoat', count: 4, restoreFace: true });
  });

  it('treats a whitespace-only prompt as missing and does not close', () => {
    const { componentInstance: dialog } = create();
    dialog.prompt.setValue('   ');

    expect(dialog.prompt.invalid).toBe(true);
    dialog.confirm();
    expect(close).not.toHaveBeenCalled();
  });

  it('rejects a prompt over the length limit', () => {
    const { componentInstance: dialog } = create();
    dialog.prompt.setValue('x'.repeat(MAX_SWAP_PROMPT_LENGTH + 1));
    expect(dialog.prompt.invalid).toBe(true);
  });

  it('disables Generate until there is a prompt', () => {
    const fixture = create();
    const generate = () =>
      [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(b =>
        b.textContent?.includes('Generate')
      )!;

    expect(generate().disabled).toBe(true);
    fixture.componentInstance.prompt.setValue('a hat');
    fixture.detectChanges();
    expect(generate().disabled).toBe(false);
  });

  it('shows the caller\'s hint in place of the default one', () => {
    const fixture = create({ thumbnailUrl: 'frame.jpg', hint: 'This frame is edited.' });
    const text = (fixture.nativeElement as HTMLElement).querySelector('.still-hint')?.textContent;
    expect(text).toContain('This frame is edited.');
  });
});
