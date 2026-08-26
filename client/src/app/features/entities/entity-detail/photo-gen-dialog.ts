import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSliderModule } from '@angular/material/slider';
import { TextFieldModule } from '@angular/cdk/text-field';

export interface PhotoGenDialogData {
  /** Thumbnail of the photo the face is taken from, shown for confirmation. */
  thumbnailUrl: string;
  caption?: string;
  /** Overrides the line under the thumbnail — a captured video frame says so. */
  hint?: string;
}

/**
 * What to ask the receiver for. Everything past `prompt` and `count` is left out
 * unless it was filled in, so the workflow's own defaults stand.
 */
export interface PhotoGenResult {
  prompt: string;
  /** Images to generate in this run. */
  count: number;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
}

/** The longest prompt the receiver is asked to take; it travels in a query string. */
export const MAX_IMAGE_PROMPT_LENGTH = 2000;

/** Images per run. The receiver's own default is 3 and its ceiling is 12. */
export const DEFAULT_IMAGE_COUNT = 3;
export const MIN_IMAGE_COUNT = 1;
export const MAX_IMAGE_COUNT = 12;

/** The advanced fields, with the range the server accepts each in. */
const ADVANCED_LIMITS = {
  width: { min: 64, max: 2048, step: 8 },
  height: { min: 64, max: 2048, step: 8 },
  steps: { min: 1, max: 150, step: 1 },
  cfg: { min: 0, max: 30, step: 0.1 },
  seed: { min: 0, max: 4294967295, step: 1 },
} as const;

/**
 * Collects the prompt for a batch of stills generated from one gallery photo —
 * the face comes from the photo, everything else from the prompt. The photo is
 * already chosen; this only asks what the new images should show.
 */
@Component({
  selector: 'app-photo-gen-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
    MatSliderModule,
    TextFieldModule,
  ],
  template: `
    <h2 mat-dialog-title>Generate images</h2>
    <mat-dialog-content>
      <div class="still">
        <img [src]="data.thumbnailUrl" [alt]="data.caption || 'Reference photo'" />
        <p class="still-hint">{{ data.hint || "This photo's face is kept. Describe the images you want." }}</p>
      </div>
      <mat-form-field appearance="outline" class="prompt-field">
        <mat-label>Image prompt</mat-label>
        <textarea matInput
                  cdkTextareaAutosize
                  cdkAutosizeMinRows="4"
                  cdkAutosizeMaxRows="10"
                  [formControl]="prompt"
                  [maxlength]="MAX_PROMPT"
                  placeholder="e.g. in dress uniform on a parade ground, golden hour, waist-up portrait"></textarea>
        <mat-hint align="end">{{ length() }} / {{ MAX_PROMPT }}</mat-hint>
      </mat-form-field>

      <div class="count">
        <label class="count-label" for="image-count">
          Images <span class="count-value">{{ countLabel() }}</span>
        </label>
        <mat-slider [min]="MIN_COUNT" [max]="MAX_COUNT" step="1" discrete>
          <input matSliderThumb id="image-count" [formControl]="count"
                 aria-label="Number of images to generate" />
        </mat-slider>
      </div>

      <button mat-button type="button" class="more-toggle" (click)="toggleAdvanced()">
        <mat-icon>{{ showAdvanced() ? 'expand_less' : 'expand_more' }}</mat-icon>
        {{ showAdvanced() ? 'Fewer options' : 'More options' }}
      </button>

      @if (showAdvanced()) {
        <div class="advanced" [formGroup]="advanced">
          <p class="advanced-hint">Leave a field empty to keep the generator's own setting.</p>
          <mat-form-field appearance="outline" class="prompt-field">
            <mat-label>Negative prompt</mat-label>
            <textarea matInput
                      cdkTextareaAutosize
                      cdkAutosizeMinRows="2"
                      cdkAutosizeMaxRows="6"
                      formControlName="negativePrompt"
                      [maxlength]="MAX_PROMPT"
                      placeholder="e.g. blurry, extra fingers, watermark"></textarea>
          </mat-form-field>

          <div class="number-grid">
            @for (field of NUMBER_FIELDS; track field.name) {
              <mat-form-field appearance="outline">
                <mat-label>{{ field.label }}</mat-label>
                <input matInput type="number" [formControlName]="field.name"
                       [min]="field.min" [max]="field.max" [step]="field.step" />
              </mat-form-field>
            }
          </div>
        </div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="prompt.invalid || advanced.invalid" (click)="confirm()">
        Generate
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { width: min(460px, 90vw); box-sizing: border-box; }
    .still { display: flex; gap: 12px; align-items: center; margin: 4px 0 16px; }
    .still img { width: 88px; height: 88px; object-fit: cover; border-radius: 8px; flex: 0 0 auto; }
    .still-hint { margin: 0; font-size: 0.8rem; opacity: 0.75; }
    .prompt-field { width: 100%; }
    .count { display: flex; flex-direction: column; }
    .count-label { font-size: 0.85rem; }
    .count-value { font-weight: 500; }
    mat-slider { width: 100%; }
    .more-toggle { align-self: flex-start; margin: 4px 0 8px; }
    .advanced-hint { margin: 0 0 12px; font-size: 0.8rem; opacity: 0.75; }
    /* min-width:0 lets a form field shrink inside its grid track — without it the
       inputs keep their intrinsic width and the dialog scrolls sideways. */
    .number-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 0 12px; }
    .number-grid mat-form-field { width: 100%; min-width: 0; }
  `],
})
export class PhotoGenDialogComponent {
  readonly data = inject<PhotoGenDialogData>(MAT_DIALOG_DATA);
  private dialogRef = inject<MatDialogRef<PhotoGenDialogComponent, PhotoGenResult>>(MatDialogRef);

