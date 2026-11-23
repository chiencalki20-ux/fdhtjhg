const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { createImageFlowController } = require('./image-flow');
const { resolveSocketSave, sanitizeFileName, getAmigoDemoRefreshReason, getVaDemoRefreshReason, getVaBalanceSnapshot, getAmigoFreeGame2Signal, getAmigoFeaturePlaySignal, getAmigoPickMeSignal, isAmigoActionRequest, isAmigoActionResponse } = require('./socket-handlers');
const { fetchAmigoDemoLink, isAmigoGameId, isAmigoPlayReadyUrl } = require('./amigo-demo-link');
const { fetchVaDemoLink, isVaGameId } = require('./va-demo-link');
const { findAmigoGame } = require('./games');
const { findVaGame } = require('./va-games');

function buildInstanceDir(baseDir, targetUrl, instanceIndex) {
  const u = new URL(targetUrl);
  let name = (u.hostname + u.pathname)
    .replace(/\//g, '_')
    .replace(/[?&=]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (!name) name = 'default';
  return path.join(baseDir, `window_${instanceIndex}_${name}`);
}

function matchesApiPattern(url, apiPatterns) {
  return apiPatterns.some(pattern => url.includes(pattern));
}

/** 路径以静态资源后缀结尾（如 .json / .js），不写入 apis */
function isStaticFileUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return /\.(png|jpe?g|gif|webp|css|js|mjs|map|woff2?|ttf|otf|svg|mp3|wav|mp4|html?|ico|json|wasm|bin|cconb?|plist|pac|atlas|ktx|pvr|astc)$/.test(pathname);
  } catch (e) {
    return false;
  }
}

/**
 * PP gameService 等接口常把 Content-Type 标成 text/html，
 * 实际 body 是 key=value&key2=value2 表单串。
 */
function looksLikeFormUrlEncoded(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.startsWith('{') || t.startsWith('[') || t.startsWith('<')) return false;
  if (/<\/?[a-z][\s>]/i.test(t.slice(0, 256))) return false;
  if (!/^[A-Za-z0-9_.-]+=/.test(t)) return false;
  const pairs = t.split('&');
  let ok = 0;
  for (const p of pairs.slice(0, 30)) {
    if (/^[A-Za-z0-9_.-]+=/.test(p)) ok++;
  }
  return ok >= 1 && ok >= Math.min(2, pairs.length);
}

function shouldSkipCapture(url) {
  return /^(data:|blob:|chrome-extension:|devtools:|about:)/i.test(url);
}

/** Cloudflare 挑战 / 盾相关请求不要拦截，否则容易直接 403 */
function isCloudflareChallengeUrl(url) {
  return /cdn-cgi\/|challenges\.cloudflare\.com|cloudflare\.com\/cdn-cgi/i.test(url);
}

function isAmigoOfficialLink(url) {
  return /launch\.amigogaming\.com|demo\.amigogaming\.cloud|sdemo\.amigogaming/i.test(String(url || ''));
}

function looksLikeAmigoHttpLink(url) {
  const u = String(url || '');
  if (isAmigoOfficialLink(u)) return false;
  return /[?&]apiUrl=/i.test(u) || /\/api\/game\//i.test(u) || /\/games-alt-wgl\/amigo\//i.test(u);
}

function isAmigoHttpApiUrl(url) {
  try {
    return /\/api\/game\/[^/]+\/(init|spin|pickme|dispatch|balance|history|exit|replay\/)/i.test(
      new URL(url).pathname
    );
  } catch (e) {
    return /\/api\/game\//i.test(String(url || ''));
  }
}

async function launchStealthBrowser() {
  const args = [
    '--window-size=500,700',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--no-default-browser-check',
    '--no-first-run',
    '--disable-infobars'
  ];
  const ignoreDefaultArgs = ['--enable-automation'];

  // 优先用本机 Chrome，Cloudflare 对 Playwright 自带 Chromium 更敏感
  try {
    const browser = await chromium.launch({
      headless: false,
      channel: 'chrome',
      args,
      ignoreDefaultArgs,
      timeout: 45000
    });
    console.log('BROWSER: system Chrome');
    return browser;
  } catch (e) {
    console.log('BROWSER: fallback Playwright Chromium (' + e.message + ')');
    return chromium.launch({
      headless: false,
      args: [
        ...args,
        '--disk-cache-size=1',
        '--media-cache-size=1'
      ],
      ignoreDefaultArgs,
      timeout: 45000
    });
  }
}

async function applyStealth(context) {
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
    } catch (e) { }

    try {
      window.chrome = window.chrome || { runtime: {} };
    } catch (e) { }

    try {
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en']
      });
    } catch (e) { }

    try {
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });
    } catch (e) { }

    try {
      const originalQuery = window.navigator.permissions.query.bind(
        window.navigator.permissions
      );
      window.navigator.permissions.query = (parameters) => (
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      );
    } catch (e) { }
  });
}

