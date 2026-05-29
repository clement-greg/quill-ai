import { Component, input, output, signal, inject, effect, computed, HostListener } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatTabsModule } from '@angular/material/tabs';
import { MatDialog } from '@angular/material/dialog';
import { TextFieldModule } from '@angular/cdk/text-field';
import { Entity, EntityPhoto, EntityReference } from '@shared/models/entity.model';
import { EntityQuote } from '@shared/models/entity-quote.model';
import { EntityService } from '../services/entity.service';
import { EntityQuoteService } from '../services/entity-quote.service';
import { ImageGenDialogComponent, ImageGenResult } from './image-gen-dialog';
import { UserSettingsService } from '../services/user-settings.service';
import { PinLockService } from '../services/pin-lock.service';
import { PinEntryOverlayComponent } from '../pin-entry-overlay/pin-entry-overlay';

@Component({
  selector: 'app-entity-edit',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
    MatSelectModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatTabsModule,
    TextFieldModule,
    PinEntryOverlayComponent,
  ],
  templateUrl: './entity-edit.html',
  styleUrl: './entity-edit.scss',
})
export class EntityEditComponent {
  private entityService = inject(EntityService);
  private entityQuoteService = inject(EntityQuoteService);
  private dialog = inject(MatDialog);
  private router = inject(Router);
  private settingsService = inject(UserSettingsService);
  readonly pinLock = inject(PinLockService);

  readonly genderOptions = this.settingsService.genderOptions;
  readonly raceOptions = this.settingsService.raceOptions;
  readonly orientationOptions = this.settingsService.orientationOptions;

  entity = input.required<Entity>();
  isNew = input(false);
  save = output<Entity>();
  cancel = output<void>();
  archive = output<string>();
  unarchive = output<string>();
  refresh = output<void>();

  readonly entityTypes: Entity['type'][] = ['PERSON', 'PLACE', 'THING'];
  readonly referenceOptions: { value: EntityReference; label: string; requiresTitle?: boolean }[] = [
    { value: 'full-name', label: 'Full Name' },
    { value: 'first-name', label: 'First Name' },
    { value: 'last-name', label: 'Last Name' },
    { value: 'nickname', label: 'Nickname' },
    { value: 'title-full-name', label: 'Title + Full Name (e.g. Dr Sanderson Williams)', requiresTitle: true },
    { value: 'title-last-name', label: 'Title + Last Name (e.g. Dr Williams)', requiresTitle: true },
  ];

  referenceOptionsForCurrentType = computed(() => {
    const type = this.draft()?.type;
    if (type !== 'PERSON') {
      return this.referenceOptions.filter(o => o.value === 'full-name' || o.value === 'nickname');
    }
    return this.referenceOptions;
  });

  draft = signal<Entity | null>(null);
  thumbnailPreview = signal<string | null>(null);
  uploading = signal(false);
  generatingImage = signal(false);
  generatingPersonality = signal(false);
  refreshing = signal(false);
  quotes = signal<EntityQuote[]>([]);
  quotesLoading = signal(false);
  quoteSaving = signal(false);

  isNarrator = computed(() => !!this.entity().isNarrator);

  // Add-quote form
  addingQuote = signal(false);
  newQuoteText = signal('');

  // Photos tab
  photos = signal<EntityPhoto[]>([]);
  photoUploading = signal(false);
  lightboxIndex = signal<number | null>(null);
  lightboxAnim = signal<'next' | 'prev' | ''>('');

  // Per-quote inline edit state: maps quote id → draft text (null = not editing)
  editingQuoteId = signal<string | null>(null);
  editingQuoteText = signal('');

  constructor() {
    effect(() => {
      const e = this.entity();
      const draft = { ...e };
      if (e.type === 'PERSON' && !e.preferredReference) {
        draft.preferredReference = 'first-name';
      } else if (e.type !== 'PERSON' && !e.preferredReference) {
        draft.preferredReference = 'full-name';
      }
      this.draft.set(draft);
      this.thumbnailPreview.set(this.proxyUrl(e.thumbnailUrl));
      this.photos.set(e.photos ?? []);
      if (e.id) this.loadQuotes(e.id);
    });
  }

