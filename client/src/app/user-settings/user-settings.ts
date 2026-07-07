import { Component, inject, signal, effect, computed, ElementRef, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { UserSettingsService, GhostCompleteItem, DEFAULT_GENDER_OPTIONS, DEFAULT_RACE_OPTIONS, DEFAULT_ORIENTATION_OPTIONS } from '../services/user-settings.service';
import { HeaderService } from '../services/header.service';
import { ContentFilterService } from '../services/content-filter.service';

export interface ColorThemeOption {
  id: string;
  label: string;
  primaryColor: string;
  surfaceColor: string;
}

export const COLOR_THEMES: ColorThemeOption[] = [
  { id: 'default',  label: 'Classic',   primaryColor: '#4A86C8', surfaceColor: '#F3F7FB' },
  { id: 'dark',     label: 'Dark',      primaryColor: '#90C4F5', surfaceColor: '#111318' },
  { id: 'rose',     label: 'Rose',      primaryColor: '#B52155', surfaceColor: '#FFF8F9' },
  { id: 'lavender', label: 'Lavender',  primaryColor: '#6B4C9A', surfaceColor: '#FDFAFF' },
  { id: 'forest',   label: 'Forest',    primaryColor: '#2E7D32', surfaceColor: '#F5FDF6' },
  { id: 'midnight', label: 'Midnight',  primaryColor: '#5B8CE8', surfaceColor: '#0E1520' },
  { id: 'amber',    label: 'Amber',     primaryColor: '#E07000', surfaceColor: '#FFFBF0' },
  { id: 'ocean',    label: 'Ocean',     primaryColor: '#0097A7', surfaceColor: '#F0FBFC' },
  { id: 'fuchsia',  label: 'Fuchsia',   primaryColor: '#B800B8', surfaceColor: '#FDF5FF' },
  { id: 'crimson',  label: 'Crimson',   primaryColor: '#EF7070', surfaceColor: '#1A0808' },
  { id: 'spring',      label: 'Spring',     primaryColor: '#7CB800', surfaceColor: '#FAFFF0' },
  { id: 'sunset',      label: 'Sunset',     primaryColor: '#C62828', surfaceColor: '#FFF5F0' },
  { id: 'minimalist',  label: 'Minimalist', primaryColor: '#E0E0E0', surfaceColor: '#FFFFFF' },
];

@Component({
  selector: 'app-user-settings',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
    MatButtonToggleModule,
    MatSlideToggleModule,
  ],
  templateUrl: './user-settings.html',
  styleUrl: './user-settings.scss',
})
export class UserSettingsComponent {
  private settingsService = inject(UserSettingsService);
  private snackBar = inject(MatSnackBar);
  private headerService = inject(HeaderService);
  private contentFilterService = inject(ContentFilterService);

  @ViewChild('avatarFileInput') avatarFileInput!: ElementRef<HTMLInputElement>;
  @ViewChild('avatarVideoInput') avatarVideoInput!: ElementRef<HTMLInputElement>;

  readonly items = this.settingsService.ghostCompleteItems;
  readonly colorTheme = this.settingsService.colorTheme;
  readonly colorThemes = COLOR_THEMES;
  readonly avatarUrl = this.settingsService.avatarUrl;
  readonly avatarVideoUrl = this.settingsService.avatarVideoUrl;
  readonly uploadingVideo = signal(false);
  readonly editorFontSize = this.settingsService.editorFontSize;
  readonly editorFontFamily = this.settingsService.editorFontFamily;
  readonly grammarCheckEnabled = this.settingsService.grammarCheckEnabled;
  readonly entityDetectionEnabled = this.settingsService.entityDetectionEnabled;
  readonly autoSaveEnabled = this.settingsService.autoSaveEnabled;

  readonly fontSizePreviewValue = computed(() => ({
    xs:     '0.75rem',
    small:  '0.875rem',
    normal: '1rem',
    large:  '1.125rem',
    xl:     '1.3rem',
  }[this.editorFontSize()] ?? '1rem'));

  readonly fontFamilyPreviewValue = computed(() => ({
    'serif':      "Georgia, 'Times New Roman', serif",
    'sans-serif': "system-ui, 'Roboto', Arial, sans-serif",
  }[this.editorFontFamily()] ?? "Georgia, 'Times New Roman', serif"));

  // Profile
  displayNameDraft = signal('');
  private displayNameDraftDirty = false;

  constructor() {
    this.headerService.setPage('Settings');
    // Keep the draft in sync with the server value until the user edits it
    effect(() => {
      if (!this.displayNameDraftDirty) {
        this.displayNameDraft.set(this.settingsService.displayName());
      }
    });
    this.contentFilterService.loadFromServer();
  }

  onDisplayNameInput(): void {
    this.displayNameDraftDirty = true;
  }

  saveProfile(): void {
    this.settingsService.setDisplayName(this.displayNameDraft().trim());
    this.displayNameDraftDirty = false;
    this.snackBar.open('Profile saved.', undefined, { duration: 2000 });
  }

  triggerAvatarUpload(): void {
    this.avatarFileInput.nativeElement.click();
  }

  onAvatarFileChange(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const img = new Image();
      img.onload = () => {
        const SIZE = 96;
        const canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext('2d')!;
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2;
        const sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, SIZE, SIZE);
        this.settingsService.setAvatarUrl(canvas.toDataURL('image/jpeg', 0.85));
        this.snackBar.open('Avatar updated.', undefined, { duration: 2000 });
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  removeAvatar(): void {
    this.settingsService.clearAvatarUrl();
  }

  /** Rewrites a stored upload URL to the same-origin media proxy. */
  proxyUrl(url: string): string {
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : url;
  }

  triggerVideoUpload(): void {
    this.avatarVideoInput.nativeElement.click();
  }

  async onAvatarVideoChange(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      this.snackBar.open('Video must be 50 MB or smaller.', undefined, { duration: 3000 });
      input.value = '';
      return;
    }
    this.uploadingVideo.set(true);
    try {
      const url = await this.settingsService.uploadProfileVideo(file);
      this.settingsService.setAvatarVideoUrl(url);
      this.snackBar.open('Profile video updated.', undefined, { duration: 2000 });
    } catch {
      this.snackBar.open('Video upload failed. Please try again.', undefined, { duration: 3000 });
    } finally {
      this.uploadingVideo.set(false);
      input.value = '';
    }
  }

