import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { firstValueFrom } from 'rxjs';
import { ChatImage, EntityProposal } from '@shared/models';
import { Entity } from '@shared/models/entity.model';
import { EntityService } from '../entity.service';
import { EntityEditComponent } from './entity-edit';

export interface EntityProposalDialogData {
  proposal: EntityProposal;
}

/**
 * Shows an entity the assistant drafted in the regular entity form so the
 * author can review, adjust, and save it. Pictures generated in the chat are
 * offered alongside: the author picks the profile picture and which ones go in
 * the gallery. When the proposal targets an existing entity (`entityId`), the
 * form loads that entity and saving updates it instead of creating one.
 * Nothing is written until Save. Closes with the saved Entity, or undefined.
 */
@Component({
  selector: 'app-entity-proposal-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatDialogModule, MatProgressSpinnerModule, EntityEditComponent],
  template: `
    <h2 mat-dialog-title class="title">
      {{ isUpdate ? 'Review pictures for ' + data.proposal.entity.name : 'Review new ' + typeLabel }}
      <span class="subtitle">Drafted by Quill{{ data.proposal.seriesTitle ? ' · ' + data.proposal.seriesTitle : '' }}</span>
    </h2>
    <mat-dialog-content>
      @if (chatImages.length) {
        <section class="pics" aria-labelledby="pics-heading">
          <h3 id="pics-heading" class="pics-heading">Pictures from this chat</h3>
          <p class="hint">Choose the profile picture and which pictures to add to the gallery.</p>
          <ul class="pics-grid">
            @for (img of chatImages; track img.url; let i = $index) {
              <li class="pic" [class.selected]="inGallery(img)">
                <img [src]="proxyUrl(img.thumbnailUrl)" [alt]="img.prompt || 'Generated picture ' + (i + 1)" loading="lazy" />
                @if (isProfile(img)) {
                  <span class="pic-badge"><mat-icon>star</mat-icon> Profile</span>
                }
                <div class="pic-actions">
                  <button mat-button type="button" [attr.aria-pressed]="isProfile(img)"
                          [attr.aria-label]="'Use picture ' + (i + 1) + ' as the profile picture'"
                          (click)="useAsProfile(img)">
                    <mat-icon>{{ isProfile(img) ? 'star' : 'star_border' }}</mat-icon> Profile
                  </button>
                  <button mat-button type="button" [attr.aria-pressed]="inGallery(img)"
                          [attr.aria-label]="(inGallery(img) ? 'Remove picture ' : 'Add picture ') + (i + 1) + (inGallery(img) ? ' from' : ' to') + ' the gallery'"
                          (click)="toggleGallery(img)">
                    <mat-icon>{{ inGallery(img) ? 'check_box' : 'check_box_outline_blank' }}</mat-icon> Gallery
                  </button>
                </div>
              </li>
            }
          </ul>
        </section>
      }

      @if (draft(); as entity) {
        @if (!isUpdate) {
          <p class="hint">Check the details Quill filled in from your conversation, adjust anything, then save.</p>
        }
        <!-- isNew hides actions that reach outside this review (archive, refresh, details page). -->
        <app-entity-edit [entity]="entity" [isNew]="true" (save)="onSave($event)" (cancel)="dialogRef.close()" />
      } @else if (!error()) {
        <div class="status"><mat-spinner diameter="18" /><span>Loading…</span></div>
      }
      @if (saving()) {
        <div class="status" role="status"><mat-spinner diameter="18" /><span>Saving…</span></div>
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
    </mat-dialog-content>
  `,
  styles: `
    .title { display: flex; flex-direction: column; gap: 2px; }
    .subtitle { font-size: 13px; font-weight: 400; color: var(--mat-sys-on-surface-variant); }
    .hint { margin: 0 0 12px; color: var(--mat-sys-on-surface-variant); font-size: 14px; }
    .pics { margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .pics-heading { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
    .pics-grid {
      list-style: none; margin: 0; padding: 0;
      display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px;
    }
    .pic {
      position: relative; display: flex; flex-direction: column;
      border: 2px solid var(--mat-sys-outline-variant); border-radius: 12px; overflow: hidden;
      background: var(--mat-sys-surface-container);
    }
    .pic.selected { border-color: var(--mat-sys-primary); }
    .pic img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
    .pic-badge {
      position: absolute; top: 6px; left: 6px; display: inline-flex; align-items: center; gap: 2px;
      padding: 2px 8px 2px 4px; border-radius: 999px; font-size: 12px; font-weight: 600;
      background: var(--mat-sys-primary); color: var(--mat-sys-on-primary);
    }
    .pic-badge mat-icon { font-size: 16px; width: 16px; height: 16px; }
    .pic-actions { display: flex; flex-wrap: wrap; justify-content: space-between; padding: 2px; }
    .pic-actions button { min-width: 0; padding: 0 8px; }
    .status { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
    .error { margin: 12px 0 0; color: var(--mat-sys-error); }
  `,
})
export class EntityProposalDialogComponent implements OnInit {
  readonly data = inject<EntityProposalDialogData>(MAT_DIALOG_DATA);
  readonly dialogRef = inject<MatDialogRef<EntityProposalDialogComponent, Entity>>(MatDialogRef);
  private readonly entityService = inject(EntityService);
  private readonly editForm = viewChild(EntityEditComponent);

