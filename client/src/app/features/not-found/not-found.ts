import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  QuillyCharacterComponent,
  QuillySpeechPosition,
} from '@app/shared/quilly-character/quilly-character';
import { QuillySequenceId } from '@app/shared/quilly-character/quilly-animation';

/**
 * Friendly 404 page. Quilly runs a repeating performance: speak the apology,
 * scratch its head once (confused), idle for a beat, then start over.
 */
@Component({
  selector: 'app-not-found',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, QuillyCharacterComponent],
  templateUrl: './not-found.html',
  styleUrl: './not-found.scss',
})
export class NotFoundComponent implements AfterViewInit, OnDestroy {
  private readonly character =
    viewChild.required<QuillyCharacterComponent>('character');

  /** Loop the active sequence (idle) vs. play once (confused). */
  protected readonly loop = signal(true);
  /** Pause between idle loop iterations. */
  protected readonly idleIntermissionMs = 2_000;
  protected readonly speechPosition: QuillySpeechPosition = 'right';

  private readonly speech = "Hmm... I can't find that page.";
  /** How long the speech bubble + talking animation stay up. */
  private readonly speechMs = 3500;
  /** How long Quilly idles before repeating the performance. */
  private readonly idleMs = 10_000;

  private timer: ReturnType<typeof setTimeout> | null = null;

  ngAfterViewInit(): void {
    this.speak();
  }

  ngOnDestroy(): void {
    this.clearTimer();
  }

  /** Step 1: say the line (talking animation + bubble), then go confused. */
  private speak(): void {
    this.clearTimer();
    // Pass a long duration so the component doesn't auto-return mid-line; we
    // cut the speech off ourselves to drive the next step.
    this.character().say(this.speech, 60_000);
    this.timer = setTimeout(() => this.confused(), this.speechMs);
  }

  /** Step 2: scratch head once. `sequenceComplete` advances us to idle. */
  private confused(): void {
    this.clearTimer();
    this.character().clearSpeech();
    this.loop.set(false);
    this.character().play('confused');
  }

  /** Step 3 (on confused finishing): idle for a beat, then repeat. */
  protected onComplete(id: QuillySequenceId): void {
    if (id !== 'confused') {
      return;
    }
    this.loop.set(true);
    this.character().play('idle');
    this.timer = setTimeout(() => this.speak(), this.idleMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
