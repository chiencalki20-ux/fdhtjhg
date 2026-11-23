/**
 * Amigo demo 游戏链接：HTTP 直连，不再打开网页。
 * GET /games 取 csrf + cookie，再 POST generateDemoGameLink。
 * 先走 Node IPv4（打包后不跟 Chromium 抢连接），失败再 Electron。
 */

const dns = require('dns');
const http = require('http');
const https = require('https');
const { URL } = require('url');

try { dns.setDefaultResultOrder('ipv4first'); } catch (_) { }

const nodeHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 2,
  maxFreeSockets: 1,
  family: 4,
  timeout: 20000
});
const nodeHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 2,
  maxFreeSockets: 1,
  family: 4,
  timeout: 20000
});

let officialQueue = Promise.resolve();
const sharedOfficialSession = {};
function enqueueOfficial(fn) {
  const run = officialQueue.then(() => fn(), () => fn());
  officialQueue = run.then(() => {}, () => {});
  return run;
}

const DEMO_LINK_API = 'https://amigogaming.com/generateDemoGameLink';
const CSRF_BOOTSTRAP_URL = 'https://amigogaming.com/games';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const COMMON_HEADERS = {
  'User-Agent': CHROME_UA,
  'Accept-Language': 'en-US,en;q=0.9'
};

function extractCsrfToken(html) {
  const text = String(html || '');
  const m =
    text.match(/<meta[^>]+name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i) ||
    text.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i);
  return m ? m[1].trim() : null;
}

function wrapNetError(err) {
  const msg = String(err && err.message || err);
  if (/HTTP 503/i.test(msg)) {
    return new Error(
      'Amigo 官网取链接口暂时不可用（503）。这不是游戏 id 写错，官网 Play Demo 现在同样失败。请稍后重试，或改用手动输入链接。'
    );
  }
  if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|socket hang up|net::ERR_|fetch failed|请求超时/i.test(msg)) {
    return new Error(
      '无法连接 amigogaming.com。请检查网络，或改用手动输入链接。'
    );
  }
  return err;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function isRetryableAmigoError(err) {
  const msg = String(err && err.message || err);
  return /419|csrf|token|429|50[0-9]|408|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|socket hang up|fetch failed|aborted|AbortError|net::ERR_|无法连接|非链接|未找到 csrf|超时/i.test(msg);
}

function isConnError(err) {
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|socket hang up|net::ERR_|fetch failed|请求超时|无法连接/i.test(
    String(err && err.message || err)
  );
}

function wrapNodeResponse(status, headers, body) {
  const raw = headers['set-cookie'];
  const setCookie = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const v = headers[String(name || '').toLowerCase()];
        if (v == null) return null;
        return Array.isArray(v) ? String(v[0]) : String(v);
      },
      getSetCookie() {
        return setCookie;
      }
    },
    async text() {
      return body.toString('utf8');
    }
  };
}

function canUseElectronNet() {
  try {
    const { net, session, app } = require('electron');
    return !!(net && session && app && typeof app.isReady === 'function' && app.isReady());
  } catch (_) {
    return false;
  }
}

function normalizeHeaderMap(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[String(k).toLowerCase()] = v;
  }
  return out;
}

async function readElectronCookies(url) {
  try {
    const { session } = require('electron');
    const list = await session.fromPartition('amigo-link').cookies.get({ url });
    return (list || []).map((c) => c.name + '=' + c.value);
  } catch (_) {
    return [];
  }
}

function mergeSetCookieHeaders(headers, extraPairs) {
  if (!extraPairs || !extraPairs.length) return headers;
  const raw = headers['set-cookie'];
  const current = Array.isArray(raw) ? raw.slice() : raw ? [raw] : [];
  if (current.length) return headers;
  return { ...headers, 'set-cookie': extraPairs };
}

