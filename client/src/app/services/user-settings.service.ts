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

const STORAGE_KEY = 'user_settings_ghost_complete';
const DARK_MODE_KEY = 'user_settings_dark_mode';
const DISPLAY_NAME_KEY = 'user_settings_display_name';
const AVATAR_URL_KEY = 'user_settings_avatar_url';

@Injectable({ providedIn: 'root' })
export class UserSettingsService {
  private http = inject(HttpClient);
  private _ghostCompleteItems = signal<GhostCompleteItem[]>(this.loadFromStorage());
  private _darkMode = signal<boolean>(localStorage.getItem(DARK_MODE_KEY) === 'true');
  private _displayName = signal<string>(localStorage.getItem(DISPLAY_NAME_KEY) ?? '');
  private _avatarUrl = signal<string>(localStorage.getItem(AVATAR_URL_KEY) ?? '');
  readonly darkMode = this._darkMode.asReadonly();
  readonly displayName = this._displayName.asReadonly();
  readonly avatarUrl = this._avatarUrl.asReadonly();

  readonly ghostCompleteItems = this._ghostCompleteItems.asReadonly();

  /** Load settings from the server, overriding localStorage. Call after authentication. */
  async loadFromServer(): Promise<void> {
    try {
      const settings = await firstValueFrom(this.http.get<UserSettingsData>('/api/user-settings'));
      const hasServerData = settings.displayName !== undefined
        || settings.avatarUrl !== undefined
        || settings.darkMode !== undefined
        || settings.ghostCompleteItems !== undefined;

      if (hasServerData) {
        if (settings.displayName !== undefined) {
          localStorage.setItem(DISPLAY_NAME_KEY, settings.displayName);
          this._displayName.set(settings.displayName);
        }
        if (settings.avatarUrl !== undefined) {
          localStorage.setItem(AVATAR_URL_KEY, settings.avatarUrl);
          this._avatarUrl.set(settings.avatarUrl);
        }
        if (settings.darkMode !== undefined) {
          localStorage.setItem(DARK_MODE_KEY, String(settings.darkMode));
          this._darkMode.set(settings.darkMode);
        }
        if (settings.ghostCompleteItems !== undefined) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(settings.ghostCompleteItems));
          this._ghostCompleteItems.set(settings.ghostCompleteItems);
        }
      } else {
        // No server record yet — migrate any existing localStorage values up
        const hasLocal = !!(this._displayName() || this._avatarUrl() || this._ghostCompleteItems().length);
        if (hasLocal) {
          this.saveToServer();
        }
      }
    } catch {
      // Server unavailable or not yet authenticated — keep localStorage values
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

  private loadFromStorage(): GhostCompleteItem[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as GhostCompleteItem[]) : [];
    } catch {
      return [];
    }
  }

  private save(items: GhostCompleteItem[]): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    this._ghostCompleteItems.set(items);
    this.saveToServer();
  }

  addItem(label: string, prompt: string): void {
    const item: GhostCompleteItem = { id: crypto.randomUUID(), label: label.trim(), prompt: prompt.trim() };
    this.save([...this._ghostCompleteItems(), item]);
  }

  updateItem(id: string, label: string, prompt: string): void {
    this.save(this._ghostCompleteItems().map(item =>
      item.id === id ? { ...item, label: label.trim(), prompt: prompt.trim() } : item
    ));
  }

  removeItem(id: string): void {
    this.save(this._ghostCompleteItems().filter(item => item.id !== id));
  }

  reorderItems(items: GhostCompleteItem[]): void {
    this.save(items);
  }

  setDarkMode(value: boolean): void {
    localStorage.setItem(DARK_MODE_KEY, String(value));
    this._darkMode.set(value);
    this.saveToServer();
  }

  setDisplayName(value: string): void {
    localStorage.setItem(DISPLAY_NAME_KEY, value);
    this._displayName.set(value);
    this.saveToServer();
  }

  setAvatarUrl(value: string): void {
    localStorage.setItem(AVATAR_URL_KEY, value);
    this._avatarUrl.set(value);
    this.saveToServer();
  }

  clearAvatarUrl(): void {
    localStorage.removeItem(AVATAR_URL_KEY);
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

