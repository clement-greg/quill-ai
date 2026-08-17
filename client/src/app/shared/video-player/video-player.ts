import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, input, output, signal, viewChild } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

/** Safari-only fullscreen entry points that TypeScript's lib.dom doesn't declare. */
interface WebkitVideoElement extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
}

/** Distance in px a pointer may travel before a tap counts as a drag. */
const DRAG_SLOP = 10;

/** How long the centre play/pause flash stays up. Must match the CSS animation. */
const FLASH_MS = 700;

/**
 * Video player with our own control bar.
 *
 * The native `controls` attribute is deliberately absent: iOS Safari renders its
 * control bar as a full-frame translucent scrim that washes out the whole video
 * for the first seconds of playback. These controls only tint the bottom strip,
 * fade out while playing, and come back on tap.
 *
 * While paused, the whole frame becomes a scrub surface — dragging across it
 * seeks, mapping the full width to the full duration. `data-vp-scrub` reflects
 * that state onto the host so an enclosing gallery knows to leave the gesture
 * alone; while playing the attribute is absent and swipes page the gallery.
 */
@Component({
  selector: 'app-video-player',
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.data-vp-scrub]': 'playing() ? null : ""',
  },
  template: `
    <video
      #video
      class="vp-video"
      [class.vp-scrubbable]="!playing()"
      [src]="src()"
      [loop]="loop()"
      [muted]="muted()"
      autoplay
      playsinline
      [attr.aria-label]="ariaLabel()"
      (pointerdown)="onFramePointerDown($event)"
      (pointermove)="onFramePointerMove($event)"
      (pointerup)="onFramePointerUp($event)"
      (pointercancel)="onFramePointerCancel()"
      (loadedmetadata)="onLoadedMetadata()"
      (timeupdate)="onTimeUpdate()"
      (durationchange)="onLoadedMetadata()"
      (play)="playing.set(true); scheduleHide()"
      (pause)="playing.set(false); showControls()"
      (volumechange)="muted.set(videoEl().nativeElement.muted)"
      (ended)="onEnded()"
    ></video>

    <!-- Re-keyed on every toggle so the CSS animation restarts. -->
    @if (flash(); as f) {
      @for (_ of [f.id]; track _) {
        <div class="vp-flash" aria-hidden="true">
          <mat-icon>{{ f.icon }}</mat-icon>
        </div>
      }
    }

    <!--
      data-vp-controls marks the region that owns its own gestures: hosts use it
      to tell a scrub or button press apart from a swipe across the video frame.
    -->
    <div class="vp-controls" data-vp-controls [class.vp-hidden]="!controlsVisible()"
         (click)="$event.stopPropagation()">
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
  protected flash = signal<{ icon: 'play_arrow' | 'pause'; id: number } | null>(null);

  protected progressPercent = computed(() => {
    const d = this.duration();
    return d > 0 ? Math.min(100, (this.currentTime() / d) * 100) : 0;
  });

  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private flashId = 0;
  private scrubbing = false;
  /** Pointer origin plus the playhead it started from, while a frame gesture is live. */
  private frameGesture: { x: number; y: number; time: number; dragging: boolean } | null = null;

  ngOnDestroy(): void {
    this.clearHideTimer();
    if (this.flashTimer !== null) clearTimeout(this.flashTimer);
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

  // ── Frame gestures ─────────────────────────────────────────────────────────

  protected onFramePointerDown(event: PointerEvent): void {
    this.frameGesture = {
      x: event.clientX,
      y: event.clientY,
      time: this.videoEl().nativeElement.currentTime,
      dragging: false,
    };
  }

  /**
   * While paused, a horizontal drag anywhere on the frame scrubs: the frame's
   * full width maps to the full duration. While playing the drag is left for
   * the enclosing gallery to read as a swipe.
   */
  protected onFramePointerMove(event: PointerEvent): void {
    const gesture = this.frameGesture;
    if (!gesture || this.playing()) return;

    const dx = event.clientX - gesture.x;
    if (!gesture.dragging) {
      if (Math.abs(dx) <= DRAG_SLOP) return;
      gesture.dragging = true;
      this.beginScrub();
      this.videoEl().nativeElement.setPointerCapture?.(event.pointerId);
    }

    const video = this.videoEl().nativeElement;
    const width = video.getBoundingClientRect().width;
    const total = this.duration();
    if (width <= 0 || total <= 0) return;

    const next = Math.min(total, Math.max(0, gesture.time + (dx / width) * total));
    video.currentTime = next;
    this.currentTime.set(next);
  }

  /** A gesture that never became a drag is a tap: reveal controls, else toggle. */
  protected onFramePointerUp(event: PointerEvent): void {
    const gesture = this.frameGesture;
    this.frameGesture = null;
    if (!gesture) return;

    if (gesture.dragging) {
      this.videoEl().nativeElement.releasePointerCapture?.(event.pointerId);
      this.endScrub();
      return;
    }
    // A tap that travelled is the gallery's swipe, not ours.
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > DRAG_SLOP) return;

    if (!this.controlsVisible()) this.showControls();
    else this.togglePlay();
  }

  protected onFramePointerCancel(): void {
    if (this.frameGesture?.dragging) this.endScrub();
    this.frameGesture = null;
  }

  // ── Playback ───────────────────────────────────────────────────────────────

  protected togglePlay(): void {
    const video = this.videoEl().nativeElement;
    const resuming = video.paused;
    if (resuming) void video.play().catch(() => undefined);
    else video.pause();
    this.showFlash(resuming ? 'play_arrow' : 'pause');
    this.showControls();
  }

  /** Briefly pulses the action's icon over the centre of the frame. */
  private showFlash(icon: 'play_arrow' | 'pause'): void {
    if (this.flashTimer !== null) clearTimeout(this.flashTimer);
    this.flash.set({ icon, id: ++this.flashId });
    this.flashTimer = setTimeout(() => {
      this.flash.set(null);
      this.flashTimer = null;
    }, FLASH_MS);
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
