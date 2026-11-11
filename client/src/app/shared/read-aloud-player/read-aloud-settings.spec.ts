import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { VoiceGalleryDialogComponent } from '@app/shared/voice-gallery/voice-gallery-dialog';
import { ReadAloudSettingsComponent } from './read-aloud-settings';

const v = (id: string, name: string) => ({ id, name, lang: 'en-US', quality: 'premium' });

describe('ReadAloudSettingsComponent', () => {
  function setup(voiceId: string | null) {
    const ra = {
      rate: signal(1),
      voiceId: signal(voiceId),
      voices: signal([v('ava', 'Ava')]),
      azureCatalog: signal([v('azure:jane', 'Jane')]),
      loadVoices: vi.fn().mockResolvedValue(undefined),
      setRate: vi.fn(),
    };
    const dialog = { open: vi.fn() };
    TestBed.configureTestingModule({
      imports: [ReadAloudSettingsComponent],
      providers: [{ provide: ReadAloudService, useValue: ra }, { provide: MatDialog, useValue: dialog }],
    });
    const fixture = TestBed.createComponent(ReadAloudSettingsComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return { el, ra, dialog };
  }

  it('names the voice in use on the voice button', () => {
    const { el, ra } = setup('azure:jane');
    expect(ra.loadVoices).toHaveBeenCalled();
    expect(el.querySelector('[aria-haspopup="dialog"]')?.getAttribute('aria-label')).toBe('Voice: Jane. Change voice');
  });

  it('falls back to "System default"', () => {
    const { el } = setup(null);
    expect(el.querySelector('[aria-haspopup="dialog"]')?.getAttribute('aria-label')).toContain('System default');
  });

  it('opens the voice gallery straight from the voice button', () => {
    const { el, dialog } = setup('ava');
    (el.querySelector('[aria-haspopup="dialog"]') as HTMLElement).click();
    expect(dialog.open).toHaveBeenCalledWith(VoiceGalleryDialogComponent, expect.objectContaining({ panelClass: 'vg-dialog-panel' }));
  });
});
