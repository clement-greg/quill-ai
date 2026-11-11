import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { ReadAloudVoiceSettingsComponent } from './read-aloud-voice-settings';

describe('ReadAloudVoiceSettingsComponent', () => {
  function setup(azure = true) {
    const ra = {
      supported: true,
      engineKind: 'web',
      voiceId: signal<string | null>('azure:en-US-JaneNeural'),
      voices: signal([{ id: 'ava', name: 'Ava', lang: 'en-US', quality: 'premium' }]),
      azureVoices: signal(azure ? [{ id: 'azure:en-US-JaneNeural', name: 'Jane', lang: 'en-US', quality: 'premium', provider: 'azure' }] : []),
      loadVoices: vi.fn().mockResolvedValue(undefined),
      setVoice: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [ReadAloudVoiceSettingsComponent],
      providers: [{ provide: ReadAloudService, useValue: ra }],
    });
    const fixture = TestBed.createComponent(ReadAloudVoiceSettingsComponent);
    fixture.detectChanges();
    return { fixture, ra, el: fixture.nativeElement as HTMLElement };
  }

  it('loads voices and shows the current choice', async () => {
    const { ra, el, fixture } = setup();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(ra.loadVoices).toHaveBeenCalled();
    expect(el.querySelector('mat-select')?.textContent).toContain('Jane');
    expect(el.textContent).toContain('Microsoft voices are natural-sounding');
  });

  it('lists both groups and picks a voice, with System default as null', async () => {
    const { fixture, ra } = setup();
    (fixture.nativeElement.querySelector('.mat-mdc-select-trigger') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    const groups = [...document.querySelectorAll('mat-optgroup')].map(g => g.querySelector('.mat-mdc-optgroup-label')?.textContent?.trim());
    expect(groups).toEqual(['Microsoft voices', 'Device voices']);
    const options = [...document.querySelectorAll('mat-option')] as HTMLElement[];
    options.find(o => o.textContent?.includes('System default'))!.click();
    expect(ra.setVoice).toHaveBeenLastCalledWith(null);
  });

  it('describes device voices only when Microsoft voices are off', () => {
    const { el } = setup(false);
    expect(el.textContent).toContain('Uses the voices on this device.');
  });
});
