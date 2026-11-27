const { ipcMain, dialog, app, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const runCrawler = require('./crawler');
const { loadTemplateSteps, findTemplateInScreenshot } = require('./image-flow');
const { fetchAmigoDemoLinks } = require('./amigo-demo-link');
const { fetchVaDemoLinks } = require('./va-demo-link');
const { findAmigoGame } = require('./games');
const { findVaGame } = require('./va-games');

// =========================
// 全局 crawler 管理
// =========================
global.crawlerInstances = global.crawlerInstances || [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runPool(
  urls,
  concurrency,
  baseDir,
  splitByWindow = true,
  apiPatterns = [],
  gameType = 'generic',
  gameId = ''
) {
  const queue = [...urls];
  const limit = Math.max(1, Number(concurrency) || 1);
  let nextInstanceIndex = 0;

  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      const instanceIndex = ++nextInstanceIndex;
      const perGameId = /^\d+$/.test(String(url).trim())
        ? String(url).trim()
        : gameId;
      const instance = await runCrawler(
        url,
        baseDir,
        instanceIndex,
        splitByWindow,
        apiPatterns,
        gameType,
        perGameId
      );

      global.crawlerInstances.push(instance);

      await sleep(1200);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    () => worker()
  );

  await Promise.all(workers);
}

/**
 * Amigo：逐个取链 → 打开窗口（严格串行，不批量预取）
 */
async function runAmigoSequential({
  gameId,
  windowCount = 3,
  urls = [],
  baseDir,
  splitByWindow = true,
  apiPatterns = [],
  regionClick = null
}) {
  const id = String(gameId || '').trim();
  const manual = (urls || []).map(u => String(u).trim()).filter(Boolean);

  if (manual.length) {
    const game = id ? findAmigoGame(id) : null;
    console.log(
      `AMIGO MANUAL: ${manual.length} 个链接${id ? ', gameId=' + id + (game ? ' (' + game.label + ')' : '') : ''}`
    );
    for (let i = 0; i < manual.length; i++) {
      console.log(`AMIGO: [${i + 1}/${manual.length}] 打开手动链接`, manual[i]);
      const instance = await runCrawler(
        manual[i],
        baseDir,
        i + 1,
        splitByWindow,
        apiPatterns,
        'amigo',
        id,
        regionClick,
        true
      );
      global.crawlerInstances.push(instance);
      await sleep(1200);
    }
    return;
  }

  if (!id) throw new Error('Amigo gameId 为空');

  const count = Math.max(1, Number(windowCount) || 3);
  const game = findAmigoGame(id);
  console.log(
    `AMIGO SEQUENTIAL: gameId=${id}${game ? ' (' + game.label + ')' : ''}, windows=${count}`
  );

  let opened = 0;
  let lastErr = null;
  const amigoSession = {};
  for (let i = 0; i < count; i++) {
    let instance = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(
          `AMIGO: [${i + 1}/${count}] 取链并打开` +
            (attempt > 1 ? `（重试 ${attempt}/2）` : '')
        );
        const links = await fetchAmigoDemoLinks(id, 1, {
          sessionType: 'mobile',
          session: amigoSession
        });
        const link = links[0];
        console.log(`AMIGO: [${i + 1}/${count}] 打开窗口`, link);
        instance = await runCrawler(
          link,
          baseDir,
          i + 1,
          splitByWindow,
          apiPatterns,
          'amigo',
          id,
          regionClick
        );
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        console.log(
          `AMIGO: [${i + 1}/${count}] 启动失败:`,
          e && e.message ? e.message : e
        );
        if (attempt < 2) await sleep(1000 * attempt);
      }
    }
    if (instance) {
      global.crawlerInstances.push(instance);
      opened++;
      await sleep(1200);
    }
  }
  if (!opened) {
    throw lastErr || new Error('Amigo 窗口全部启动失败');
  }
  if (opened < count) {
    console.log(`AMIGO: 已打开 ${opened}/${count} 个窗口，其余启动失败`);
  }
}

/**
 * VA：官网 getGameLink 逐个取链 → 打开窗口
 */