  removeVideo(): void {
    this.settingsService.clearAvatarVideoUrl();
  }

  // New item form
  newLabel = signal('');
  newPrompt = signal('');

  // Inline editing
  editingId = signal<string | null>(null);
  editLabel = signal('');
  editPrompt = signal('');

  addItem(): void {
    const label = this.newLabel().trim();
    const prompt = this.newPrompt().trim();
    if (!label || !prompt) {
      this.snackBar.open('Label and prompt are required.', undefined, { duration: 3000 });
      return;
    }
    this.settingsService.addItem(label, prompt);
    this.newLabel.set('');
    this.newPrompt.set('');
    this.snackBar.open('Ghost complete item added.', undefined, { duration: 2000 });
  }

  startEdit(item: GhostCompleteItem): void {
    this.editingId.set(item.id);
    this.editLabel.set(item.label);
    this.editPrompt.set(item.prompt);
  }

  saveEdit(): void {
    const id = this.editingId();
    if (!id) return;
    const label = this.editLabel().trim();
    const prompt = this.editPrompt().trim();
    if (!label || !prompt) {
      this.snackBar.open('Label and prompt are required.', undefined, { duration: 3000 });
      return;
    }
    this.settingsService.updateItem(id, label, prompt);
    this.editingId.set(null);
    this.snackBar.open('Item updated.', undefined, { duration: 2000 });
  }

  cancelEdit(): void {
    this.editingId.set(null);
  }

  removeItem(id: string): void {
    this.settingsService.removeItem(id);
    this.snackBar.open('Item removed.', undefined, { duration: 2000 });
  }

  selectTheme(id: string): void {
    this.settingsService.setColorTheme(id);
  }

  setEditorFontSize(value: string): void {
    this.settingsService.setEditorFontSize(value);
  }

  setEditorFontFamily(value: string): void {
    this.settingsService.setEditorFontFamily(value);
  }

  setGrammarCheckEnabled(value: boolean): void {
    this.settingsService.setGrammarCheckEnabled(value);
  }

  setEntityDetectionEnabled(value: boolean): void {
    this.settingsService.setEntityDetectionEnabled(value);
  }

  setAutoSaveEnabled(value: boolean): void {
    this.settingsService.setAutoSaveEnabled(value);
  }

  // ── Character Attribute Options ────────────────────
  readonly genderOptions = this.settingsService.genderOptions;
  readonly raceOptions = this.settingsService.raceOptions;
  readonly orientationOptions = this.settingsService.orientationOptions;

  newGenderOption = signal('');
  newRaceOption = signal('');
  newOrientationOption = signal('');

  addGenderOption(): void {
    const val = this.newGenderOption().trim();
    if (!val) return;
    if (this.genderOptions().includes(val)) {
      this.snackBar.open('That value already exists.', undefined, { duration: 2000 });
      return;
    }
    this.settingsService.setGenderOptions([...this.genderOptions(), val]);
    this.newGenderOption.set('');
  }

  removeGenderOption(val: string): void {
    this.settingsService.setGenderOptions(this.genderOptions().filter(v => v !== val));
  }

  resetGenderOptions(): void {
    this.settingsService.setGenderOptions([...DEFAULT_GENDER_OPTIONS]);
  }

  addRaceOption(): void {
    const val = this.newRaceOption().trim();
    if (!val) return;
    if (this.raceOptions().includes(val)) {
      this.snackBar.open('That value already exists.', undefined, { duration: 2000 });
      return;
    }
    this.settingsService.setRaceOptions([...this.raceOptions(), val]);
    this.newRaceOption.set('');
  }

  removeRaceOption(val: string): void {
    this.settingsService.setRaceOptions(this.raceOptions().filter(v => v !== val));
  }

  resetRaceOptions(): void {
    this.settingsService.setRaceOptions([...DEFAULT_RACE_OPTIONS]);
  }

  addOrientationOption(): void {
    const val = this.newOrientationOption().trim();
    if (!val) return;
    if (this.orientationOptions().includes(val)) {
      this.snackBar.open('That value already exists.', undefined, { duration: 2000 });
      return;
    }
    this.settingsService.setOrientationOptions([...this.orientationOptions(), val]);
    this.newOrientationOption.set('');
  }

  removeOrientationOption(val: string): void {
    this.settingsService.setOrientationOptions(this.orientationOptions().filter(v => v !== val));
  }

  resetOrientationOptions(): void {
    this.settingsService.setOrientationOptions([...DEFAULT_ORIENTATION_OPTIONS]);
  }

  // ── Content Moderation ────────────────────
  readonly contentFilterTerms = this.contentFilterService.terms;
  newContentFilterTerm = signal('');

  addContentFilterTerm(): void {
    const term = this.newContentFilterTerm().trim();
    if (!term) return;
    if (this.contentFilterTerms().includes(term)) {
      this.snackBar.open('That term already exists.', undefined, { duration: 2000 });
      return;
    }
    this.contentFilterService.addTerm(term);
    this.newContentFilterTerm.set('');
  }

  removeContentFilterTerm(term: string): void {
    this.contentFilterService.removeTerm(term);
  }

}
