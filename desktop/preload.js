// Exposes the few desktop-only capabilities the Angular client needs. The client
// feature-detects `window.quillDesktop` to know it is running inside Electron.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quillDesktop', {
  /** Runs Google Sign-In in the system browser and resolves with the Google ID token. */
  signInWithGoogle: () => ipcRenderer.invoke('google-sign-in'),

  /** Replaces the native menu bar's app-state-dependent content (see app-menu.js). */
  setMenuModel: (model) => ipcRenderer.send('menu-model', model),

  /** Subscribes to native menu clicks; returns an unsubscribe function. */
  onMenuCommand: (listener) => {
    const handler = (_event, command) => listener(command);
    ipcRenderer.on('menu-command', handler);
    return () => ipcRenderer.removeListener('menu-command', handler);
  },
});
