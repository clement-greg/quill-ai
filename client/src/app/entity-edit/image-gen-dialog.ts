import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatIconModule } from '@angular/material/icon';
import { TextFieldModule } from '@angular/cdk/text-field';

/** A photo that can be used as the reference (source) image for generation. */
export interface ImageGenSource {
  url: string;
  thumbnailUrl: string;
  label: string;
}

export interface ImageGenDialogData {
  /** Photos selectable as the reference image. Omit to hide the source picker. */
  sources?: ImageGenSource[];
  /** URL of the source selected by default (e.g. the entity's profile picture). */
  defaultSourceUrl?: string;
  /** Provider selected by default. Defaults to 'gpt'. */
  defaultProvider?: 'gpt' | 'gemini';
}

export interface ImageGenResult {
  prompt: string;
  provider: 'gpt' | 'gemini';
  /** URL of the reference image to keep the same face/body, if one was chosen. */
  referenceImageUrl?: string;
}

@Component({
  selector: 'app-image-gen-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatInputModule,
    MatFormFieldModule,
    MatSelectModule,
    MatIconModule,
    TextFieldModule,
  ],
  template: `
    <h2 mat-dialog-title>Generate Image</h2>
    <mat-dialog-content>
      <mat-form-field appearance="outline" class="prompt-field">
        <mat-label>Image prompt</mat-label>
        <textarea matInput
                  cdkTextareaAutosize
                  cdkAutosizeMinRows="4"
                  cdkAutosizeMaxRows="10"
                  [(ngModel)]="prompt"
                  placeholder="Describe the image you want to generate…"></textarea>
      </mat-form-field>

      @if (sources.length) {
        <div class="source-section">
          <span class="source-label">Source photo</span>
          <p class="source-hint">The generated image will reuse this face and body.</p>
          <div class="source-grid">
            <button type="button" class="source-card"
                    [class.source-card--selected]="selectedSourceUrl() === null"
                    (click)="selectedSourceUrl.set(null)"
                    aria-label="No reference photo">
              <mat-icon class="source-none-icon">block</mat-icon>
              <span class="source-name">None</span>
            </button>
            @for (s of sources; track s.url) {
              <button type="button" class="source-card"
                      [class.source-card--selected]="selectedSourceUrl() === s.url"
                      (click)="selectedSourceUrl.set(s.url)"
                      [attr.aria-label]="'Use ' + s.label + ' as reference'">
                <img [src]="proxyUrl(s.thumbnailUrl)" [alt]="s.label" />
                <span class="source-name">{{ s.label }}</span>
              </button>
            }
          </div>
        </div>
      }

      <mat-form-field appearance="outline" class="model-field">
        <mat-label>Model</mat-label>
        <mat-select [(ngModel)]="provider">
          <mat-option value="gpt">GPT Image (Azure Foundry)</mat-option>
          <mat-option value="gemini">Gemini (Google AI Studio)</mat-option>
        </mat-select>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="!prompt.trim()" (click)="confirm()">
        Generate
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .prompt-field { width: 100%; }
    .model-field { width: 100%; margin-top: 8px; }
    mat-dialog-content { width: min(460px, 90vw); box-sizing: border-box; }
    .source-section { margin: 4px 0 12px; }
    .source-label { font-weight: 500; font-size: 0.9rem; }
    .source-hint { margin: 2px 0 8px; font-size: 0.78rem; opacity: 0.7; }
    .source-grid { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; }
    .source-card {
      flex: 0 0 auto; width: 72px; padding: 0; border: 2px solid transparent;
      border-radius: 8px; background: rgba(127,127,127,0.08); cursor: pointer;
      display: flex; flex-direction: column; align-items: center; overflow: hidden;
    }
    .source-card img { width: 72px; height: 72px; object-fit: cover; display: block; }
    .source-none-icon { width: 72px; height: 72px; font-size: 32px; display: flex;
      align-items: center; justify-content: center; opacity: 0.5; }
    .source-card--selected { border-color: var(--mat-sys-primary, #6750a4); }
    .source-name {
      width: 100%; padding: 3px 4px; font-size: 0.72rem; text-align: center;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
  `],
})
export class ImageGenDialogComponent {
  private dialogRef = inject(MatDialogRef<ImageGenDialogComponent>);
  private data = inject<ImageGenDialogData | null>(MAT_DIALOG_DATA, { optional: true });

  prompt = '';
  provider: 'gpt' | 'gemini' = this.data?.defaultProvider ?? 'gpt';
  readonly sources: ImageGenSource[] = this.data?.sources ?? [];
  selectedSourceUrl = signal<string | null>(
    this.data?.defaultSourceUrl ?? this.sources[0]?.url ?? null,
  );

  proxyUrl(url: string): string {
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : url;
  }

  confirm(): void {
    const text = this.prompt.trim();
    if (!text) return;
    this.dialogRef.close({
      prompt: text,
      provider: this.provider,
      referenceImageUrl: this.selectedSourceUrl() ?? undefined,
    } satisfies ImageGenResult);
  }
}
