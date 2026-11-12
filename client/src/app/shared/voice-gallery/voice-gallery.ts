import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy, Component, computed, inject, InjectionToken, input, OnDestroy, OnInit, output, signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AzureSpeechClient, AzureVoice } from '@app/core/read-aloud/azure-speech-client';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import {
  displayName, DEFAULT_FILTER, filterIsDefault, filterVoices, GenderFilter, languageOptions, LanguageFilter, previewText, tagOptions,
  TypeFilter, VoiceFilter, voiceTags,
} from './voice-filter';

/** Makes the <audio> element previews play through (replaced in tests). */
export const PREVIEW_AUDIO = new InjectionToken<() => HTMLAudioElement>('PREVIEW_AUDIO', {
  providedIn: 'root',
  factory: () => {
    const win = inject(DOCUMENT).defaultView;
    return () => (win ? new win.Audio() : document.createElement('audio'));
  },
});

/** Cards shown at first, and added by each "Show more". */
const PAGE = 48;
/** Tags shown on a card before "+n". */
const CARD_TAGS = 3;

/** Browse, filter, preview and pick Microsoft voices. By default picking a card
 *  sets the reader's voice; in "pick" mode it only emits `picked` (e.g. to give a
 *  character a voice) and `selectedId` marks the current choice. */
@Component({
  selector: 'app-voice-gallery',
  imports: [
    MatButtonModule, MatButtonToggleModule, MatChipsModule, MatFormFieldModule, MatIconModule, MatInputModule,
    MatSelectModule, MatTooltipModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './voice-gallery.html',
  styleUrl: './voice-gallery.scss',
})
export class VoiceGalleryComponent implements OnInit, OnDestroy {
  readonly ra = inject(ReadAloudService);
  private readonly azure = inject(AzureSpeechClient);
  private readonly audio = inject(PREVIEW_AUDIO)();

  readonly mode = input<'reader' | 'pick'>('reader');
  /** The voice shown as selected in "pick" mode. */
  readonly selectedId = input<string | null>(null);
  readonly picked = output<AzureVoice>();
  readonly currentId = computed(() => this.mode() === 'pick' ? this.selectedId() : this.ra.voiceId());

  readonly displayName = displayName;
  readonly filter = signal<VoiceFilter>(DEFAULT_FILTER);
  readonly limit = signal(PAGE);
  /** Voice whose preview is playing, or loading when `previewLoading`. */
  readonly previewing = signal<string | null>(null);
  readonly previewLoading = signal(false);
  readonly previewError = signal<string | null>(null);

  readonly myLanguageName = computed(() => {
    const lang = this.ra.language.toLowerCase().split('-')[0];
    const match = this.ra.azureCatalog().find(v => v.lang.toLowerCase().startsWith(`${lang}-`));
    return match ? match.localeName.replace(/\s*\(.*\)$/, '') : 'My language';
  });
  readonly languages = computed(() => languageOptions(this.ra.azureCatalog()));
  readonly matches = computed(() =>
    filterVoices(this.ra.azureCatalog(), this.filter(), this.ra.language, this.ra.pinnedVoices()));
  readonly shown = computed(() => this.matches().slice(0, this.limit()));
  readonly remaining = computed(() => Math.max(0, this.matches().length - this.limit()));
  readonly tags = computed(() => tagOptions(this.ra.azureCatalog(), this.filter(), this.ra.language));
  readonly filtered = computed(() => !filterIsDefault(this.filter()));

  private readonly previewUrls = new Map<string, string>();
  private previewRequest = 0;

  ngOnInit(): void {
    void this.ra.loadVoices();
    this.audio.onended = () => this.previewing.set(null);
  }

  ngOnDestroy(): void {
    this.stopPreview();
    for (const url of this.previewUrls.values()) URL.revokeObjectURL(url);
  }

  update(change: Partial<VoiceFilter>): void {
    this.filter.update(f => ({ ...f, ...change }));
    this.limit.set(PAGE);
  }

  setSearch(value: string): void { this.update({ search: value }); }
  setLanguage(value: LanguageFilter): void { this.update({ language: value }); }
  setGender(value: GenderFilter): void { this.update({ gender: value }); }
  setType(value: TypeFilter): void { this.update({ type: value }); }

  toggleTag(tag: string): void {
    const tags = this.filter().tags;
    this.update({ tags: tags.includes(tag) ? tags.filter(t => t !== tag) : [...tags, tag] });
  }

  clearFilters(): void {
    this.filter.set(DEFAULT_FILTER);
    this.limit.set(PAGE);
  }

  showMore(): void {
    this.limit.update(n => n + PAGE);
  }

  choose(voice: AzureVoice): void {
    if (this.mode() === 'pick') this.picked.emit(voice);
    else this.ra.setVoice(voice.id);
  }

  cardTags(voice: AzureVoice): { shown: string[]; more: number } {
    const tags = voiceTags(voice);
    return { shown: tags.slice(0, CARD_TAGS), more: Math.max(0, tags.length - CARD_TAGS) };
  }

  initial(voice: AzureVoice): string {
    return voice.name.trim().charAt(0).toUpperCase();
  }

  /** Plays a short sample in the voice at the reader's speed; pressing again stops it. */
  async preview(voice: AzureVoice): Promise<void> {
    if (this.previewing() === voice.id) { this.stopPreview(); return; }
    this.stopPreview();
    // Don't talk over the book.
    if (this.ra.state() === 'playing') this.ra.playPause();
    const request = ++this.previewRequest;
    this.previewing.set(voice.id);
    this.previewError.set(null);
    const rate = this.ra.rate();
    const key = `${voice.id}|${rate}`;
    try {
      let url = this.previewUrls.get(key);
      if (!url) {
        this.previewLoading.set(true);
        const blob = await this.azure.synthesize(previewText(voice), voice.id, rate);
        url = URL.createObjectURL(blob);
        this.previewUrls.set(key, url);
      }
      if (request !== this.previewRequest) return;
      this.previewLoading.set(false);
      this.audio.src = url;
      await this.audio.play();
    } catch (err) {
      if (request !== this.previewRequest) return;
      this.previewing.set(null);
      this.previewLoading.set(false);
      this.previewError.set(`Couldn't play ${voice.name}: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }

  stopPreview(): void {
    this.previewRequest++;
    this.audio.pause();
    this.previewing.set(null);
    this.previewLoading.set(false);
  }
}
