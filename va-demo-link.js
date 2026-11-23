/**
 * VA demo 链接：官网 Play now 走 GET /api/getGameLink，再打开返回的 play url。
 * https://www.va-game.com/api/getGameLink?gameID={id}&lang=en-US&muteMusic=true&muteSound=true
 * → https://web.praise555.com/play/?token=...&language=en-US&icon=VA&redirectUrl=...
 */

const https = require('https');
const { URL } = require('url');

const VA_SITE = 'https://www.va-game.com';
const GET_GAME_LINK_API = VA_SITE + '/api/getGameLink';
const DEFAULT_LANGUAGE = 'en-US';
const DEFAULT_REDIRECT = VA_SITE + '/en/game?category=slot';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function isVaGameId(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function httpGetJson(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let settled = false;
    const req = https.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: 'GET',
      family: 4,
      headers: {
        'User-Agent': CHROME_UA,
        Accept: 'application/json, text/plain, */*',
        Referer: DEFAULT_REDIRECT,
        Origin: VA_SITE
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('VA getGameLink HTTP ' + res.statusCode + ': ' + text.slice(0, 200)));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (_) {
          reject(new Error('VA getGameLink 返回非 JSON: ' + text.slice(0, 200)));
        }
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      if (settled) return;
      settled = true;
      reject(new Error('VA 取链超时'));
    }, timeoutMs);
    req.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(e);
    });
    req.end();
  });
}

function appendRedirect(playUrl, redirectUrl) {
  const href = String(playUrl || '').trim();
  if (!href) throw new Error('VA getGameLink 未返回 url');
  if (!redirectUrl) return href;
  if (/[?&]redirectUrl=/i.test(href)) return href;
  return href + (href.includes('?') ? '&' : '?') + 'redirectUrl=' + redirectUrl;
}

async function fetchVaDemoLink(gameId, options = {}) {
  const id = String(gameId || '').trim();
  if (!id) throw new Error('VA gameId 为空');
  const lang = options.language || DEFAULT_LANGUAGE;
  const params = new URLSearchParams({
    gameID: id,
    lang,
    muteMusic: 'true',
    muteSound: 'true'
  });
  const json = await httpGetJson(GET_GAME_LINK_API + '?' + params.toString());
  const ok = json && json.status && String(json.status.code) === '0';
  const url = json && json.data && json.data.url;
  if (!ok || !url) {
    const msg = (json && json.status && json.status.message) || '未知错误';
    throw new Error('VA 取链失败: ' + msg);
  }
  const redirectUrl = options.redirectUrl === undefined ? DEFAULT_REDIRECT : options.redirectUrl;
  return appendRedirect(url, redirectUrl);
}

async function fetchVaDemoLinks(gameId, count, options = {}) {
  const n = Math.max(1, Number(count) || 1);
  const links = [];
  for (let i = 0; i < n; i++) {
    console.log(`VA: [${i + 1}/${n}] 官网取 demo 链接...`);
    links.push(await fetchVaDemoLink(gameId, options));
  }
  return links;
}

module.exports = {
  GET_GAME_LINK_API,
  DEFAULT_LANGUAGE,
  DEFAULT_REDIRECT,
  fetchVaDemoLink,
  fetchVaDemoLinks,
  isVaGameId
};
