import { TestBed } from '@angular/core/testing';
import { resetSourceThumbnailPlaceholder, SourceThumbnailComponent } from './source-thumbnail';

describe('SourceThumbnailComponent', () => {
  afterEach(() => resetSourceThumbnailPlaceholder());

  function create() {
    const fixture = TestBed.createComponent(SourceThumbnailComponent);
    fixture.componentRef.setInput('src', 'thumb.jpg');
    fixture.componentRef.setInput('alt', 'Photo');
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows the photo until it is double-clicked', () => {
    const el = create();
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('thumb.jpg');

    img.dispatchEvent(new MouseEvent('dblclick'));
    TestBed.tick();
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.placeholder')?.getAttribute('aria-label')).toBe('Photo');
  });

  it('keeps the placeholder for thumbnails opened later', () => {
    create().querySelector('img')!.dispatchEvent(new MouseEvent('dblclick'));
    const later = create();
    expect(later.querySelector('img')).toBeNull();
    expect(later.querySelector('.placeholder')).not.toBeNull();
  });
});
