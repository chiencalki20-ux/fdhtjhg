const { Jimp } = require('jimp');

// 粗扫缩放：少档位，多窗口时避免 10 档全开把主进程打满
const SCALES = [0.75, 0.85, 1, 1.15, 1.3];
const MATCH_MAX_WIDTH = 1280;
const SCAN_CONCURRENCY = 1;

const scanWaiters = [];
let scanActive = 0;

function acquireScanSlot() {
  if (scanActive < SCAN_CONCURRENCY) {
    scanActive++;
    return Promise.resolve();
  }
  return new Promise(resolve => scanWaiters.push(resolve));
}

function releaseScanSlot() {
  const next = scanWaiters.shift();
  if (next) next();
  else scanActive = Math.max(0, scanActive - 1);
}

function prepareScreenForMatch(screen) {
  const sw = screen.bitmap.width;
  const sh = screen.bitmap.height;
  const down = sw > MATCH_MAX_WIDTH ? MATCH_MAX_WIDTH / sw : 1;
  if (down >= 1) return { screen, down: 1 };
  const resized = screen.clone().resize({
    w: Math.max(4, Math.round(sw * down)),
    h: Math.max(4, Math.round(sh * down))
  });
  return { screen: resized, down };
}

let _cv = null;
let _cvLoadError = null;

function getOpenCV() {
  if (_cv) return _cv;
  if (_cvLoadError) return null;
  try {
    _cv = require('opencv-wasm').cv;
    return _cv;
  } catch (e) {
    _cvLoadError = e;
    return null;
  }
}

function isOpenCVAvailable() {
  return !!getOpenCV();
}

/** 引擎保底：低于此分视为背景噪声，不能当命中 */
function engineScoreFloor(engine) {
  return engine === 'opencv' ? 0.75 : 0.64;
}

/**
 * 按本步骤最近几次扫描自动算阈值，无需手填。
 * 有背景分时：max(保底, 背景均值+0.22)；否则用保底。
 */
function autoThresholdFromScans(score, engine, recentScores) {
  const floor = engineScoreFloor(engine);
  const bg = recentScores.filter(s => s < floor);
  const bgAvg = bg.length ? bg.reduce((a, b) => a + b, 0) / bg.length : 0;
  const auto = Math.max(floor, bgAvg + 0.22);
  return Math.min(0.97, auto);
}

// =========================
// 旧模式：稀疏像素抽样 + RGB 色差
// =========================
function buildTemplateSamples(image, maxSamples = 400) {
  const { data, width, height } = image.bitmap;
  const total = width * height;
  const stride = Math.max(1, Math.floor(Math.sqrt(total / maxSamples)));

  const samples = [];
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const idx = (y * width + x) * 4;
      if (data[idx + 3] < 128) continue;
      samples.push({
        x,
        y,
        r: data[idx],
        g: data[idx + 1],
        b: data[idx + 2]
      });
    }
  }

  return samples;
}

function scoreAt(sdata, sw, samples, sx, sy, tol3) {
  let matched = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const idx = ((sy + s.y) * sw + (sx + s.x)) * 4;
    const diff =
      Math.abs(sdata[idx] - s.r) +
      Math.abs(sdata[idx + 1] - s.g) +
      Math.abs(sdata[idx + 2] - s.b);
    if (diff <= tol3) matched++;
  }
  return samples.length ? matched / samples.length : 0;
}

function buildVariant(image, scale) {
  const w = Math.max(4, Math.round(image.bitmap.width * scale));
  const h = Math.max(4, Math.round(image.bitmap.height * scale));
  const clone = image.clone().resize({ w, h });
  return { scale, width: w, height: h, samples: buildTemplateSamples(clone) };
}

async function scanVariant(screen, variant, tol3, step, region) {
  const { data: sdata, width: sw, height: sh } = screen.bitmap;
  const tw = variant.width;
  const th = variant.height;

  if (tw > sw || th > sh || !variant.samples.length) {
    return { score: 0, x: -1, y: -1 };
  }

  const x0 = region ? Math.max(0, region.x0) : 0;
  const y0 = region ? Math.max(0, region.y0) : 0;
  const x1 = region ? Math.min(sw - tw, region.x1) : sw - tw;
  const y1 = region ? Math.min(sh - th, region.y1) : sh - th;

  let best = { score: 0, x: -1, y: -1 };
  let rowCount = 0;

  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const score = scoreAt(sdata, sw, variant.samples, x, y, tol3);
      if (score > best.score) {
        best = { score, x, y };
      }
    }

    if ((++rowCount & 7) === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }

    if (best.score >= 0.99) break;
  }

  return best;
}