function electronNetRequest(url, options = {}, timeoutMs = 12000) {
  const { net, session } = require('electron');
  const ses = session.fromPartition('amigo-link');
  return new Promise((resolve, reject) => {
    let settled = false;
    const method = String(options.method || 'GET').toUpperCase();
    const req = net.request({
      method,
      url,
      session: ses,
      redirect: 'manual'
    });
    const headers = { ...COMMON_HEADERS, ...(options.headers || {}) };
    for (const [k, v] of Object.entries(headers)) {
      if (v == null || k === 'redirect' || k === 'signal') continue;
      try { req.setHeader(k, String(v)); } catch (_) { }
    }

    const done = (err, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(res);
    };

    const timer = setTimeout(() => {
      try { req.abort(); } catch (_) { }
      done(new Error('请求超时: ' + url));
    }, timeoutMs);

    req.on('redirect', (statusCode, _method, redirectUrl, responseHeaders) => {
      done(null, wrapNodeResponse(
        statusCode,
        { ...normalizeHeaderMap(responseHeaders), location: redirectUrl },
        Buffer.alloc(0)
      ));
      try { req.abort(); } catch (_) { }
    });

    req.on('response', (response) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        readElectronCookies(url).then((pairs) => {
          done(null, wrapNodeResponse(
            response.statusCode || 0,
            mergeSetCookieHeaders(response.headers, pairs),
            body
          ));
        }).catch(() => {
          done(null, wrapNodeResponse(
            response.statusCode || 0,
            response.headers,
            body
          ));
        });
      });
      response.on('error', (e) => done(e));
    });

    req.on('error', (e) => done(e));
    if (options.body != null) req.write(String(options.body));
    req.end();
  });
}

function rawRequest(url, options = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const method = String(options.method || 'GET').toUpperCase();
    const headers = {
      ...COMMON_HEADERS,
      ...(options.headers || {}),
      'Accept-Encoding': 'identity'
    };
    delete headers.redirect;
    delete headers.signal;
    const body = options.body == null ? null : Buffer.from(String(options.body));
    if (body) headers['Content-Length'] = String(body.length);

    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method,
      headers,
      family: 4,
      servername: u.hostname,
      agent: u.protocol === 'http:' ? nodeHttpAgent : nodeHttpsAgent,
      lookup(hostname, opts, cb) {
        dns.lookup(hostname, { family: 4, all: false }, cb);
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(wrapNodeResponse(res.statusCode || 0, res.headers, Buffer.concat(chunks)));
      });
    });

    const timer = setTimeout(() => {
      req.destroy();
      if (settled) return;
      settled = true;
      reject(new Error('请求超时: ' + url));
    }, timeoutMs);

    req.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(e);
    });
    if (body) req.write(body);
    req.end();
  });
}

async function oneRequest(url, options = {}, timeoutMs = 20000) {
  try {
    return await rawRequest(url, options, timeoutMs);
  } catch (e) {
    if (canUseElectronNet() && isConnError(e)) {
      console.log('AMIGO: Node 请求失败，改 Chromium:', String(e && e.message || e).slice(0, 120));
      return electronNetRequest(url, options, Math.min(timeoutMs, 12000));
    }
    throw e;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const follow = options.redirect !== 'manual';
  const maxHops = follow ? 5 : 1;
  let current = url;
  let opts = { ...options };
  for (let i = 0; i < maxHops; i++) {
    const res = await oneRequest(current, opts, timeoutMs);
    const loc = res.headers.get('location');
    if (follow && res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).href;
      opts = { ...opts, method: 'GET', body: undefined };
      continue;
    }
    return res;
  }
  throw new Error('重定向过多: ' + url);
}

async function withRetry(fn, label, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = String(e && e.message || e);
      if (!isRetryableAmigoError(e) || i === tries - 1) throw e;
      const wait = /503/.test(msg)
        ? 2000 * (i + 1)
        : /ECONNRESET|ETIMEDOUT|超时|无法连接|net::ERR_/.test(msg)
          ? 1500 * (i + 1)
          : 800 * (i + 1);
      console.log(`AMIGO: ${label}失败，${wait}ms 后重试 (${i + 1}/${tries - 1}):`, msg.slice(0, 120));
      await sleep(wait);
    }
  }
  throw last;
}

