import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AzureSpeechClient, AzureVoice } from '@app/core/read-aloud/azure-speech-client';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { PREVIEW_AUDIO, VoiceGalleryComponent } from './voice-gallery';

function voice(id: string, over: Partial<AzureVoice> = {}): AzureVoice {
  return {
    id: `azure:${id}`, name: id, lang: 'en-US', localeName: 'English (United States)', quality: 'premium', provider: 'azure',
    gender: 'Female', hd: false, multilingual: false, personalities: [], scenarios: [], ...over,
  };
}

describe('VoiceGalleryComponent', () => {
  function setup(catalog: AzureVoice[] = [voice('Jane', { scenarios: ['Audiobook'] }), voice('Andrew', { gender: 'Male' })]) {
    const ra = {
      language: 'en-US',
      azureCatalog: signal(catalog),
      voiceId: signal<string | null>('azure:Jane'),
      pinnedVoices: signal<string[]>([]),
      state: signal('playing'),
      rate: signal(1.25),
      loadVoices: vi.fn().mockResolvedValue(undefined),
      setVoice: vi.fn(),
      togglePin: vi.fn(),
      playPause: vi.fn(),
    };
    const azure = { synthesize: vi.fn().mockResolvedValue(new Blob(['mp3'])) };
    const audio = { src: '', onended: null as (() => void) | null, play: vi.fn().mockResolvedValue(undefined), pause: vi.fn() };
    TestBed.configureTestingModule({
      imports: [VoiceGalleryComponent],
      providers: [
        { provide: ReadAloudService, useValue: ra },
        { provide: AzureSpeechClient, useValue: azure },
        { provide: PREVIEW_AUDIO, useValue: () => audio },
      ],
    });
    const fixture = TestBed.createComponent(VoiceGalleryComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const cards = () => [...el.querySelectorAll('.vg-card')] as HTMLElement[];
    return { fixture, el, ra, azure, audio, cards, component: fixture.componentInstance };
  }

  it('shows a card per voice, marking the one in use', () => {
    const { cards, ra } = setup();
    expect(ra.loadVoices).toHaveBeenCalled();
    expect(cards().map(c => c.querySelector('.vg-name')?.textContent)).toEqual(['Andrew', 'Jane']);
    const jane = cards()[1]!;
    expect(jane.classList).toContain('selected');
    expect(jane.querySelector('.vg-choose')?.getAttribute('aria-pressed')).toBe('true');
    expect(jane.textContent).toContain('Audiobook');
  });

  it('picks and pins a voice', () => {
    const { cards, ra } = setup();
    (cards()[0]!.querySelector('.vg-choose') as HTMLElement).click();
    expect(ra.setVoice).toHaveBeenCalledWith('azure:Andrew');
    (cards()[0]!.querySelector('[aria-label^="Pin"]') as HTMLElement).click();
    expect(ra.togglePin).toHaveBeenCalledWith('azure:Andrew');
  });

  it('filters, then clears', () => {
    const { component, fixture, cards, el } = setup();
    component.setGender('Male');
    fixture.detectChanges();
    expect(cards()).toHaveLength(1);
    expect(el.querySelector('.vg-summary')?.textContent).toContain('1 voice');
    component.toggleTag('Audiobook');
    fixture.detectChanges();
    expect(el.textContent).toContain('No voices match');
    component.clearFilters();
    fixture.detectChanges();
    expect(cards()).toHaveLength(2);
  });

  it('pages long lists', () => {
    const many = Array.from({ length: 60 }, (_, i) => voice(`V${String(i).padStart(2, '0')}`));
    const { component, fixture, cards, el } = setup(many);
    expect(cards()).toHaveLength(48);
    expect(el.textContent).toContain('Show more (12 left)');
    component.showMore();
    fixture.detectChanges();
    expect(cards()).toHaveLength(60);
  });

  it('previews at the reader\'s speed, pausing the book, and stops on a second press', async () => {
    const { component, azure, audio, ra } = setup();
    await component.preview(voice('Jane'));
    expect(ra.playPause).toHaveBeenCalled();
    expect(azure.synthesize).toHaveBeenCalledWith(expect.stringContaining("I'm Jane"), 'azure:Jane', 1.25);
    expect(audio.play).toHaveBeenCalled();
    expect(component.previewing()).toBe('azure:Jane');
    await component.preview(voice('Jane'));
    expect(audio.pause).toHaveBeenCalled();
    expect(component.previewing()).toBeNull();
    // A replay reuses the fetched sample.
    await component.preview(voice('Jane'));
    expect(azure.synthesize).toHaveBeenCalledTimes(1);
  });

  it('reports a preview that fails', async () => {
    const { component, azure } = setup();
    azure.synthesize.mockRejectedValue(new Error('busy'));
    await component.preview(voice('Andrew'));
    expect(component.previewError()).toBe("Couldn't play Andrew: busy");
    expect(component.previewing()).toBeNull();
  });
});
