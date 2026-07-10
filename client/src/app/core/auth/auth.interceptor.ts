import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const token = auth.idToken;

  if (token && req.url.startsWith('/api')) {
    const authed = req.clone({
      setHeaders: { Authorization: `Bearer ${token}` },
    });
    return next(authed);
  }
  return next(req);
};

// Auth endpoints handle their own errors; refreshing in response to their 401s
// would loop. Everything else under /api is a candidate for refresh-and-retry.
const isAuthEndpoint = (url: string) => url.startsWith('/api/auth/');

/**
 * On a 401 from an authenticated API call, transparently refresh the access
 * token and retry the original request once. If the refresh itself fails, the
 * session is unrecoverable, so notify the user and send them to /login.
 */
export const authErrorInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);

  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status !== 401 || !req.url.startsWith('/api') || isAuthEndpoint(req.url)) {
        return throwError(() => err);
      }

      return auth.refreshAccessToken().pipe(
        switchMap(newToken =>
          next(req.clone({ setHeaders: { Authorization: `Bearer ${newToken}` } }))
        ),
        catchError(refreshErr => {
          auth.handleSessionExpired();
          return throwError(() => refreshErr);
        })
      );
    })
  );
};