function cookieHeaderFromSetCookie(setCookieList) {
  const map = new Map();
  for (const raw of setCookieList || []) {
    if (!raw) continue;
    const pair = String(raw).split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    map.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...map.entries()].map(([k, v]) => k + '=' + v).join('; ');
}

function mergeCookieHeader(prev, setCookieList) {
  const map = new Map();
  for (const part of String(prev || '').split(';')) {
    const pair = part.trim();
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    map.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  for (const raw of setCookieList || []) {
    if (!raw) continue;
    const pair = String(raw).split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    map.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...map.entries()].map(([k, v]) => k + '=' + v).join('; ');
}

function readSetCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') {
    return res.headers.getSetCookie();
  }
  const one = res.headers.get('set-cookie');
  return one ? [one] : [];
}

async function createAmigoSession() {
  const res = await fetchWithTimeout(CSRF_BOOTSTRAP_URL, {
    headers: {
      ...COMMON_HEADERS,
      Accept: 'text/html,application/xhtml+xml'
    },
    redirect: 'follow'
  });
  const html = await res.text();
  const csrf = extractCsrfToken(html);
  if (!res.ok) {
    throw new Error('获取 Amigo 页面失败: HTTP ' + res.status);
  }
  if (!csrf) {
    throw new Error('未找到 csrf-token，站点可能拦了直连请求');
  }
  return {
    csrf,
    cookie: cookieHeaderFromSetCookie(readSetCookies(res))
  };
}