  update<K extends keyof Entity>(field: K, value: Entity[K]): void {
    const current = this.draft();
    if (current) {
      const updated = { ...current, [field]: value };
      if (field === 'type') {
        const personOnlyRefs: EntityReference[] = ['first-name', 'last-name', 'title-full-name', 'title-last-name'];
        if (value === 'PERSON' && !current.preferredReference) {
          updated.preferredReference = 'first-name';
        } else if (value !== 'PERSON' && personOnlyRefs.includes(current.preferredReference as EntityReference)) {
          updated.preferredReference = 'full-name';
        }
      }
      this.draft.set(updated);
    }
  }

  proxyUrl(url: string | undefined): string | null {
    if (!url) return null;
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }

  @HostListener('keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const idx = this.lightboxIndex();
    if (idx === null) return;
    if (event.key === 'Escape') { this.closeLightbox(); event.preventDefault(); }
    else if (event.key === 'ArrowRight') { this.lightboxNext(); event.preventDefault(); }
    else if (event.key === 'ArrowLeft') { this.lightboxPrev(); event.preventDefault(); }
  }

  openLightbox(index: number): void {
    this.lightboxAnim.set('');
    this.lightboxIndex.set(index);
  }

  closeLightbox(): void {
    this.lightboxIndex.set(null);
  }

  lightboxNext(): void {
    const idx = this.lightboxIndex();
    if (idx === null) return;
    this.lightboxAnim.set('next');
    this.lightboxIndex.set((idx + 1) % this.photos().length);
  }

  lightboxPrev(): void {
    const idx = this.lightboxIndex();
    if (idx === null) return;
    this.lightboxAnim.set('prev');
    this.lightboxIndex.set((idx - 1 + this.photos().length) % this.photos().length);
  }

