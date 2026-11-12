import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { AzureSpeechClient } from '@app/core/read-aloud/azure-speech-client';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { EntityVoiceDialogComponent, EntityVoiceDialogData } from './entity-voice-dialog';

describe('EntityVoiceDialogComponent', () => {
  function setup(data: EntityVoiceDialogData) {
    const close = vi.fn();
    const ra = {
      language: 'en-US',
      azureCatalog: signal([{
        id: 'azure:Jane', name: 'Jane', lang: 'en-US', localeName: 'English (United States)', quality: 'premium',
        provider: 'azure', gender: 'Female', hd: false, multilingual: false, personalities: [], scenarios: [],
      }]),
      voiceId: signal('azure:Other'),
      pinnedVoices: signal<string[]>([]),
      state: signal('idle'),
      rate: signal(1),
      loadVoices: vi.fn(),
      setVoice: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [EntityVoiceDialogComponent],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
        { provide: ReadAloudService, useValue: ra },
        { provide: AzureSpeechClient, useValue: { synthesize: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(EntityVoiceDialogComponent);
    fixture.detectChanges();
    return { el: fixture.nativeElement as HTMLElement, close, ra };
  }

  it('picks a voice for the character without touching the reader\'s voice', () => {
    const { el, close, ra } = setup({ name: 'Ann', voiceId: null, isNarrator: false });
    expect(el.textContent).toContain('Voice for Ann');
    expect(el.textContent).toContain('Use the narration voice');
    (el.querySelector('.vg-choose') as HTMLElement).click();
    expect(close).toHaveBeenCalledWith({ voiceId: 'azure:Jane' });
    expect(ra.setVoice).not.toHaveBeenCalled();
  });

  it('marks the current voice and offers the reader\'s voice for the narrator', () => {
    const { el, close } = setup({ name: 'Narrator', voiceId: 'azure:Jane', isNarrator: true });
    expect(el.querySelector('.vg-card')?.classList).toContain('selected');
    const reset = [...el.querySelectorAll('button')].find(b => b.textContent?.includes("Use the reader's voice"))!;
    reset.click();
    expect(close).toHaveBeenCalledWith({ voiceId: null });
  });
});
