import { ChangeDetectionStrategy, Component } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSliderModule } from '@angular/material/slider';
import { TextFieldModule } from '@angular/cdk/text-field';

export interface ClothesSwapResult {
  prompt: string;
  /** Edited copies to generate in this run. */
  count: number;
}

/** The longest prompt the receiver is asked to take; it travels in a query string. */
export const MAX_SWAP_PROMPT_LENGTH = 2000;

/** Edits per run. The server's ceiling is 8 — each is a full pass on one GPU. */
export const DEFAULT_SWAP_COUNT = 1;
export const MIN_SWAP_COUNT = 1;
export const MAX_SWAP_COUNT = 8;

/**
 * The inputs for a clothes swap: what to change about the clothing, pose or
 * background, and how many versions. Shared by the gallery's dialog and the
 * queue screen's, so both ask the same.
 */
@Component({
  selector: 'app-clothes-swap-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatInputModule, MatFormFieldModule, MatSliderModule, TextFieldModule],
  template: `
    <mat-form-field appearance="outline" class="prompt-field">
      <mat-label>Changes</mat-label>
      <textarea matInput
                cdkTextareaAutosize
                cdkAutosizeMinRows="4"
                cdkAutosizeMaxRows="10"
                [formControl]="prompt"
                [maxlength]="MAX_PROMPT"
                placeholder="e.g. Change the clothing to a charcoal wool overcoat over a white shirt. Replace the background with a city street at dusk."></textarea>
      <mat-hint align="end">{{ length() }} / {{ MAX_PROMPT }}</mat-hint>
    </mat-form-field>

    <div class="count">
      <label class="count-label" for="swap-count">
        Images <span class="count-value">{{ chosenCount() }}</span>
      </label>
      <mat-slider [min]="MIN_COUNT" [max]="MAX_COUNT" step="1" discrete>
        <input matSliderThumb id="swap-count" [formControl]="count"
               aria-label="Number of images to generate" />
      </mat-slider>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .prompt-field { width: 100%; }
    .count { display: flex; flex-direction: column; }
    .count-label { font-size: 0.85rem; }
    .count-value { font-weight: 500; }
    /* Stretched by the flex column rather than width:100% -- the slider has 8px
       side margins, and 100% plus those overflows into a sideways scroll. */
    mat-slider { width: auto; }
  `],
})
export class ClothesSwapFormComponent {
  readonly MAX_PROMPT = MAX_SWAP_PROMPT_LENGTH;
  readonly MIN_COUNT = MIN_SWAP_COUNT;
  readonly MAX_COUNT = MAX_SWAP_COUNT;

  // Whitespace alone is no instruction, so the required check runs on the
  // trimmed value rather than on what is literally in the box.
  readonly prompt = new FormControl('', {
    nonNullable: true,
    validators: [c => (String(c.value).trim() ? null : { required: true }), Validators.maxLength(MAX_SWAP_PROMPT_LENGTH)],
  });

  readonly count = new FormControl(DEFAULT_SWAP_COUNT, { nonNullable: true });

  readonly form = new FormGroup({ prompt: this.prompt, count: this.count });

  /** For the host's submit button. */
  readonly invalid = toSignal(this.form.statusChanges.pipe(map(s => s !== 'VALID')), {
    initialValue: this.form.invalid,
  });

  private readonly value = toSignal(this.prompt.valueChanges, { initialValue: '' });
  readonly length = () => this.value().length;

  readonly chosenCount = toSignal(this.count.valueChanges, { initialValue: DEFAULT_SWAP_COUNT });

  /** What was asked for, or null while the form can't be sent. */
  result(): ClothesSwapResult | null {
    const prompt = this.prompt.value.trim();
    if (!prompt || this.form.invalid) return null;
    return { prompt, count: this.count.value };
  }
}
