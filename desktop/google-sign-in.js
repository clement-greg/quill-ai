// Google refuses to sign users in from embedded browsers ("This browser or app
// may not be secure"), so the desktop app hands sign-in to the system browser.
//
// Flow: open <app origin>/login?desktopPort=…&desktopState=… in the default
// browser. That page runs the normal GSI button (the origin is already
// registered on the OAuth client) and, instead of signing itself in, form-POSTs
// the Google ID token to a one-shot listener on 127.0.0.1. The state value
// ties the callback to this request; the token itself is still verified by the
// server's /api/auth/login like any other sign-in.

const http = require('http');
const crypto = require('crypto');
const { shell } = require('electron');

const TIMEOUT_MS = 5 * 60 * 1000;

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Quill AI</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f5f2ea;color:#222">
<div style="text-align:center"><h1 style="font-weight:500">You're signed in</h1><p>You can close this tab and return to Quill AI.</p></div>
<script>setTimeout(() => window.close(), 1500)</script></body>`;

let cancelPending = null;

/** Resolves with a Google ID token once the user finishes signing in in their browser. */
function signInWithGoogle(appOrigin) {
  // A second click supersedes a sign-in the user abandoned in the browser.
  cancelPending?.(new Error('Superseded by a new sign-in attempt'));

  const state = crypto.randomBytes(24).toString('hex');

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) req.destroy();
      });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        if (form.get('state') !== state || !form.get('credential')) {
          res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Sign-in request did not match. Try again from Quill AI.');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE);
        finish(null, form.get('credential'));
      });
    });

    const timer = setTimeout(() => finish(new Error('Sign-in timed out')), TIMEOUT_MS);
    timer.unref();

    function finish(err, credential) {
      clearTimeout(timer);
      server.close();
      cancelPending = null;
      if (err) reject(err);
      else resolve(credential);
    }
    cancelPending = (err) => finish(err);

    server.on('error', (err) => finish(err));
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const url = new URL('/login', appOrigin);
      url.searchParams.set('desktopPort', String(port));
      url.searchParams.set('desktopState', state);
      shell.openExternal(url.toString());
    });
  });
}

module.exports = { signInWithGoogle };
