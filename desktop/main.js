// startup1rit desktop — menu-bar app that runs the local color-grading backend
// so the Premiere panel works without a terminal.
//
// Responsibilities:
//   - fork the Express backend (server.js) with the user's API key + a writable
//     data dir (the packaged app bundle is read-only).
//   - menu-bar tray: status, settings, install the Premiere panel, quit.
//   - a small settings window for entering the Anthropic API key.

const { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { fork, exec } = require('child_process');

const USER_DATA = app.getPath('userData');
const CONFIG_PATH = path.join(USER_DATA, 'config.json');
const PORT = 3001;

let tray = null;
let settingsWin = null;
let server = null;

// ---------- backend location ----------

// Packaged: backend lives in Contents/Resources/backend. Dev: project root.
function backendDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(__dirname, '..');
}

// ---------- config ----------

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return { apiKey: '', model: 'claude-sonnet-4-6', ceiling: 10 };
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(USER_DATA, { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

function hasKey() {
  return !!(loadConfig().apiKey || '').trim();
}

// ---------- backend process ----------

function startServer() {
  stopServer();
  const cfg = loadConfig();
  const serverPath = path.join(backendDir(), 'server.js');

  server = fork(serverPath, [], {
    cwd: backendDir(),
    env: Object.assign({}, process.env, {
      ELECTRON_RUN_AS_NODE: '1',
      ACA_DATA_DIR: USER_DATA,
      ANTHROPIC_API_KEY: cfg.apiKey || '',
      ANTHROPIC_MODEL: cfg.model || 'claude-sonnet-4-6',
      WEEKLY_COST_CEILING_USD: String(cfg.ceiling || 10),
      PORT: String(PORT),
    }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  server.stdout.on('data', (d) => console.log('[backend]', String(d).trim()));
  server.stderr.on('data', (d) => console.error('[backend]', String(d).trim()));
  server.on('exit', () => { server = null; refreshTray(); });

  refreshTray();
}

function stopServer() {
  if (server) {
    server.removeAllListeners('exit');
    server.kill();
    server = null;
  }
}

function backendRunning() {
  return !!server;
}

// Probe the health endpoint (the fork being alive != listening yet).
function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 1500 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ---------- Premiere panel install ----------

function installPanel() {
  return new Promise((resolve) => {
    const script = path.join(backendDir(), 'premiere-plugin', 'install-mac.sh');
    if (!fs.existsSync(script)) {
      resolve({ ok: false, output: 'install-mac.sh not found at ' + script });
      return;
    }
    exec('bash ' + JSON.stringify(script), { timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: (stdout || '') + (stderr || '') });
    });
  });
}

// ---------- tray ----------

function refreshTray() {
  if (!tray) return;
  const running = backendRunning();
  tray.setTitle(running ? ' s1r ●' : ' s1r ○');
  tray.setToolTip('startup1rit — backend ' + (running ? 'running' : 'stopped'));

  const menu = Menu.buildFromTemplate([
    { label: running ? 'Backend: running' : 'Backend: stopped', enabled: false },
    { type: 'separator' },
    { label: 'Settings / API key…', click: openSettings },
    { label: 'Install Premiere panel', click: async () => {
        const r = await installPanel();
        openSettings();
        if (settingsWin) settingsWin.webContents.send('install-result', r);
      } },
    { label: running ? 'Restart backend' : 'Start backend', click: startServer },
    { type: 'separator' },
    { label: 'Open GitHub releases', click: () =>
        shell.openExternal('https://github.com/mattypark/startup1rit/releases') },
    { label: 'Quit', click: () => { stopServer(); app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  // Menu-bar text only — avoids shipping icon assets for now.
  tray = new Tray(nativeImage.createEmpty());
  refreshTray();
}

// ---------- settings window ----------

function openSettings() {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 460,
    height: 560,
    resizable: false,
    title: 'startup1rit',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ---------- ipc ----------

ipcMain.handle('get-state', async () => {
  const cfg = loadConfig();
  const health = await checkHealth();
  return {
    apiKey: cfg.apiKey || '',
    model: cfg.model || 'claude-sonnet-4-6',
    ceiling: cfg.ceiling || 10,
    running: backendRunning(),
    healthy: !!health,
    port: PORT,
  };
});

ipcMain.handle('save-config', async (_evt, cfg) => {
  const current = loadConfig();
  saveConfig({
    apiKey: typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : current.apiKey,
    model: cfg.model || current.model || 'claude-sonnet-4-6',
    ceiling: Number(cfg.ceiling) || current.ceiling || 10,
  });
  startServer();
  // give the listener a moment to bind
  await new Promise((r) => setTimeout(r, 600));
  return { ok: true, healthy: !!(await checkHealth()) };
});

ipcMain.handle('install-panel', async () => installPanel());

ipcMain.handle('restart-backend', async () => {
  startServer();
  await new Promise((r) => setTimeout(r, 600));
  return { ok: true, healthy: !!(await checkHealth()) };
});

// ---------- lifecycle ----------

app.whenReady().then(() => {
  if (app.dock) app.dock.hide(); // menu-bar app, no dock icon
  createTray();
  startServer();
  if (!hasKey()) openSettings(); // first run: prompt for the key
});

app.on('window-all-closed', (e) => {
  // Keep running in the menu bar even when the settings window closes.
  e.preventDefault();
});

app.on('before-quit', stopServer);