async function findBestMatchLegacy(screen, tpl, options) {
  const tol3 = options.tolerance * 3;
  const coarseStep = options.scanStep;

  let coarse = { score: 0, x: -1, y: -1, width: 0, height: 0, scale: 1 };

  for (const variant of tpl.variants) {
    const best = await scanVariant(screen, variant, tol3, coarseStep, null);
    if (best.score > coarse.score) {
      coarse = {
        score: best.score,
        x: best.x,
        y: best.y,
        width: variant.width,
        height: variant.height,
        scale: variant.scale
      };
    }
  }

  if (coarse.score < 0.4 || coarse.x < 0) {
    return coarse;
  }

  let best = coarse;
  const { width: sw, height: sh } = screen.bitmap;
  const fineScales = [];
  for (const f of [0.92, 0.96, 1.0, 1.04, 1.08]) {
    const s = coarse.scale * f;
    if (s > 0 && !fineScales.includes(s)) fineScales.push(s);
  }

  const range = coarseStep * 2 + 2;

  for (const fs of fineScales) {
    const variant = buildVariant(tpl.image, fs);
    if (variant.width > sw || variant.height > sh) continue;

    const region = {
      x0: coarse.x - range,
      y0: coarse.y - range,
      x1: coarse.x + range,
      y1: coarse.y + range
    };

    const r = await scanVariant(screen, variant, tol3, 1, region);
    if (r.score > best.score) {
      best = {
        score: r.score,
        x: r.x,
        y: r.y,
        width: variant.width,
        height: variant.height,
        scale: fs
      };
    }
  }

  return best;
}

// =========================
// OpenCV 模式：灰度 + matchTemplate (TM_CCOEFF_NORMED)
// =========================
function jimpToRgbaMat(cv, image) {
  const { data, width, height } = image.bitmap;
  const copy = new Uint8ClampedArray(data.length);
  copy.set(data);
  return cv.matFromImageData({ width, height, data: copy });
}

function releaseTemplateCv(tpl) {
  if (!tpl || !tpl.cvGray) return;
  for (const mat of tpl.cvGray.values()) {
    try { mat.delete(); } catch (_) { }
  }
  tpl.cvGray = null;
}

function getCachedTplGray(cv, tpl, w, h) {
  if (!tpl.cvGray) tpl.cvGray = new Map();
  const key = w + 'x' + h;
  const cached = tpl.cvGray.get(key);
  if (cached) return cached;
  const resized = tpl.image.clone().resize({ w, h });
  const rgba = jimpToRgbaMat(cv, resized);
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  rgba.delete();
  tpl.cvGray.set(key, gray);
  return gray;
}

function matchTemplateAtScale(cv, srcGray, tpl, scale) {
  const w = Math.max(4, Math.round(tpl.image.bitmap.width * scale));
  const h = Math.max(4, Math.round(tpl.image.bitmap.height * scale));
  if (w > srcGray.cols || h > srcGray.rows) {
    return { score: 0, x: -1, y: -1, width: w, height: h, scale };
  }

  const tplGray = getCachedTplGray(cv, tpl, w, h);
  const result = new cv.Mat();
  try {
    cv.matchTemplate(srcGray, tplGray, result, cv.TM_CCOEFF_NORMED);
    const mm = cv.minMaxLoc(result);
    const score = typeof mm.maxVal === 'number' ? mm.maxVal : 0;
    return {
      score: score > 0 ? score : 0,
      x: mm.maxLoc ? mm.maxLoc.x : -1,
      y: mm.maxLoc ? mm.maxLoc.y : -1,
      width: w,
      height: h,
      scale
    };
  } finally {
    result.delete();
  }
}

function scalesToTry(tpl, scaleMul) {
  const mul = scaleMul > 0 ? scaleMul : 1;
  if (tpl.lockScale > 0) {
    return [0.92, 0.96, 1, 1.04, 1.08]
      .map(f => tpl.lockScale * f * mul)
      .filter(s => s > 0);
  }
  return SCALES.map(s => s * mul);
}

async function findBestMatchOpenCV(screen, tpl, options) {
  const cv = getOpenCV();
  if (!cv) {
    if (tpl.variants && tpl.variants.length) {
      return findBestMatchLegacy(screen, tpl, options);
    }
    return { score: 0, x: -1, y: -1, width: 0, height: 0, scale: 1 };
  }

  const srcRgba = jimpToRgbaMat(cv, screen);
  const srcGray = new cv.Mat();

  try {
    cv.cvtColor(srcRgba, srcGray, cv.COLOR_RGBA2GRAY);

    let best = { score: 0, x: -1, y: -1, width: 0, height: 0, scale: 1 };
    const scales = scalesToTry(tpl, options.scaleMul || 1);
    for (const scale of scales) {
      const r = matchTemplateAtScale(cv, srcGray, tpl, scale);
      if (r.score > best.score) best = r;
      await new Promise(resolve => setImmediate(resolve));
      if (best.score >= 0.92) break;
    }

    // 未锁定缩放且粗扫不够稳时才精扫，少做几档
    if (!tpl.lockScale && best.score >= 0.35 && best.score < 0.90 && best.x >= 0) {
      for (const f of [0.92, 0.96, 1.04, 1.08]) {
        const s = best.scale * f;
        if (s <= 0) continue;
        const r = matchTemplateAtScale(cv, srcGray, tpl, s);
        if (r.score > best.score) best = r;
      }
    }

    return best;
  } finally {
    srcRgba.delete();
    srcGray.delete();
  }
}