  readonly MAX_PROMPT = MAX_IMAGE_PROMPT_LENGTH;
  readonly MIN_COUNT = MIN_IMAGE_COUNT;
  readonly MAX_COUNT = MAX_IMAGE_COUNT;

  readonly NUMBER_FIELDS = [
    { name: 'width', label: 'Width', ...ADVANCED_LIMITS.width },
    { name: 'height', label: 'Height', ...ADVANCED_LIMITS.height },
    { name: 'steps', label: 'Steps', ...ADVANCED_LIMITS.steps },
    { name: 'cfg', label: 'CFG', ...ADVANCED_LIMITS.cfg },
    { name: 'seed', label: 'Seed', ...ADVANCED_LIMITS.seed },
  ] as const;

  // A prompt of only whitespace is no prompt, so the required check runs on the
  // trimmed value rather than on what is literally in the box.
  readonly prompt = new FormControl('', {
    nonNullable: true,
    validators: [c => (String(c.value).trim() ? null : { required: true }), Validators.maxLength(MAX_IMAGE_PROMPT_LENGTH)],
  });

  readonly count = new FormControl(DEFAULT_IMAGE_COUNT, { nonNullable: true });

  /**
   * The extra settings, all optional. An empty box means "not asked for" and is
   * dropped on the way out — the server then leaves the parameter off entirely
   * so the receiver's workflow keeps its own value.
   */
  readonly advanced = new FormGroup({
    negativePrompt: new FormControl('', { nonNullable: true }),
    width: new FormControl<number | null>(null, range(ADVANCED_LIMITS.width)),
    height: new FormControl<number | null>(null, range(ADVANCED_LIMITS.height)),
    steps: new FormControl<number | null>(null, range(ADVANCED_LIMITS.steps)),
    cfg: new FormControl<number | null>(null, range(ADVANCED_LIMITS.cfg)),
    seed: new FormControl<number | null>(null, range(ADVANCED_LIMITS.seed)),
  });

  readonly showAdvanced = signal(false);

  private readonly value = toSignal(this.prompt.valueChanges, { initialValue: '' });
  readonly length = () => this.value().length;

  private readonly chosenCount = toSignal(this.count.valueChanges, {
    initialValue: DEFAULT_IMAGE_COUNT,
  });
  readonly countLabel = () => `${this.chosenCount()}`;

  toggleAdvanced(): void {
    this.showAdvanced.update(open => !open);
  }

  confirm(): void {
    const prompt = this.prompt.value.trim();
    if (!prompt || this.advanced.invalid) return;

    const extra = this.advanced.getRawValue();
    const negativePrompt = extra.negativePrompt.trim();

    this.dialogRef.close({
      prompt,
      count: this.count.value,
      ...(negativePrompt && { negativePrompt }),
      ...numberIfSet('width', extra.width),
      ...numberIfSet('height', extra.height),
      ...numberIfSet('steps', extra.steps),
      ...numberIfSet('cfg', extra.cfg),
      ...numberIfSet('seed', extra.seed),
    });
  }
}

/** Bounds an optional number box: an empty one is valid, an out-of-range one is not. */
function range({ min, max }: { min: number; max: number }) {
  return (control: { value: unknown }) => {
    if (control.value === null || control.value === undefined || control.value === '') return null;
    const value = Number(control.value);
    return Number.isFinite(value) && value >= min && value <= max ? null : { range: { min, max } };
  };
}

/** Keeps a filled-in box and drops an empty one, so the caller can spread it. */
function numberIfSet(name: string, value: number | null): Record<string, number> {
  return value === null || value === undefined || Number.isNaN(value) ? {} : { [name]: Number(value) };
}