async function runVaSequential({
  gameId,
  windowCount = 3,
  urls = [],
  baseDir,
  splitByWindow = true,
  apiPatterns = []
}) {
  const id = String(gameId || '').trim();
  const manual = (urls || []).map(u => String(u).trim()).filter(Boolean);

  if (manual.length) {
    const game = id ? findVaGame(id) : null;
    console.log(
      `VA MANUAL: ${manual.length} 个链接${id ? ', gameId=' + id + (game ? ' (' + game.label + ')' : '') : ''}`
    );
    for (let i = 0; i < manual.length; i++) {
      console.log(`VA: [${i + 1}/${manual.length}] 打开手动链接`, manual[i]);
      const instance = await runCrawler(
        manual[i],
        baseDir,
        i + 1,
        splitByWindow,
        apiPatterns,
        'va',
        id
      );
      global.crawlerInstances.push(instance);
      await sleep(1200);
    }
    return;
  }

  if (!id) throw new Error('VA gameId 为空');

  const count = Math.max(1, Number(windowCount) || 3);
  const game = findVaGame(id);
  console.log(
    `VA SEQUENTIAL: gameId=${id}${game ? ' (' + game.label + ')' : ''}, windows=${count}`
  );

  for (let i = 0; i < count; i++) {
    console.log(`VA: [${i + 1}/${count}] 取链并打开`);
    const links = await fetchVaDemoLinks(id, 1);
    const link = links[0];
    console.log(`VA: [${i + 1}/${count}] 打开窗口`, link);
    const instance = await runCrawler(
      link,
      baseDir,
      i + 1,
      splitByWindow,
      apiPatterns,
      'va',
      id
    );
    global.crawlerInstances.push(instance);
    await sleep(1200);
  }
}

ipcMain.handle('fetch-demo-links', async (e, { type, gameId, count } = {}) => {
  try {
    const id = String(gameId || '').trim();
    if (!id) return { ok: false, message: '请选择游戏' };
    const n = Math.max(1, Math.min(20, Number(count) || 1));
    const kind = String(type || '').toLowerCase();
    if (kind === 'va') {
      const links = await fetchVaDemoLinks(id, n);
      return { ok: true, links };
    }
    if (kind !== 'amigo') {
      return { ok: false, message: '平台只支持 Amigo 或 VA' };
    }
    const links = await fetchAmigoDemoLinks(id, n, { sessionType: 'mobile' });
    return { ok: true, links };
  } catch (err) {
    return { ok: false, message: err.message || '取链失败' };
  }
});

ipcMain.handle('save-amigo-games', async (e, list) => {
  if (!Array.isArray(list)) return { ok: false, message: '游戏列表无效' };
  const filePath = path.join(__dirname, 'games.js');
  const body =
    'const amigoGameList = ' +
    JSON.stringify(list, null, 2) +
    ';\n\n' +
    'function findAmigoGame(gameId) {\n' +
    "  const id = String(gameId || '').trim();\n" +
    '  return amigoGameList.find(g => String(g.id) === id) || null;\n' +
    '}\n\n' +
    'module.exports = {\n' +
    '  amigoGameList,\n' +
    '  findAmigoGame\n' +
    '};\n';
  try {
    fs.writeFileSync(filePath, body, 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, message: err.message || '写入 games.js 失败' };
  }
});