async function findBestMatch(screen, tpl, options) {
  if (options.engine === 'opencv') {
    return findBestMatchOpenCV(screen, tpl, options);
  }
  return findBestMatchLegacy(screen, tpl, options);
}

async function loadTemplateSteps(steps, opts = {}) {
  const engine = opts.engine === 'legacy' ? 'legacy' : 'opencv';
  const needVariants = engine !== 'opencv';
  const loaded = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const image = await Jimp.read(step.path);
    const baseW = image.bitmap.width;
    const baseH = image.bitmap.height;

    const variants = [];
    if (needVariants) {
      for (const scale of SCALES) {
        const w = Math.max(4, Math.round(baseW * scale));
        const h = Math.max(4, Math.round(baseH * scale));
        const clone = image.clone().resize({ w, h });
        variants.push({
          scale,
          width: w,
          height: h,
          samples: buildTemplateSamples(clone)
        });
      }
    }

    loaded.push({
      name: step.name || `step-${i + 1}`,
      path: step.path,
      image,
      baseW,
      baseH,
      variants
    });
  }
  return loaded;
}

function createImageFlowController(page) {
  let running = false;
  let timer = null;
  let stepIndex = 0;
  let templates = [];
  let options = {};
  let busy = false;
  let loggedScreenSize = false;
  let onLog = null;
  let retryCount = 0;
  let recentScores = [];
  let scanLogCount = 0;

  function emit(msg, important = true) {
    if (important) console.log(msg);
    if (typeof onLog === 'function') {
      try { onLog(msg); } catch (e) { }
    }
  }

  async function tick() {
    if (!running || page.isClosed()) {
      running = false;
      return;
    }

    if (busy) {
      if (running) timer = setTimeout(tick, options.interval);
      return;
    }

    busy = true;
    let gotSlot = false;
    try {
      const tpl = templates[stepIndex];
      await acquireScanSlot();
      gotSlot = true;
      if (!running || page.isClosed()) return;

      let screenshot = await page.screenshot({ type: 'png' });
      await new Promise(resolve => setImmediate(resolve));
      let full = await Jimp.read(screenshot);
      screenshot = null;
      await new Promise(resolve => setImmediate(resolve));
      const useDownscale = options.engine === 'opencv';
      const prepared = useDownscale ? prepareScreenForMatch(full) : { screen: full, down: 1 };
      const screen = prepared.screen;
      const down = prepared.down;
      const fullW = full.bitmap.width;
      const fullH = full.bitmap.height;
      if (screen !== full) full = null;

      if (!loggedScreenSize) {
        loggedScreenSize = true;
        emit(
          `图像识别 引擎=${options.engine} 截图=${fullW}x${fullH}` +
          (down < 1 ? ` 匹配缩放=${down.toFixed(2)}` : '') +
          ` 模板=${tpl.baseW}x${tpl.baseH}`
        );
      }

      const match = await findBestMatch(screen, tpl, {
        ...options,
        scaleMul: down
      });
      const score = Number(match && match.score);
      const safeScore = Number.isFinite(score) ? score : 0;
      const autoThreshold = autoThresholdFromScans(safeScore, options.engine, recentScores);
      recentScores.push(safeScore);
      if (recentScores.length > 10) recentScores.shift();

      const logicalScale = down > 0 ? Number(match.scale || 0) / down : Number(match.scale || 0);
      scanLogCount++;
      if (scanLogCount === 1 || scanLogCount % 4 === 0) {
        emit(
          `图像识别 扫描[${tpl.name}] ${stepIndex + 1}/${templates.length} ` +
          `最佳得分=${safeScore.toFixed(3)} ` +
          `自动阈值=${autoThreshold.toFixed(3)} 缩放=${logicalScale.toFixed(2)}`,
          false
        );
      }

      if (safeScore >= autoThreshold && running && !page.isClosed()) {
        // 先推进步骤：OpenCV 点中后页面常立刻变，mouse/tap 可能抛错；
        // 若等点击成功再 advance，最后一步会卡死并反复扫描。
        retryCount = 0;
        const hitName = tpl.name;
        if (logicalScale > 0 && safeScore >= 0.88) tpl.lockScale = logicalScale;
        const shouldStop = advanceStep();

        try {
          const x = Math.round((Number(match.x) + Number(match.width) / 2) / down);
          const y = Math.round((Number(match.y) + Number(match.height) / 2) / down);
          if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0) {
            await page.mouse.click(x, y, { delay: 20 });
            emit(
              `图像识别 命中[${hitName}] 点击(${x}, ${y}) ` +
              `得分=${safeScore.toFixed(3)} 缩放=${logicalScale.toFixed(2)}`
            );
          } else {
            emit(`图像识别 命中[${hitName}] 坐标无效，已跳到下一步`);
          }
        } catch (clickErr) {
          emit(`图像识别 命中[${hitName}] 点击异常: ${clickErr.message}，已跳到下一步`);
        }

        if (shouldStop) return;
      } else if (options.mode === 'retry' && running && !page.isClosed()) {
        retryCount++;
        emit(
          `图像识别 未匹配[${tpl.name}] 重试 ${retryCount}/${options.maxRetries}`
        );
        if (retryCount >= options.maxRetries) {
          emit(
            `图像识别 [${tpl.name}] 已达重试上限 ${options.maxRetries} 次，自动跳到下一步`
          );
          retryCount = 0;
          if (advanceStep()) return;
        }
      }
    } catch (e) {
      console.log('IMAGE FLOW ERROR:', e.message);
    } finally {
      if (gotSlot) releaseScanSlot();
      busy = false;
      if (!running) releaseLoadedTemplates();
    }

    if (running) {
      timer = setTimeout(tick, options.interval);
    }
  }

  function releaseLoadedTemplates() {
    for (const tpl of templates) {
      releaseTemplateCv(tpl);
      tpl.image = null;
      tpl.variants = [];
    }
    templates = [];
  }

  function advanceStep() {
    recentScores = [];
    const from = stepIndex;
    stepIndex = (stepIndex + 1) % templates.length;
    const next = templates[stepIndex];
    if (stepIndex === 0) {
      emit(
        options.once
          ? '图像识别 单次流程完成 ✅'
          : `图像识别 全部步骤完成，回到 [${next && next.name}] 1/${templates.length}`
      );
      if (options.once) {
        running = false;
        busy = false;
        if (timer) { clearTimeout(timer); timer = null; }
        const cb = options.onComplete;
        if (typeof cb === 'function') {
          try { cb(); } catch (e) { }
        }
        return true;
      }
      return false;
    }
    emit(`图像识别 进入 [${next && next.name}] ${stepIndex + 1}/${templates.length}（来自步骤 ${from + 1}）`);
    return false;
  }

  return {
    async start(steps, opts = {}) {
      this.stop();
      onLog = typeof opts.onLog === 'function' ? opts.onLog : null;

      let engine = opts.engine === 'legacy' ? 'legacy' : 'opencv';
      if (engine === 'opencv' && !isOpenCVAvailable()) {
        emit('图像识别 OpenCV 不可用，回退到旧模式（抽样色差）');
        engine = 'legacy';
      }

      templates = await loadTemplateSteps(steps, { engine });
      stepIndex = 0;
      retryCount = 0;
      recentScores = [];
      scanLogCount = 0;
      loggedScreenSize = false;
      options = {
        engine,
        interval: Math.max(300, Number(opts.interval) || 1000),
        startDelay: Math.max(0, Number(opts.startDelay) || 0),
        tolerance: Number(opts.tolerance) || 40,
        scanStep: Math.max(1, Number(opts.scanStep) || 3),
        mode: opts.mode === 'retry' ? 'retry' : 'complete',
        maxRetries: Math.max(1, Number(opts.maxRetries) || 3),
        once: !!opts.once,
        onComplete: typeof opts.onComplete === 'function' ? opts.onComplete : null
      };
      emit(
        `图像识别 启动 引擎=${options.engine} 步骤数=${templates.length} ` +
        `间隔=${options.interval}ms 阈值=自动 ` +
        `模式=${options.mode === 'retry' ? '重试(上限' + options.maxRetries + '次)' : '完整'}`
      );
      running = true;
      timer = setTimeout(tick, options.startDelay);
    },
    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!busy) releaseLoadedTemplates();
    },
    isRunning() {
      return running;
    }
  };
}

module.exports = {
  createImageFlowController,
  loadTemplateSteps,
  isOpenCVAvailable,
  findTemplateInScreenshot: async function (screenshotBuffer, tpl, options) {
    const screen = await Jimp.read(screenshotBuffer);
    return findBestMatch(screen, tpl, options || {});
  }
};