async function postDemoLink(session, id, sessionType) {
  const res = await fetchWithTimeout(DEMO_LINK_API, {
    method: 'POST',
    headers: {
      ...COMMON_HEADERS,
      Accept: 'text/plain, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-TOKEN': session.csrf,
      Cookie: session.cookie,
      Origin: 'https://amigogaming.com',
      Referer: CSRF_BOOTSTRAP_URL
    },
    body: new URLSearchParams({ id, sessionType }).toString(),
    redirect: 'follow'
  });
  session.cookie = mergeCookieHeader(session.cookie, readSetCookies(res));
  const text = String(await res.text()).trim();
  if (!res.ok) {
    throw new Error(`generateDemoGameLink HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!/^https?:\/\//i.test(text)) {
    throw new Error(`generateDemoGameLink 返回非链接: ${text.slice(0, 200)}`);
  }
  return text;
}

function isAmigoPlayReadyUrl(url) {
  const href = String(url || '');
  if (!href) return false;
  return !/\/session\/open\/sid\//i.test(href)
    && !/\/icasino\/sessions\/launch/i.test(href)
    && !/\/organic2\/websocket\/launch/i.test(href)
    && !/\/js-frontend\/html5\//i.test(href);
}

function isAmigoHtml5LoaderUrl(url) {
  return /\/js-frontend\/html5\//i.test(String(url || ''));
}

async function followAmigoRedirects(startUrl) {
  let url = String(startUrl || '').trim();
  let cookie = '';
  let res = null;
  for (let i = 0; i < 8; i++) {
    res = await fetchWithTimeout(url, {
      redirect: 'manual',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        Referer: i === 0 ? CSRF_BOOTSTRAP_URL : url,
        Cookie: cookie
      }
    }, 15000);
    cookie = mergeCookieHeader(cookie, readSetCookies(res));
    const loc = res.headers.get('location');
    if (!loc) return { url, cookie, res };
    url = new URL(loc, url).href;
  }
  return { url, cookie, res };
}

function finalizeAmigoPlayUrl(resourcesLocation, html5Url, info) {
  const play = new URL(resourcesLocation);
  const src = new URL(html5Url);
  for (const key of ['profile', 'resetSettings', 'exit']) {
    if (!play.searchParams.get(key) && src.searchParams.get(key)) {
      play.searchParams.set(key, src.searchParams.get(key));
    }
  }
  if (info && info.replayLink && !play.searchParams.get('replayLink')) {
    play.searchParams.set('replayLink', info.replayLink);
    if (info.replaySize != null) {
      play.searchParams.set('replaySize', String(info.replaySize));
    }
  }
  return play.href;
}

/** 跟完 sid / icasino / html5，POST launch 拿到所有游戏同一条可玩地址 */
async function resolveAmigoPlayUrl(startUrl) {
  const hop = await followAmigoRedirects(startUrl);
  if (isAmigoPlayReadyUrl(hop.url)) return hop.url;
  if (!isAmigoHtml5LoaderUrl(hop.url)) return hop.url || startUrl;

  const page = new URL(hop.url);
  const launch = page.searchParams.get('launch');
  if (!launch) return hop.url;

  const res = await fetchWithTimeout(launch, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: page.origin,
      Referer: hop.url,
      Cookie: hop.cookie
    },
    body: new URLSearchParams({
      session: page.searchParams.get('session') || '',
      sign: page.searchParams.get('sign') || '',
      info: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 GAME (lgen-US GR[500x700])',
      mobile: page.searchParams.get('mobile') || 'true'
    }).toString()
  }, 15000);

  const info = JSON.parse(await res.text());
  if (!info || !info.resourcesLocation) return hop.url;
  return finalizeAmigoPlayUrl(info.resourcesLocation, hop.url, info);
}

/**
 * @param {string|number} gameId
 * @param {{ sessionType?: 'mobile'|'desktop' }} [options]
 * @returns {Promise<string>} launch URL
 */
async function fetchAmigoDemoLink(gameId, options = {}) {
  const links = await fetchAmigoDemoLinks(gameId, 1, options);
  return links[0];
}

/**
 * 同一会话连续取多条 demo 链（给多窗口用）
 */
async function fetchAmigoDemoLinks(gameId, count, options = {}) {
  const id = String(gameId || '').trim();
  if (!id) throw new Error('amigo gameId 为空');
  const n = Math.max(1, Number(count) || 1);
  const sessionType = options.sessionType === 'desktop' ? 'desktop' : 'mobile';
  try {
    const links = [];
    for (let i = 0; i < n; i++) {
      console.log(`AMIGO: [${i + 1}/${n}] 直连取 demo 链接...`);
      const link = await enqueueOfficial(async () => {
        const session = options.session || sharedOfficialSession;
        if (!session.csrf) {
          const created = await withRetry(
            () => createAmigoSession(),
            '获取 csrf'
          );
          session.csrf = created.csrf;
          session.cookie = created.cookie;
        }
        return withRetry(async () => {
          try {
            return await postDemoLink(session, id, sessionType);
          } catch (e) {
            const msg = String(e && e.message || e);
            if (/419|csrf|token/i.test(msg)) {
              const next = await createAmigoSession();
              session.csrf = next.csrf;
              session.cookie = next.cookie;
              return await postDemoLink(session, id, sessionType);
            }
            throw e;
          }
        }, '取 demo 链');
      });
      let playUrl = link;
      try {
        playUrl = await resolveAmigoPlayUrl(link);
      } catch (e) {
        console.log('AMIGO: 解析可玩地址失败，仍用 sid 链:', e && e.message ? e.message : e);
      }
      if (playUrl !== link) {
        console.log('AMIGO: 直连打开', playUrl);
      }
      links.push(playUrl);
      if (i < n - 1) await sleep(500);
    }
    return links;
  } catch (e) {
    throw wrapNetError(e);
  }
}

function isAmigoGameId(value) {
  return /^\d+$/.test(String(value || '').trim());
}

module.exports = {
  DEMO_LINK_API,
  CHROME_UA,
  fetchAmigoDemoLink,
  fetchAmigoDemoLinks,
  resolveAmigoPlayUrl,
  isAmigoPlayReadyUrl,
  extractCsrfToken,
  isAmigoGameId
};
