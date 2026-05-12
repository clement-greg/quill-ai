import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { UserSettingsService } from './user-settings.service';

describe('UserSettingsService', () => {
  let service: UserSettingsService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(UserSettingsService);
  });

  afterEach(() => localStorage.clear());

  it('should be created', () => expect(service).toBeTruthy());

  // ── Ghost-complete items ───────────────────────────────────────────────────

  it('ghostCompleteItems is empty by default', () => {
    expect(service.ghostCompleteItems()).toEqual([]);
  });

  it('addItem appends an item and persists to localStorage', () => {
    service.addItem('Label A', 'Prompt A');
    const items = service.ghostCompleteItems();
    expect(items.length).toBe(1);
    expect(items[0].label).toBe('Label A');
    expect(items[0].prompt).toBe('Prompt A');
    expect(items[0].id).toBeTruthy();
    expect(localStorage.getItem('user_settings_ghost_complete')).not.toBeNull();
  });

  it('addItem trims whitespace from label and prompt', () => {
    service.addItem('  trimmed  ', '  prompt  ');
    const item = service.ghostCompleteItems()[0];
    expect(item.label).toBe('trimmed');
    expect(item.prompt).toBe('prompt');
  });

  it('updateItem updates label and prompt by id', () => {
    service.addItem('Original', 'Old prompt');
    const id = service.ghostCompleteItems()[0].id;
    service.updateItem(id, 'Updated', 'New prompt');
    const item = service.ghostCompleteItems()[0];
    expect(item.label).toBe('Updated');
    expect(item.prompt).toBe('New prompt');
  });

  it('removeItem deletes the item with the given id', () => {
    service.addItem('To Remove', 'prompt');
    const id = service.ghostCompleteItems()[0].id;
    service.removeItem(id);
    expect(service.ghostCompleteItems()).toEqual([]);
  });

  it('reorderItems replaces the entire list', () => {
    service.addItem('A', 'pa');
    service.addItem('B', 'pb');
    const [a, b] = service.ghostCompleteItems();
    service.reorderItems([b, a]);
    const reordered = service.ghostCompleteItems();
    expect(reordered[0].label).toBe('B');
    expect(reordered[1].label).toBe('A');
  });

  it('getMatchingItems returns items whose label contains the input', () => {
    service.addItem('Dragons', 'about dragons');
    service.addItem('Dwarves', 'about dwarves');
    service.addItem('Elves', 'about elves');
    const matches = service.getMatchingItems('dra');
    expect(matches.length).toBe(1);
    expect(matches[0].label).toBe('Dragons');
  });

  it('getMatchingItems is case-insensitive', () => {
    service.addItem('UNICORN', 'prompt');
    expect(service.getMatchingItems('uni').length).toBe(1);
  });

  // ── Dark mode ─────────────────────────────────────────────────────────────

  it('darkMode is false by default', () => {
    expect(service.darkMode()).toBe(false);
  });

  it('setDarkMode(true) updates signal and persists to localStorage', () => {
    service.setDarkMode(true);
    expect(service.darkMode()).toBe(true);
    expect(localStorage.getItem('user_settings_dark_mode')).toBe('true');
  });

  it('setDarkMode(false) persists "false"', () => {
    service.setDarkMode(true);
    service.setDarkMode(false);
    expect(service.darkMode()).toBe(false);
    expect(localStorage.getItem('user_settings_dark_mode')).toBe('false');
  });

  // ── Display name ──────────────────────────────────────────────────────────

  it('displayName is empty by default', () => {
    expect(service.displayName()).toBe('');
  });

  it('setDisplayName updates signal and persists', () => {
    service.setDisplayName('Alice');
    expect(service.displayName()).toBe('Alice');
    expect(localStorage.getItem('user_settings_display_name')).toBe('Alice');
  });

  // ── Avatar URL ────────────────────────────────────────────────────────────

  it('setAvatarUrl updates signal and persists', () => {
    service.setAvatarUrl('https://example.com/avatar.png');
    expect(service.avatarUrl()).toBe('https://example.com/avatar.png');
  });

  it('clearAvatarUrl resets signal and removes from localStorage', () => {
    service.setAvatarUrl('https://example.com/avatar.png');
    service.clearAvatarUrl();
    expect(service.avatarUrl()).toBe('');
    expect(localStorage.getItem('user_settings_avatar_url')).toBeNull();
  });
});
