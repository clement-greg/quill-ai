import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface GhostCompleteItem {
  id: string;
  label: string;
  prompt: string;
}

export interface UserSettingsData {
  displayName?: string;
  avatarUrl?: string;
  darkMode?: boolean;
  colorTheme?: string;
  editorFontSize?: string;
  editorFontFamily?: string;
  ghostCompleteItems?: GhostCompleteItem[];
}

@Injectable({ providedIn: 'root' })
export class UserSettingsService {
  private http = inject(HttpClient);
  private _ghostCompleteItems = signal<GhostCompleteItem[]>([]);
  private _colorTheme = signal<string>('default');
  private _editorFontSize = signal<string>('normal');
  private _editorFontFamily = signal<string>('serif');
  private _displayName = signal<string>('');
  private _avatarUrl = signal<string>('');
  /** True when the active theme is a dark variant (for backward compat). */
  readonly darkMode = computed(() =>
    this._colorTheme() === 'dark' || this._colorTheme() === 'midnight'
  );
  readonly colorTheme = this._colorTheme.asReadonly();
  readonly editorFontSize = this._editorFontSize.asReadonly();
  readonly editorFontFamily = this._editorFontFamily.asReadonly();
  readonly displayName = this._displayName.asReadonly();
  readonly avatarUrl = this._avatarUrl.asReadonly();
  readonly ghostCompleteItems = this._ghostCompleteItems.asReadonly();

  /** Loads all settings from the server. Call after authentication. */
  async loadFromServer(): Promise<void> {
    try {
      const settings = await firstValueFrom(this.http.get<UserSettingsData>('/api/user-settings'));
      this._displayName.set(settings.displayName ?? '');
      this._avatarUrl.set(settings.avatarUrl ?? '');
      // Migrate: if no colorTheme yet, fall back to the legacy darkMode flag
      this._colorTheme.set(settings.colorTheme ?? (settings.darkMode ? 'dark' : 'default'));
      this._editorFontSize.set(settings.editorFontSize ?? 'normal');
      this._editorFontFamily.set(settings.editorFontFamily ?? 'serif');
      this._ghostCompleteItems.set(settings.ghostCompleteItems ?? []);
    } catch {
      // Server unavailable — signals keep their default values
    }
  }

  private saveToServer(): void {
    firstValueFrom(
      this.http.put<UserSettingsData>('/api/user-settings', {
        displayName: this._displayName(),
        avatarUrl: this._avatarUrl(),
        colorTheme: this._colorTheme(),
        darkMode: this.darkMode(),
        editorFontSize: this._editorFontSize(),
        editorFontFamily: this._editorFontFamily(),
        ghostCompleteItems: this._ghostCompleteItems(),
      })
    ).catch(() => {});
  }

  private saveItems(items: GhostCompleteItem[]): void {
    this._ghostCompleteItems.set(items);
    this.saveToServer();
  }

  addItem(label: string, prompt: string): void {
    const item: GhostCompleteItem = { id: crypto.randomUUID(), label: label.trim(), prompt: prompt.trim() };
    this.saveItems([...this._ghostCompleteItems(), item]);
  }

  updateItem(id: string, label: string, prompt: string): void {
    this.saveItems(this._ghostCompleteItems().map(item =>
      item.id === id ? { ...item, label: label.trim(), prompt: prompt.trim() } : item
    ));
  }

  removeItem(id: string): void {
    this.saveItems(this._ghostCompleteItems().filter(item => item.id !== id));
  }

  reorderItems(items: GhostCompleteItem[]): void {
    this.saveItems(items);
  }

  setColorTheme(value: string): void {
    this._colorTheme.set(value);
    this.saveToServer();
  }

  setEditorFontSize(value: string): void {
    this._editorFontSize.set(value);
    this.saveToServer();
  }

  setEditorFontFamily(value: string): void {
    this._editorFontFamily.set(value);
    this.saveToServer();
  }

  /** @deprecated Use setColorTheme instead. Kept for backward compatibility. */
  setDarkMode(value: boolean): void {
    this._colorTheme.set(value ? 'dark' : 'default');
    this.saveToServer();
  }

  setDisplayName(value: string): void {
    this._displayName.set(value);
    this.saveToServer();
  }

  setAvatarUrl(value: string): void {
    this._avatarUrl.set(value);
    this.saveToServer();
  }

  clearAvatarUrl(): void {
    this._avatarUrl.set('');
    this.saveToServer();
  }

  getMatchingItems(input: string): GhostCompleteItem[] {
    const lower = input.toLowerCase().trim();
    if (!lower) return this._ghostCompleteItems();
    return this._ghostCompleteItems().filter(item =>
      item.label.toLowerCase().includes(lower) || item.prompt.toLowerCase().includes(lower)
    );
  }
}

