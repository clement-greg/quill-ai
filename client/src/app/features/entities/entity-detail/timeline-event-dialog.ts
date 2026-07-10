import {
  Component,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
  OnInit,
} from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatDialog, MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatAutocompleteModule, MatAutocompleteSelectedEvent } from '@angular/material/autocomplete';
import { TextFieldModule } from '@angular/cdk/text-field';
import { AsyncPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Observable, of, combineLatest } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, map, catchError, startWith } from 'rxjs/operators';
import { toObservable } from '@angular/core/rxjs-interop';
import { Entity, EntityPhoto } from '@shared/models/entity.model';
import { TimelineEvent, TimelineEventPhoto } from '@shared/models/timeline-event.model';
import { EntityService } from '../entity.service';
import { PhotoPickerDialogComponent, PhotoPickerResult } from '../entity-edit/photo-picker-dialog';

export interface TimelineEventDialogData {
  entity: Entity;
  event?: TimelineEvent;
}

export interface TimelineEventDialogResult {
  name: string;
  timeframe?: string;
  description?: string;
  location?: string;
  locationEntityId?: string;
  photo?: TimelineEventPhoto;
  /** Set when a file upload added a new photo to the entity gallery. */
  updatedEntity?: Entity;
}

interface LocationOption {
  label: string;
  value: string;
  entityId?: string;
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
    MatAutocompleteModule,
    TextFieldModule,
    AsyncPipe,
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
        <mat-label>Location (optional)</mat-label>
        <mat-icon matPrefix>place</mat-icon>
        <input matInput formControlName="location"
               placeholder="e.g. London, The Dark Forest, Rivendell"
               [matAutocomplete]="locationAuto"
               (input)="onLocationInput()" />
        <mat-autocomplete #locationAuto="matAutocomplete"
                          (optionSelected)="onLocationSelected($event)">
          @if (placeEntities().length > 0) {
            <mat-optgroup label="Series places">
              @for (opt of filteredPlaceOptions$ | async; track opt.entityId) {
                <mat-option [value]="opt.value">
                  <mat-icon class="place-opt-icon" aria-hidden="true">place</mat-icon>
                  {{ opt.label }}
                </mat-option>
              }
            </mat-optgroup>
          }
          @if (realWorldSuggestions$ | async; as suggestions) {
            @if (suggestions.length > 0) {
              <mat-optgroup label="Real-world places">
                @for (s of suggestions; track s) {
                  <mat-option [value]="s">{{ s }}</mat-option>
                }
              </mat-optgroup>
            }
          }
        </mat-autocomplete>
        @if (selectedPlaceEntity(); as linked) {
          <mat-hint>
            <mat-icon class="hint-icon" aria-hidden="true">link</mat-icon>
            Linked to {{ linked.name }}
          </mat-hint>
        } @else {
          <mat-hint>Real or fictitious — type to get suggestions</mat-hint>
        }
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
    .full-field { width: 100%; margin-top: 16px; }
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
    .place-opt-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
      vertical-align: middle;
      margin-right: 4px;
      color: var(--mat-sys-primary, #6750a4);
    }
    .hint-icon {
      font-size: 13px;
      width: 13px;
      height: 13px;
      vertical-align: middle;
    }
  `],
})
export class TimelineEventDialogComponent implements OnInit {
  private dialogRef = inject(MatDialogRef<TimelineEventDialogComponent>);
  private dialog = inject(MatDialog);
  private entityService = inject(EntityService);
  private http = inject(HttpClient);
  private fb = inject(FormBuilder);
  readonly data = inject<TimelineEventDialogData>(MAT_DIALOG_DATA);

  form = this.fb.nonNullable.group({
    name: [this.data.event?.name ?? '', Validators.required],
    timeframe: [this.data.event?.timeframe ?? ''],
    location: [this.data.event?.location ?? ''],
    description: [this.data.event?.description ?? ''],
  });

  placeEntities = signal<Entity[]>([]);

  /** The PLACE entity currently linked to this event (selected from autocomplete). */
  selectedLocationEntityId = signal<string | null>(this.data.event?.locationEntityId ?? null);

  readonly selectedPlaceEntity = computed(() => {
    const id = this.selectedLocationEntityId();
    if (!id) return null;
    return this.placeEntities().find(e => e.id === id) ?? null;
  });

  readonly filteredPlaceOptions$: Observable<LocationOption[]> = combineLatest([
    this.form.controls.location.valueChanges.pipe(startWith(this.form.controls.location.value)),
    toObservable(this.placeEntities),
  ]).pipe(
    map(([q, places]) => {
      const query = (q ?? '').toLowerCase().trim();
      return places
        .filter(e => !query || e.name.toLowerCase().includes(query))
        .map(e => ({ label: e.name, value: e.name, entityId: e.id }));
    }),
  );

  readonly realWorldSuggestions$: Observable<string[]> = this.form.controls.location.valueChanges.pipe(
    debounceTime(300),
    distinctUntilChanged(),
    switchMap(q => !q || q.trim().length < 2
      ? of([])
      : this.http.get<{ suggestions: string[] }>('/api/timeline-events/places/autocomplete', { params: { q: q.trim() } }).pipe(
          map(r => r.suggestions),
          catchError(() => of([])),
        )
    ),
    startWith([]),
  );

  photo = signal<TimelineEventPhoto | null>(this.data.event?.photo ?? null);
  uploading = signal(false);

  private entityPhotos = signal<EntityPhoto[]>(this.data.entity.photos ?? []);
  private updatedEntity: Entity | undefined;

  ngOnInit(): void {
    this.entityService.getBySeries(this.data.entity.seriesId).pipe(
      map(entities => entities.filter(e => e.type === 'PLACE' && !e.archived)),
      catchError(() => of([] as Entity[])),
    ).subscribe(places => this.placeEntities.set(places));
  }

  onLocationInput(): void {
    this.selectedLocationEntityId.set(null);
  }

  onLocationSelected(event: MatAutocompleteSelectedEvent): void {
    const value: string = event.option.value as string;
    const match = this.placeEntities().find(e => e.name === value);
    this.selectedLocationEntityId.set(match?.id ?? null);
  }

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
    const { name, timeframe, location, description } = this.form.getRawValue();
    this.dialogRef.close({
      name: name.trim(),
      timeframe: timeframe.trim() || undefined,
      location: location.trim() || undefined,
      locationEntityId: this.selectedLocationEntityId() ?? undefined,
      description: description.trim() || undefined,
      photo: this.photo() ?? undefined,
      updatedEntity: this.updatedEntity,
    } satisfies TimelineEventDialogResult);
  }
}