/** 资源落盘去重键：按路径（不含 query），同文件不同 ?v= 只存一份 */
function resourceDedupeKey(url) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).replace(/\/$/, '');
  } catch (e) {
    return String(url || '').split(/[?#]/)[0];
  }
}

function buildResourceRelPath(url) {
  const u = new URL(url);
  // 只用 hostname + pathname，不把 query 拼进文件名
  let filePath = u.hostname + u.pathname;
  if (filePath.endsWith('/')) filePath += 'index.html';
  if (!path.extname(filePath)) filePath += '.bin';

  // Windows 路径过长会导致写入失败 → 资源缺失
  if (filePath.length > 180) {
    const ext = path.extname(filePath) || '.bin';
    const hash = crypto.createHash('md5').update(u.hostname + u.pathname).digest('hex');
    filePath = path.join(u.hostname, hash + ext);
  }
  return filePath;
}

function isDownloadableResourceUrl(url) {
  if (!url || shouldSkipCapture(url) || isCloudflareChallengeUrl(url)) return false;
  if (/^(ws|wss):/i.test(url)) return false;
  return true;
}

async function saveResourceFile(saveDir, url, buffer) {
  const fullPath = path.join(saveDir, buildResourceRelPath(url));
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  try {
    const st = await fs.promises.stat(fullPath);
    if (st.size >= buffer.length && st.size > 0) {
      return { fullPath, skipped: true };
    }
  } catch (_) { }
  await fs.promises.writeFile(fullPath, buffer);
  return { fullPath, skipped: false };
}

async function downloadListedResources({ saveDir, urls, fetchBuffer, onLog }) {
  const list = (urls || []).filter(isDownloadableResourceUrl);
  const emit = (msg) => {
    if (typeof onLog === 'function') {
      try { onLog(msg); } catch (_) { }
    }
  };
  const stats = { total: list.length, saved: 0, skipped: 0, failed: 0 };
  if (!list.length) {
    emit('静态资源清单为空');
    return stats;
  }
  emit(`开始下载静态资源 ${list.length} 个 → ${saveDir}`);
  let cursor = 0;
  const limit = Math.min(3, list.length);
  async function worker() {
    while (cursor < list.length) {
      const url = list[cursor++];
      const n = cursor;
      try {
        const buffer = await fetchBuffer(url);
        if (!buffer || !buffer.length) {
          stats.failed++;
          continue;
        }
        const r = await saveResourceFile(saveDir, url, buffer);
        if (r.skipped) stats.skipped++;
        else stats.saved++;
      } catch (_) {
        stats.failed++;
      }
      if (n === 1 || n === list.length || n % 20 === 0) {
        emit(`静态资源 ${n}/${list.length} 已存=${stats.saved} 跳过=${stats.skipped} 失败=${stats.failed}`);
      }
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  emit(`静态资源下载完成 已存=${stats.saved} 跳过=${stats.skipped} 失败=${stats.failed}`);
  return stats;
}

// 按窗口目录串行落盘：入队顺序 = 收到 body 的顺序，写完一条再写下一条
const apiSaveQueues = new Map();

function enqueueWindowApiJob(saveDir, job) {
  const prev = apiSaveQueues.get(saveDir) || Promise.resolve();
  const next = prev.then(job).catch(err => {
    console.log('API SAVE ERROR:', err && err.message);
  });
  apiSaveQueues.set(saveDir, next);
}

/** 是否值得尝试按 API 落盘（不依赖 body） */
function mightBeApiResponse(contentType, resourceType, url, apiPatterns) {
  const ct = (contentType || '').toLowerCase();
  if (resourceType === 'xhr' || resourceType === 'fetch') return true;
  if (
    ct.includes('application/json') ||
    ct.includes('+json') ||
    ct.includes('text/json') ||
    ct.includes('application/octet-stream') ||
    ct.includes('text/plain') ||
    ct.includes('text/html') ||
    ct.includes('application/x-www-form-urlencoded')
  ) {
    return true;
  }
  if (apiPatterns.length > 0 && matchesApiPattern(url, apiPatterns)) return true;
  return false;
}

async function saveApiToDisk(saveDir, url, buffer, contentType, resourceType, apiPatterns) {
  const ct = (contentType || '').toLowerCase();
  const isAjax = resourceType === 'xhr' || resourceType === 'fetch';
  const isJsonType =
    ct.includes('application/json') ||
    ct.includes('+json') ||
    ct.includes('text/json');
  const isOctetStream = ct.includes('application/octet-stream');
  const isTextualMistyped =
    ct.includes('text/html') ||
    ct.includes('text/plain') ||
    ct.includes('application/x-www-form-urlencoded') ||
    ct === '' ||
    ct.includes('x-unknown');
  const isStaticUrl = isStaticFileUrl(url);
  if (isStaticUrl) return null;
  const urlMatchesPattern =
    apiPatterns.length > 0 && matchesApiPattern(url, apiPatterns);
  const parseAsProtobuf =
    isOctetStream &&
    (apiPatterns.length === 0 || urlMatchesPattern);

  let apiText = null;
  let kind = 'json';
  if (isOctetStream) {
    apiText = parseAsProtobuf
      ? parseOctetStream(buffer, url)
      : buffer.toString('utf8');
    kind = 'octet-stream';
  } else if (!isStaticUrl && isJsonType) {
    apiText = buffer.toString('utf8');
    kind = 'json';
  } else if (!isStaticUrl && (isAjax || isTextualMistyped || urlMatchesPattern)) {
    const raw = buffer.toString('utf8').trim();
    if (raw.startsWith('{') || raw.startsWith('[')) {
      apiText = raw;
      kind = 'json';
    } else if (looksLikeFormUrlEncoded(raw)) {
      // 如 /gs2c/ge/v4/gameService：CT=text/html，body=表单串
      apiText = raw;
      kind = 'form';
    }
  }
  if (apiText === null || apiText === '') return null;

  const text = toSingleLine(apiText);
  if (!text) return null;

  const u = new URL(url);
  let fileName = (u.hostname + u.pathname)
    .replace(/\//g, '_')
    .replace(/[?&=]/g, '_');
  if (!fileName || fileName === u.hostname) {
    fileName = u.hostname + '_root';
  }
  if (fileName.length > 120) {
    const hash = crypto.createHash('md5').update(u.hostname + u.pathname).digest('hex').slice(0, 16);
    fileName = u.hostname.replace(/\W/g, '_') + '_' + hash;
  }
  const apiPath = path.join(saveDir, 'apis', fileName + '.txt');
  await fs.promises.mkdir(path.dirname(apiPath), { recursive: true });
  await fs.promises.appendFile(apiPath, text + '\n');
  return { apiPath, kind };
}

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      if (result <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return [Number(result), pos];
      }
      return [result.toString(), pos];
    }
    shift += 7n;
  }
  throw new Error('truncated varint');
}

function isPrintableUtf8(buf) {
  const text = buf.toString('utf8');
  // 含替换字符说明不是合法 UTF-8 文本
  if (!text.length || text.includes('\uFFFD')) return false;
  return /^[\x09\x0a\x0d\x20-\x7e\u0080-\uFFFF]*$/.test(text);
}

/** 判断是否像真正的业务字符串，避免把 packed 二进制误当文本（如 "       ?       ?"） */
function looksLikeText(buf) {
  if (!isPrintableUtf8(buf)) return false;
  const text = buf.toString('utf8');
  const trimmed = text.trim();
  if (!trimmed) return false;

  // 空格过多：多为二进制刚好落在可打印区
  if ((text.match(/ /g) || []).length / text.length > 0.2) return false;

  // 无字母数字：纯符号/空白不是业务文本
  if (!/[A-Za-z0-9]/.test(trimmed)) return false;

  // "333333 ?333333 ?" 这类：数字夹杂空格+?，实为 packed varint 残留
  if (/\s\?/.test(trimmed)) return false;

  return true;
}

function looksLikeProtobuf(buf) {
  if (!buf || !buf.length) return false;
  try {
    const [tag] = readVarint(buf, 0);
    const field = Number(BigInt(tag) >> 3n);
    const wire = Number(BigInt(tag) & 7n);
    return field > 0 && field <= 200 && [0, 1, 2, 5].includes(wire);
  } catch (e) {
    return false;
  }
}

function tryDecodePackedVarints(slice) {
  if (!slice || !slice.length) return null;
  try {
    const packed = [];
    let p = 0;
    while (p < slice.length) {
      let val;
      [val, p] = readVarint(slice, p);
      packed.push(val);
    }
    // 整段都是 varint：含多字节，或单字节序列（避免误把正常字符串当 packed）
    if (packed.length === 0) return null;
    if (packed.length < slice.length) return packed;
    // 全部单字节 varint：仅在不像文本时采用
    return packed;
  } catch (e) {
    return null;
  }
}

function formatRawBytes(slice) {
  const bytes = [...slice];
  if (!bytes.length) return [];

  const packed = tryDecodePackedVarints(slice);
  if (packed) return packed;

  if (bytes.length <= 64) {
    return bytes;
  }

  return {
    len: bytes.length,
    hex: slice.toString('hex'),
    bytes: bytes.slice(0, 64)
  };
}

/** wire=1/5 的浮点包装：JSON 中整数也输出 6.0，避免与 varint 整型混淆 */
function PbFloat(value) {
  if (!(this instanceof PbFloat)) return new PbFloat(value);
  this.value = value;
}

function stringifyProtobufJson(value) {
  if (value instanceof PbFloat) {
    const n = value.value;
    if (!Number.isFinite(n)) return 'null';
    if (Object.is(n, -0)) return '-0.0';
    if (Number.isInteger(n)) return `${n}.0`;
    return String(n);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stringifyProtobufJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const parts = [];
    for (const [k, v] of Object.entries(value)) {
      parts.push(`${JSON.stringify(k)}:${stringifyProtobufJson(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 同名字段出现多次 → 数组；只出现一次 → 保持原类型（不强制包数组）。 */
function addProtobufField(result, key, value) {
  if (result[key] !== undefined) {
    if (!Array.isArray(result[key])) result[key] = [result[key]];
    result[key].push(value);
  } else {
    result[key] = value;
  }
}

function isProtoScalarIntType(type) {
  return (
    type === 'int32' ||
    type === 'int64' ||
    type === 'uint32' ||
    type === 'uint64' ||
    type === 'sint32' ||
    type === 'sint64' ||
    type === 'bool'
  );
}

function isProtoWideIntType(type) {
  return type === 'int64' || type === 'uint64' || type === 'sint64';
}

/** map 条目固定为 message{ f1=key, f2=value }，value 类型取自父字段 meta.type */
function mapEntrySchema(meta) {
  return {
    fields: [
      { id: 1, type: 'int32', repeated: false, packed: false, mapKeyInt32: false },
      {
        id: 2,
        type: meta && meta.type ? meta.type : 'unknown',
        repeated: false,
        packed: false,
        mapKeyInt32: false
      }
    ]
  };
}

function schemaFieldMap(schema) {
  if (!schema || !Array.isArray(schema.fields)) return null;
  const map = new Map();
  for (const f of schema.fields) map.set(Number(f.id), f);
  return map;
}

/** wire=0 整型：int64/uint64 一律字符串，避免精度/类型抖动 */
function coerceVarintByMeta(val, meta) {
  if (!meta) return val;
  if (isProtoWideIntType(meta.type) && typeof val === 'number') return String(val);
  if (meta.type === 'bool') return val === 1 || val === '1' || val === true;
  if (meta.type === 'float' || meta.type === 'double') {
    const n = typeof val === 'number' ? val : Number(val);
    return Number.isFinite(n) ? new PbFloat(n) : val;
  }
  return val;
}

/**
 * packed varint 与「单字段 varint message」歧义：
 * 08 0d → {"f1":13} 也是 [8,13]。无 schema 时：单整型/字符串字段倾向 packed。
 */
function isPackedVarintAmbiguousMessage(nested) {
  const keys = Object.keys(nested);
  if (keys.length !== 1) return false;
  const v = nested[keys[0]];
  if (typeof v === 'string') return true;
  if (typeof v === 'number' && Number.isInteger(v)) return true;
  return false;
}

/**
 * 严格解析 message（完整消费 + 合法 wire）。
 * schema 仅作用于本层字段；子 message 用子 schema / map 条目 schema，不用父字段表。
 */
function strictDecodeMessage(buffer, schema) {
  const result = {};
  let pos = 0;
  const byId = schemaFieldMap(schema);
  while (pos < buffer.length) {
    let tag;
    try { [tag, pos] = readVarint(buffer, pos); } catch (e) { return null; }
    const field = Number(BigInt(tag) >> 3n);
    const wire = Number(BigInt(tag) & 7n);
    if (field < 1) return null;
    const key = `f${field}`;
    const meta = byId ? byId.get(field) : null;
    if (wire === 0) {
      let val;
      try { [val, pos] = readVarint(buffer, pos); } catch (e) { return null; }
      addProtobufField(result, key, coerceVarintByMeta(val, meta));
    } else if (wire === 1) {
      if (pos + 8 > buffer.length) return null;
      addProtobufField(result, key, new PbFloat(buffer.readDoubleLE(pos)));
      pos += 8;
    } else if (wire === 2) {
      let len;
      try { [len, pos] = readVarint(buffer, pos); } catch (e) { return null; }
      len = Number(len);
      if (len < 0 || pos + len > buffer.length) return null;
      const sub = buffer.subarray(pos, pos + len);
      pos += len;
      addProtobufField(result, key, decodeLengthDelimitedValue(sub, meta));
    } else if (wire === 5) {
      if (pos + 4 > buffer.length) return null;
      addProtobufField(result, key, new PbFloat(buffer.readFloatLE(pos)));
      pos += 4;
    } else {
      return null;
    }
  }
  return pos === buffer.length ? result : null;
}

function tryDecodeNestedMessage(slice, schema) {
  if (!looksLikeProtobuf(slice)) return null;
  try {
    const decoded = strictDecodeMessage(slice, schema || null);
    if (!decoded) return null;
    return Object.keys(decoded).length ? decoded : null;
  } catch (e) {
    return null;
  }
}

function decodeUtf8String(slice) {
  const text = slice.toString('utf8');
  if (text.includes('\uFFFD')) return null;
  return text;
}

/**
 * 解码 wire=2。有 schema 时按真实字段类型，不用启发式改写：
 * - string → 字符串（即使内容是 JSON 也不 parse 成对象）
 * - bytes → 原始字节/packed
 * - repeated/packed 标量整型 → 数组
 * - message / map 条目 → 对象 {f1,f2,...}；map 用条目 schema 解 f1/f2
 * - 无 meta → 内容消歧（歧义单字段 message ↔ packed）
 */
function decodeLengthDelimitedValue(slice, meta) {
  if (meta && meta.type === 'string') {
    const s = decodeUtf8String(slice);
    return s !== null ? s : formatRawBytes(slice);
  }
  if (meta && meta.type === 'bytes') {
    return formatRawBytes(slice);
  }

  const preferPacked =
    meta &&
    isProtoScalarIntType(meta.type) &&
    !meta.mapKeyInt32 &&
    (meta.repeated || meta.packed);
  const preferMessage =
    meta && (meta.type === 'message' || meta.mapKeyInt32 === true);

  if (preferPacked) {
    const packed = tryDecodePackedVarints(slice);
    if (packed) return packed;
  }

  // map：用 {f1:key,f2:value} 条目 schema，保证 value 侧 float/int/message 类型准确
  if (preferMessage && meta && meta.mapKeyInt32) {
    const entry = tryDecodeNestedMessage(slice, mapEntrySchema(meta));
    if (entry) return entry;
  }

  if (preferMessage && meta && meta.type === 'message') {
    const nestedMsg = tryDecodeNestedMessage(slice, meta.messageSchema || null);
    if (nestedMsg) return nestedMsg;
  }

  const nested = tryDecodeNestedMessage(slice, null);
  if (nested) {
    if (preferMessage) return nested;
    if (!preferPacked && isPackedVarintAmbiguousMessage(nested)) {
      const packed = tryDecodePackedVarints(slice);
      if (packed) return packed;
    }
    return nested;
  }

  // protobuf 字符串保持字符串；不要 JSON.parse，否则 {"8":1} 会从 string 变成 object
  if (looksLikeText(slice)) {
    return slice.toString('utf8');
  }
  return formatRawBytes(slice);
}

function decodeProtobuf(buffer, schema) {
  const result = {};
  let pos = 0;
  const byId = schemaFieldMap(schema);

  while (pos < buffer.length) {
    let tag;
    [tag, pos] = readVarint(buffer, pos);
    const field = Number(BigInt(tag) >> 3n);
    const wire = Number(BigInt(tag) & 7n);
    const key = `f${field}`;
    const meta = byId ? byId.get(field) : null;

    if (wire === 0) {
      let val;
      [val, pos] = readVarint(buffer, pos);
      addProtobufField(result, key, coerceVarintByMeta(val, meta));
    } else if (wire === 1) {
      addProtobufField(result, key, new PbFloat(buffer.readDoubleLE(pos)));
      pos += 8;
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buffer, pos);
      const slice = buffer.subarray(pos, pos + Number(len));
      pos += Number(len);
      addProtobufField(result, key, decodeLengthDelimitedValue(slice, meta));
    } else if (wire === 5) {
      addProtobufField(result, key, new PbFloat(buffer.readFloatLE(pos)));
      pos += 4;
    } else {
      break;
    }
  }

  return result;
}

/**
 * 保证一条响应一行。
 * 不 parse/stringify：避免大整型精度丢失、字段顺序/数字格式被改写。
 * 只去掉换行（pretty-print 的 JSON 去掉 \\n 后仍合法）。
 */
function toSingleLine(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return '';
  return trimmed.replace(/\r?\n/g, '');
}

/**
 * 从游戏源码 Protoutils 字段装饰器提取的 schema（proto-schemas/*.json）。
 * 解码时用于精确区分：标量 packed → 数组，message/map 条目 → 对象，string → 字符串。
 */
const PROTO_SCHEMAS = [];
(function loadProtoSchemas() {
  const dir = path.join(__dirname, 'proto-schemas');
  const files = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || name.startsWith('_')) continue;
      files.push(path.join(dir, name));
    }
  } catch (e) { }
  // 兼容旧单文件
  const legacy = path.join(__dirname, 'proto-schema-wild-bounty-spin.json');
  if (fs.existsSync(legacy)) files.push(legacy);

  for (const file of files) {
    try {
      const s = require(file);
      if (s && Array.isArray(s.fields) && s.fields.length) PROTO_SCHEMAS.push(s);
    } catch (e) { }
  }
})();

function resolveProtoSchema(url) {
  if (!url || !PROTO_SCHEMAS.length) return null;
  const u = String(url);

  // 1) 精确：apiPathIncludes / apiPathIncludesAny
  for (const s of PROTO_SCHEMAS) {
    if (s.genericPgV4Spin || s.matchGameApiV4) continue;
    const hints = []
      .concat(s.apiPathIncludesAny || [])
      .concat(s.apiPathIncludes ? [s.apiPathIncludes] : []);
    for (const h of hints) {
      if (h && u.includes(h)) return s;
    }
    if (s.staticPathIncludes && u.includes(s.staticPathIncludes)) return s;
  }

  // 2) PG v4 通用：/game-api/<slug>/v4/...（各游戏 Spin 字段角色同构）
  if (/\/game-api\/[^/]+\/v4\//i.test(u)) {
    const common = PROTO_SCHEMAS.find(s => s.matchGameApiV4 || s.genericPgV4Spin);
    if (common) return common;
  }

  return null;
}

/** 解码后补正：顶层 float 标量。数组/对象/字符串形状已在 decode 阶段按 schema+wire 判定。 */
function normalizeByProtoFieldMeta(value, meta) {
  if (!meta) return value;
  if (meta.type === 'float' || meta.type === 'double') {
    if (typeof value === 'number' && !(value instanceof PbFloat)) {
      return new PbFloat(value);
    }
  }
  if (isProtoWideIntType(meta.type) && typeof value === 'number') {
    return String(value);
  }
  return value;
}

function applyProtoSchema(decoded, schema) {
  if (!decoded || !schema || !Array.isArray(schema.fields)) return decoded;
  const byId = new Map(schema.fields.map(f => [Number(f.id), f]));
  for (const key of Object.keys(decoded)) {
    const m = /^f(\d+)$/.exec(key);
    if (!m) continue;
    const meta = byId.get(Number(m[1]));
    if (!meta) continue;
    decoded[key] = normalizeByProtoFieldMeta(decoded[key], meta);
  }
  return decoded;
}

function parseOctetStream(buffer, url) {
  let data = buffer;
  try {
    data = zlib.gunzipSync(buffer);
  } catch (e) { }

  const candidates = data === buffer ? [buffer] : [data, buffer];
  const schema = resolveProtoSchema(url);

  for (const candidate of candidates) {
    const text = candidate.toString('utf8');
    const trimmed = text.trim();

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return toSingleLine(trimmed);
    }

    if (/^[\x09\x0a\x0d\x20-\x7e\u0080-\uFFFF]*$/.test(trimmed) && trimmed.length > 0) {
      return toSingleLine(trimmed);
    }

    if (looksLikeProtobuf(candidate)) {
      try {
        const decoded = applyProtoSchema(decodeProtobuf(candidate, schema), schema);
        return stringifyProtobufJson(decoded);
      } catch (e) { }
    }
  }

  try {
    const decoded = applyProtoSchema(decodeProtobuf(buffer, schema), schema);
    return stringifyProtobufJson(decoded);
  } catch (e) {
    return buffer.toString('hex');
  }
}

module.exports = async function (
  TARGET_URL,
  SAVE_DIR,
  instanceIndex = 1,
  splitByWindow = true,
  apiPatterns = [],
  gameType = 'generic',
  gameId = '',
  regionClick = null,
  amigoUseHttp = false
) {

  if (!TARGET_URL || !SAVE_DIR) return;

  let startUrl = String(TARGET_URL).trim();
  const type = String(gameType || 'generic').toLowerCase();
  let amigoGameId = String(gameId || '').trim();
  let vaGameId = String(gameId || '').trim();
  if (type === 'amigo') {
    if (!amigoGameId && isAmigoGameId(startUrl)) {
      amigoGameId = startUrl;
    }
    if (amigoGameId) {
      const g = findAmigoGame(amigoGameId);
      console.log(
        'AMIGO GAME:',
        amigoGameId,
        g ? g.label : '(不在列表中)'
      );
    }
  } else if (type === 'va') {
    if (!vaGameId && isVaGameId(startUrl)) {
      vaGameId = startUrl;
    }
    if (vaGameId) {
      const g = findVaGame(vaGameId);
      console.log(
        'VA GAME:',
        vaGameId,
        g ? g.label : '(不在列表中)'
      );
    }
  }

  console.log('GAME TYPE:', gameType || 'generic');

  const browser = await launchStealthBrowser();

  // 允许 Service Worker：部分站点 / Cloudflare 挑战依赖正常浏览器能力
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 500, height: 700 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    colorScheme: 'light',
    javaScriptEnabled: true,
    serviceWorkers: 'allow'
  });
  await applyStealth(context);

  // Amigo：URL 填游戏 id 时自动生成 demo 链接
  if (type === 'amigo' && isAmigoGameId(startUrl)) {
    amigoGameId = String(startUrl).trim();
    console.log('AMIGO: 正在获取 demo 链接, gameId=', amigoGameId);
    startUrl = await fetchAmigoDemoLink(amigoGameId, {
      sessionType: 'mobile'
    });
    console.log('AMIGO LINK:', startUrl);
  }

  if (type === 'va' && isVaGameId(startUrl)) {
    vaGameId = String(startUrl).trim();
    startUrl = await fetchVaDemoLink(vaGameId);
    console.log('VA LINK:', startUrl);
  }

  const useAmigoHttp =
    String(gameType).toLowerCase() === 'amigo' &&
    (amigoUseHttp || looksLikeAmigoHttpLink(startUrl)) &&
    !isAmigoOfficialLink(startUrl);
  if (String(gameType).toLowerCase() === 'amigo') {
    console.log('AMIGO CLICK SOURCE:', useAmigoHttp ? 'HTTP /api/game/*' : 'WebSocket');
  }

  const EFFECTIVE_SAVE_DIR = splitByWindow
    ? buildInstanceDir(SAVE_DIR, startUrl, instanceIndex)
    : SAVE_DIR;
  fs.mkdirSync(EFFECTIVE_SAVE_DIR, { recursive: true });
  const SOCKET_DIR = path.join(EFFECTIVE_SAVE_DIR, 'sockets');
  fs.mkdirSync(SOCKET_DIR, { recursive: true });
  console.log('SAVE DIR:', EFFECTIVE_SAVE_DIR, splitByWindow ? '(分窗口)' : '(共用)');

  const page = await context.newPage();

  let amigoRefreshing = false;
  let vaRefreshing = false;
  let vaStopped = false;
  let vaGameSocketOpen = 0;
  let vaLastBalance = null;
  let vaLastBet = 0;

  function resolveVaGameId(targetPage) {
    if (vaGameId) return vaGameId;
    try {
      const p = targetPage && !targetPage.isClosed() ? targetPage : page;
      const u = new URL(p.url());
      return String(u.searchParams.get('game_code') || '').trim();
    } catch (_) {
      return '';
    }
  }

  function isVaGameSocket(url) {
    return /BlueBox\/websocket|gs\.praise555|gs\.victor-win/i.test(String(url || ''));
  }

  async function refreshVaLink(targetPage, reason) {
    if (String(gameType).toLowerCase() !== 'va') return;
    if (vaStopped) return;
    const id = resolveVaGameId(targetPage);
    if (!id) {
      console.log('VA 换链: 无 gameId，无法自动换链（请在界面选择游戏）');
      return;
    }
    if (vaRefreshing) {
      console.log('VA 换链: 进行中，跳过');
      return;
    }
    vaRefreshing = true;
    try {
      const why = reason === 'kick' ? '未下注被踢' : '余额不足';
      console.log('VA 换链:', why, '重新取链 gameId=', id);
      const newUrl = await fetchVaDemoLink(id);
      console.log('VA 换链: 新链接', newUrl);
      const p = targetPage && !targetPage.isClosed() ? targetPage : page;
      try {
        await p.evaluate(() => {
          try { localStorage.clear(); } catch (_) { }
          try { sessionStorage.clear(); } catch (_) { }
        });
      } catch (_) { }
      try {
        await p.context().clearCookies();
      } catch (_) { }
      await p.goto(newUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 120000,
        referer: 'https://www.va-game.com/en/game?category=slot'
      });
      vaLastBalance = null;
      vaLastBet = 0;
      console.log('VA 换链: 已切换当前窗口到新链接', p.url());
    } catch (e) {
      console.log('VA 换链失败:', e.message);
    } finally {
      vaRefreshing = false;
    }
  }

  async function refreshAmigoLink(targetPage, reason) {
    if (String(gameType).toLowerCase() !== 'amigo') return;
    const why = reason === 'balance' ? '余额不足' : '403';
    if (!amigoGameId) {
      console.log('AMIGO 换链: 无 gameId，无法自动换链（请用游戏 id 启动或在界面选择游戏）');
      return;
    }
    if (amigoRefreshing) {
      console.log('AMIGO 换链: 进行中，跳过');
      return;
    }
    amigoRefreshing = true;
    try {
      console.log('AMIGO 换链:', why, '重新获取 gameId=', amigoGameId);
      const newUrl = await fetchAmigoDemoLink(amigoGameId, {
        sessionType: 'mobile'
      });
      console.log('AMIGO 换链: 新链接', newUrl);
      const p = targetPage && !targetPage.isClosed() ? targetPage : page;
      await p.goto(newUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 120000,
        referer: 'https://amigogaming.com/games'
      });
      try {
        await p.waitForURL(
          (u) => isAmigoPlayReadyUrl(u.href),
          { timeout: 45000 }
        );
      } catch (_) { }
      console.log('AMIGO 换链: 已切换当前窗口到新链接', p.url());
    } catch (e) {
      console.log('AMIGO 换链失败:', e.message);
    } finally {
      amigoRefreshing = false;
    }
  }

  const resourceSet = new Set();
  const apiSet = new Set();
  const routeHandledRequests = new WeakSet();
  let listWriteTimer = null;

  function flushResourceList() {
    if (listWriteTimer) {
      clearTimeout(listWriteTimer);
      listWriteTimer = null;
    }
    fs.writeFile(
      path.join(EFFECTIVE_SAVE_DIR, 'all-resources.json'),
      JSON.stringify([...resourceSet], null, 2),
      () => {}
    );
  }

  function noteResourceUrl(url) {
    if (!url || shouldSkipCapture(url)) return;
    const before = resourceSet.size;
    resourceSet.add(url);
    if (resourceSet.size === before) return;
    if (listWriteTimer) return;
    listWriteTimer = setTimeout(() => {
      listWriteTimer = null;
      flushResourceList();
    }, 1000);
  }

  function scheduleCapture(url, buffer, contentType, resourceType) {
    const copy = Buffer.from(buffer || []);
    if (!copy.length) return;
    noteResourceUrl(url);
    enqueueWindowApiJob(EFFECTIVE_SAVE_DIR, () =>
      persistCapture(url, copy, contentType, resourceType)
    );
  }

  async function persistCapture(url, buffer, contentType, resourceType) {
    try {
      const saved = await saveApiToDisk(
        EFFECTIVE_SAVE_DIR,
        url,
        buffer,
        contentType,
        resourceType,
        apiPatterns
      );
      if (saved) {
        apiSet.add(url);
        console.log(
          'API APPENDED:',
          saved.apiPath,
          `(${saved.kind})`
        );
      }
    } catch (e) {
      console.log('API SAVE ERROR:', url, e.message);
    }
  }

  function getResourceInfo() {
    let url = '';
    try {
      if (page && !page.isClosed()) url = page.url();
    } catch (_) { }
    const count = [...resourceSet].filter(
      u => !apiSet.has(u) && isDownloadableResourceUrl(u)
    ).length;
    return {
      url,
      saveDir: EFFECTIVE_SAVE_DIR,
      count
    };
  }

  async function downloadStaticResources({ onLog, saveDir } = {}) {
    flushResourceList();
    const urls = [...resourceSet].filter(u => !apiSet.has(u));
    const fetchBuffer = async (url) => {
      const res = await context.request.get(url, { timeout: 45000 });
      if (!res.ok()) throw new Error(String(res.status()));
      return Buffer.from(await res.body());
    };
    return downloadListedResources({
      saveDir: saveDir || EFFECTIVE_SAVE_DIR,
      urls,
      fetchBuffer,
      onLog
    });
  }

  // 只拦 xhr/fetch：静态资源走浏览器，避免 9 窗时所有图片/JS 都绕进主进程
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    const resourceType = request.resourceType();
    if (
      resourceType !== 'xhr' &&
      resourceType !== 'fetch'
    ) {
      return route.continue();
    }
    const method = request.method();
    if (
      method === 'OPTIONS' ||
      method === 'HEAD' ||
      isStaticFileUrl(url) ||
      shouldSkipCapture(url) ||
      isCloudflareChallengeUrl(url)
    ) {
      return route.continue();
    }
    try {
      const response = await route.fetch();
      const status = response.status();
      const buffer = Buffer.from(await response.body());
      const headers = response.headers();
      const contentType = headers['content-type'] || '';

      if (status >= 200 && status < 300 && buffer.length) {
        routeHandledRequests.add(request);
        scheduleCapture(url, buffer, contentType, resourceType);
        handleAmigoHttpExchange(url, request, buffer);
      }

      const fulfillHeaders = { ...headers };
      delete fulfillHeaders['content-encoding'];
      delete fulfillHeaders['Content-Encoding'];
      delete fulfillHeaders['content-length'];
      delete fulfillHeaders['Content-Length'];
      delete fulfillHeaders['transfer-encoding'];
      delete fulfillHeaders['Transfer-Encoding'];
      await route.fulfill({
        status,
        headers: fulfillHeaders,
        body: buffer
      });
    } catch (e) {
      console.log('ROUTE CAPTURE ERROR:', url, e.message);
      try {
        await route.continue();
      } catch (_) { }
    }
  });
  let autoClickTimer = null;
  let vaKeepAliveTimer = null;
  const imageFlow = createImageFlowController(page);

  function stopVaKeepAliveClick() {
    if (!vaKeepAliveTimer) return;
    clearInterval(vaKeepAliveTimer);
    vaKeepAliveTimer = null;
  }

  function startVaKeepAliveClick() {
    if (String(gameType).toLowerCase() !== 'va') return;
    if (vaKeepAliveTimer) return;
    console.log('VA: 图像识别期间每 30 秒点击旋转按钮，避免长时间未下注');
    vaKeepAliveTimer = setInterval(async () => {
      try {
        if (!page || page.isClosed()) return;
        const viewport = page.viewportSize() || { width: 500, height: 700 };
        const x = Math.floor(viewport.width * 0.5);
        const y = Math.floor(viewport.height * 0.9);
        await page.mouse.click(x, y, { delay: 20 });
      } catch (e) {
        console.log('VA KEEP-ALIVE CLICK ERROR:', e.message);
      }
    }, 30000);
  }

  function startAutoClick(
    xPercent = 0.5,
    yPercent = 0.5,
    interval = 2000
  ) {

    if (autoClickTimer) return;

    stopVaKeepAliveClick();
    stopCombinedFlow();
    imageFlow.stop();

    console.log(
      "START AUTO CLICK:",
      xPercent,
      yPercent
    );

    autoClickTimer = setInterval(async () => {
      try {
        if (page.isClosed()) return;
        const viewport = page.viewportSize() || { width: 1280, height: 720 };
        const x = Math.floor(viewport.width * xPercent);
        const y = Math.floor(viewport.height * yPercent);
        await page.mouse.click(x, y, { delay: 20 });
      } catch (e) {
        console.log('AUTO CLICK ERROR:', e.message);
      }
    }, interval);
  }
  // =========================
  // 停止自动点击
  // =========================
  function stopAutoClick() {

    if (!autoClickTimer) return;

    clearInterval(autoClickTimer);

    autoClickTimer = null;


  }

  let regionClickTimer = null;
  let regionClickIndex = 0;
  let regionClickGen = 0;
  let regionClickBusy = false;
  const pickme = {
    active: false,
    mode: null,
    waitingPair: false,
    seenReq: false,
    seenRes: false,
    retryTimer: null,
    scatterTimer: null,
    scatterGen: 0,
    clicking: false,
    lastJump: null,
    pointIndex: 0
  };

  function toRatio(v, fallbackPercent) {
    const n = Number(v);
    const pct = Number.isFinite(n) ? n : fallbackPercent;
    return Math.min(1, Math.max(0, pct / 100));
  }

  function getRegionBox(opts) {
    const xMin = toRatio(opts && opts.xMin, 1);
    const xMax = toRatio(opts && opts.xMax, 100);
    const yMin = toRatio(opts && opts.yMin, 20);
    const yMax = toRatio(opts && opts.yMax, 80);
    return {
      left: Math.min(xMin, xMax),
      right: Math.max(xMin, xMax),
      top: Math.min(yMin, yMax),
      bottom: Math.max(yMin, yMax)
    };
  }

  function getPickmePoints(opts) {
    const raw = opts && opts.pickmePoints;
    if (Array.isArray(raw) && raw.length) {
      const pts = raw
        .map(p => ({
          x: toRatio(p && p.x, 20),
          y: toRatio(p && p.y, 35)
        }))
        .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
      if (pts.length) return pts;
    }
    // 兼容旧单点字段
    return [
      {
        x: toRatio(opts && opts.pickmeX, 20),
        y: toRatio(opts && opts.pickmeY, 35)
      }
    ];
  }

  function getPickmeScatterPoints(opts) {
    const o = opts || {};
    if (o.pickmeMode === 'grid') {
      const g = o.pickmeGrid || {};
      return buildGridCells({
        xMin: g.xMin,
        xMax: g.xMax,
        yMin: g.yMin,
        yMax: g.yMax,
        rows: g.rows,
        cols: g.cols
      });
    }
    return getPickmePoints(o);
  }

  function nextPickmePoint() {
    const pts = getPickmeScatterPoints(regionClick || {});
    const i = pickme.pointIndex % pts.length;
    pickme.pointIndex = i + 1;
    return { ...pts[i], i, total: pts.length };
  }

  function updateRegionClick(next) {
    if (!next || typeof next !== 'object') return;
    if (!regionClick || typeof regionClick !== 'object') regionClick = {};
    if (next.pickmeMode === 'grid' || next.pickmeMode === 'fixed') {
      regionClick.pickmeMode = next.pickmeMode;
    }
    if (Array.isArray(next.pickmePoints)) {
      regionClick.pickmePoints = next.pickmePoints
        .map(p => ({ x: Number(p && p.x), y: Number(p && p.y) }))
        .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    }
    if (next.pickmeGrid && typeof next.pickmeGrid === 'object') {
      regionClick.pickmeGrid = {
        xMin: Number(next.pickmeGrid.xMin),
        xMax: Number(next.pickmeGrid.xMax),
        yMin: Number(next.pickmeGrid.yMin),
        yMax: Number(next.pickmeGrid.yMax),
        rows: Math.max(1, Number(next.pickmeGrid.rows) || 4),
        cols: Math.max(1, Number(next.pickmeGrid.cols) || 5)
      };
    }
    const x = Number(next.pickmeX);
    const y = Number(next.pickmeY);
    if (Number.isFinite(x)) regionClick.pickmeX = x;
    if (Number.isFinite(y)) regionClick.pickmeY = y;
  }

  const MATCH3_JUMP_PX = 40;

  function nextMatch3JumpPoint() {
    const box = getRegionBox(regionClick || {});
    const viewport = page.viewportSize() || { width: 500, height: 700 };
    const left = box.left * viewport.width;
    const top = box.top * viewport.height;
    const w = Math.max(1, (box.right - box.left) * viewport.width);
    const h = Math.max(1, (box.bottom - box.top) * viewport.height);
    const cols = Math.max(1, Math.floor(w / MATCH3_JUMP_PX));
    const rows = Math.max(1, Math.floor(h / MATCH3_JUMP_PX));
    const last = pickme.lastJump;
    const candidates = [];
    const far = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (last && last.r === r && last.c === c) continue;
        const dist = last ? Math.abs(r - last.r) + Math.abs(c - last.c) : 99;
        const pt = {
          x: (left + (c + 0.5) * MATCH3_JUMP_PX) / viewport.width,
          y: (top + (r + 0.5) * MATCH3_JUMP_PX) / viewport.height,
          r,
          c
        };
        candidates.push(pt);
        if (dist >= 2) far.push(pt);
      }
    }
    const pool = far.length ? far : (candidates.length ? candidates : [{
      x: (box.left + box.right) / 2,
      y: (box.top + box.bottom) / 2,
      r: 0,
      c: 0
    }]);
    const pt = pool[Math.floor(Math.random() * pool.length)];
    pickme.lastJump = { r: pt.r, c: pt.c };
    return pt;
  }

  function buildGridCells(opts) {
    const box = getRegionBox(opts);
    const rows = Math.max(1, Number(opts && opts.rows) || 4);
    const cols = Math.max(1, Number(opts && opts.cols) || 5);
    const cellW = (box.right - box.left) / cols;
    const cellH = (box.bottom - box.top) / rows;
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cells.push({
          x: box.left + (c + 0.5) * cellW,
          y: box.top + (r + 0.5) * cellH,
          r,
          c
        });
      }
    }
    return cells;
  }

  async function tapRatio(xRatio, yRatio) {
    if (page.isClosed()) return;
    const viewport = page.viewportSize() || { width: 500, height: 700 };
    const x = Math.floor(viewport.width * xRatio);
    const y = Math.floor(viewport.height * yRatio);
    // 只用一次 click，避免 mouse+touch 叠两次把主进程打满
    await page.mouse.click(x, y, { delay: 20 });
  }

  function getClickInterval() {
    return Math.max(200, Number(regionClick && regionClick.interval) || 800);
  }

  function stopRegionClick() {
    const running = !!regionClickTimer;
    regionClickGen++;
    regionClickBusy = false;
    if (regionClickTimer) {
      clearTimeout(regionClickTimer);
      regionClickTimer = null;
    }
    regionClickIndex = 0;
    if (running) console.log('STOP REGION CLICK');
  }

  function scheduleRegionClick(cells, gen) {
    if (gen !== regionClickGen) return;
    const interval = getClickInterval();
    regionClickTimer = setTimeout(async () => {
      if (gen !== regionClickGen || page.isClosed()) return;
      if (regionClickBusy) {
        scheduleRegionClick(cells, gen);
        return;
      }
      regionClickBusy = true;
      try {
        const pt = cells[regionClickIndex % cells.length];
        regionClickIndex++;
        await tapRatio(pt.x, pt.y);
      } catch (e) {
        console.log('REGION CLICK ERROR:', e.message);
      } finally {
        regionClickBusy = false;
      }
      if (gen === regionClickGen) scheduleRegionClick(cells, gen);
    }, interval);
  }

  function startRegionClick() {
    if (regionClickTimer) return;
    stopPickMeClick();
    const cells = buildGridCells(regionClick || {});
    const gen = ++regionClickGen;
    regionClickIndex = 0;
    regionClickBusy = false;
    console.log('START REGION CLICK', cells.length, '格, interval', getClickInterval());
    scheduleRegionClick(cells, gen);
  }

  function stopPickMeClick() {
    const running = pickme.active || pickme.retryTimer || pickme.scatterTimer;
    pickme.scatterGen++;
    pickme.active = false;
    pickme.mode = null;
    pickme.waitingPair = false;
    pickme.seenReq = false;
    pickme.seenRes = false;
    pickme.clicking = false;
    pickme.lastJump = null;
    pickme.pointIndex = 0;
    if (pickme.retryTimer) {
      clearTimeout(pickme.retryTimer);
      pickme.retryTimer = null;
    }
    if (pickme.scatterTimer) {
      clearTimeout(pickme.scatterTimer);
      pickme.scatterTimer = null;
    }
    if (running) console.log('STOP PICKME');
  }

  function schedulePickMeScatter(gen) {
    if (gen !== pickme.scatterGen) return;
    const interval = getClickInterval();
    pickme.scatterTimer = setTimeout(async () => {
      if (gen !== pickme.scatterGen || !pickme.active || pickme.mode !== 'scatter') return;
      if (page.isClosed()) return;
      if (pickme.clicking) {
        schedulePickMeScatter(gen);
        return;
      }
      pickme.clicking = true;
      try {
        const pt = nextPickmePoint();
        const cell = pt.r != null ? ` r${pt.r + 1}c${pt.c + 1}` : '';
        console.log('PICKME CLICK', pt.i + 1 + '/' + pt.total + cell, pt.x.toFixed(3), pt.y.toFixed(3));
        await tapRatio(pt.x, pt.y);
      } catch (e) {
        console.log('PICKME CLICK ERROR:', e.message);
      } finally {
        pickme.clicking = false;
      }
      if (gen === pickme.scatterGen && pickme.active && pickme.mode === 'scatter') {
        schedulePickMeScatter(gen);
      }
    }, interval);
  }

  function startPickMeScatter() {
    if (pickme.mode === 'pair') return;
    if (pickme.active && pickme.mode === 'scatter') return;
    stopRegionClick();
    pickme.active = true;
    pickme.mode = 'scatter';
    pickme.waitingPair = false;
    pickme.clicking = false;
    pickme.pointIndex = 0;
    const gen = ++pickme.scatterGen;
    const mode = (regionClick && regionClick.pickmeMode) || 'fixed';
    const n = getPickmeScatterPoints(regionClick || {}).length;
    const modeLabel = mode === 'grid' ? '区域切块' : '固定坐标';
    console.log('START PICKME', modeLabel, n, '点, interval', getClickInterval());
    if (pickme.scatterTimer) {
      clearTimeout(pickme.scatterTimer);
      pickme.scatterTimer = null;
    }
    schedulePickMeScatter(gen);
  }

  async function clickPickMePairPoint() {
    if (!pickme.active || pickme.mode !== 'pair' || page.isClosed() || pickme.clicking) return;
    pickme.clicking = true;
    pickme.seenReq = false;
    pickme.seenRes = false;
    pickme.waitingPair = true;
    const pt = nextMatch3JumpPoint();
    console.log('MATCH3 JUMP', 'row', pt.r, 'col', pt.c);
    try {
      await tapRatio(pt.x, pt.y);
    } catch (e) {
      console.log('MATCH3 CLICK ERROR:', e.message);
    } finally {
      pickme.clicking = false;
    }
    if (!pickme.active || pickme.mode !== 'pair') return;
    if (!pickme.waitingPair) {
      clickPickMePairPoint();
      return;
    }
    if (pickme.retryTimer) clearTimeout(pickme.retryTimer);
    pickme.retryTimer = setTimeout(() => {
      if (pickme.active && pickme.mode === 'pair' && pickme.waitingPair) {
        clickPickMePairPoint();
      }
    }, Math.max(300, getClickInterval()));
  }

  function startPickMePairClick() {
    if (pickme.active && pickme.mode === 'pair') return;
    stopRegionClick();
    if (pickme.scatterTimer) {
      clearTimeout(pickme.scatterTimer);
      pickme.scatterTimer = null;
    }
    pickme.scatterGen++;
    pickme.active = true;
    pickme.mode = 'pair';
    pickme.waitingPair = false;
    pickme.lastJump = null;
    pickme.clicking = false;
    console.log('START MATCH3 40px 格子跳动，成对后换点');
    clickPickMePairPoint();
  }

  function onPickMeRevealed(type) {
    console.log('PICKME 类型', type);
    if (type === 'MATCH3') {
      startPickMePairClick();
      return;
    }
    stopPickMeClick();
    startRegionClick();
  }

  function onPickMeWsFrame(payloadText, kind) {
    if (!pickme.active || pickme.mode !== 'pair' || !pickme.waitingPair) return;
    if (kind === 'send' && isAmigoActionRequest(payloadText)) {
      pickme.seenReq = true;
    }
    if (kind === 'recv' && isAmigoActionResponse(payloadText)) {
      pickme.seenRes = true;
    }
    if (pickme.seenReq && pickme.seenRes) {
      pickme.waitingPair = false;
      if (pickme.retryTimer) {
        clearTimeout(pickme.retryTimer);
        pickme.retryTimer = null;
      }
      console.log('MATCH3 成对，换点位');
      if (!pickme.clicking) clickPickMePairPoint();
    }
  }

  function applyAmigoRecvSignals(payloadText, allowRefresh) {
    if (String(gameType).toLowerCase() !== 'amigo') return;
    const refreshReason = allowRefresh && !useAmigoHttp
      ? getAmigoDemoRefreshReason(payloadText)
      : null;
    if (refreshReason) {
      console.log(
        refreshReason === 'balance'
          ? 'SOCKET: Amigo 余额不足，重新取链'
          : 'SOCKET: Amigo ErrorResponse code=403'
      );
      stopPickMeClick();
      stopRegionClick();
      refreshAmigoLink(page, refreshReason).catch(e =>
        console.log('AMIGO refresh error:', e.message)
      );
    }

    const pick = getAmigoPickMeSignal(payloadText);
    if (pick && pick.phase === 'scatter') startPickMeScatter();
    if (pick && pick.phase === 'revealed') onPickMeRevealed(pick.type);

    const fg2 = getAmigoFreeGame2Signal(payloadText);
    const fg = getAmigoFeaturePlaySignal(payloadText, 'FREE_GAME');
    const m3 = getAmigoFeaturePlaySignal(payloadText, 'MATCH3');

    if (fg2 === 'stop' || fg === 'stop' || m3 === 'stop') {
      stopRegionClick();
      stopPickMeClick();
    } else {
      if (fg2 === 'start' || fg === 'start') {
        if (pickme.mode === 'scatter') stopPickMeClick();
        if (pickme.mode !== 'pair') startRegionClick();
      }
      if (m3 === 'start') {
        if (pickme.mode === 'scatter') stopPickMeClick();
        startPickMePairClick();
      }
    }

    onPickMeWsFrame(payloadText, 'recv');
  }

  function applyVaRecvSignals(payloadText) {
    if (String(gameType).toLowerCase() !== 'va') return;
    const reason = getVaDemoRefreshReason(payloadText);
    if (reason === 'balance' || reason === 'kick') {
      console.log(
        'SOCKET: VA',
        reason === 'kick' ? '未下注被踢' : '余额不足',
        '重新取链'
      );
      refreshVaLink(page, reason).catch(e =>
        console.log('VA refresh error:', e.message)
      );
      return;
    }
    const snap = getVaBalanceSnapshot(payloadText);
    if (!snap) return;
    if (snap.userPointBefore != null && vaLastBalance != null) {
      const cost = vaLastBalance - snap.userPointBefore;
      if (cost > 0 && cost < 10000) vaLastBet = cost;
    }
    if (snap.balance != null) vaLastBalance = snap.balance;
    else if (snap.userPointBefore != null) vaLastBalance = snap.userPointBefore;
    const spendable = snap.balance != null ? snap.balance : snap.userPointBefore;
    if (spendable != null && vaLastBet > 0 && spendable + 1e-9 < vaLastBet) {
      console.log('SOCKET: VA 余额不够下一注，重新取链', spendable, '<', vaLastBet);
      refreshVaLink(page).catch(e =>
        console.log('VA refresh error:', e.message)
      );
    }
  }

  function handleAmigoHttpExchange(url, request, buffer) {
    if (!useAmigoHttp || !isAmigoHttpApiUrl(url)) return;
    let reqText = '';
    try {
      reqText = (request && request.postData()) || '';
    } catch (_) { }
    if (reqText) onPickMeWsFrame(reqText, 'send');
    const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
    if (text) applyAmigoRecvSignals(text, false);
  }

  function decodeWsPayload(payload) {
    if (typeof payload === 'string') return payload;
    if (Buffer.isBuffer(payload)) return payload.toString('utf8');
    if (payload != null) return Buffer.from(payload).toString('utf8');
    return '';
  }

  function startImageFlow(steps, options = {}) {
    stopCombinedFlow();
    stopAutoClick();
    startVaKeepAliveClick();
    return imageFlow.start(steps, options);
  }

  function stopImageFlow() {
    stopVaKeepAliveClick();
    imageFlow.stop();
  }

  // =========================
  // 模式三：自动点击 + 图像识别 联动编排
  //   点击 clickCount 次 -> 执行一次完整图像识别流程 -> 完成后重新开始点击，循环往复
  // =========================
  let combinedRunning = false;
  let combinedTimer = null;

  function combinedLog(msg, onLog) {
    console.log(msg);
    if (typeof onLog === 'function') {
      try { onLog(msg); } catch (e) { }
    }
  }

  function doCombinedClicks(clickOpts, count, onLog, onDone) {
    let clicked = 0;
    const interval = Math.max(200, Number(clickOpts.interval) || 2000);
    const xPercent = Number(clickOpts.xPercent) || 0.5;
    const yPercent = Number(clickOpts.yPercent) || 0.5;

    combinedTimer = setInterval(async () => {
      if (!combinedRunning || page.isClosed()) {
        clearInterval(combinedTimer);
        combinedTimer = null;
        return;
      }

      try {
        const viewport = page.viewportSize() || { width: 1280, height: 720 };
        const x = Math.floor(viewport.width * xPercent);
        const y = Math.floor(viewport.height * yPercent);

        await page.mouse.click(x, y, { delay: 20 });

        clicked++;
        combinedLog(`模式三 自动点击 ${clicked}/${count}`, onLog);
      } catch (e) {
        console.log('COMBINED CLICK ERROR:', e.message);
      }

      if (clicked >= count) {
        clearInterval(combinedTimer);
        combinedTimer = null;
        if (typeof onDone === 'function') onDone();
      }
    }, interval);
  }

  function runCombinedCycle(clickOpts, count, steps, imageOptions, onLog) {
    if (!combinedRunning || page.isClosed()) return;

    // 阶段一：自动点击 count 次
    combinedLog(`模式三 开始新一轮：先自动点击 ${count} 次`, onLog);
    doCombinedClicks(clickOpts, count, onLog, () => {
      if (!combinedRunning || page.isClosed()) return;

      // 阶段二：执行一次完整图像识别流程（按所选模式匹配）
      combinedLog('模式三 点击已达设定次数，开始执行图像识别流程', onLog);
      imageFlow.start(steps, {
        ...imageOptions,
        onLog,
        once: true,
        onComplete: () => {
          if (!combinedRunning || page.isClosed()) return;
          // 阶段三：图像识别完整跑完一轮后，重新开始自动点击
          combinedLog('模式三 图像识别流程完成，重新开始自动点击', onLog);
          runCombinedCycle(clickOpts, count, steps, imageOptions, onLog);
        }
      });
    });
  }

  function startCombinedFlow({ clickOpts = {}, clickCount = 20, steps = [], imageOptions = {}, onLog } = {}) {
    // 先停掉其它模式
    stopAutoClick();
    imageFlow.stop();
    if (combinedTimer) {
      clearInterval(combinedTimer);
      combinedTimer = null;
    }

    combinedRunning = true;
    const count = Math.max(1, Number(clickCount) || 20);
    startVaKeepAliveClick();
    combinedLog(`模式三 启动：每点击 ${count} 次触发一次图像识别流程`, onLog);
    runCombinedCycle(clickOpts, count, steps, imageOptions, onLog);
  }

  function stopCombinedFlow() {
    stopVaKeepAliveClick();
    if (!combinedRunning && !combinedTimer) return;
    combinedRunning = false;
    if (combinedTimer) {
      clearInterval(combinedTimer);
      combinedTimer = null;
    }
    imageFlow.stop();
  }
  // =========================
  // ① 页面统一处理逻辑（你原本的逻辑保留）
  // =========================
  const handlePage = (page) => {
    page.on('request', request => {
      noteResourceUrl(request.url());
    });

    // 兜底：未走 route 的接口补抓；静态资源只记清单，不读 body
    page.on('response', async response => {
      try {
        const url = response.url();
        if (shouldSkipCapture(url) || isCloudflareChallengeUrl(url)) return;
        noteResourceUrl(url);

        const status = response.status();
        if (status < 200 || status >= 300) return;

        let request = null;
        try {
          request = response.request();
        } catch (_) { }
        if (request && routeHandledRequests.has(request)) return;

        let contentType = '';
        let resourceType = 'other';
        let requestMethod = 'GET';
        try {
          contentType = response.headers()['content-type'] || '';
          if (request) {
            resourceType = request.resourceType();
            requestMethod = request.method();
          }
        } catch (_) { }

        if (resourceType === 'image' || resourceType === 'font' || resourceType === 'media' || resourceType === 'stylesheet' || resourceType === 'script') {
          return;
        }
        if (isStaticFileUrl(url)) return;
        if (!mightBeApiResponse(contentType, resourceType, url, apiPatterns)) return;

        let buffer = null;
        try {
          buffer = await response.body();
        } catch (e) {
          if (requestMethod.toUpperCase() !== 'GET') {
            console.log('BODY UNAVAILABLE (non-GET):', url, e.message);
            return;
          }
          try {
            const res = await context.request.get(url, { timeout: 30000 });
            if (res.ok()) {
              buffer = Buffer.from(await res.body());
              console.log('FALLBACK FETCH:', url);
            }
          } catch (e2) {
            console.log('BODY UNAVAILABLE:', url, e.message);
            return;
          }
        }

        if (!buffer || !buffer.length) return;
        scheduleCapture(url, buffer, contentType, resourceType);
        handleAmigoHttpExchange(url, request, buffer);
      } catch (e) {
        // 忽略错误
      }
    });

    // websocket：按游戏策略保存服务端下行帧
    page.on('websocket', ws => {
      const wsUrl = ws.url();
      console.log('WEBSOCKET:', wsUrl);
      noteResourceUrl(wsUrl);
      if (String(gameType).toLowerCase() === 'va' && isVaGameSocket(wsUrl)) {
        vaGameSocketOpen++;
      }

      ws.on('framesent', event => {
        try {
          const payloadText = decodeWsPayload(event.payload);
          if (!payloadText || !String(payloadText).trim()) return;
          if (String(gameType).toLowerCase() === 'amigo' && !useAmigoHttp) {
            onPickMeWsFrame(payloadText, 'send');
          }
        } catch (e) {
          console.log('SOCKET SENT ERROR:', e.message);
        }
      });

      ws.on('framereceived', event => {
        try {
          const isVa = String(gameType).toLowerCase() === 'va';
          let payloadText = '';
          if (isVa) {
            const raw = event.payload;
            if (typeof raw === 'string') {
              payloadText = raw;
            } else if (raw != null) {
              const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
              if (buf.length) payloadText = buf.toString('hex');
            }
          } else {
            payloadText = decodeWsPayload(event.payload);
          }
          if (!payloadText || !String(payloadText).trim()) return;

          if (String(gameType).toLowerCase() === 'amigo' && !useAmigoHttp) {
            applyAmigoRecvSignals(payloadText, true);
          }

          const resolved = resolveSocketSave(gameType, payloadText);
          if (String(gameType).toLowerCase() === 'va' && resolved && resolved.line) {
            applyVaRecvSignals(resolved.line);
          }
          if (!resolved || !resolved.line) return;

          let fileName = resolved.fileName;
          if (!fileName) {
            // 通用：按 ws 主机+路径命名
            try {
              const u = new URL(wsUrl);
              fileName = sanitizeFileName(
                (u.hostname + u.pathname).replace(/\//g, '_')
              );
            } catch (e) {
              fileName = 'ws_' + Date.now();
            }
          }

          const socketPath = path.join(SOCKET_DIR, fileName + '.txt');
          fs.appendFile(socketPath, resolved.line + '\n', () => {});
          console.log('SOCKET APPENDED:', socketPath, `(${resolved.kind})`);
        } catch (e) {
          console.log('SOCKET SAVE ERROR:', e.message);
        }
      });

      ws.on('close', () => {
        console.log('WEBSOCKET CLOSED:', wsUrl);
        if (String(gameType).toLowerCase() !== 'va' || !isVaGameSocket(wsUrl)) {
          return;
        }
        vaGameSocketOpen = Math.max(0, vaGameSocketOpen - 1);
        if (vaStopped || vaRefreshing) return;
        setTimeout(() => {
          if (vaStopped || vaRefreshing || vaGameSocketOpen > 0) return;
          if (!page || page.isClosed()) return;
          console.log('SOCKET: VA 游戏连接断开，按未下注踢人换链');
          refreshVaLink(page, 'kick').catch(e =>
            console.log('VA refresh error:', e.message)
          );
        }, 2500);
      });
    });

  };

  // iframe / popup 支持（保留）
  context.on('page', page => {
    handlePage(page);
  });

  handlePage(page);

  // =========================
  // 打开页面
  // =========================
  const gotoOpts = {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  };
  if (String(gameType).toLowerCase() === 'amigo') {
    gotoOpts.referer = 'https://amigogaming.com/games';
  }
  if (String(gameType).toLowerCase() === 'va') {
    gotoOpts.referer = 'https://www.va-game.com/en/game?category=slot';
  }
  async function gotoStart(url) {
    await page.goto(url, gotoOpts);
    if (String(gameType).toLowerCase() === 'amigo' && !useAmigoHttp) {
      try {
        await page.waitForURL(
          (u) => isAmigoPlayReadyUrl(u.href),
          { timeout: 45000 }
        );
        console.log('AMIGO 已跳转:', page.url());
      } catch (_) {
        console.log('AMIGO 仍停在 launch 页:', page.url());
      }
    }
  }

  try {
    await gotoStart(startUrl);
  } catch (e) {
    if (String(gameType).toLowerCase() === 'amigo' && amigoGameId) {
      try {
        console.log('AMIGO 打开失败，重新取链再开:', e.message);
        startUrl = await fetchAmigoDemoLink(amigoGameId, {
          sessionType: 'mobile'
        });
        console.log('AMIGO LINK:', startUrl);
        await gotoStart(startUrl);
      } catch (e2) {
        try { await browser.close(); } catch (_) { }
        throw e2;
      }
    } else {
      try { await browser.close(); } catch (_) { }
      throw e;
    }
  }
  try {
    const blocked = await page.locator('text=Sorry, you have been blocked').count();
    if (blocked > 0) {
      console.log(
        '检测到 Cloudflare 拦截。请确认已安装本机 Chrome；若仍被拦，多半是 IP/机房网络被风控，需换网络后重试。'
      );
    }
  } catch (_) { }
  console.log('页面已打开，持续抓取中...');

  setTimeout(() => {
    flushResourceList();
    console.log('=================================');
    console.log('窗口就绪', instanceIndex);
    console.log('资源清单:', resourceSet.size);
    console.log('API数量:', apiSet.size);
    console.log('=================================');
  }, 8000);

  return {
    page,
    browser,
    saveDir: EFFECTIVE_SAVE_DIR,
    getResourceInfo,
    downloadStaticResources,
    async close() {
      vaStopped = true;
      flushResourceList();
      stopVaKeepAliveClick();
      stopCombinedFlow();
      stopImageFlow();
      stopRegionClick();
      stopPickMeClick();
      stopAutoClick();
      try {
        await browser.close();
      } catch (_) { }
    },
    startAutoClick,
    stopAutoClick,
    startImageFlow,
    stopImageFlow,
    startCombinedFlow,
    stopCombinedFlow,
    stopRegionClick,
    updateRegionClick
  };
};

module.exports.downloadListedResources = downloadListedResources;