const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const runMultiCrawler = require('./runner');
const SETTINGS_FILE = path.join(__dirname, 'bk-settings.json');
const LAUNCH_FILE = path.join(__dirname, 'launch-job.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.loadFile('index.html');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('launch-job-ready');
  });
  app.whenReady().then(createWindow);
}

ipcMain.handle('select-folder', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });

  if (res.canceled) return null;
  return res.filePaths[0];
});

ipcMain.handle('get-bk-settings', () => readSettings());

ipcMain.handle('save-bk-settings', (_event, data) => {
  const prev = readSettings();
  const dir = String(data?.dir || '').trim();
  const next = { ...prev, dir: dir || prev.dir || '' };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
});

ipcMain.handle('consume-launch-job', () => {
  try {
    const job = JSON.parse(fs.readFileSync(LAUNCH_FILE, 'utf8'));
    fs.unlinkSync(LAUNCH_FILE);
    return job;
  } catch {
    return null;
  }
});

ipcMain.handle('start-multi', async (event, data) => {
  await runMultiCrawler(data);
});