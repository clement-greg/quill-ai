import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, input, output, signal, viewChild } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

/** Safari-only fullscreen entry points that TypeScript's lib.dom doesn't declare. */
interface WebkitVideoElement extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
}

/**
 * Video player with our own control bar.
 *
 * The native `controls` attribute is deliberately absent: iOS Safari renders its
 * control bar as a full-frame translucent scrim that washes out the whole video
 * for the first seconds of playback. These controls only tint the bottom strip,
 * fade out while playing, and come back on tap.
 */
@Component({
  selector: 'app-video-player',
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <video
      #video
      class="vp-video"
      [src]="src()"
      [loop]="loop()"
      [muted]="muted()"
      autoplay
      playsinline
      [attr.aria-label]="ariaLabel()"
      (click)="onVideoClick()"
      (loadedmetadata)="onLoadedMetadata()"
      (timeupdate)="onTimeUpdate()"
      (durationchange)="onLoadedMetadata()"
      (play)="playing.set(true); scheduleHide()"
      (pause)="playing.set(false); showControls()"
      (volumechange)="muted.set(videoEl().nativeElement.muted)"
      (ended)="onEnded()"
    ></video>

    <div class="vp-controls" [class.vp-hidden]="!controlsVisible()" (click)="$event.stopPropagation()">
      <button type="button" class="vp-btn" (click)="togglePlay()"
              [attr.aria-label]="playing() ? 'Pause' : 'Play'">
        <mat-icon>{{ playing() ? 'pause' : 'play_arrow' }}</mat-icon>
      </button>

      <span class="vp-time">{{ clock(currentTime()) }}</span>

      <input
        class="vp-seek"
        type="range"
        min="0"
        [max]="duration() || 0"
        step="0.01"
        [value]="currentTime()"
        [style.--vp-progress]="progressPercent() + '%'"
        aria-label="Seek"
        (input)="onSeek($event)"
        (pointerdown)="beginScrub()"
        (pointerup)="endScrub()"
        (pointercancel)="endScrub()"
      />

      <span class="vp-time">{{ clock(duration()) }}</span>

      <button type="button" class="vp-btn" (click)="toggleMute()"
              [attr.aria-label]="muted() ? 'Unmute' : 'Mute'">
        <mat-icon>{{ muted() ? 'volume_off' : 'volume_up' }}</mat-icon>
      </button>

      <button type="button" class="vp-btn" (click)="enterFullscreen()" aria-label="Full screen">
        <mat-icon>fullscreen</mat-icon>
      </button>
    </div>
  `,
  styleUrl: './video-player.scss',
})
export class VideoPlayer implements OnDestroy {
  src = input<string | null>(null);
  loop = input(true);
  ariaLabel = input<string | null>(null);

  ended = output<void>();

  protected videoEl = viewChild.required<ElementRef<HTMLVideoElement>>('video');

  protected playing = signal(false);
  protected muted = signal(false);
  protected currentTime = signal(0);
  protected duration = signal(0);
  protected controlsVisible = signal(true);

  protected progressPercent = computed(() => {
    const d = this.duration();
    return d > 0 ? Math.min(100, (this.currentTime() / d) * 100) : 0;
  });

  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private scrubbing = false;

  ngOnDestroy(): void {
    this.clearHideTimer();
  }

  // ── Controls visibility ────────────────────────────────────────────────────

  /** Shows the bar and restarts the auto-hide countdown. */
  protected showControls(): void {
    this.controlsVisible.set(true);
    this.scheduleHide();
  }

  /** Hides the bar after a few seconds, but only while the video is playing. */
  protected scheduleHide(): void {
    this.clearHideTimer();
    this.hideTimer = setTimeout(() => {
      if (this.playing() && !this.scrubbing) this.controlsVisible.set(false);
    }, 3000);
  }

  private clearHideTimer(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  /** Tapping the frame reveals the controls; tapping again toggles playback. */
  protected onVideoClick(): void {
    if (!this.controlsVisible()) this.showControls();
    else this.togglePlay();
  }

  // ── Playback ───────────────────────────────────────────────────────────────

  protected togglePlay(): void {
    const video = this.videoEl().nativeElement;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
    this.showControls();
  }

  protected toggleMute(): void {
    const video = this.videoEl().nativeElement;
    video.muted = !video.muted;
    this.muted.set(video.muted);
    this.showControls();
  }

  protected enterFullscreen(): void {
    const video = this.videoEl().nativeElement as WebkitVideoElement;
    // iPhone Safari has no Element.requestFullscreen — only the video-specific one.
    if (video.requestFullscreen) void video.requestFullscreen().catch(() => undefined);
    else video.webkitEnterFullscreen?.();
    this.showControls();
  }

  protected onSeek(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.videoEl().nativeElement.currentTime = value;
    this.currentTime.set(value);
    this.showControls();
  }

  protected beginScrub(): void {
    this.scrubbing = true;
    this.controlsVisible.set(true);
    this.clearHideTimer();
  }

  protected endScrub(): void {
    this.scrubbing = false;
    this.scheduleHide();
  }

  // ── Media events ───────────────────────────────────────────────────────────

  protected onLoadedMetadata(): void {
    const video = this.videoEl().nativeElement;
    this.duration.set(Number.isFinite(video.duration) ? video.duration : 0);
    this.muted.set(video.muted);
    this.playing.set(!video.paused);
    this.showControls();
  }

  protected onTimeUpdate(): void {
    if (!this.scrubbing) this.currentTime.set(this.videoEl().nativeElement.currentTime);
  }

  protected onEnded(): void {
    this.playing.set(false);
    this.controlsVisible.set(true);
    this.ended.emit();
  }

  /** Formats seconds as m:ss (or h:mm:ss past an hour). */
  protected clock(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const s = String(total % 60).padStart(2, '0');
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }
}
