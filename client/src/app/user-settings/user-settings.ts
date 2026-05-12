import { Component, inject, signal, effect, ElementRef, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { UserSettingsService, GhostCompleteItem } from '../services/user-settings.service';
import { HeaderService } from '../services/header.service';

@Component({
  selector: 'app-user-settings',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
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
  readonly darkMode = this.settingsService.darkMode;
  readonly avatarUrl = this.settingsService.avatarUrl;

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

  toggleDarkMode(value: boolean): void {
    this.settingsService.setDarkMode(value);
  }
}
