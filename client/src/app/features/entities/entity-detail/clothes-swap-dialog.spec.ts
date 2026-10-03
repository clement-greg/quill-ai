import { TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { ClothesSwapDialogComponent, ClothesSwapDialogData } from './clothes-swap-dialog';
import { ClothesSwapFormComponent, DEFAULT_SWAP_COUNT, MAX_SWAP_PROMPT_LENGTH } from './clothes-swap-form';

describe('ClothesSwapFormComponent', () => {
  function create() {
    const fixture = TestBed.createComponent(ClothesSwapFormComponent);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  it('defaults to one image and starts invalid', () => {
    const form = create();
    expect(form.count.value).toBe(DEFAULT_SWAP_COUNT);
    expect(form.invalid()).toBe(true);
    expect(form.result()).toBeNull();
  });

  it('gives the trimmed prompt and the count', () => {
    const form = create();
    form.prompt.setValue('  a red raincoat  ');
    form.count.setValue(4);
    expect(form.invalid()).toBe(false);
    expect(form.result()).toEqual({ prompt: 'a red raincoat', count: 4 });
  });

  it('treats a whitespace-only prompt as missing', () => {
    const form = create();
    form.prompt.setValue('   ');
    expect(form.invalid()).toBe(true);
    expect(form.result()).toBeNull();
  });

  it('rejects a prompt over the length limit', () => {
    const form = create();
    form.prompt.setValue('x'.repeat(MAX_SWAP_PROMPT_LENGTH + 1));
    expect(form.result()).toBeNull();
  });
});

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

  const generateButton = (el: HTMLElement) =>
    [...el.querySelectorAll('button')].find(b => b.textContent?.includes('Generate'))!;

  it('closes with what the form asked for', () => {
    const { componentInstance: dialog } = create();
    dialog.form().prompt.setValue('a hat');
    dialog.confirm();
    expect(close).toHaveBeenCalledWith({ prompt: 'a hat', count: DEFAULT_SWAP_COUNT });
  });

  it('does not close while the form is invalid', () => {
    create().componentInstance.confirm();
    expect(close).not.toHaveBeenCalled();
  });

  it('disables Generate until there is a prompt', () => {
    const fixture = create();
    expect(generateButton(fixture.nativeElement).disabled).toBe(true);
    fixture.componentInstance.form().prompt.setValue('a hat');
    fixture.detectChanges();
    expect(generateButton(fixture.nativeElement).disabled).toBe(false);
  });

  it("shows the caller's hint in place of the default one", () => {
    const fixture = create({ thumbnailUrl: 'frame.jpg', hint: 'This frame is edited.' });
    const text = (fixture.nativeElement as HTMLElement).querySelector('.still-hint')?.textContent;
    expect(text).toContain('This frame is edited.');
  });
});
