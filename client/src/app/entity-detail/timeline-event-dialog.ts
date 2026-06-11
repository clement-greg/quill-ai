import {
  Component,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatDialog, MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TextFieldModule } from '@angular/cdk/text-field';
import { Entity, EntityPhoto } from '@shared/models/entity.model';
import { TimelineEvent, TimelineEventPhoto } from '@shared/models/timeline-event.model';
import { EntityService } from '../services/entity.service';
import { PhotoPickerDialogComponent, PhotoPickerResult } from '../entity-edit/photo-picker-dialog';

export interface TimelineEventDialogData {
  entity: Entity;
  event?: TimelineEvent;
}

export interface TimelineEventDialogResult {
  name: string;
  timeframe?: string;
  description?: string;
  photo?: TimelineEventPhoto;
  /** Set when a file upload added a new photo to the entity gallery. */
  updatedEntity?: Entity;
}

@Component({
  selector: 'app-timeline-event-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
    MatProgressSpinnerModule,
    TextFieldModule,
  ],
  template: `
    <h2 mat-dialog-title>{{ data.event ? 'Edit Timeline Event' : 'Add Timeline Event' }}</h2>
    <mat-dialog-content [formGroup]="form">
      <mat-form-field appearance="outline" class="full-field">
        <mat-label>Event name</mat-label>
        <input matInput formControlName="name" required />
      </mat-form-field>

      <mat-form-field appearance="outline" class="full-field">
        <mat-label>Timeframe</mat-label>
        <input matInput formControlName="timeframe" placeholder="e.g. Three years before the war" />
        <mat-hint>Free-form — relative to other events is fine</mat-hint>
      </mat-form-field>

      <mat-form-field appearance="outline" class="full-field">
        <mat-label>Description (optional)</mat-label>
        <textarea matInput
                  cdkTextareaAutosize
                  cdkAutosizeMinRows="2"
                  cdkAutosizeMaxRows="6"
                  formControlName="description"></textarea>
      </mat-form-field>

      <div class="photo-row">
        <div class="photo-preview" [class.photo-preview--empty]="!photo()">
          @if (photo(); as p) {
              <img [src]="proxyUrl(p.thumbnailUrl)" alt="Event photo" />
          } @else {
            <mat-icon>image</mat-icon>
          }
        </div>
        <div class="photo-buttons">
          <button mat-stroked-button type="button" (click)="pickFromGallery()" [disabled]="uploading()">
            <mat-icon>photo_library</mat-icon>
            Gallery
          </button>
          <button mat-stroked-button type="button" (click)="fileInput.click()" [disabled]="uploading()">
            @if (uploading()) {
              <mat-spinner diameter="16" class="upload-spinner" />
            } @else {
              <mat-icon>upload</mat-icon>
            }
            Upload
          </button>
          @if (photo()) {
            <button mat-button type="button" (click)="photo.set(null)" [disabled]="uploading()">
              Remove
            </button>
          }
        </div>
        <input type="file" hidden accept="image/*" #fileInput (change)="onFileSelected($event)" />
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="form.invalid || uploading()" (click)="confirm()">
        Save
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { width: min(440px, 90vw); box-sizing: border-box; }
    .full-field { width: 100%; margin-top: 4px; }
    .photo-row { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
    .photo-preview {
      width: 72px;
      height: 72px;
      border-radius: 8px;
      overflow: hidden;
      flex-shrink: 0;
      background: var(--mat-sys-surface-variant, #e8e0f0);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--mat-sys-on-surface-variant, #49454f);
      img { width: 100%; height: 100%; object-fit: cover; display: block; }
    }
    .photo-buttons { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .upload-spinner { display: inline-block; }
  `],
})
export class TimelineEventDialogComponent {
  private dialogRef = inject(MatDialogRef<TimelineEventDialogComponent>);
  private dialog = inject(MatDialog);
  private entityService = inject(EntityService);
  private fb = inject(FormBuilder);
  readonly data = inject<TimelineEventDialogData>(MAT_DIALOG_DATA);

  form = this.fb.nonNullable.group({
    name: [this.data.event?.name ?? '', Validators.required],
    timeframe: [this.data.event?.timeframe ?? ''],
    description: [this.data.event?.description ?? ''],
  });

  photo = signal<TimelineEventPhoto | null>(this.data.event?.photo ?? null);
  uploading = signal(false);

  private entityPhotos = signal<EntityPhoto[]>(this.data.entity.photos ?? []);
  private updatedEntity: Entity | undefined;

  pickFromGallery(): void {
    const ref = this.dialog.open(PhotoPickerDialogComponent, {
      data: this.entityPhotos(),
      autoFocus: false,
    });
    ref.afterClosed().subscribe((result?: PhotoPickerResult) => {
      if (result) this.photo.set({ url: result.url, thumbnailUrl: result.thumbnailUrl });
    });
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    this.uploading.set(true);
    this.entityService.uploadThumbnail(file).subscribe({
      next: ({ url, thumbnailUrl }) => {
        // New photos always join the entity gallery so they show up everywhere.
        this.entityService.addPhoto(this.data.entity.id, url, thumbnailUrl).subscribe({
          next: updated => {
            this.updatedEntity = updated;
            this.entityPhotos.set(updated.photos ?? []);
            this.photo.set({ url, thumbnailUrl });
            this.uploading.set(false);
          },
          error: () => this.uploading.set(false),
        });
      },
      error: () => this.uploading.set(false),
    });
  }

  proxyUrl(url: string): string {
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : url;
  }

  confirm(): void {
    if (this.form.invalid) return;
    const { name, timeframe, description } = this.form.getRawValue();
    this.dialogRef.close({
      name: name.trim(),
      timeframe: timeframe.trim() || undefined,
      description: description.trim() || undefined,
      photo: this.photo() ?? undefined,
      updatedEntity: this.updatedEntity,
    } satisfies TimelineEventDialogResult);
  }
}
