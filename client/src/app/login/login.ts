import { Component, ElementRef, ViewChild, AfterViewInit, inject, PLATFORM_ID, NgZone, DestroyRef, signal, ChangeDetectionStrategy } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { AuthService } from '../auth/auth.service';
import { QuillyCharacterComponent } from '../shared/quilly-character/quilly-character';
import { environment } from '../../environments/environment';

/** Lines Quilly cycles through while the user is on the login page. */
const QUILLY_MESSAGES = [
  'Welcome back! Sign in to continue.',
  'Every great story starts with a single word.',
  'Your characters missed you while you were gone.',
  'I sharpened my quill just for you.',
  'Plot holes fear us. Sign in and let\'s prove it.',
  'The blank page is only scary before the first line.',
  'I\'ve been guarding your drafts. Nothing escaped.',
  'Heroes, villains, and everyone in between await.',
  'A chapter a day keeps the writer\'s block away.',
  'Somewhere in your story, a dragon is getting impatient.',
  'First drafts are allowed to be messy. I checked the rules.',
  'Your world won\'t build itself. Well... I might help a little.',
  'Ink runs in my veins. Literally. I\'m a quill.',
  'Today feels like a good day for a plot twist.',
  'Even the longest saga starts with "once upon a time."',
  'I promise not to judge your typos. Much.',
  'Your protagonist has been pacing since you left.',
  'Stories are just daydreams with better organization.',
  'Sign in before the muse wanders off again!',
  'The best time to write was yesterday. The second best is now.',
] as const;

declare const google: {
  accounts: {
    id: {
      initialize(config: object): void;
      renderButton(parent: HTMLElement, config: object): void;
      prompt(): void;
    };
  };
};

@Component({
  selector: 'app-login',
  imports: [MatCardModule, QuillyCharacterComponent],
  templateUrl: './login.html',
  styleUrl: './login.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent implements AfterViewInit {
  @ViewChild('googleBtn') googleBtnRef!: ElementRef<HTMLDivElement>;

  /** How long each speech bubble stays visible. */
  protected readonly speechMs = 5000;
  /** Pause between one bubble disappearing and the next appearing. */
  private readonly intermissionMs = 10000;

  protected readonly speech = signal('');

  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly ngZone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

  private messageIndex = 0;
  private speechTimer: ReturnType<typeof setTimeout> | null = null;

  ngAfterViewInit(): void {
    if (!isPlatformBrowser(this.platformId)) return;

    this.showNextMessage();
    this.destroyRef.onDestroy(() => {
      if (this.speechTimer !== null) clearTimeout(this.speechTimer);
    });

    const waitForGoogle = () => {
      if (typeof google !== 'undefined') {
        google.accounts.id.initialize({
          client_id: environment.googleClientId,
          callback: (response: { credential: string }) => {
            this.ngZone.run(async () => {
              await this.auth.handleCredentialResponse(response.credential);
              this.router.navigate(['/series']);
            });
          },
          auto_select: false,
          cancel_on_tap_outside: true,
        });
        google.accounts.id.renderButton(this.googleBtnRef.nativeElement, {
          theme: 'outline',
          size: 'large',
          text: 'signin_with',
          shape: 'rectangular',
        });
      } else {
        setTimeout(waitForGoogle, 100);
      }
    };
    waitForGoogle();
  }

  /** Show the next message, then queue the following one after the bubble hides. */
  private showNextMessage(): void {
    this.speech.set(QUILLY_MESSAGES[this.messageIndex]);
    this.messageIndex = (this.messageIndex + 1) % QUILLY_MESSAGES.length;
    this.speechTimer = setTimeout(() => {
      this.speech.set('');
      this.speechTimer = setTimeout(() => this.showNextMessage(), this.intermissionMs);
    }, this.speechMs);
  }
}
