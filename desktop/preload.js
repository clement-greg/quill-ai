// Exposes the few desktop-only capabilities the Angular client needs. The client
// feature-detects `window.quillDesktop` to know it is running inside Electron.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quillDesktop', {
  /** Runs Google Sign-In in the system browser and resolves with the Google ID token. */
  signInWithGoogle: () => ipcRenderer.invoke('google-sign-in'),
});