ipcMain.handle('export-amigo-click', async (e, payload) => {
  const res = await dialog.showSaveDialog({
    title: '导出点击区域预设',
    defaultPath: 'amigo-click-presets.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(res.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, message: err.message || '导出失败' };
  }
});

ipcMain.handle('import-amigo-click', async () => {
  const res = await dialog.showOpenDialog({
    title: '导入点击区域预设',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  try {
    const text = fs.readFileSync(res.filePaths[0], 'utf8');
    const data = JSON.parse(text);
    return { ok: true, data, path: res.filePaths[0] };
  } catch (err) {
    return { ok: false, message: err.message || '导入失败' };
  }
});

ipcMain.handle('update-region-click', async (e, data) => {
  const instances = global.crawlerInstances || [];
  instances.forEach(item => {
    if (item && typeof item.updateRegionClick === 'function') {
      item.updateRegionClick(data);
    }
  });
  return { ok: true };
});

// =========================
// 开始全部自动点击
// =========================
ipcMain.handle('start-click-all', async (e, {
  x,
  y,
  interval,
  mode3,
  clickCount,
  steps,
  imageInterval,
  imageThreshold,
  imageMode,
  imageEngine,
  imageMaxRetries
}) => {
  try {
    if (!global.crawlerInstances.length) {
      await dialog.showMessageBox({
        type: 'error',
        title: '错误',
        message: '无可用窗口'
      });

      return {
        ok: false,
        message: '无可用窗口'
      };
    }

    if (mode3 && (!steps || !steps.length)) {
      return { ok: false, message: '模式三需要至少一个图像识别步骤' };
    }

    const onLog = (msg) => {
      try {
        if (e.sender && !e.sender.isDestroyed()) {
          e.sender.send('image-flow-log', msg);
        }
      } catch (err) { }
    };

    global.crawlerInstances.forEach((item, i) => {
      if (!item) return;
      // 先停掉可能在跑的其它模式
      if (typeof item.stopCombinedFlow === 'function') item.stopCombinedFlow();
      if (typeof item.stopImageFlow === 'function') item.stopImageFlow();
      if (typeof item.stopAutoClick === 'function') item.stopAutoClick();

      if (mode3 && typeof item.startCombinedFlow === 'function') {
        const tag = `窗口${i + 1}`;
        item.startCombinedFlow({
          clickOpts: { xPercent: x, yPercent: y, interval },
          clickCount,
          steps,
          imageOptions: {
            interval: imageInterval,
            threshold: imageThreshold,
            mode: imageMode,
            engine: imageEngine === 'legacy' ? 'legacy' : 'opencv',
            maxRetries: imageMaxRetries,
            startDelay: i * 400
          },
          onLog: (msg) => onLog(`[${tag}] ${msg}`)
        });
      } else if (typeof item.startAutoClick === 'function') {
        setTimeout(() => item.startAutoClick(x, y, interval), i * 80);
      }
    });

    return {
      ok: true
    };
  } catch (err) {
    console.error('start-click-all error:', err);

    return {
      ok: false,
      message: err.message || '启动自动点击失败'
    };
  }
});

// =========================
// 停止全部自动点击
// =========================
ipcMain.handle('stop-click-all', async () => {
  try {
    for (const item of global.crawlerInstances) {
      if (item && typeof item.stopCombinedFlow === 'function') {
        item.stopCombinedFlow();
      }
      if (item && typeof item.stopAutoClick === 'function') {
        item.stopAutoClick();
      }
    }

    return {
      ok: true
    };
  } catch (err) {
    console.error('stop-click-all error:', err);

    return {
      ok: false,
      message: err.message || '停止自动点击失败'
    };
  }
});

// =========================
// 图像识别流程
// =========================
ipcMain.handle('select-image-file', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
    ]
  });

  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('start-image-flow-all', async (e, {
  steps,
  interval,
  threshold,
  mode,
  engine,
  maxRetries
}) => {
  try {
    if (!global.crawlerInstances.length) {
      await dialog.showMessageBox({
        type: 'error',
        title: '错误',
        message: '无可用窗口，请先开始抓取'
      });
      return { ok: false, message: '无可用窗口' };
    }

    if (!steps || !steps.length) {
      return { ok: false, message: '请至少添加一个识别步骤' };
    }

    const onLog = (msg) => {
      try {
        if (e.sender && !e.sender.isDestroyed()) {
          e.sender.send('image-flow-log', msg);
        }
      } catch (err) { }
    };

    global.crawlerInstances.forEach((item, i) => {
      if (item && typeof item.stopCombinedFlow === 'function') {
        item.stopCombinedFlow();
      }
      if (item && typeof item.stopAutoClick === 'function') {
        item.stopAutoClick();
      }
      if (item && typeof item.startImageFlow === 'function') {
        const tag = `窗口${i + 1}`;
        item.startImageFlow(steps, {
          interval,
          threshold,
          mode,
          engine: engine === 'legacy' ? 'legacy' : 'opencv',
          maxRetries,
          startDelay: i * 400,
          onLog: (msg) => onLog(`[${tag}] ${msg}`)
        });
      }
    });

    return { ok: true, total: steps.length };
  } catch (err) {
    console.error('start-image-flow-all error:', err);
    return {
      ok: false,
      message: err.message || '启动图像识别流程失败'
    };
  }
});

ipcMain.handle('stop-image-flow-all', async () => {
  try {
    for (const item of global.crawlerInstances) {
      if (item && typeof item.stopCombinedFlow === 'function') {
        item.stopCombinedFlow();
      }
      if (item && typeof item.stopImageFlow === 'function') {
        item.stopImageFlow();
      }
    }

    return { ok: true };
  } catch (err) {
    console.error('stop-image-flow-all error:', err);
    return {
      ok: false,
      message: err.message || '停止图像识别流程失败'
    };
  }
});

// =========================
// 检测当前画面里模板的最佳匹配得分（用于自动填入匹配阈值）
// =========================
ipcMain.handle('detect-threshold', async (e, { steps, engine } = {}) => {
  try {
    if (!global.crawlerInstances.length) {
      return { ok: false, message: '无可用窗口，请先开始抓取' };
    }
    if (!steps || !steps.length) {
      return { ok: false, message: '请至少添加一个识别步骤' };
    }

    const matchEngine = engine === 'legacy' ? 'legacy' : 'opencv';
    const templates = await loadTemplateSteps(steps, { engine: matchEngine });
    const options = {
      engine: matchEngine,
      threshold: 2,
      tolerance: 40,
      scanStep: 3
    };

    let bestScore = 0;
    let bestName = '';
    const perStep = {};

    for (const item of global.crawlerInstances) {
      const page = item && item.page;
      if (!page || page.isClosed()) continue;

      const buffer = await page.screenshot({ type: 'png' });

      for (const tpl of templates) {
        const m = await findTemplateInScreenshot(buffer, tpl, options);
        const score = m.score || 0;
        if (!(tpl.name in perStep) || score > perStep[tpl.name]) {
          perStep[tpl.name] = score;
        }
        if (score > bestScore) {
          bestScore = score;
          bestName = tpl.name;
        }
      }
    }

    return {
      ok: true,
      bestScore,
      bestName,
      perStep,
      engine: matchEngine
    };
  } catch (err) {
    console.error('detect-threshold error:', err);
    return {
      ok: false,
      message: err.message || '检测失败'
    };
  }
});

// =========================
// 保存所有窗口当前截图（用于裁剪精准模板）
// =========================
ipcMain.handle('list-resource-windows', async () => {
  const instances = global.crawlerInstances || [];
  const windows = [];
  instances.forEach((item, i) => {
    if (!item || typeof item.downloadStaticResources !== 'function') return;
    const info = typeof item.getResourceInfo === 'function'
      ? item.getResourceInfo()
      : {};
    windows.push({
      index: i,
      label: `窗口${i + 1}`,
      url: info.url || '',
      count: Number(info.count) || 0
    });
  });
  return { ok: true, windows };
});

ipcMain.handle('download-static-resources', async (e, {
  windowIndexes,
  saveDir
} = {}) => {
  try {
    if (!saveDir || !String(saveDir).trim()) {
      return { ok: false, message: '请选择存储位置' };
    }
    const destRoot = String(saveDir).trim();
    const onLog = (msg) => {
      try {
        if (e.sender && !e.sender.isDestroyed()) {
          e.sender.send('image-flow-log', msg);
        }
      } catch (_) { }
    };

    const instances = global.crawlerInstances || [];
    const indexes = (Array.isArray(windowIndexes) ? windowIndexes : [])
      .map(n => Number(n))
      .filter(n => Number.isInteger(n) && n >= 0 && n < instances.length);

    const totals = { saved: 0, skipped: 0, failed: 0, lists: 0, dir: destRoot };

    if (indexes.length) {
      const multi = indexes.length > 1;
      for (const i of indexes) {
        const item = instances[i];
        if (!item || typeof item.downloadStaticResources !== 'function') continue;
        const dest = multi ? path.join(destRoot, `window_${i + 1}`) : destRoot;
        const tag = `窗口${i + 1}`;
        const r = await item.downloadStaticResources({
          saveDir: dest,
          onLog: (msg) => onLog(`[${tag}] ${msg}`)
        });
        totals.saved += r.saved || 0;
        totals.skipped += r.skipped || 0;
        totals.failed += r.failed || 0;
        totals.lists += 1;
      }
      if (!totals.lists) {
        return { ok: false, message: '所选窗口不可用' };
      }
      return { ok: true, ...totals };
    }

    return { ok: false, message: '没有可下载的窗口。请先开始抓取' };
  } catch (err) {
    console.error('download-static-resources error:', err);
    return {
      ok: false,
      message: err.message || '下载静态资源失败'
    };
  }
});

ipcMain.handle('capture-screenshots', async (e, { dir } = {}) => {
  try {
    if (!global.crawlerInstances.length) {
      await dialog.showMessageBox({
        type: 'error',
        title: '错误',
        message: '无可用窗口，请先开始抓取'
      });
      return { ok: false, message: '无可用窗口' };
    }

    const baseDir = dir && dir.trim()
      ? dir
      : app.getPath('pictures');
    const outDir = path.join(baseDir, 'window-screenshots');
    fs.mkdirSync(outDir, { recursive: true });

    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .slice(0, 19);

    const saved = [];
    for (let i = 0; i < global.crawlerInstances.length; i++) {
      const item = global.crawlerInstances[i];
      const page = item && item.page;
      if (!page || page.isClosed()) continue;

      const filePath = path.join(outDir, `window-${i + 1}-${stamp}.png`);
      const buffer = await page.screenshot({ type: 'png' });
      fs.writeFileSync(filePath, buffer);
      saved.push(filePath);
    }

    if (saved.length) {
      shell.openPath(outDir);
    }

    return { ok: true, count: saved.length, dir: outDir, files: saved };
  } catch (err) {
    console.error('capture-screenshots error:', err);
    return {
      ok: false,
      message: err.message || '保存截图失败'
    };
  }
});

ipcMain.handle('reload-all-windows', async () => {
  const instances = global.crawlerInstances || [];
  const pages = instances
    .map(item => item && item.page)
    .filter(page => page && !page.isClosed());
  if (!pages.length) {
    return { ok: false, message: '当前没有可刷新的窗口' };
  }
  const results = await Promise.all(pages.map(async page => {
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
      return true;
    } catch (err) {
      console.error('reload window error:', err);
      return false;
    }
  }));
  const reloaded = results.filter(Boolean).length;
  return {
    ok: reloaded > 0,
    reloaded,
    failed: results.length - reloaded,
    message: reloaded ? '' : '刷新失败'
  };
});

