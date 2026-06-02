import { Component, OnInit, ElementRef, ViewChild, AfterViewInit, inject, PLATFORM_ID, NgZone } from '@angular/core';
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

@Component({
  selector: 'app-login',
  imports: [MatCardModule],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class LoginComponent implements AfterViewInit {
  @ViewChild('googleBtn') googleBtnRef!: ElementRef<HTMLDivElement>;

  private auth = inject(AuthService);
  private router = inject(Router);
  private platformId = inject(PLATFORM_ID);
  private ngZone = inject(NgZone);

  ngAfterViewInit(): void {
    if (!isPlatformBrowser(this.platformId)) return;

    const waitForGoogle = () => {
      if (typeof google !== 'undefined') {
        google.accounts.id.initialize({
          client_id: environment.googleClientId,
          callback: (response: { credential: string }) => {
            // Google's callback runs outside Angular's NgZone; re-enter it so
            // the signal update and router navigation are processed correctly.
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
}
