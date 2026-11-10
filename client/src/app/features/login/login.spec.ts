import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AuthService } from '@app/core/auth/auth.service';
import { LoginComponent } from './login';

type GsiConfig = { callback: (response: { credential: string }) => void };

describe('LoginComponent', () => {
  let auth: { handleCredentialResponse: ReturnType<typeof vi.fn> };
  let gsiConfig: GsiConfig | null;
  let renderButton: ReturnType<typeof vi.fn>;
  let submitted: HTMLFormElement[];

  const win = window as Window & { quillDesktop?: unknown; quillNative?: unknown };
  // @types/google.maps already types a global `google`; the GSI stub doesn't match it.
  const glob = globalThis as unknown as Record<string, unknown>;

  beforeEach(() => {
    auth = { handleCredentialResponse: vi.fn().mockResolvedValue(undefined) };
    gsiConfig = null;
    renderButton = vi.fn();
    submitted = [];

    glob['google'] = {
      accounts: {
        id: {
          initialize: (config: GsiConfig) => { gsiConfig = config; },
          renderButton,
          prompt: vi.fn(),
        },
      },
    };
    // jsdom implements neither media playback nor form navigation.
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) {
      submitted.push(this);
    });

    TestBed.configureTestingModule({
      imports: [LoginComponent],
      providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
    });
  });

  afterEach(() => {
    delete win.quillDesktop;
    delete win.quillNative;
    delete glob['google'];
    window.history.replaceState({}, '', '/');
    vi.restoreAllMocks();
  });

  async function create() {
    const fixture = TestBed.createComponent(LoginComponent);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement, navigate };
  }

  describe('in the browser', () => {
    it('renders the Google button and signs in with the returned credential', async () => {
      const { el, navigate } = await create();

      expect(renderButton).toHaveBeenCalled();
      expect(el.querySelector('.desktop-google-btn')).toBeNull();

      gsiConfig!.callback({ credential: 'google-id-token' });
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(['/series']));
      expect(auth.handleCredentialResponse).toHaveBeenCalledWith('google-id-token');
      expect(submitted).toHaveLength(0);
    });
  });

  describe('opened by the desktop app for sign-in', () => {
    beforeEach(() => {
      window.history.replaceState({}, '', '/login?desktopPort=51234&desktopState=abc123');
    });

    it('tells the user they are signing in for the desktop app', async () => {
      const { el } = await create();
      expect(el.textContent).toContain('continue in the Quill AI desktop app');
    });

    it('posts the credential to the desktop app instead of signing in here', async () => {
      const { navigate } = await create();

      gsiConfig!.callback({ credential: 'google-id-token' });

      expect(submitted).toHaveLength(1);
      const form = submitted[0];
      expect(form.method.toUpperCase()).toBe('POST');
      expect(form.action).toBe('http://127.0.0.1:51234/callback');
      const fields = Object.fromEntries(new FormData(form).entries());
      expect(fields).toEqual({ credential: 'google-id-token', state: 'abc123' });
      expect(auth.handleCredentialResponse).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    });

    it('ignores a non-numeric port and signs in normally', async () => {
      window.history.replaceState({}, '', '/login?desktopPort=evil.example&desktopState=abc123');
      const { el } = await create();

      gsiConfig!.callback({ credential: 'google-id-token' });

      await vi.waitFor(() => expect(auth.handleCredentialResponse).toHaveBeenCalledWith('google-id-token'));
      expect(submitted).toHaveLength(0);
      expect(el.textContent).not.toContain('desktop app');
    });

    it('ignores a handoff with no state', async () => {
      window.history.replaceState({}, '', '/login?desktopPort=51234');
      await create();

      gsiConfig!.callback({ credential: 'google-id-token' });

      await vi.waitFor(() => expect(auth.handleCredentialResponse).toHaveBeenCalled());
      expect(submitted).toHaveLength(0);
    });
  });

  describe('inside the desktop app', () => {
    let signInWithGoogle: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      signInWithGoogle = vi.fn();
      win.quillDesktop = { signInWithGoogle };
    });

    it('shows its own button instead of the blocked Google one', async () => {
      const { el } = await create();

      expect(el.querySelector('.desktop-google-btn')?.textContent).toContain('Sign in with Google');
      expect(renderButton).not.toHaveBeenCalled();
      expect(gsiConfig).toBeNull();
    });

    it('signs in with the credential from the system browser', async () => {
      signInWithGoogle.mockResolvedValue('google-id-token');
      const { el, navigate } = await create();

      el.querySelector<HTMLButtonElement>('.desktop-google-btn')!.click();

      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(['/series']));
      expect(auth.handleCredentialResponse).toHaveBeenCalledWith('google-id-token');
    });

    it('disables the button and points to the browser while waiting', async () => {
      signInWithGoogle.mockReturnValue(new Promise(() => {}));
      const { fixture, el } = await create();
      const button = el.querySelector<HTMLButtonElement>('.desktop-google-btn')!;

      button.click();
      fixture.detectChanges();

      expect(button.disabled).toBe(true);
      expect(button.textContent).toContain('Finish signing in in your browser');
    });

    it('shows an error and stays put when sign-in fails', async () => {
      signInWithGoogle.mockRejectedValue(new Error('Sign-in timed out'));
      const { fixture, el, navigate } = await create();
      const button = el.querySelector<HTMLButtonElement>('.desktop-google-btn')!;

      button.click();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(el.querySelector('.desktop-error')?.textContent).toContain('Try again');
      });
      expect(button.disabled).toBe(false);
      expect(auth.handleCredentialResponse).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    });

    it('shows an error when the server rejects the credential', async () => {
      signInWithGoogle.mockResolvedValue('google-id-token');
      auth.handleCredentialResponse.mockRejectedValue(new Error('401'));
      const { fixture, el, navigate } = await create();

      el.querySelector<HTMLButtonElement>('.desktop-google-btn')!.click();

      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(el.querySelector('.desktop-error')).not.toBeNull();
      });
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  describe('opened by the iOS app for sign-in', () => {
    const STATE = 'state_0123456789abcdef';
    let assign: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      assign = vi.fn();
      vi.spyOn(window, 'location', 'get').mockReturnValue({
        ...window.location,
        search: `?nativeCallback=quillai&nativeState=${STATE}`,
        assign,
      } as unknown as Location);
    });

    it('tells the user they are signing in for the app', async () => {
      const { el } = await create();
      expect(el.textContent).toContain('continue in the Quill AI app');
    });

    it('hands the credential back through the quillai:// scheme instead of signing in here', async () => {
      const { navigate } = await create();

      gsiConfig!.callback({ credential: 'google-id-token' });

      expect(assign).toHaveBeenCalledWith(`quillai://auth?state=${STATE}&credential=google-id-token`);
      expect(auth.handleCredentialResponse).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    });

    it.each([
      ['another app\'s scheme', `?nativeCallback=evilapp&nativeState=${STATE}`],
      ['a too-short state', '?nativeCallback=quillai&nativeState=abc'],
      ['a missing state', '?nativeCallback=quillai'],
    ])('ignores a handoff with %s and signs in normally', async (_label, search) => {
      vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, search, assign } as unknown as Location);
      const { el } = await create();

      gsiConfig!.callback({ credential: 'google-id-token' });

      await vi.waitFor(() => expect(auth.handleCredentialResponse).toHaveBeenCalledWith('google-id-token'));
      expect(assign).not.toHaveBeenCalled();
      expect(el.textContent).not.toContain('continue in the Quill AI app');
    });
  });

  describe('inside the iOS app', () => {
    let signInWithGoogle: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      signInWithGoogle = vi.fn();
      win.quillNative = { platform: 'ios', signInWithGoogle, setSession: vi.fn() };
    });

    it('shows its own button instead of the blocked Google one', async () => {
      const { el } = await create();
      expect(el.querySelector('.desktop-google-btn')?.textContent).toContain('Sign in with Google');
      expect(renderButton).not.toHaveBeenCalled();
    });

    it('signs in with the credential from the auth sheet', async () => {
      signInWithGoogle.mockResolvedValue('google-id-token');
      const { el, navigate } = await create();

      el.querySelector<HTMLButtonElement>('.desktop-google-btn')!.click();

      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(['/series']));
      expect(auth.handleCredentialResponse).toHaveBeenCalledWith('google-id-token');
    });

    it('does not mention a browser while waiting', async () => {
      signInWithGoogle.mockReturnValue(new Promise(() => {}));
      const { fixture, el } = await create();
      const button = el.querySelector<HTMLButtonElement>('.desktop-google-btn')!;
      button.click();
      fixture.detectChanges();
      expect(button.textContent).toContain('Finishing sign-in');
    });
  });
});