  readonly isUpdate = !!this.data.proposal.entityId;
  readonly typeLabel = { PERSON: 'character', PLACE: 'place', THING: 'thing' }[this.data.proposal.entity.type];
  /** Every picture offered: the chat's pictures, or at least the proposed ones. */
  readonly chatImages: ChatImage[] = this.data.proposal.chatImages ??
    (this.data.proposal.entity.photos ?? []).map(p => ({ url: p.url, thumbnailUrl: p.thumbnailUrl }));

  readonly draft = signal<Entity | null>(null);
  /** The existing entity's photos (update mode), so nothing is added twice. */
  private existingPhotoUrls = new Set<string>();
  private readonly profileUrl = signal(this.data.proposal.entity.originalUrl ?? null);
  private readonly galleryUrls = signal(new Set((this.data.proposal.entity.photos ?? []).map(p => p.url)));
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly inGallery = (img: ChatImage) => this.galleryUrls().has(img.url);
  readonly isProfile = (img: ChatImage) => this.profileUrl() === img.url;
  private readonly selectedGallery = computed(() => this.chatImages.filter(img => this.galleryUrls().has(img.url)));

  async ngOnInit(): Promise<void> {
    const { proposal } = this.data;
    if (!proposal.entityId) {
      const { photos: _chosenSeparately, ...fields } = proposal.entity;
      this.draft.set({ ...fields, id: crypto.randomUUID(), seriesId: proposal.seriesId });
      return;
    }
    try {
      const existing = await firstValueFrom(this.entityService.getById(proposal.entityId));
      this.existingPhotoUrls = new Set((existing.photos ?? []).map(p => p.url));
      const { thumbnailUrl, originalUrl } = proposal.entity;
      this.draft.set(thumbnailUrl && originalUrl ? { ...existing, thumbnailUrl, originalUrl } : existing);
      if (!originalUrl) this.profileUrl.set(existing.originalUrl ?? null);
    } catch {
      this.error.set(`Could not load ${proposal.entity.name}.`);
    }
  }

  useAsProfile(img: ChatImage): void {
    this.editForm()?.setProfilePhoto(img.url, img.thumbnailUrl);
    this.profileUrl.set(img.url);
    this.galleryUrls.update(set => new Set(set).add(img.url));
  }

  toggleGallery(img: ChatImage): void {
    this.galleryUrls.update(set => {
      const next = new Set(set);
      if (!next.delete(img.url)) next.add(img.url);
      return next;
    });
  }

  /** Generated images are served through the decrypting image proxy. */
  proxyUrl(url: string): string {
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : url;
  }

  async onSave(entity: Entity): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    const photos = this.selectedGallery().map(img => ({ url: img.url, thumbnailUrl: img.thumbnailUrl }));
    try {
      if (!this.isUpdate) {
        const created = await firstValueFrom(this.entityService.create({ ...entity, ...(photos.length ? { photos } : {}) }));
        this.dialogRef.close(created);
        return;
      }
      // Updates keep the stored gallery, so new gallery pictures are appended one by one.
      let saved = await firstValueFrom(this.entityService.update(entity));
      for (const photo of photos.filter(p => !this.existingPhotoUrls.has(p.url))) {
        saved = await firstValueFrom(this.entityService.addPhoto(saved.id, photo.url, photo.thumbnailUrl));
        this.existingPhotoUrls.add(photo.url); // a retry after a failure won't add it twice
      }
      this.dialogRef.close(saved);
    } catch {
      this.error.set('Could not save the entity. Please try again.');
      this.saving.set(false);
    }
  }
}
