/**
 * 各游戏 WebSocket 响应落盘策略。
 * 返回 { fileName, line }；无法识别时返回 null（调用方可走通用兜底）。
 *
 * Amigo 样例：
 * { "@type": "responses.ActionResponse", id: 1, balance: { "@type": "Balance", ... }, ... }
 * → 文件名用顶层 @type：responses.ActionResponse.txt
 */

const { decodeSfsPackets, vaMessageName } = require('./sfs2x-decode');

function toSingleLine(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/\r?\n/g, '');
}

function sanitizeFileName(name) {
  return String(name || 'unknown')
    .replace(/^type\.googleapis\.com\//i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 120) || 'unknown';
}

/**
 * Amigo 只用顶层 @type（忽略 balance/betParams 等嵌套里的 @type）
 * 例：responses.ActionResponse / features.States
 */
function extractTopLevelAtType(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj['@type'] === 'string' && obj['@type'].trim()) {
    return obj['@type'].trim();
  }
  return null;
}

/** 原文正则兜底：取第一个 "@type":"..."（通常即顶层） */
function extractAtTypeFromText(text) {
  const m = String(text).match(/"@type"\s*:\s*"([^"]+)"/);
  return m ? m[1].trim() : null;
}

function tryParseJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    return null;
  }
}

function atTypeToFileName(atType) {
  // type.googleapis.com/foo.Bar → foo.Bar；responses.ActionResponse 原样保留
  const short = atType.includes('/')
    ? atType.slice(atType.lastIndexOf('/') + 1)
    : atType;
  return sanitizeFileName(short);
}

/** Amigo：按顶层 @type 分文件 */
function handleAmigo(payloadText) {
  const line = toSingleLine(payloadText);
  if (!line) return null;

  let atType = null;
  const obj = tryParseJson(line);
  if (obj) {
    if (Array.isArray(obj)) {
      for (const item of obj) {
        atType = extractTopLevelAtType(item);
        if (atType) break;
      }
    } else {
      atType = extractTopLevelAtType(obj);
    }
  }
  if (!atType) {
    atType = extractAtTypeFromText(line);
  }
  if (!atType) return null;

  return {
    fileName: atTypeToFileName(atType),
    line,
    kind: 'amigo'
  };
}

/** 通用：整段 JSON/文本，文件名由调用方按 ws url 生成 */
function handleGeneric(payloadText) {
  const line = toSingleLine(payloadText);
  if (!line) return null;
  return {
    fileName: null,
    line,
    kind: 'generic'
  };
}

/** VA：文本 JSON 原样保存；SFS 二进制（hex）解成 JSON，按命令名分文件 */
function handleVa(payloadText) {
  const line = toSingleLine(payloadText);
  if (!line) return null;

  if (line.startsWith('{') || line.startsWith('[')) {
    const obj = tryParseJson(line);
    const name = obj && !Array.isArray(obj) ? (obj.router || obj.msg) : null;
    return {
      fileName: name ? sanitizeFileName(name) : null,
      line: obj ? toSingleLine(JSON.stringify(obj)) : line,
      kind: 'va'
    };
  }

  if (/^[0-9a-fA-F]+$/.test(line) && line.length % 2 === 0) {
    try {
      const msgs = decodeSfsPackets(Buffer.from(line, 'hex'));
      if (msgs.length) {
        const payload = msgs.length === 1 ? msgs[0] : msgs;
        const name = msgs.length === 1 ? vaMessageName(msgs[0]) : null;
        return {
          fileName: name ? sanitizeFileName(name) : null,
          line: toSingleLine(JSON.stringify(payload)),
          kind: 'va'
        };
      }
    } catch (e) {
      // 解不开就保留 hex
    }
  }

  return {
    fileName: null,
    line,
    kind: 'va'
  };
}

const HANDLERS = {
  amigo: handleAmigo,
  va: handleVa,
  generic: handleGeneric
};

/**
 * @param {string} gameType amigo | generic | ...
 * @param {string} payloadText 已解码的文本帧
 * @returns {{ fileName: string|null, line: string, kind: string }|null}
 */
function resolveSocketSave(gameType, payloadText) {
  const key = String(gameType || 'generic').toLowerCase();
  const handler = HANDLERS[key] || HANDLERS.generic;
  const result = handler(payloadText);
  if (result) return result;
  if (key !== 'generic') {
    return handleGeneric(payloadText);
  }
  return null;
}

/**
 * Amigo 链接失效：顶层 @type=responses.ErrorResponse 且 code=403
 */
function isAmigoLinkExpiredError(payloadText) {
  const line = toSingleLine(payloadText);
  if (!line) return false;
  const obj = tryParseJson(line);
  if (obj && !Array.isArray(obj)) {
    const at = extractTopLevelAtType(obj);
    if (at === 'responses.ErrorResponse') {
      const code = obj.code;
      return code === 403 || code === '403';
    }
  }
  if (!/"@type"\s*:\s*"responses\.ErrorResponse"/.test(line)) return false;
  return /"code"\s*:\s*"?403"?/.test(line);
}

