import { Injectable, signal, inject } from '@angular/core';
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
  ghostCompleteItems?: GhostCompleteItem[];
}

@Injectable({ providedIn: 'root' })
export class UserSettingsService {
  private http = inject(HttpClient);
  private _ghostCompleteItems = signal<GhostCompleteItem[]>([]);
  private _darkMode = signal<boolean>(false);
  private _displayName = signal<string>('');
  private _avatarUrl = signal<string>('');
  readonly darkMode = this._darkMode.asReadonly();
  readonly displayName = this._displayName.asReadonly();
  readonly avatarUrl = this._avatarUrl.asReadonly();
  readonly ghostCompleteItems = this._ghostCompleteItems.asReadonly();

  /** Loads all settings from the server. Call after authentication. */
  async loadFromServer(): Promise<void> {
    try {
      const settings = await firstValueFrom(this.http.get<UserSettingsData>('/api/user-settings'));
      this._displayName.set(settings.displayName ?? '');
      this._avatarUrl.set(settings.avatarUrl ?? '');
      this._darkMode.set(settings.darkMode ?? false);
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
        darkMode: this._darkMode(),
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

  setDarkMode(value: boolean): void {
    this._darkMode.set(value);
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

