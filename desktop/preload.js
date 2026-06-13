// Bridges the settings window to the main process over a narrow, safe surface.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('s1r', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  installPanel: () => ipcRenderer.invoke('install-panel'),
  restartBackend: () => ipcRenderer.invoke('restart-backend'),
  onInstallResult: (cb) => ipcRenderer.on('install-result', (_e, r) => cb(r)),
});
