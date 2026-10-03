import { ChangeDetectionStrategy, Component, OnDestroy, computed, signal, viewChild, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { EntityPick, entityImageSrc } from '@app/features/entities/entity-picker/entity-picker';
import {
  EntityPickerDialogComponent,
  EntityPickerDialogData,
} from '@app/features/entities/entity-picker/entity-picker-dialog';
import { VideoGenFormComponent, VideoGenResult } from '@app/features/entities/entity-detail/video-gen-form';
import { PhotoGenFormComponent, PhotoGenResult } from '@app/features/entities/entity-detail/photo-gen-form';
import { ClothesSwapFormComponent, ClothesSwapResult } from '@app/features/entities/entity-detail/clothes-swap-form';

/** The generators the gallery offers, by what they make. */
export type NewGenerationKind = 'video' | 'images' | 'clothes-swap';

/** The generator chosen, paired with what its form asked for. */
export type NewGenerationRequest =
  | { kind: 'video'; request: VideoGenResult }
  | { kind: 'images'; request: PhotoGenResult }
  | { kind: 'clothes-swap'; request: ClothesSwapResult };

export type NewGenerationResult = NewGenerationRequest & {
  /** The source image, as picked, dropped or pasted. */
  file: File;
  /** Where the finished assets are attached. */
  entity: EntityPick;
};

/** Same ceiling the upload route enforces. */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/**
 * Starts a generation from the queue screen. The gallery already knows its
 * photo and its entity, so here the user supplies both — an image from disk, a
 * drop, or the clipboard — alongside the chosen generator's inputs. Those
 * inputs are the gallery dialogs' own form components, so the options match.
 */
@Component({
  selector: 'app-new-generation-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatButtonModule,
    MatButtonToggleModule,
    MatDialogModule,
    MatIconModule,
    VideoGenFormComponent,
    PhotoGenFormComponent,
    ClothesSwapFormComponent,
  ],
  host: { '(window:paste)': 'onPaste($event)' },
  template: `
    <h2 mat-dialog-title>New generation</h2>
    <mat-dialog-content>
      <h3 class="step">Generate</h3>
      <mat-button-toggle-group class="kinds" [value]="kind()" (change)="kind.set($event.value)"
                               aria-label="What to generate">
        <mat-button-toggle value="images"><mat-icon>auto_awesome</mat-icon> Images</mat-button-toggle>
        <mat-button-toggle value="video"><mat-icon>movie</mat-icon> Video</mat-button-toggle>
        <mat-button-toggle value="clothes-swap"><mat-icon>checkroom</mat-icon> Clothes swap</mat-button-toggle>
      </mat-button-toggle-group>

      <h3 class="step">Image</h3>
      <div class="drop"
           [class.drop--over]="dragOver()"
           (dragover)="onDragOver($event)"
           (dragleave)="dragOver.set(false)"
           (drop)="onDrop($event)">
        @if (preview(); as url) {
          <img class="drop-preview" [src]="url" alt="Source image" (error)="onPreviewError()" />
        } @else {
          <mat-icon class="drop-icon">add_photo_alternate</mat-icon>
        }
        <div class="drop-body">
          <p class="drop-text">
            {{ file() ? file()!.name : 'Drop an image here, or paste one with Ctrl+V.' }}
          </p>
          <div class="drop-actions">
            <button mat-stroked-button type="button" (click)="picker.click()">
              <mat-icon>folder_open</mat-icon> Choose file
            </button>
            <button mat-stroked-button type="button" (click)="pasteFromClipboard()">
              <mat-icon>content_paste</mat-icon> Paste
            </button>
          </div>
        </div>
        <input #picker type="file" accept="image/*" hidden (change)="onFileChosen(picker)" />
      </div>
      @if (imageError()) {
        <p class="error" role="alert">{{ imageError() }}</p>
      }

      <h3 class="step">Details</h3>
      <p class="kind-hint">{{ kindHint() }}</p>

      <div class="generator">
        @switch (kind()) {
          @case ('images') { <app-photo-gen-form /> }
          @case ('video') { <app-video-gen-form /> }
          @case ('clothes-swap') { <app-clothes-swap-form /> }
        }
      </div>

      <h3 class="step">Save to</h3>
      <div class="save-to">
        @if (entityImage(); as src) {
          <img class="save-to-avatar" [src]="src" alt="" />
        } @else {
          <span class="save-to-avatar save-to-avatar--empty"><mat-icon>person</mat-icon></span>
        }
        <span class="save-to-name" [class.save-to-name--empty]="!entity()">
          {{ entity()?.name ?? 'No entity chosen' }}
        </span>
        <button mat-stroked-button type="button" (click)="chooseEntity()">
          {{ entity() ? 'Change' : 'Choose entity' }}
        </button>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="!ready()" (click)="confirm()">Generate</button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { width: min(520px, 90vw); box-sizing: border-box; }
    .step { margin: 12px 0 8px; font-size: 0.9rem; font-weight: 500; }
    .drop {
      display: flex; gap: 12px; align-items: center; padding: 12px;
      border: 2px dashed rgba(128, 128, 128, 0.4); border-radius: 8px;
    }
    .drop--over { border-color: var(--mat-sys-primary); background: rgba(103, 80, 164, 0.08); }
    .drop-preview { width: 88px; height: 88px; object-fit: cover; border-radius: 8px; flex: 0 0 auto; }
    .drop-icon { font-size: 48px; width: 88px; height: 48px; opacity: 0.5; flex: 0 0 auto; }
    .drop-body { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
    .drop-text { margin: 0; font-size: 0.85rem; overflow-wrap: anywhere; }
    .drop-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .error { margin: 6px 0 0; font-size: 0.8rem; color: var(--mat-sys-error); }
    .kinds { display: flex; flex-wrap: wrap; }
    .kinds mat-button-toggle { flex: 1 1 auto; }
    .kind-hint { margin: 0 0 12px; font-size: 0.8rem; opacity: 0.75; }
    .save-to {
      display: flex; align-items: center; gap: 10px; padding: 8px 12px;
      border: 1px solid rgba(128, 128, 128, 0.3); border-radius: 8px;
    }
    .save-to-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; flex: 0 0 auto; }
    .save-to-avatar--empty {
      display: flex; align-items: center; justify-content: center; background: rgba(128, 128, 128, 0.2);
    }
    .save-to-avatar--empty mat-icon { opacity: 0.7; }
    .save-to-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .save-to-name--empty { opacity: 0.6; }
  `],
})
export class NewGenerationDialogComponent implements OnDestroy {
  private dialogRef = inject<MatDialogRef<NewGenerationDialogComponent, NewGenerationResult>>(MatDialogRef);
  private dialog = inject(MatDialog);