  @HostListener('paste', ['$event'])
  onPaste(event: ClipboardEvent): void {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
    if (this.isNarrator()) return;

    const items = event.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (!file) continue;
        event.preventDefault();
        this.uploadFile(file);
        break;
      }
    }
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.uploadFile(file);
  }

  private uploadFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => this.thumbnailPreview.set(reader.result as string);
    reader.readAsDataURL(file);

    this.uploading.set(true);
    this.entityService.uploadThumbnail(file).subscribe({
      next: ({ url, thumbnailUrl }) => {
        const current = this.draft();
        if (current) {
          this.draft.set({ ...current, thumbnailUrl, originalUrl: url });
        }
        this.thumbnailPreview.set(this.proxyUrl(thumbnailUrl));
        this.uploading.set(false);
      },
      error: () => this.uploading.set(false),
    });
  }

  onNameBlur(): void {
    const d = this.draft();
    if (!d || d.type !== 'PERSON') return;
    if (d.firstName?.trim() || d.lastName?.trim()) return;
    const parts = d.name.trim().split(/\s+/);
    if (parts.length >= 2) {
      const lastName = parts[parts.length - 1];
      const firstName = parts.slice(0, parts.length - 1).join(' ');
      this.draft.set({ ...d, firstName, lastName });
    } else if (parts.length === 1 && parts[0]) {
      this.draft.set({ ...d, firstName: parts[0], lastName: '' });
    }
  }

  openGenerateImageDialog(): void {
    const dialogRef = this.dialog.open(ImageGenDialogComponent, { width: '500px' });
    dialogRef.afterClosed().subscribe((result: ImageGenResult | undefined) => {
      if (!result) return;
      this.generatingImage.set(true);
      this.entityService.generateImage(result.prompt, result.provider).subscribe({
        next: ({ url, thumbnailUrl }) => {
          const current = this.draft();
          if (current) {
            this.draft.set({ ...current, thumbnailUrl, originalUrl: url });
          }
          this.thumbnailPreview.set(this.proxyUrl(thumbnailUrl));
          this.generatingImage.set(false);
        },
        error: () => this.generatingImage.set(false),
      });
    });
  }

  onSave(): void {
    const d = this.draft();
    if (!d || !d.name.trim()) return;
    this.save.emit(d);
  }

  generatePersonality(): void {
    const d = this.draft();
    if (!d) return;
    this.generatingPersonality.set(true);
    this.entityService.generatePersonality(d.id, d.personality ?? '').subscribe({
      next: ({ personality }) => {
        this.draft.set({ ...d, personality });
        this.generatingPersonality.set(false);
      },
      error: () => this.generatingPersonality.set(false),
    });
  }

  onCancel(): void {
    this.cancel.emit();
  }

  onRefresh(): void {
    this.refresh.emit();
  }

  onArchive(): void {
    const d = this.draft();
    if (d?.id) {
      this.archive.emit(d.id);
    }
  }

  onUnarchive(): void {
    const d = this.draft();
    if (d?.id) {
      this.unarchive.emit(d.id);
    }
  }

  loadQuotes(entityId: string): void {
    this.quotesLoading.set(true);
    this.entityQuoteService.getByEntity(entityId).subscribe({
      next: quotes => { this.quotes.set(quotes); this.quotesLoading.set(false); },
      error: () => this.quotesLoading.set(false),
    });
  }

  toggleHighlight(quote: EntityQuote): void {
    const next = !quote.isHighlighted;
    this.entityQuoteService.setHighlight(quote.id, quote.entityId, next).subscribe(updated => {
      this.quotes.update(qs => qs.map(q => q.id === updated.id ? updated : q));
    });
  }

  startAddQuote(): void {
    this.addingQuote.set(true);
    this.newQuoteText.set('');
  }

  cancelAddQuote(): void {
    this.addingQuote.set(false);
    this.newQuoteText.set('');
  }

  saveNewQuote(): void {
    const text = this.newQuoteText().trim();
    const entityId = this.entity().id;
    if (!text || !entityId || this.quoteSaving()) return;
    this.quoteSaving.set(true);
    this.entityQuoteService.create(entityId, text).subscribe({
      next: created => {
        this.quotes.update(qs => [...qs, created]);
        this.addingQuote.set(false);
        this.newQuoteText.set('');
        this.quoteSaving.set(false);
      },
      error: () => this.quoteSaving.set(false),
    });
  }

  startEditQuote(quote: EntityQuote): void {
    this.editingQuoteId.set(quote.id);
    this.editingQuoteText.set(quote.text);
  }

  cancelEditQuote(): void {
    this.editingQuoteId.set(null);
    this.editingQuoteText.set('');
  }

  saveEditQuote(quote: EntityQuote): void {
    const text = this.editingQuoteText().trim();
    if (!text || this.quoteSaving()) return;
    this.quoteSaving.set(true);
    this.entityQuoteService.updateText(quote.id, quote.entityId, text).subscribe({
      next: updated => {
        this.quotes.update(qs => qs.map(q => q.id === updated.id ? updated : q));
        this.editingQuoteId.set(null);
        this.editingQuoteText.set('');
        this.quoteSaving.set(false);
      },
      error: () => this.quoteSaving.set(false),
    });
  }

  deleteQuote(quote: EntityQuote): void {
    this.entityQuoteService.delete(quote.id, quote.entityId).subscribe({
      next: () => this.quotes.update(qs => qs.filter(q => q.id !== quote.id)),
    });
  }

  onPhotoFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    this.uploadPhoto(file);
  }

  private uploadPhoto(file: File): void {
    const entityId = this.entity().id;
    if (!entityId) return;
    this.photoUploading.set(true);
    this.entityService.uploadThumbnail(file).subscribe({
      next: ({ url, thumbnailUrl }) => {
        this.entityService.addPhoto(entityId, url, thumbnailUrl).subscribe({
          next: updated => {
            this.photos.set(updated.photos ?? []);
            this.photoUploading.set(false);
          },
          error: () => this.photoUploading.set(false),
        });
      },
      error: () => this.photoUploading.set(false),
    });
  }

  deletePhoto(index: number): void {
    const entityId = this.entity().id;
    if (!entityId) return;
    this.entityService.removePhoto(entityId, index).subscribe({
      next: updated => this.photos.set(updated.photos ?? []),
    });
  }

  openRelationshipDiagram(): void {
    const d = this.draft();
    if (d?.seriesId) {
      this.router.navigate(['/series', d.seriesId, 'relationships']);
    }
  }

  /** Lock photos whenever the user switches tabs, so returning to the Photos tab requires re-entry. */
  onPhotosTabChange(_index: number): void {
    if (this.pinLock.hasPin()) {
      this.pinLock.lock();
    }
  }
}
