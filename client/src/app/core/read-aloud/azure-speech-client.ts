import { inject, Injectable, Injector } from '@angular/core';
import { AuthFetchService } from '@app/core/services/auth-fetch.service';
import { AZURE_VOICE_PREFIX, ReadAloudVoice } from './read-aloud.model';

/** What GET /api/speech/voices answers. */
interface VoicesResponse {
  enabled: boolean;
  defaultVoice: string | null;
  voices: { id: string; name: string; lang: string; gender?: string }[];
}

export interface AzureVoices {
  /** The server has an Azure Speech key. */
  enabled: boolean;
  /** Player voice id of the default Microsoft voice (Jane), when enabled. */
  defaultVoiceId: string | null;
  voices: ReadAloudVoice[];
}

const DISABLED: AzureVoices = { enabled: false, defaultVoiceId: null, voices: [] };

/** Talks to the server's Azure Speech proxy (the key never reaches the client). */
@Injectable({ providedIn: 'root' })
export class AzureSpeechClient {
  // Resolved on first use, so the read-aloud player can be built without HTTP (tests, no Azure).
  private readonly injector = inject(Injector);
  private voicesRequest: Promise<AzureVoices> | null = null;

  private get http(): AuthFetchService {
    return this.injector.get(AuthFetchService);
  }

  /** The Microsoft voices, fetched once; disabled when the server can't offer them. */
  voices(): Promise<AzureVoices> {
    this.voicesRequest ??= this.loadVoices();
    return this.voicesRequest;
  }

  /** MP3 of `text` spoken by `voiceId` (a player id, with the azure: prefix) at `rate`. */
  async synthesize(text: string, voiceId: string, rate: number, signal?: AbortSignal): Promise<Blob> {
    const res = await this.http.fetch('/api/speech/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: voiceId.slice(AZURE_VOICE_PREFIX.length), rate }),
      signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `Microsoft voice failed (${res.status}).`);
    }
    return res.blob();
  }

  private async loadVoices(): Promise<AzureVoices> {
    try {
      const res = await this.http.fetch('/api/speech/voices');
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json() as VoicesResponse;
      if (!body.enabled) return DISABLED;
      return {
        enabled: true,
        defaultVoiceId: body.defaultVoice ? AZURE_VOICE_PREFIX + body.defaultVoice : null,
        voices: body.voices.map(v => ({
          id: AZURE_VOICE_PREFIX + v.id, name: v.name, lang: v.lang, quality: 'premium' as const, provider: 'azure' as const,
        })),
      };
    } catch {
      // Try again next time the voice list is opened.
      this.voicesRequest = null;
      return DISABLED;
    }
  }
}
