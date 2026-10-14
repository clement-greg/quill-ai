// Electron shell for Quill AI.
//
// Where the window points:
//   - QUILL_URL, when set (e.g. http://localhost:6258 for `npm run dev`).
//   - Installed builds: the hosted site (`quill.hostedUrl` in package.json).
//     Installers carry no server and no secrets.
//   - Run from the repo: boots the compiled Express server
//     (../dist/server/index.js) in a utility process with ../_private/config.json.

const { app, BrowserWindow, shell, utilityProcess, Menu, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { signInWithGoogle } = require('./google-sign-in');

const { quill } = require('./package.json');

const ROOT = path.join(__dirname, '..');
// Google Sign-In only accepts origins registered on the OAuth client, so the
// port is fixed rather than picked at random.
const PORT = Number(process.env.QUILL_PORT || 3200);
const USE_LOCAL_SERVER = !process.env.QUILL_URL && !app.isPackaged;
const APP_URL = process.env.QUILL_URL || (app.isPackaged ? quill.hostedUrl : `http://localhost:${PORT}`);
const ORIGIN = new URL(APP_URL).origin;

let server = null;
let mainWindow = null;

function startServer() {
  const entry = path.join(ROOT, 'dist', 'server', 'index.js');
  const clientIndex = path.join(ROOT, 'client', 'dist', 'client', 'browser', 'index.html');
  for (const required of [entry, clientIndex]) {
    if (!fs.existsSync(required)) {
      throw new Error(`Missing ${path.relative(ROOT, required)} — run \`npm run build\` first.`);
    }
  }

  const env = { ...process.env, PORT: String(PORT) };
  const localConfig = path.join(ROOT, '_private', 'config.json');
  if (!env.QUILL_CONFIG_PATH && fs.existsSync(localConfig)) env.QUILL_CONFIG_PATH = localConfig;

  server = utilityProcess.fork(entry, [], { env, cwd: ROOT, stdio: 'inherit', serviceName: 'Quill AI Server' });
  server.on('exit', (code) => {
    server = null;
    if (!app.isQuitting) {
      console.error(`[electron] server exited with code ${code}`);
      app.quit();
    }
  });
}

/** Polls the public /api/hello route until the server answers (cosmos init can take a few seconds). */
function waitForServer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(`${ORIGIN}/api/hello`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error(`Server did not start on ${ORIGIN}`));
      else setTimeout(attempt, 300);
    };
    attempt();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Quill AI',
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(ORIGIN)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Links that navigate the main window off-site open in the default browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // A hosted-site outage or no network would otherwise leave a blank window.
  mainWindow.webContents.on('did-fail-load', (_event, code, _desc, url, isMainFrame) => {
    // -3 is ERR_ABORTED: a navigation superseded by another, not a failure.
    if (!isMainFrame || code === -3 || !url.startsWith(ORIGIN)) return;
    mainWindow.loadFile(path.join(__dirname, 'offline.html'), { query: { url: APP_URL } });
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => (mainWindow = null));
  mainWindow.loadURL(APP_URL);
}

app.setName('Quill AI');

// A second launch focuses the existing window instead of opening another.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

ipcMain.handle('google-sign-in', async () => {
  const credential = await signInWithGoogle(ORIGIN);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  app.focus({ steal: true });
  return credential;
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));

  // The PWA service worker would keep serving the previous build after a
  // rebuild, and buys nothing when the server is local, so start clean.
  await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });

  try {
    if (USE_LOCAL_SERVER) {
      startServer();
      await waitForServer();
    }
    createWindow();
  } catch (err) {
    console.error('[electron]', err.message);
    app.quit();
  }

  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  server?.kill();
});
