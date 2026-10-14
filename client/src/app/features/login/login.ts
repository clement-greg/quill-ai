import { Component, ElementRef, ViewChild, AfterViewInit, inject, PLATFORM_ID, NgZone, DestroyRef, signal, ChangeDetectionStrategy, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { AuthService } from '@app/core/auth/auth.service';
import { environment } from '../../../environments/environment';
import { getQuillDesktop } from '@app/core/desktop/quill-desktop';

/** Lines the robot cycles through while the user is on the login page. */
const ROBOT_MESSAGES = [
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

/**
 * Where to hand a Google credential when this page was opened in the system
 * browser by the desktop app, which can't run Google Sign-In itself.
 */
interface DesktopHandoff {
  port: string;
  state: string;
}

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
  imports: [MatCardModule],
  templateUrl: './login.html',
  styleUrl: './login.scss',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent implements AfterViewInit {
  @ViewChild('googleBtn') googleBtnRef!: ElementRef<HTMLDivElement>;
  @ViewChild('bgVideo') bgVideoRef!: ElementRef<HTMLVideoElement>;

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

  protected readonly desktop = isPlatformBrowser(this.platformId) ? getQuillDesktop() : null;
  protected readonly handoff = this.readDesktopHandoff();
  protected readonly desktopSigningIn = signal(false);
  protected readonly desktopError = signal('');

  private messageIndex = 0;
  private speechTimer: ReturnType<typeof setTimeout> | null = null;
  private reversePlaybackHandle: number | null = null;

  ngAfterViewInit(): void {
    if (!isPlatformBrowser(this.platformId)) return;

    const video = this.bgVideoRef.nativeElement;
    video.muted = true;
    video.play().catch(() => {});
    video.addEventListener('ended', this.onVideoEnded);
    this.showNextMessage();
    this.destroyRef.onDestroy(() => {
      if (this.speechTimer !== null) clearTimeout(this.speechTimer);
      video.removeEventListener('ended', this.onVideoEnded);
      if (this.reversePlaybackHandle !== null) cancelAnimationFrame(this.reversePlaybackHandle);
    });

    // Google blocks sign-in inside Electron, so the desktop app signs in through
    // the system browser instead of rendering the GSI button here.
    if (this.desktop) return;

    const waitForGoogle = () => {
      if (typeof google !== 'undefined') {
        google.accounts.id.initialize({
          client_id: environment.googleClientId,
          callback: (response: { credential: string }) => {
            if (this.handoff) {
              this.postToDesktop(this.handoff, response.credential);
              return;
            }
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

  protected async signInWithDesktop(): Promise<void> {
    if (!this.desktop) return;
    this.desktopSigningIn.set(true);
    this.desktopError.set('');
    try {
      const credential = await this.desktop.signInWithGoogle();
      await this.auth.handleCredentialResponse(credential);
      this.router.navigate(['/series']);
    } catch {
      this.desktopError.set('Sign-in didn\'t finish. Try again.');
    } finally {
      this.desktopSigningIn.set(false);
    }
  }

  private readDesktopHandoff(): DesktopHandoff | null {
    if (!isPlatformBrowser(this.platformId)) return null;
    const params = new URLSearchParams(location.search);
    const port = params.get('desktopPort');
    const state = params.get('desktopState');
    return port && /^\d+$/.test(port) && state ? { port, state } : null;
  }

  /**
   * Hands the credential to the desktop app's loopback listener. A form POST
   * (rather than fetch) keeps the token out of the URL and needs no CORS.
   */
  private postToDesktop(handoff: DesktopHandoff, credential: string): void {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = `http://127.0.0.1:${handoff.port}/callback`;
    for (const [name, value] of [['credential', credential], ['state', handoff.state]]) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
  }

  /** Plays the background video forward, then reverse, forever, to keep a seamless loop. */
  private readonly onVideoEnded = (): void => {
    this.ngZone.runOutsideAngular(() => this.stepReverse());
  };

  private stepReverse(): void {
    const video = this.bgVideoRef.nativeElement;
    // Roughly one frame's worth of time at 30fps; reverse playback has no native browser support.
    const frameSeconds = 1 / 30;
    const nextTime = video.currentTime - frameSeconds;

    if (nextTime <= 0) {
      video.currentTime = 0;
      video.play().catch(() => {});
      return;
    }

    video.currentTime = nextTime;
    this.reversePlaybackHandle = requestAnimationFrame(() => this.stepReverse());
  }

  /** Show the next message, then queue the following one after the bubble hides. */
  private showNextMessage(): void {
    this.speech.set(ROBOT_MESSAGES[this.messageIndex]);
    this.messageIndex = (this.messageIndex + 1) % ROBOT_MESSAGES.length;
    this.speechTimer = setTimeout(() => {
      this.speech.set('');
      this.speechTimer = setTimeout(() => this.showNextMessage(), this.intermissionMs);
    }, this.speechMs);
  }
}
