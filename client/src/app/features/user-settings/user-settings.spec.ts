import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { UserSettingsService } from '@app/core/services/user-settings.service';
import { HeaderService } from '@app/core/services/header.service';
import { AppUpdateService } from '@app/core/services/app-update.service';
import { ContentFilterService } from './content-filter.service';
import { UserSettingsComponent } from './user-settings';

/** Any member read off it is a no-op function, which covers both signals and methods. */
function stubService<T>(): T {
  return new Proxy({}, { get: () => () => undefined }) as T;
}

describe('UserSettingsComponent app update', () => {
  let forceUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    forceUpdate = vi.fn().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: UserSettingsService, useValue: stubService<UserSettingsService>() },
        { provide: HeaderService, useValue: stubService<HeaderService>() },
        { provide: ContentFilterService, useValue: stubService<ContentFilterService>() },
        { provide: MatSnackBar, useValue: stubService<MatSnackBar>() },
        { provide: AppUpdateService, useValue: { forceUpdate } },
      ],
    });
  });

  it('forces the update once and shows it is under way', () => {
    const cmp = TestBed.createComponent(UserSettingsComponent).componentInstance;
    expect(cmp.updatingApp()).toBe(false);

    cmp.updateApp();
    cmp.updateApp();

    expect(cmp.updatingApp()).toBe(true);
    expect(forceUpdate).toHaveBeenCalledTimes(1);
  });
});
