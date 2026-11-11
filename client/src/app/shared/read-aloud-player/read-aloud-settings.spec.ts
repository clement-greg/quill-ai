import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { VoiceGalleryDialogComponent } from '@app/shared/voice-gallery/voice-gallery-dialog';
import { ReadAloudSettingsComponent } from './read-aloud-settings';

const v = (id: string, name: string) => ({ id, name, lang: 'en-US', quality: 'premium' });

describe('ReadAloudSettingsComponent', () => {
  function setup(voiceId: string | null, pinned: string[] = []) {
    const ra = {
      engineKind: 'web',
      rate: signal(1),
      voiceId: signal(voiceId),
      voices: signal([v('ava', 'Ava')]),
      azureCatalog: signal([v('azure:jane', 'Jane'), v('azure:sonia', 'Sonia'), v('azure:andrew', 'Andrew')]),
      azureDefaultId: signal<string | null>('azure:jane'),
      pinnedVoices: signal(pinned),
      loadVoices: vi.fn(),
      setVoice: vi.fn(),
      setRate: vi.fn(),
    };
    const dialog = { open: vi.fn() };
    TestBed.configureTestingModule({
      imports: [ReadAloudSettingsComponent],
      providers: [{ provide: ReadAloudService, useValue: ra }, { provide: MatDialog, useValue: dialog }],
    });
    const fixture = TestBed.createComponent(ReadAloudSettingsComponent);
    fixture.detectChanges();
    return { component: fixture.componentInstance, dialog };
  }

  it('lists pinned voices, then the current one and the default, once each', () => {
    const { component } = setup('azure:andrew', ['azure:sonia', 'azure:jane']);
    expect(component.quickVoices().map(x => x.name)).toEqual(['Sonia', 'Jane', 'Andrew']);
    expect(component.selectedVoiceName()).toBe('Andrew');
  });

  it('just the default when nothing is pinned and a device voice is in use', () => {
    const { component } = setup('ava');
    expect(component.quickVoices().map(x => x.name)).toEqual(['Jane']);
    expect(component.selectedVoiceName()).toBe('Ava');
  });

  it('opens the gallery', () => {
    const { component, dialog } = setup(null);
    component.browse();
    expect(dialog.open).toHaveBeenCalledWith(VoiceGalleryDialogComponent, expect.objectContaining({ ariaLabel: 'Choose a voice' }));
  });
});