function getAmigoBalanceAmount(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const raw = obj.balance && typeof obj.balance === 'object'
    ? obj.balance.amount
    : obj.amount;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function getAmigoSpinCost(obj) {
  const bp = obj && obj.betParams;
  if (!bp || typeof bp !== 'object') return 0;
  const bet = Number(bp.bet);
  const mul = Number(bp.multiplier);
  const den = Number(bp.denomination);
  if (!Number.isFinite(bet) || !Number.isFinite(den)) return 0;
  return bet * den * (Number.isFinite(mul) && mul > 0 ? mul : 1);
}

/**
 * 余额不足：ErrorResponse 报余额，或当前余额不够下一注。
 */
function isAmigoInsufficientBalance(payloadText) {
  const line = toSingleLine(payloadText);
  if (!line) return false;
  const obj = tryParseJson(line);
  if (obj && !Array.isArray(obj)) {
    const at = extractTopLevelAtType(obj);
    if (at === 'responses.ErrorResponse') {
      const code = obj.code;
      if (code === 402 || code === '402') return true;
      const msg = String(obj.message || obj.error || obj.reason || '');
      if (/insufficient|not enough|no.?funds|no.?balance|low.?balance|余额不足|余额不够/i.test(msg)) {
        return true;
      }
    }
    const amount = getAmigoBalanceAmount(obj);
    if (amount != null) {
      if (amount <= 0) return true;
      const cost = getAmigoSpinCost(obj);
      if (cost > 0 && amount < cost) return true;
    }
  }
  return /insufficient|not enough (balance|funds)|余额不足/i.test(line);
}

function getAmigoDemoRefreshReason(payloadText) {
  if (isAmigoLinkExpiredError(payloadText)) return '403';
  if (isAmigoInsufficientBalance(payloadText)) return 'balance';
  return null;
}

const AMIGO_FREE_GAME_TYPE = 'FREE_GAME_2';
const AMIGO_BONUS_TYPES = ['MATCH3', 'FREE_GAME', 'FREE_GAME_2'];

/**
 * 解析 Amigo states：ActionResponse / InitResponse 都会带 states
 *（进游戏若已在免费局，状态常在 InitResponse，不能只等 ActionResponse）
 */
function parseAmigoStates(payloadText) {
  const obj = tryParseJson(toSingleLine(payloadText));
  if (!obj || typeof obj !== 'object') return null;
  const at = obj['@type'];
  if (
    at !== 'responses.ActionResponse' &&
    at !== 'responses.InitResponse'
  ) {
    return null;
  }
  const states = obj.states;
  if (!states || typeof states !== 'object') return null;
  return states;
}

/**
 * 指定玩法开始/结束：
 * start：feature status=INIT|ACTIVE，且 current 或 initialized 指向该玩法
 *   （Fruit Invaders 等直接进免费局时常是 current=SLOT + initialized=FREE_GAME + status=INIT）
 * stop：current=该玩法 且 status=FINISHED
 */
function getAmigoFeaturePlaySignal(payloadText, featureId) {
  const states = parseAmigoStates(payloadText);
  if (!states || !featureId) return null;
  const feat = states[featureId];
  const status = feat && feat.status;
  const current = states.current;
  const initialized = states.initialized;
  if (
    (status === 'ACTIVE' || status === 'INIT') &&
    (current === featureId || initialized === featureId)
  ) {
    return 'start';
  }
  if (status === 'FINISHED' && current === featureId) {
    return 'stop';
  }
  return null;
}

/**
 * HAR 最后一局免费游戏：states.current = FREE_GAME_2
 * 开始：current=FREE_GAME_2 且 status=INIT|ACTIVE
 * 结束：FREE_GAME_2.status=FINISHED
 */
function getAmigoFreeGame2Signal(payloadText) {
  return getAmigoFeaturePlaySignal(payloadText, AMIGO_FREE_GAME_TYPE);
}

function getAmigoPayloadType(payloadText) {
  const obj = tryParseJson(toSingleLine(payloadText));
  return obj && typeof obj['@type'] === 'string' ? obj['@type'] : '';
}

function isAmigoActionRequest(payloadText) {
  return getAmigoPayloadType(payloadText) === 'requests.ActionRequest';
}

function isAmigoActionResponse(payloadText) {
  return getAmigoPayloadType(payloadText) === 'responses.ActionResponse';
}

/**
 * PICKME 预选（路径 A）：
 * scatter：initialized=PICKME 或 PICKME.status=INIT
 * revealed：current=PICKME 且 initialized 为 MATCH3 / FREE_GAME / FREE_GAME_2
 *
 * 若已直接在 FREE_GAME / FREE_GAME_2 / MATCH3 轮转中（路径 B），返回 null，
 * 由 getAmigoFeaturePlaySignal 触发区域/格子点击。
 */
function getAmigoPickMeSignal(payloadText) {
  const states = parseAmigoStates(payloadText);
  if (!states) return null;
  const current = states.current;
  const initialized = states.initialized;
  const pickStatus = states.PICKME && states.PICKME.status;

  // 已直接进入玩法轮转 → 不走 PICKME
  if (
    current === 'FREE_GAME' ||
    current === 'FREE_GAME_2' ||
    current === 'MATCH3'
  ) {
    return null;
  }

  if (current === 'PICKME' && AMIGO_BONUS_TYPES.indexOf(initialized) !== -1) {
    return { phase: 'revealed', type: initialized };
  }
  if (initialized === 'PICKME' || pickStatus === 'INIT') {
    return { phase: 'scatter' };
  }
  return null;
}

function parseVaMessages(payloadText) {
  const line = toSingleLine(payloadText);
  if (!line) return [];
  if (line.startsWith('{') || line.startsWith('[')) {
    const obj = tryParseJson(line);
    if (!obj) return [];
    return Array.isArray(obj) ? obj : [obj];
  }
  if (/^[0-9a-fA-F]+$/.test(line) && line.length % 2 === 0) {
    try {
      return decodeSfsPackets(Buffer.from(line, 'hex'));
    } catch (e) {
      return [];
    }
  }
  return [];
}

function vaInnerData(msg) {
  return msg && msg.p && msg.p.p && typeof msg.p.p === 'object' ? msg.p.p : null;
}

function getVaBalanceSnapshot(payloadText) {
  const msgs = parseVaMessages(payloadText);
  let snap = null;
  for (const m of msgs) {
    const data = vaInnerData(m);
    if (!data) continue;
    const next = { name: vaMessageName(m) || '' };
    if (data.Balance != null) {
      const n = Number(data.Balance);
      if (Number.isFinite(n)) next.balance = n;
    }
    if (data.UserPointBefore != null) {
      const n = Number(data.UserPointBefore);
      if (Number.isFinite(n)) next.userPointBefore = n;
    }
    if (data.Points != null && data.Ratio != null) {
      const n = Number(data.Points) / Number(data.Ratio);
      if (Number.isFinite(n)) next.balance = n;
    }
    if (next.balance != null || next.userPointBefore != null) snap = next;
  }
  return snap;
}

function isVaInsufficientBalance(payloadText) {
  const line = toSingleLine(payloadText);
  if (!line) return false;
  if (/insufficient|not enough (balance|funds|point)|no.?funds|no.?point|NoMoney|NoPoint|余额不足|余额不够|点数不足/i.test(line)) {
    return true;
  }
  const msgs = parseVaMessages(line);
  for (const m of msgs) {
    const name = vaMessageName(m) || '';
    if (/insufficient|NoMoney|NoPoint|NotEnough|余额不足/i.test(name)) return true;
    const data = vaInnerData(m);
    if (!data) continue;
    const bal = Number(data.Balance);
    if (Number.isFinite(bal) && bal <= 0) return true;
    const before = Number(data.UserPointBefore);
    if (Number.isFinite(before) && before <= 0) return true;
  }
  return false;
}

function isVaIdleKick(payloadText) {
  const line = toSingleLine(payloadText);
  if (!line) return false;
  if (
    /Kick@#\$|S_9005|haven't placed any bet|长时间未下注|您已离开游戏/i.test(line)
  ) {
    return true;
  }
  const msgs = parseVaMessages(line);
  for (const m of msgs) {
    const blob = JSON.stringify(m);
    if (
      /Kick@#\$|S_9005|haven't placed any bet|长时间未下注|您已离开游戏/i.test(blob)
    ) {
      return true;
    }
    const name = vaMessageName(m) || '';
    if (/LeaveGame|KickMsg/i.test(name)) return true;
  }
  return false;
}

function getVaDemoRefreshReason(payloadText) {
  if (isVaInsufficientBalance(payloadText)) return 'balance';
  if (isVaIdleKick(payloadText)) return 'kick';
  return null;
}

module.exports = {
  resolveSocketSave,
  sanitizeFileName,
  extractTopLevelAtType,
  extractAtTypeFromText,
  isAmigoLinkExpiredError,
  isAmigoInsufficientBalance,
  getAmigoDemoRefreshReason,
  getVaDemoRefreshReason,
  isVaIdleKick,
  getVaBalanceSnapshot,
  getAmigoFreeGame2Signal,
  getAmigoFeaturePlaySignal,
  getAmigoPickMeSignal,
  isAmigoActionRequest,
  isAmigoActionResponse,
  AMIGO_FREE_GAME_TYPE,
  AMIGO_BONUS_TYPES,
  HANDLERS
};
