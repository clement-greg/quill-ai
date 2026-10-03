import { ChangeDetectionStrategy, Component } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSliderModule } from '@angular/material/slider';
import { TextFieldModule } from '@angular/cdk/text-field';

export interface VideoGenResult {
  prompt: string;
  /** Clip length in seconds; the server converts it to a frame count. */
  durationSeconds: number;
}

/** The longest prompt the receiver is asked to take; it travels in a query string. */
export const MAX_VIDEO_PROMPT_LENGTH = 2000;

/** Clip length is chosen in half-second steps; the generator's own default is 5s. */
export const MIN_VIDEO_SECONDS = 0.5;
export const MAX_VIDEO_SECONDS = 8;
export const VIDEO_SECONDS_STEP = 0.5;
export const DEFAULT_VIDEO_SECONDS = 5;

/**
 * The inputs for an image-to-video job: the motion prompt and the clip length.
 * Shared by the gallery's dialog and the queue screen's, so both ask the same.
 */
@Component({
  selector: 'app-video-gen-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatInputModule, MatFormFieldModule, MatSliderModule, TextFieldModule],
  template: `
    <mat-form-field appearance="outline" class="prompt-field">
      <mat-label>Motion prompt</mat-label>
      <textarea matInput
                cdkTextareaAutosize
                cdkAutosizeMinRows="4"
                cdkAutosizeMaxRows="10"
                [formControl]="prompt"
                [maxlength]="MAX_PROMPT"
                placeholder="e.g. slow push in, he turns and smiles, the flag ripples behind him"></textarea>
      <mat-hint align="end">{{ length() }} / {{ MAX_PROMPT }}</mat-hint>
    </mat-form-field>

    <div class="duration">
      <label class="duration-label" for="video-duration">
        Length <span class="duration-value">{{ durationLabel() }}</span>
      </label>
      <mat-slider [min]="MIN_SECONDS" [max]="MAX_SECONDS" [step]="STEP" discrete
                  [displayWith]="formatSeconds">
        <input matSliderThumb id="video-duration" [formControl]="duration"
               aria-label="Clip length in seconds" />
      </mat-slider>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .prompt-field { width: 100%; }
    .duration { display: flex; flex-direction: column; }
    .duration-label { font-size: 0.85rem; }
    .duration-value { font-weight: 500; }
    /* Stretched by the flex column rather than width:100% -- the slider has 8px
       side margins, and 100% plus those overflows into a sideways scroll. */
    mat-slider { width: auto; }
  `],
})
export class VideoGenFormComponent {
  readonly MAX_PROMPT = MAX_VIDEO_PROMPT_LENGTH;
  readonly MIN_SECONDS = MIN_VIDEO_SECONDS;
  readonly MAX_SECONDS = MAX_VIDEO_SECONDS;
  readonly STEP = VIDEO_SECONDS_STEP;

  // A prompt of only whitespace is no prompt, so the required check runs on the
  // trimmed value rather than on what is literally in the box.
  readonly prompt = new FormControl('', {
    nonNullable: true,
    validators: [c => (String(c.value).trim() ? null : { required: true }), Validators.maxLength(MAX_VIDEO_PROMPT_LENGTH)],
  });

  readonly duration = new FormControl(DEFAULT_VIDEO_SECONDS, { nonNullable: true });

  readonly form = new FormGroup({ prompt: this.prompt, duration: this.duration });

  /** For the host's submit button. */
  readonly invalid = toSignal(this.form.statusChanges.pipe(map(s => s !== 'VALID')), {
    initialValue: this.form.invalid,
  });

  private readonly value = toSignal(this.prompt.valueChanges, { initialValue: '' });
  readonly length = () => this.value().length;

  private readonly seconds = toSignal(this.duration.valueChanges, {
    initialValue: DEFAULT_VIDEO_SECONDS,
  });
  readonly durationLabel = () => this.formatSeconds(this.seconds());

  /** Also the slider's own thumb label, so both read the same. */
  readonly formatSeconds = (seconds: number) => `${seconds.toFixed(1)}s`;

  /** What was asked for, or null while the form can't be sent. */
  result(): VideoGenResult | null {
    const prompt = this.prompt.value.trim();
    if (!prompt || this.form.invalid) return null;
    return { prompt, durationSeconds: this.duration.value };
  }
}
