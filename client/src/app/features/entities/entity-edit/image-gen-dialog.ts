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
  /** Dialog heading. Defaults to 'Generate Image'. */
  title?: string;
  /** Photos selectable as the reference image. Omit to hide the source picker. */
  sources?: ImageGenSource[];
  /** Heading for the source picker. Defaults to 'Source photo'. */
  sourceLabel?: string;
  /** Explanatory text under the source heading. */
  sourceHint?: string;
  /** URL of the source selected by default (e.g. the entity's profile picture). */
  defaultSourceUrl?: string;
  /** Existing categories to choose from. Omit/empty to hide the category picker. */
  categories?: string[];
}

export interface ImageGenResult {
  prompt: string;
  /** URL of the reference image to keep the same face/body, if one was chosen. */
  referenceImageUrl?: string;
  /** Chosen category, when a category picker was shown. */
  category?: string;
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
    <h2 mat-dialog-title>{{ title }}</h2>
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
          <span class="source-label">{{ sourceLabel }}</span>
          <p class="source-hint">{{ sourceHint }}</p>
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

      @if (categories.length) {
        <mat-form-field appearance="outline" class="category-field">
          <mat-label>Category</mat-label>
          <mat-select [(ngModel)]="category">
            <mat-option [value]="''">— None —</mat-option>
            @for (c of categories; track c) {
              <mat-option [value]="c">{{ c }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="!prompt.trim()" (click)="confirm()">
        Generate
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .prompt-field { width: 100%; margin-top: 8px; }
    .category-field { width: 100%; margin-top: 8px; }
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
  readonly title = this.data?.title ?? 'Generate Image';
  readonly sourceLabel = this.data?.sourceLabel ?? 'Source photo';
  readonly sourceHint = this.data?.sourceHint ?? 'The generated image will reuse this face and body.';
  readonly sources: ImageGenSource[] = this.data?.sources ?? [];
  readonly categories: string[] = this.data?.categories ?? [];
  category = '';
  selectedSourceUrl = signal<string | null>(this.data?.defaultSourceUrl ?? null);

  proxyUrl(url: string): string {
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : url;
  }

  confirm(): void {
    const text = this.prompt.trim();
    if (!text) return;
    this.dialogRef.close({
      prompt: text,
      referenceImageUrl: this.selectedSourceUrl() ?? undefined,
      category: this.category || undefined,
    } satisfies ImageGenResult);
  }
}
