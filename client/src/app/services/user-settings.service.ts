import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export const DEFAULT_GENDER_OPTIONS = [
  'Female', 'Male', 'Non-binary', 'Genderfluid', 'Agender', 'Other',
];

export const DEFAULT_RACE_OPTIONS = [
  'Asian', 'Black / African', 'East Asian', 'Hispanic / Latino',
  'Indigenous / Native', 'Middle Eastern', 'Mixed / Multiracial',
  'Pacific Islander', 'South Asian', 'White / European', 'Other',
];

export const DEFAULT_ORIENTATION_OPTIONS = [
  'Asexual', 'Bisexual', 'Gay', 'Heterosexual', 'Lesbian',
  'Pansexual', 'Queer', 'Other',
];

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
  grammarCheckEnabled?: boolean;
  entityDetectionEnabled?: boolean;
  autoSaveEnabled?: boolean;
  genderOptions?: string[];
  raceOptions?: string[];
  orientationOptions?: string[];
  pinHash?: string;
  showHiddenPhotos?: boolean;
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
  private _grammarCheckEnabled = signal<boolean>(true);
  private _entityDetectionEnabled = signal<boolean>(true);
  private _autoSaveEnabled = signal<boolean>(false);
  private _genderOptions = signal<string[]>(DEFAULT_GENDER_OPTIONS);
  private _raceOptions = signal<string[]>(DEFAULT_RACE_OPTIONS);
  private _orientationOptions = signal<string[]>(DEFAULT_ORIENTATION_OPTIONS);
  private _pinHash = signal<string>('');
  private _showHiddenPhotos = signal<boolean>(false);
  private _settingsLoaded = signal(false);
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
  readonly grammarCheckEnabled = this._grammarCheckEnabled.asReadonly();
  readonly entityDetectionEnabled = this._entityDetectionEnabled.asReadonly();
  readonly autoSaveEnabled = this._autoSaveEnabled.asReadonly();
  readonly genderOptions = this._genderOptions.asReadonly();
  readonly raceOptions = this._raceOptions.asReadonly();
  readonly orientationOptions = this._orientationOptions.asReadonly();
  readonly pinHash = this._pinHash.asReadonly();
  readonly hasPin = computed(() => !!this._pinHash());
  readonly showHiddenPhotos = this._showHiddenPhotos.asReadonly();
  readonly settingsLoaded = this._settingsLoaded.asReadonly();

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
      this._grammarCheckEnabled.set(settings.grammarCheckEnabled ?? true);
      this._entityDetectionEnabled.set(settings.entityDetectionEnabled ?? true);
      this._autoSaveEnabled.set(settings.autoSaveEnabled ?? false);
      this._genderOptions.set(settings.genderOptions ?? DEFAULT_GENDER_OPTIONS);
      this._raceOptions.set(settings.raceOptions ?? DEFAULT_RACE_OPTIONS);
      this._orientationOptions.set(settings.orientationOptions ?? DEFAULT_ORIENTATION_OPTIONS);
      this._pinHash.set(settings.pinHash ?? '');
      this._showHiddenPhotos.set(settings.showHiddenPhotos ?? false);
    } catch {
      // Server unavailable — signals keep their default values
    }
    this._settingsLoaded.set(true);
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
        grammarCheckEnabled: this._grammarCheckEnabled(),
        entityDetectionEnabled: this._entityDetectionEnabled(),
        autoSaveEnabled: this._autoSaveEnabled(),
        genderOptions: this._genderOptions(),
        raceOptions: this._raceOptions(),
        orientationOptions: this._orientationOptions(),
        pinHash: this._pinHash(),
        showHiddenPhotos: this._showHiddenPhotos(),
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

  setGrammarCheckEnabled(value: boolean): void {
    this._grammarCheckEnabled.set(value);
    this.saveToServer();
  }

  setEntityDetectionEnabled(value: boolean): void {
    this._entityDetectionEnabled.set(value);
    this.saveToServer();
  }

  setAutoSaveEnabled(value: boolean): void {
    this._autoSaveEnabled.set(value);
    this.saveToServer();
  }

  clearAvatarUrl(): void {
    this._avatarUrl.set('');
    this.saveToServer();
  }

  setGenderOptions(values: string[]): void {
    this._genderOptions.set(values);
    this.saveToServer();
  }

  setRaceOptions(values: string[]): void {
    this._raceOptions.set(values);
    this.saveToServer();
  }

  setOrientationOptions(values: string[]): void {
    this._orientationOptions.set(values);
    this.saveToServer();
  }

  setPinHash(hash: string): void {
    this._pinHash.set(hash);
    this.saveToServer();
  }

  clearPinHash(): void {
    this._pinHash.set('');
    this.saveToServer();
  }

  setShowHiddenPhotos(value: boolean): void {
    this._showHiddenPhotos.set(value);
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

