import { Component, ElementRef, ViewChild, AfterViewInit, inject, PLATFORM_ID, NgZone, signal, DestroyRef, ChangeDetectionStrategy } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { AuthService } from '../auth/auth.service';
import { environment } from '../../environments/environment';

declare const google: {
  accounts: {
    id: {
      initialize(config: object): void;
      renderButton(parent: HTMLElement, config: object): void;
      prompt(): void;
    };
  };
};

const KEN_BURNS_KEYFRAMES: Keyframe[][] = [
  [{ transform: 'scale(1) translate(0, 0)' },      { transform: 'scale(1.08) translate(-2%, -1%)' }],
  [{ transform: 'scale(1.06) translate(2%, 1%)' },  { transform: 'scale(1) translate(-1%, -0.5%)' }],
  [{ transform: 'scale(1) translate(-1%, 1%)' },    { transform: 'scale(1.08) translate(1%, -1.5%)' }],
  [{ transform: 'scale(1.07) translate(1%, -1%)' }, { transform: 'scale(1) translate(-1.5%, 0.5%)' }],
  [{ transform: 'scale(1) translate(1.5%, 0.5%)' }, { transform: 'scale(1.08) translate(-1%, 1%)' }],
  [{ transform: 'scale(1.06) translate(-1%, -1%)' },{ transform: 'scale(1) translate(1%, 1.5%)' }],
];

@Component({
  selector: 'app-login',
  imports: [MatCardModule],
  templateUrl: './login.html',
  styleUrl: './login.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent implements AfterViewInit {
  @ViewChild('googleBtn') googleBtnRef!: ElementRef<HTMLDivElement>;

  protected readonly currentIndex = signal(0);

  private readonly elRef = inject(ElementRef);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly ngZone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

  private slideEls: HTMLElement[] = [];
  private readonly animations = new Map<number, Animation>();

  ngAfterViewInit(): void {
    if (!isPlatformBrowser(this.platformId)) return;

    this.slideEls = Array.from(
      (this.elRef.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.bg-slide')
    );
    this.startKenBurns(0);

    const intervalId = setInterval(() => this.advance(), 10000);
    this.destroyRef.onDestroy(() => clearInterval(intervalId));

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

  private startKenBurns(index: number): void {
    const el = this.slideEls[index];
    if (!el) return;
    el.style.transform = '';
    const anim = el.animate(KEN_BURNS_KEYFRAMES[index], {
      duration: 12000,
      easing: 'ease-in-out',
      fill: 'forwards',
    });
    this.animations.set(index, anim);
  }

  private advance(): void {
    const outIdx = this.currentIndex();
    const inIdx = (outIdx + 1) % 6;
    const outEl = this.slideEls[outIdx];
    const anim = this.animations.get(outIdx);

    if (anim && outEl) {
      // Freeze the live animated transform as an inline style so CSS transition can take over
      anim.commitStyles();
      anim.cancel();
      this.animations.delete(outIdx);
      void outEl.offsetHeight; // force reflow so the browser registers the frozen value
      outEl.style.transform = ''; // CSS transition eases from the frozen value back to identity
    }

    this.startKenBurns(inIdx);
    this.currentIndex.set(inIdx);
  }
}
