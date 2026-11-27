const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const runMultiCrawler = require('./runner');
const SETTINGS_FILE = path.join(__dirname, 'bk-settings.json');
const LAUNCH_FILE = path.join(__dirname, 'launch-job.json');
const DEFAULT_UPDATE_BASE = 'http://192.168.10.119:5889/';

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
  const next = { ...prev };
  if (data && Object.prototype.hasOwnProperty.call(data, 'dir')) {
    const dir = String(data.dir || '').trim();
    next.dir = dir || prev.dir || '';
  }
  if (data && Object.prototype.hasOwnProperty.call(data, 'updateBaseUrl')) {
    next.updateBaseUrl = String(data.updateBaseUrl || '').trim();
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
});

function updatePackagePath() {
  const version = app.getVersion();
  if (process.platform === 'win32') {
    const fileName = `BK Game Tool Setup ${version}.exe`;
    return { fileName, rel: `安装包/windows/${fileName}` };
  }
  if (process.platform === 'darwin') {
    const fileName = `BK Game Tool-${version}.dmg`;
    return { fileName, rel: `安装包/mac/${fileName}` };
  }
  throw new Error('当前系统不支持一键更新，仅支持 Windows 和 macOS');
}

function buildUpdateUrl(baseUrl) {
  const { fileName, rel } = updatePackagePath();
  let base = String(baseUrl || '').trim() || DEFAULT_UPDATE_BASE;
  if (!/^https?:\/\//i.test(base)) {
    throw new Error('更新地址需要以 http:// 或 https:// 开头');
  }
  base = base.replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('path', rel);
  return { url: `${base}/api/download?${params.toString()}`, fileName };
}

function downloadToFile(url, dest, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let lib;
    try {
      lib = new URL(url).protocol === 'https:' ? https : http;
    } catch (err) {
      reject(err);
      return;
    }
    const req = lib.get(url, res => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('下载重定向次数过多'));
          return;
        }
        const next = new URL(res.headers.location, url).href;
        downloadToFile(next, dest, onProgress, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          let message = `下载失败 HTTP ${code}`;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (body && body.error) message = body.error;
          } catch (_) { }
          reject(new Error(message));
        });
        return;
      }
      const contentType = String(res.headers['content-type'] || '');
      if (contentType.includes('text/html') || contentType.includes('application/json')) {
        res.resume();
        reject(new Error('下载地址返回的不是安装包'));
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      let lastTick = 0;
      const file = fs.createWriteStream(dest);
      res.on('data', chunk => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastTick > 300) {
          lastTick = now;
          onProgress(received, total);
        }
      });
      res.on('error', err => {
        file.destroy();
        reject(err);
      });
      file.on('error', err => {
        res.destroy();
        reject(err);
      });
      file.on('finish', () => {
        onProgress(received, total);
        resolve(received);
      });
      res.pipe(file);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('下载超时')));
  });
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function scheduleInstall(dest) {
  const tempDir = app.getPath('temp');
  if (process.platform === 'win32') {
    const bat = path.join(tempDir, 'bk-game-tool-update.bat');
    fs.writeFileSync(
      bat,
      `@echo off\r\nping 127.0.0.1 -n 3 >nul\r\nstart "" "${dest}"\r\n`,
      'utf8'
    );
    spawn('cmd.exe', ['/d', '/c', bat], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref();
    return;
  }
  const sh = path.join(tempDir, 'bk-game-tool-update.sh');
  const script = [
    '#!/bin/bash',
    'sleep 2',
    'DMG=' + shQuote(dest),
    'ATTACH=$(hdiutil attach -nobrowse -noverify "$DMG" 2>&1) || { open "$DMG"; exit 0; }',
    "MOUNT=$(printf '%s\\n' \"$ATTACH\" | sed -n 's/.*\\(\\/Volumes\\/.*\\)/\\1/p' | tail -n 1)",
    'if [ -z "$MOUNT" ]; then open "$DMG"; exit 0; fi',
    "APP=$(find \"$MOUNT\" -maxdepth 2 -name '*.app' -print -quit)",
    'if [ -z "$APP" ]; then open "$MOUNT"; exit 0; fi',
    'NAME=$(basename "$APP")',
    'rm -rf "/Applications/$NAME"',
    'if cp -R "$APP" /Applications/; then',
    '  hdiutil detach "$MOUNT" -quiet || true',
    '  open "/Applications/$NAME"',
    'else',
    '  open "$MOUNT"',
    'fi',
    ''
  ].join('\n');
  fs.writeFileSync(sh, script, { mode: 0o755 });
  spawn('/bin/bash', [sh], { detached: true, stdio: 'ignore' }).unref();
}

let updateInProgress = false;

ipcMain.handle('app-update', async (event, data) => {
  if (updateInProgress) return { ok: false, message: '正在更新，请稍候' };
  updateInProgress = true;
  const send = (payload) => {
    try {
      if (event.sender && !event.sender.isDestroyed()) {
        event.sender.send('app-update-progress', payload);
      }
    } catch (_) { }
  };
  try {
    const { url, fileName } = buildUpdateUrl(data && data.baseUrl);
    const dest = path.join(app.getPath('temp'), fileName);
    send({ phase: 'start', url, fileName });
    const size = await downloadToFile(url, dest, (received, total) => {
      send({ phase: 'download', received, total });
    });
    if (!size) throw new Error('下载到的安装包是空文件');
    scheduleInstall(dest);
    send({ phase: 'install', fileName });
    setTimeout(() => app.quit(), 800);
    return { ok: true, message: `已下载 ${fileName}，即将安装并退出` };
  } catch (err) {
    updateInProgress = false;
    return { ok: false, message: err.message || '更新失败' };
  }
});

function consumeLaunchJob() {
  const files = [
    path.join(process.env.LOCALAPPDATA || '', 'templates-manager', 'launch-job.json'),
    LAUNCH_FILE,
  ];
  for (const file of files) {
    try {
      const job = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.unlinkSync(file);
      return job;
    } catch {
      // 这份不存在或还没写完，继续看下一份
    }
  }
  return null;
}

ipcMain.handle('consume-launch-job', () => consumeLaunchJob());

ipcMain.handle('start-multi', async (event, data) => {
  await runMultiCrawler(data);
});