  readonly file = signal<File | null>(null);
  readonly preview = signal<string | null>(null);
  readonly imageError = signal<string | null>(null);
  readonly dragOver = signal(false);
  readonly kind = signal<NewGenerationKind>('images');
  readonly entity = signal<EntityPick | null>(null);
  readonly entityImage = computed(() => entityImageSrc(this.entity()?.thumbnailUrl));

  /** Only the chosen generator's form is on screen; the others are undefined. */
  readonly videoForm = viewChild(VideoGenFormComponent);
  readonly photoForm = viewChild(PhotoGenFormComponent);
  readonly swapForm = viewChild(ClothesSwapFormComponent);

  private readonly activeForm = computed(() => {
    switch (this.kind()) {
      case 'video':
        return this.videoForm();
      case 'images':
        return this.photoForm();
      case 'clothes-swap':
        return this.swapForm();
    }
  });

  readonly ready = computed(() => {
    const form = this.activeForm();
    return !!this.file() && !this.imageError() && !!this.entity() && !!form && !form.invalid();
  });

  /** The same line the gallery's dialog shows under its photo. */
  readonly kindHint = computed(() => {
    switch (this.kind()) {
      case 'video':
        return 'This image is the first frame. Describe the motion you want.';
      case 'images':
        return "This image's face is kept. Describe the images you want.";
      case 'clothes-swap':
        return 'This person is kept. Describe the clothing, pose or background changes you want.';
    }
  });

  ngOnDestroy(): void {
    this.revokePreview();
  }

  /** Opens the picker on its own; a cancelled pick keeps the current choice. */
  chooseEntity(): void {
    this.dialog
      .open<EntityPickerDialogComponent, EntityPickerDialogData, EntityPick>(EntityPickerDialogComponent, {
        data: { title: 'Save results to' },
      })
      .afterClosed()
      .subscribe(pick => {
        if (pick) this.entity.set(pick);
      });
  }

  onPaste(event: ClipboardEvent): void {
    const image = [...(event.clipboardData?.files ?? [])].find(f => f.type.startsWith('image/'));
    // Text pasted into a prompt box carries no image, so it passes straight through.
    if (!image) return;
    event.preventDefault();
    this.useFile(image);
  }

  /** The button route to the clipboard, for when there's no keyboard to paste with. */
  async pasteFromClipboard(): Promise<void> {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(t => t.startsWith('image/'));
        if (!type) continue;
        const blob = await item.getType(type);
        this.useFile(new File([blob], `pasted.${type.split('/')[1] || 'png'}`, { type }));
        return;
      }
      this.imageError.set('There is no image on the clipboard.');
    } catch {
      this.imageError.set('Could not read the clipboard — try Ctrl+V instead.');
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(true);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(false);
    const dropped = event.dataTransfer?.files?.[0];
    if (dropped) this.useFile(dropped);
  }

  onFileChosen(input: HTMLInputElement): void {
    const chosen = input.files?.[0];
    // Cleared so choosing the same file again still fires a change.
    input.value = '';
    if (chosen) this.useFile(chosen);
  }

  /** The browser couldn't draw it, so the generator couldn't read it either. */
  onPreviewError(): void {
    this.imageError.set("That file can't be read as an image — try a JPEG or PNG.");
  }

  useFile(file: File): void {
    if (!file.type.startsWith('image/')) {
      this.imageError.set('That is not an image.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      this.imageError.set('That image is larger than the 50 MB limit.');
      return;
    }
    this.revokePreview();
    this.imageError.set(null);
    this.file.set(file);
    this.preview.set(URL.createObjectURL(file));
  }

  confirm(): void {
    const file = this.file();
    const entity = this.entity();
    if (!this.ready() || !file || !entity) return;
    const chosen = this.chosenRequest();
    if (chosen) this.dialogRef.close({ ...chosen, file, entity });
  }

  private chosenRequest(): NewGenerationRequest | null {
    switch (this.kind()) {
      case 'video': {
        const request = this.videoForm()?.result();
        return request ? { kind: 'video', request } : null;
      }
      case 'images': {
        const request = this.photoForm()?.result();
        return request ? { kind: 'images', request } : null;
      }
      case 'clothes-swap': {
        const request = this.swapForm()?.result();
        return request ? { kind: 'clothes-swap', request } : null;
      }
    }
  }

  private revokePreview(): void {
    const url = this.preview();
    if (url) URL.revokeObjectURL(url);
    this.preview.set(null);
  }
}
