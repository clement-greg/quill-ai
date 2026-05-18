import { Component, inject, signal, effect, computed, ElementRef, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { UserSettingsService, GhostCompleteItem } from '../services/user-settings.service';
import { HeaderService } from '../services/header.service';

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

  @ViewChild('avatarFileInput') avatarFileInput!: ElementRef<HTMLInputElement>;

  readonly items = this.settingsService.ghostCompleteItems;
  readonly colorTheme = this.settingsService.colorTheme;
  readonly colorThemes = COLOR_THEMES;
  readonly avatarUrl = this.settingsService.avatarUrl;
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
    this.headerService.set([{ label: 'Settings' }]);
    // Keep the draft in sync with the server value until the user edits it
    effect(() => {
      if (!this.displayNameDraftDirty) {
        this.displayNameDraft.set(this.settingsService.displayName());
      }
    });
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
}
