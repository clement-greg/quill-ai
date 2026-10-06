import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { of } from 'rxjs';
import { EntityPickerDialogComponent } from '@app/features/entities/entity-picker/entity-picker-dialog';
import { NewGenerationDialogComponent } from './new-generation-dialog';

/** Replaces only the clipboard -- Angular reads other parts of navigator. */
function stubClipboard(read: () => Promise<unknown[]>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { read }, configurable: true });
}

const png = (name = 'a.png', size = 10) =>
  new File([new Uint8Array(size)], name, { type: 'image/png' });

describe('NewGenerationDialogComponent', () => {
  let close: ReturnType<typeof vi.fn>;
  let pickerResult: unknown;
  let opened: unknown[];

  function create(): ComponentFixture<NewGenerationDialogComponent> {
    close = vi.fn();
    TestBed.configureTestingModule({
      imports: [NewGenerationDialogComponent],
      providers: [{ provide: MatDialogRef, useValue: { close } }],
    });
    // Overridden rather than provided: the component's own MatDialogModule
    // would otherwise hand it the real service.
    TestBed.overrideProvider(MatDialog, {
      useValue: {
        open: (component: unknown) => {
          opened.push(component);
          return { afterClosed: () => of(pickerResult) };
        },
      },
    });
    const fixture = TestBed.createComponent(NewGenerationDialogComponent);
    fixture.detectChanges();
    return fixture;
  }

  /** Fills in everything but the generator's own form. */
  function withImageAndEntity(fixture: ComponentFixture<NewGenerationDialogComponent>, file = png()) {
    fixture.componentInstance.useFile(file);
    fixture.componentInstance.entity.set({ id: 'e-1', name: 'Janet' });
    fixture.detectChanges();
    return file;
  }

  beforeEach(() => {
    pickerResult = undefined;
    opened = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('defaults to generating images and shows that form', () => {
    const fixture = create();
    expect(fixture.componentInstance.kind()).toBe('images');
    expect(fixture.componentInstance.photoForm()).toBeDefined();
  });

  it('swaps in the chosen generator form', () => {
    const fixture = create();
    fixture.componentInstance.kind.set('clothes-swap');
    fixture.detectChanges();
    expect(fixture.componentInstance.swapForm()).toBeDefined();
    expect(fixture.componentInstance.photoForm()).toBeUndefined();
  });

  it('is not ready until it has an image, an entity, and a filled-in form', () => {
    const fixture = create();
    const dialog = fixture.componentInstance;
    expect(dialog.ready()).toBe(false);
    withImageAndEntity(fixture);
    expect(dialog.ready()).toBe(false);
    dialog.photoForm()!.prompt.setValue('a portrait');
    expect(dialog.ready()).toBe(true);
  });

  it('closes with the image, the entity and an images request', () => {
    const fixture = create();
    const file = withImageAndEntity(fixture);
    fixture.componentInstance.photoForm()!.prompt.setValue('a portrait');
    fixture.componentInstance.photoForm()!.count.setValue(5);

    fixture.componentInstance.confirm();

    expect(close).toHaveBeenCalledWith({
      kind: 'images',
      request: { prompt: 'a portrait', count: 5 },
      file,
      entity: { id: 'e-1', name: 'Janet' },
    });
  });

  it('closes with a video request', () => {
    const fixture = create();
    fixture.componentInstance.kind.set('video');
    fixture.detectChanges();
    withImageAndEntity(fixture);
    fixture.componentInstance.videoForm()!.prompt.setValue('she waves');
    fixture.componentInstance.videoForm()!.duration.setValue(3);

    fixture.componentInstance.confirm();

    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'video', request: { prompt: 'she waves', durationSeconds: 3 } })
    );
  });

  it('closes with a clothes-swap request', () => {
    const fixture = create();
    fixture.componentInstance.kind.set('clothes-swap');
    fixture.detectChanges();
    withImageAndEntity(fixture);
    fixture.componentInstance.swapForm()!.prompt.setValue('a red coat');

    fixture.componentInstance.confirm();

    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'clothes-swap', request: { prompt: 'a red coat', count: 8 } })
    );
  });

  it('does not close until everything is filled in', () => {
    const fixture = create();
    withImageAndEntity(fixture);
    fixture.componentInstance.confirm();
    expect(close).not.toHaveBeenCalled();
  });

  it('picks the entity in a separate dialog', () => {
    pickerResult = { id: 'e-9', name: 'Bob' };
    const { componentInstance: dialog } = create();
    dialog.chooseEntity();
    expect(opened).toEqual([EntityPickerDialogComponent]);
    expect(dialog.entity()).toEqual({ id: 'e-9', name: 'Bob' });
  });

  it("shows the chosen entity's profile picture", () => {
    const fixture = create();
    fixture.componentInstance.entity.set({ id: 'e-1', name: 'Janet', thumbnailUrl: 'https://blob.test/janet_thumb.webp' });
    fixture.detectChanges();
    const img = (fixture.nativeElement as HTMLElement).querySelector<HTMLImageElement>('img.save-to-avatar');
    expect(img?.getAttribute('src')).toBe('/api/image/janet_thumb.webp');
  });

  it('falls back to an icon for an entity without a picture', () => {
    const fixture = create();
    fixture.componentInstance.entity.set({ id: 'e-1', name: 'Janet' });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('img.save-to-avatar')).toBeNull();
    expect(el.querySelector('.save-to-avatar--empty')).not.toBeNull();
  });

  it('keeps the current entity when the picker is cancelled', () => {
    const { componentInstance: dialog } = create();
    dialog.entity.set({ id: 'e-1', name: 'Janet' });
    dialog.chooseEntity();
    expect(dialog.entity()).toEqual({ id: 'e-1', name: 'Janet' });
  });

  it('refuses a file that is not an image', () => {
    const { componentInstance: dialog } = create();
    dialog.useFile(new File(['x'], 'notes.txt', { type: 'text/plain' }));
    expect(dialog.file()).toBeNull();
    expect(dialog.imageError()).toMatch(/not an image/);
  });

  it('refuses an image over the upload limit', () => {
    const { componentInstance: dialog } = create();
    dialog.useFile(png('huge.png', 50 * 1024 * 1024 + 1));
    expect(dialog.file()).toBeNull();
    expect(dialog.imageError()).toMatch(/50 MB/);
  });

  it('takes an image pasted with the keyboard', () => {
    const { componentInstance: dialog } = create();
    const file = png('pasted.png');
    const event = { clipboardData: { files: [file] }, preventDefault: vi.fn() } as unknown as ClipboardEvent;

    dialog.onPaste(event);

    expect(dialog.file()).toBe(file);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('lets a text paste through, so prompts can still be pasted', () => {
    const { componentInstance: dialog } = create();
    const event = { clipboardData: { files: [] }, preventDefault: vi.fn() } as unknown as ClipboardEvent;
    dialog.onPaste(event);
    expect(dialog.file()).toBeNull();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('takes an image from the clipboard button', async () => {
    const blob = new Blob([new Uint8Array(4)], { type: 'image/png' });
    stubClipboard(async () => [{ types: ['image/png'], getType: async () => blob }]);
    const { componentInstance: dialog } = create();

    await dialog.pasteFromClipboard();

    expect(dialog.file()?.type).toBe('image/png');
  });

  it('says so when the clipboard has no image', async () => {
    stubClipboard(async () => [{ types: ['text/plain'] }]);
    const { componentInstance: dialog } = create();

    await dialog.pasteFromClipboard();

    expect(dialog.imageError()).toMatch(/no image on the clipboard/);
  });

  it('takes a dropped image', () => {
    const { componentInstance: dialog } = create();
    const file = png('dropped.png');
    dialog.onDrop({ preventDefault: vi.fn(), dataTransfer: { files: [file] } } as unknown as DragEvent);
    expect(dialog.file()).toBe(file);
    expect(dialog.dragOver()).toBe(false);
  });

  it('blocks Generate when the browser cannot draw the image', () => {
    const fixture = create();
    withImageAndEntity(fixture);
    fixture.componentInstance.photoForm()!.prompt.setValue('a portrait');
    fixture.componentInstance.onPreviewError();
    expect(fixture.componentInstance.ready()).toBe(false);
  });

  it('revokes the preview when it closes', () => {
    const fixture = create();
    fixture.componentInstance.useFile(png());
    fixture.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });
});
