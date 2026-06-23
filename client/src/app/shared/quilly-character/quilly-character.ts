import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  QuillyAnimationService,
  QuillyLoadedAnimation,
  QuillySequenceId,
} from './quilly-animation';

/** Placement of the speech bubble relative to the character. */
export type QuillySpeechPosition = 'above' | 'right' | 'left';

/**
 * Reusable animated "Quilly" character. Renders a sprite-sheet animation on a
 * canvas and can switch between sequences declaratively (via the `sequence`
 * input) or imperatively (via `play()`).
 *
 * @example
 * ```html
 * <app-quilly-character sequence="dance" [loop]="true" [size]="240" />
 * ```
 */
@Component({
  selector: 'app-quilly-character',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="quilly-wrap">
      @if (bubbleVisible() && speechText()) {
        <div
          class="bubble"
          [class.pos-above]="speechPosition() === 'above'"
          [class.pos-right]="speechPosition() === 'right'"
          [class.pos-left]="speechPosition() === 'left'"
          role="status"
          aria-live="polite"
        >
          <span class="bubble-bg"></span>
          <span class="bubble-tail"></span>
          <span class="bubble-text">{{ speechText() }}</span>
        </div>
      }

      <canvas
        #canvas
        [width]="frameWidth()"
        [height]="frameHeight()"
        [style.height.px]="size()"
        [attr.role]="'img'"
        [attr.aria-label]="ariaLabel() || 'Animated Quilly character'"
      ></canvas>

      <!-- Hand-drawn "roughen" filter applied to the bubble outline. -->
      <svg class="rough-defs" aria-hidden="true" focusable="false">
        <defs>
          <filter id="quilly-rough">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.014"
              numOctaves="2"
              seed="7"
              result="noise"
            />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="5" />
          </filter>
        </defs>
      </svg>
    </div>
  `,
  styles: [
    `
      :host {
        display: inline-block;
        line-height: 0;
      }
      .quilly-wrap {
        position: relative;
        display: inline-block;
      }
      canvas {
        width: auto;
        max-width: 100%;
      }
      .rough-defs {
        position: absolute;
        width: 0;
        height: 0;
      }

      .bubble {
        /* --qx / --qy carry the centering translate so the pop keyframe can
           re-use it without clobbering the per-position offset. */
        --qx: -50%;
        --qy: 0;
        position: absolute;
        z-index: 1;
        /* max-content keeps the bubble sized to its text (up to max-width)
           rather than shrinking to the space left of the containing block. */
        width: max-content;
        max-width: 240px;
        min-width: 64px;
        padding: 0.65rem 0.9rem;
        line-height: 1.25;
        text-align: center;
        transform: translate(var(--qx), var(--qy));
        animation: bubble-pop 0.18s ease-out;
      }
      /* The artwork only fills the middle ~18%-82% of each frame; the rest is
         transparent padding. Anchor bubbles to the artwork edge, not the
         canvas box, so they hug the character instead of floating away. */
      .bubble.pos-above {
        bottom: 88%;
        left: 50%;
        --qx: -50%;
        --qy: 0;
      }
      .bubble.pos-right {
        left: 81%;
        top: 40%;
        margin-left: 6px;
        --qx: 0;
        --qy: -50%;
      }
      .bubble.pos-left {
        right: 81%;
        top: 40%;
        margin-right: 6px;
        --qx: 0;
        --qy: -50%;
      }
      .bubble-bg,
      .bubble-tail {
        background: #fff;
        border: 2px solid #2f3d3d;
        /* Roughen filter gives the outline a hand-drawn wobble. */
        filter: url(#quilly-rough);
      }
      .bubble-bg {
        position: absolute;
        inset: 0;
        /* Asymmetric radii read as a hand-drawn box rather than a clean rect. */
        border-radius: 235px 18px 220px 16px / 16px 215px 18px 235px;
      }
      .bubble-tail {
        position: absolute;
        width: 16px;
        height: 16px;
      }
      /* Tail is a bordered square rotated to a diamond; the two visible borders
         form the point, the bare corner tucks back into the bubble body. */
      .pos-above .bubble-tail {
        bottom: -8px;
        left: 42%;
        border-top: none;
        border-left: none;
        transform: rotate(45deg) skewX(-8deg);
      }
      .pos-right .bubble-tail {
        left: -8px;
        top: 42%;
        border-top: none;
        border-right: none;
        transform: rotate(45deg) skewY(-8deg);
      }
      .pos-left .bubble-tail {
        right: -8px;
        top: 42%;
        border-bottom: none;
        border-left: none;
        transform: rotate(45deg) skewY(-8deg);
      }
      .bubble-text {
        position: relative;
        font-family: 'Patrick Hand', 'Segoe Print', 'Comic Sans MS', cursive;
        font-size: 1.15rem;
        color: #2f3d3d;
        line-height: 1.25;
        overflow-wrap: break-word;
      }

      @keyframes bubble-pop {
        from {
          opacity: 0;
          transform: translate(var(--qx), var(--qy)) scale(0.85);
        }
        to {
          opacity: 1;
          transform: translate(var(--qx), var(--qy)) scale(1);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .bubble {
          animation: none;
        }
      }
    `,
  ],
})
export class QuillyCharacterComponent {
  /** Sequence to display. Changing it (re)starts playback. */
  readonly sequence = input<QuillySequenceId>('idle');
  /** Loop the sequence indefinitely (default) or play once and hold the last frame. */
  readonly loop = input(true);
  /** Pause, in milliseconds, between loop iterations (0 = continuous). */
  readonly loopIntermission = input(0);
  /** Rendered height in CSS pixels; width follows the source aspect ratio. */
  readonly size = input(200);
  /** Start playing automatically when the sequence loads. */
  readonly autoplay = input(true);
  /** Base path where the `.json`/`.png` assets live. */
  readonly basePath = input('/quilly');
  /** Accessible label for the rendered image. */
  readonly ariaLabel = input<string>('');
  /** Text to show in the speech bubble. Empty hides the bubble. */
  readonly speech = input<string>('');
  /**
   * How long the bubble stays visible (and the `talking` animation loops), in
   * milliseconds. Use `0` (the default) to estimate the duration from the text
   * length and `speechRate`.
   */
  readonly speechDuration = input(0);
  /** Speaking pace, in words per minute, used to estimate the speech duration. */
  readonly speechRate = input(140);
  /** Where the speech bubble sits relative to the character. */
  readonly speechPosition = input<QuillySpeechPosition>('above');

  /** Emitted when a non-looping sequence reaches its final frame. */
  readonly sequenceComplete = output<QuillySequenceId>();

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly animations = inject(QuillyAnimationService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly frameWidth = signal(601);
  protected readonly frameHeight = signal(633);
  protected readonly speechText = signal('');
  protected readonly bubbleVisible = signal(false);
  private speechTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a `say()`/speech-driven talking animation is playing. */
  private speaking = false;

  private loaded: QuillyLoadedAnimation | null = null;
  private currentSequence: QuillySequenceId = 'idle';
  private frameIndex = 0;
  private elapsed = 0;
  private lastTimestamp = 0;
  private rafId = 0;
  /** Monotonic token to ignore stale async loads when the sequence changes fast. */
  private loadToken = 0;
  /** When set, overrides the `loop` input for the current playback. */
  private loopOverride: boolean | null = null;
  /** Pending replay timer while paused between loops. */
  private intermissionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // React to sequence (and base-path) changes by loading + playing.
    effect(() => {
      const id = this.sequence();
      const base = this.basePath();
      this.loadAndStart(id, base);
    });

    // React to the `speech` input: speak the text (talking animation + bubble).
    effect(() => {
      const text = this.speech();
      const duration = this.speechDuration();
      if (text) {
        this.startSpeaking(text, this.resolveSpeechMs(text, duration));
      } else {
        this.clearSpeech();
      }
    });

    this.destroyRef.onDestroy(() => {
      this.cancelLoop();
      this.clearSpeechTimer();
    });
  }

  /** Imperatively switch to and play a sequence. */
  play(sequence: QuillySequenceId): void {
    this.loadAndStart(sequence, this.basePath());
  }

  /** Stop playback, holding the current frame. */
  stop(): void {
    this.cancelLoop();
  }

  /**
   * Speak the given text: show a bubble and loop the `talking` animation for
   * the speech duration, then return to the declared `sequence`. The duration
   * defaults to an estimate from the text length (overridable per call or via
   * the `speechDuration` input).
   */
  say(text: string, durationMs?: number): void {
    if (!text) {
      this.clearSpeech();
      return;
    }
    this.startSpeaking(text, this.resolveSpeechMs(text, durationMs ?? this.speechDuration()));
  }

  /** Hide the bubble, stop talking, and return to the declared sequence. */
  clearSpeech(): void {
    this.clearSpeechTimer();
    this.bubbleVisible.set(false);
    this.speechText.set('');
    if (this.speaking) {
      this.speaking = false;
      this.loadAndStart(this.sequence(), this.basePath());
    }
  }

  /** Estimate how long it takes to say `text`, in milliseconds. */
  private resolveSpeechMs(text: string, durationMs: number): number {
    if (durationMs > 0) {
      return durationMs;
    }
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const wpm = Math.max(1, this.speechRate());
    const estimate = (words / wpm) * 60_000;
    // Floor so very short utterances stay readable; pad so the bubble lingers.
    return Math.max(1500, Math.round(estimate) + 400);
  }

  private startSpeaking(text: string, durationMs: number): void {
    this.clearSpeechTimer();
    this.speaking = true;
    this.speechText.set(text);
    this.bubbleVisible.set(true);
    // Loop the talking animation regardless of the `loop`/`autoplay` inputs.
    this.loadAndStart('talking', this.basePath(), { loop: true, autoplay: true });
    this.speechTimer = setTimeout(() => this.finishSpeaking(), durationMs);
  }

  private finishSpeaking(): void {
    this.speechTimer = null;
    this.speaking = false;
    this.bubbleVisible.set(false);
    this.speechText.set('');
    // Return to whatever sequence the host has declared.
    this.loadAndStart(this.sequence(), this.basePath());
  }

  private clearSpeechTimer(): void {
    if (this.speechTimer !== null) {
      clearTimeout(this.speechTimer);
      this.speechTimer = null;
    }
  }

  private async loadAndStart(
    id: QuillySequenceId,
    base: string,
    opts?: { loop?: boolean; autoplay?: boolean },
  ): Promise<void> {
    const token = ++this.loadToken;
    let animation: QuillyLoadedAnimation;
    try {
      animation = await this.animations.loadById(id, base);
    } catch (err) {
      console.error(`[QuillyCharacter] ${(err as Error).message}`);
      return;
    }
    // A newer load started while we were awaiting; abandon this one.
    if (token !== this.loadToken) {
      return;
    }
    this.loaded = animation;
    this.currentSequence = id;
    this.loopOverride = opts?.loop ?? null;
    const first = animation.frames[0]?.frame;
    if (first) {
      this.frameWidth.set(first.w);
      this.frameHeight.set(first.h);
    }
    this.frameIndex = 0;
    this.elapsed = 0;
    this.drawCurrentFrame();
    if (opts?.autoplay ?? this.autoplay()) {
      this.startLoop();
    }
  }

  private startLoop(): void {
    this.cancelLoop();
    this.lastTimestamp = 0;
    this.rafId = requestAnimationFrame((t) => this.tick(t));
  }

  private cancelLoop(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.intermissionTimer !== null) {
      clearTimeout(this.intermissionTimer);
      this.intermissionTimer = null;
    }
  }

  private tick(timestamp: number): void {
    const anim = this.loaded;
    if (!anim || anim.frames.length === 0) {
      return;
    }
    if (this.lastTimestamp === 0) {
      this.lastTimestamp = timestamp;
    }
    this.elapsed += timestamp - this.lastTimestamp;
    this.lastTimestamp = timestamp;

    const current = anim.frames[this.frameIndex];
    if (this.elapsed >= current.duration) {
      this.elapsed -= current.duration;
      const next = this.frameIndex + 1;
      if (next >= anim.frames.length) {
        if (this.loopOverride ?? this.loop()) {
          // Skip the intermission for forced loops (e.g. while speaking), which
          // must stay continuous.
          const pause = this.loopOverride !== null ? 0 : this.loopIntermission();
          if (pause > 0) {
            // Hold the final frame, then restart after the intermission.
            this.frameIndex = anim.frames.length - 1;
            this.drawCurrentFrame();
            this.cancelLoop();
            this.intermissionTimer = setTimeout(() => {
              this.intermissionTimer = null;
              this.frameIndex = 0;
              this.elapsed = 0;
              this.startLoop();
            }, pause);
            return;
          }
          this.frameIndex = 0;
        } else {
          this.frameIndex = anim.frames.length - 1;
          this.drawCurrentFrame();
          this.cancelLoop();
          this.sequenceComplete.emit(this.currentSequence);
          return;
        }
      } else {
        this.frameIndex = next;
      }
      this.drawCurrentFrame();
    }
    this.rafId = requestAnimationFrame((t) => this.tick(t));
  }

  private drawCurrentFrame(): void {
    const anim = this.loaded;
    const canvas = this.canvasRef().nativeElement;
    const ctx = canvas.getContext('2d');
    if (!anim || !ctx) {
      return;
    }
    const { frame } = anim.frames[this.frameIndex];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      anim.image,
      frame.x,
      frame.y,
      frame.w,
      frame.h,
      0,
      0,
      frame.w,
      frame.h,
    );
  }
}
