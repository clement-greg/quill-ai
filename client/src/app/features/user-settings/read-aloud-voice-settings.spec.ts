import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { VoiceGalleryComponent } from '@app/shared/voice-gallery/voice-gallery';
import { ReadAloudVoiceSettingsComponent } from './read-aloud-voice-settings';

@Component({ selector: 'app-voice-gallery', template: '<div class="fake-gallery"></div>' })
class FakeGalleryComponent {}

const JANE = { id: 'azure:en-US-JaneNeural', name: 'Jane', lang: 'en-US', quality: 'premium', provider: 'azure' };

describe('ReadAloudVoiceSettingsComponent', () => {
  function setup(azure = true, voiceId: string | null = JANE.id) {
    const ra = {
      supported: true,
      engineKind: 'web',
      voiceId: signal<string | null>(voiceId),
      voices: signal([{ id: 'ava', name: 'Ava', lang: 'en-US', quality: 'premium' }]),
      azureCatalog: signal(azure ? [JANE] : []),
      loadVoices: vi.fn().mockResolvedValue(undefined),
      setVoice: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [ReadAloudVoiceSettingsComponent],
      providers: [{ provide: ReadAloudService, useValue: ra }],
    });
    TestBed.overrideComponent(ReadAloudVoiceSettingsComponent, {
      remove: { imports: [VoiceGalleryComponent] },
      add: { imports: [FakeGalleryComponent] },
    });
    const fixture = TestBed.createComponent(ReadAloudVoiceSettingsComponent);
    fixture.detectChanges();
    return { fixture, ra, el: fixture.nativeElement as HTMLElement };
  }

  it('names the voice in use and shows the gallery when Microsoft voices are on', () => {
    const { ra, el } = setup();
    expect(ra.loadVoices).toHaveBeenCalled();
    expect(el.querySelector('.voice-current')?.textContent).toContain('Jane');
    expect(el.querySelector('.fake-gallery')).not.toBeNull();
    expect(el.textContent).toContain('Device voices');
  });

  it('picks a device voice, with System default as null', async () => {
    const { fixture, ra } = setup(true, 'ava');
    (fixture.nativeElement.querySelector('.mat-mdc-select-trigger') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    const options = [...document.querySelectorAll('mat-option')] as HTMLElement[];
    expect(options.map(o => o.textContent?.trim())).toEqual(['System default', 'Ava en-US']);
    options[0]!.click();
    expect(ra.setVoice).toHaveBeenLastCalledWith(null);
  });

  it('shows only device voices when Microsoft voices are off', () => {
    const { el } = setup(false, null);
    expect(el.querySelector('.fake-gallery')).toBeNull();
    expect(el.querySelector('.voice-current')?.textContent).toContain('system default');
  });
});
