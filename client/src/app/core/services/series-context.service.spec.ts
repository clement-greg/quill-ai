import { TestBed } from '@angular/core/testing';
import { SeriesContextService } from './series-context.service';

const STORAGE_KEY = 'quill_last_series_id';

describe('SeriesContextService', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
  });

  afterEach(() => localStorage.clear());

  it('starts with null when nothing is stored', () => {
    const service = TestBed.inject(SeriesContextService);
    expect(service.currentSeriesId()).toBeNull();
  });

  it('restores the last series id from localStorage on creation', () => {
    localStorage.setItem(STORAGE_KEY, 's-42');
    const service = TestBed.inject(SeriesContextService);
    expect(service.currentSeriesId()).toBe('s-42');
  });

  it('set(id) updates the signal and persists to localStorage', () => {
    const service = TestBed.inject(SeriesContextService);
    service.set('s-7');
    expect(service.currentSeriesId()).toBe('s-7');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('s-7');
  });

  it('set(null) clears both the signal and the stored value', () => {
    const service = TestBed.inject(SeriesContextService);
    service.set('s-7');
    service.set(null);
    expect(service.currentSeriesId()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('clear() behaves like set(null)', () => {
    const service = TestBed.inject(SeriesContextService);
    service.set('s-9');
    service.clear();
    expect(service.currentSeriesId()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