// =========================
// 一次性关闭所有窗口
// =========================
ipcMain.handle('close-all-windows', async () => {
  try {
    if (!global.crawlerInstances.length) {
      await dialog.showMessageBox({
        type: 'info',
        title: '提示',
        message: '当前没有可关闭的窗口'
      });
      return {
        ok: false,
        message: '当前没有可关闭的窗口'
      };
    }
    const instances = [...global.crawlerInstances];
    for (const item of instances) {
      await closeCrawlerInstance(item);
    }
    global.crawlerInstances = [];
    return {
      ok: true,
      closed: instances.length
    };
  } catch (err) {
    console.error('close-all-windows error:', err);
    return {
      ok: false,
      message: err.message || '关闭所有窗口失败'
    };
  }
});

async function closeCrawlerInstance(item) {
  if (!item) return;
  if (typeof item.stopCombinedFlow === 'function') {
    item.stopCombinedFlow();
  }
  if (typeof item.stopImageFlow === 'function') {
    item.stopImageFlow();
  }
  if (typeof item.stopRegionClick === 'function') {
    item.stopRegionClick();
  }
  if (typeof item.stopAutoClick === 'function') {
    item.stopAutoClick();
  }
  if (typeof item.close === 'function') {
    await item.close();
    return;
  }
  if (item.window && typeof item.window.close === 'function') {
    item.window.close();
    return;
  }
  if (item.browser && typeof item.browser.close === 'function') {
    await item.browser.close();
    return;
  }
  if (item.page && typeof item.page.close === 'function') {
    await item.page.close();
  }
}
module.exports = async function ({
  urls,
  dir,
  concurrency,
  splitByWindow = true,
  apiPatterns = [],
  gameType = 'generic',
  gameId = '',
  windowCount = 3,
  crawlMode = 'normal',
  regionClick = null
}) {
  console.log('CRAWL MODE:', crawlMode);
  console.log('SPLIT BY WINDOW:', splitByWindow);
  console.log('API PATTERNS:', apiPatterns);
  console.log('GAME TYPE:', gameType);
  console.log('GAME ID:', gameId || '(none)');

  if (crawlMode === 'amigo' || (gameType === 'amigo' && gameId)) {
    await runAmigoSequential({
      gameId,
      windowCount,
      urls,
      baseDir: dir,
      splitByWindow,
      apiPatterns,
      regionClick
    });
  } else if (crawlMode === 'va' || (gameType === 'va' && gameId)) {
    await runVaSequential({
      gameId,
      windowCount,
      urls,
      baseDir: dir,
      splitByWindow,
      apiPatterns
    });
  } else {
    console.log('TOTAL:', urls.length);
    await runPool(
      urls,
      concurrency,
      dir,
      splitByWindow,
      apiPatterns,
      gameType || 'generic',
      gameId
    );
  }

  console.log('ALL DONE');

  return {
    ok: true,
    total: crawlMode === 'amigo' || crawlMode === 'va'
      ? ((urls && urls.length) ? urls.length : (Number(windowCount) || 3))
      : urls.length
  };
};