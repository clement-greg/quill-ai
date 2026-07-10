import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { UserSettingsService } from './user-settings.service';

describe('UserSettingsService', () => {
  let service: UserSettingsService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(UserSettingsService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  /** Flush the pending PUT /api/user-settings triggered by a setter. */
  function flushSave(): void {
    http.expectOne('/api/user-settings').flush({});
  }

  it('should be created', () => expect(service).toBeTruthy());

  // ── Ghost-complete items ───────────────────────────────────────────────────

  it('ghostCompleteItems is empty by default', () => {
    expect(service.ghostCompleteItems()).toEqual([]);
  });

  it('addItem appends an item', () => {
    service.addItem('Label A', 'Prompt A');
    flushSave();
    const items = service.ghostCompleteItems();
    expect(items.length).toBe(1);
    expect(items[0].label).toBe('Label A');
    expect(items[0].prompt).toBe('Prompt A');
    expect(items[0].id).toBeTruthy();
  });

  it('addItem trims whitespace from label and prompt', () => {
    service.addItem('  trimmed  ', '  prompt  ');
    flushSave();
    const item = service.ghostCompleteItems()[0];
    expect(item.label).toBe('trimmed');
    expect(item.prompt).toBe('prompt');
  });

  it('updateItem updates label and prompt by id', () => {
    service.addItem('Original', 'Old prompt');
    flushSave();
    const id = service.ghostCompleteItems()[0].id;
    service.updateItem(id, 'Updated', 'New prompt');
    flushSave();
    const item = service.ghostCompleteItems()[0];
    expect(item.label).toBe('Updated');
    expect(item.prompt).toBe('New prompt');
  });

  it('removeItem deletes the item with the given id', () => {
    service.addItem('To Remove', 'prompt');
    flushSave();
    const id = service.ghostCompleteItems()[0].id;
    service.removeItem(id);
    flushSave();
    expect(service.ghostCompleteItems()).toEqual([]);
  });

  it('reorderItems replaces the entire list', () => {
    service.addItem('A', 'pa');
    flushSave();
    service.addItem('B', 'pb');
    flushSave();
    const [a, b] = service.ghostCompleteItems();
    service.reorderItems([b, a]);
    flushSave();
    const reordered = service.ghostCompleteItems();
    expect(reordered[0].label).toBe('B');
    expect(reordered[1].label).toBe('A');
  });

  it('getMatchingItems returns items whose label contains the input', () => {
    service.addItem('Dragons', 'about dragons');
    flushSave();
    service.addItem('Dwarves', 'about dwarves');
    flushSave();
    service.addItem('Elves', 'about elves');
    flushSave();
    const matches = service.getMatchingItems('dra');
    expect(matches.length).toBe(1);
    expect(matches[0].label).toBe('Dragons');
  });

  it('getMatchingItems is case-insensitive', () => {
    service.addItem('UNICORN', 'prompt');
    flushSave();
    expect(service.getMatchingItems('uni').length).toBe(1);
  });

  // ── Dark mode ─────────────────────────────────────────────────────────────

  it('darkMode is false by default', () => {
    expect(service.darkMode()).toBe(false);
  });

  it('setDarkMode(true) updates signal and saves to server', () => {
    service.setDarkMode(true);
    const req = http.expectOne('/api/user-settings');
    expect(req.request.body['darkMode']).toBe(true);
    req.flush({});
    expect(service.darkMode()).toBe(true);
  });

  it('setDarkMode(false) saves false to server', () => {
    service.setDarkMode(true);
    flushSave();
    service.setDarkMode(false);
    const req = http.expectOne('/api/user-settings');
    expect(req.request.body['darkMode']).toBe(false);
    req.flush({});
    expect(service.darkMode()).toBe(false);
  });

  // ── Display name ──────────────────────────────────────────────────────────

  it('displayName is empty by default', () => {
    expect(service.displayName()).toBe('');
  });

  it('setDisplayName updates signal and saves to server', () => {
    service.setDisplayName('Alice');
    const req = http.expectOne('/api/user-settings');
    expect(req.request.body['displayName']).toBe('Alice');
    req.flush({});
    expect(service.displayName()).toBe('Alice');
  });

  // ── Avatar URL ────────────────────────────────────────────────────────────

  it('setAvatarUrl updates signal and saves to server', () => {
    service.setAvatarUrl('https://example.com/avatar.png');
    const req = http.expectOne('/api/user-settings');
    expect(req.request.body['avatarUrl']).toBe('https://example.com/avatar.png');
    req.flush({});
    expect(service.avatarUrl()).toBe('https://example.com/avatar.png');
  });

  it('clearAvatarUrl resets signal and saves to server', () => {
    service.setAvatarUrl('https://example.com/avatar.png');
    flushSave();
    service.clearAvatarUrl();
    const req = http.expectOne('/api/user-settings');
    expect(req.request.body['avatarUrl']).toBe('');
    req.flush({});
    expect(service.avatarUrl()).toBe('');
  });

  // ── loadFromServer ────────────────────────────────────────────────────────

  it('loadFromServer sets all signals from server response', async () => {
    const promise = service.loadFromServer();
    http.expectOne('/api/user-settings').flush({
      displayName: 'Bob',
      avatarUrl: 'https://example.com/bob.png',
      darkMode: true,
      ghostCompleteItems: [{ id: '1', label: 'L', prompt: 'P' }],
    });
    await promise;
    expect(service.displayName()).toBe('Bob');
    expect(service.avatarUrl()).toBe('https://example.com/bob.png');
    expect(service.darkMode()).toBe(true);
    expect(service.ghostCompleteItems().length).toBe(1);
  });

  it('loadFromServer resets to defaults when server returns empty object', async () => {
    service.setDarkMode(true);
    flushSave();
    const promise = service.loadFromServer();
    http.expectOne('/api/user-settings').flush({});
    await promise;
    expect(service.displayName()).toBe('');
    expect(service.darkMode()).toBe(false);
    expect(service.ghostCompleteItems()).toEqual([]);
  });
});

