/**
 * 从 PG 静态资源批量提取 Spin schema，并生成通用 pg-v4-spin-common.json。
 * 用法: node tools/extract-proto-schemas.js
 */
const fs = require('fs');
const path = require('path');
const { extractProtoClasses } = require('./pg-proto-classes');

const STATIC_ROOTS = [
  'c:/Users/User/Desktop/projet/game_resource/pg-v4/pg-static-v4',
  'c:/Users/User/Desktop/projet/game_resource/pg-v4/pg-static-v4-2'
];
const OUT_DIR = path.join(__dirname, '..', 'proto-schemas');
const GAME_IDS = [
  '68', '98', '104', '126', '135', '1451122', '1492288',
  '1543462', '1695365', '2009635', '2012025', '2100928'
];
/** 解混淆后按源码 proto 类精确生成（顶层 + GameInfo + 嵌套子消息），不参与 common 合并 */
const PRECISE_GAME_IDS = ['87', '1615454', '1671262', '1760238', '1799745'];

/** 已知 staticId → API slug（HAR/线上验证过的优先） */
const KNOWN_API_SLUGS = {
  '135': 'wild-bounty-sd',
  '87': 'treasures-of-aztec',
  '1671262': 'genstones-gold'
};

const SCALAR_TYPES = new Set([
  'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64',
  'fixed32', 'fixed64', 'sfixed32', 'sfixed64',
  'float', 'double', 'bool', 'string', 'bytes'
]);

/**
 * 框架内置类型（定义在加密的框架包里，读不到源码）。
 * Int32List：135 线上数据 wp 值为 {"f1":[0,6,8,11]}，即 f1 = packed int32。
 * DoubleList：同一套 *List 包装约定，f1 = packed double。
 * Int32ListCollection / FeatureBuy 无可核对数据，不定内层结构。
 */
const BUILTIN_MESSAGES = {
  Int32List: [{ name: null, id: 1, type: 'int32', repeated: true, packed: true, mapKey: null }],
  DoubleList: [{ name: null, id: 1, type: 'double', repeated: true, packed: true, mapKey: null }]
};

function classifyType(expr) {
  const e = String(expr).replace(/\s+/g, '');
  if (/\+'32'|\+"32"/.test(e)) return 'int32';
  if (/\+'64'|\+"64"/.test(e)) return 'int64';
  const plus = (e.match(/\+/g) || []).length;
  if (plus >= 5 && /['"]n['"]/.test(e)) return 'message';
  if (plus === 1) return 'float';
  if (plus >= 2 && plus <= 4) return 'string';
  return 'unknown';
}

function parseDecoratorFields(block) {
  const re = /\]\(\s*(?:['"]([\w]+)['"]|[^,]+)\s*,\s*(0x[0-9a-fA-F]+)\s*,\s*([^,]+)\s*,\s*(!0x[01]|!0|!1|true|false)\s*,\s*(!0x[01]|!0|!1|true|false)\s*,\s*(!0x[01]|!0|!1|true|false)\s*(?:,\s*([^)\]]+))?\)/g;
  const byId = new Map();
  let m;
  while ((m = re.exec(block))) {
    const id = parseInt(m[2], 16);
    if (!Number.isFinite(id) || id < 1) continue;
    const toBool = (s) => s === '!0x0' || s === '!0' || s === 'true';
    byId.set(id, {
      name: m[1] || null,
      id,
      type: classifyType(m[3].replace(/\s+/g, '')),
      repeated: toBool(m[4]),
      packed: toBool(m[5]),
      mapKeyInt32: !!m[7]
    });
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function extractSpinFields(text) {
  const anchors = ["'rl',0x35", '"rl",0x35', "'wp',0x65", '"wp",0x65'];
  const byId = new Map();
  for (const a of anchors) {
    let from = 0;
    let hits = 0;
    while (hits < 5) {
      const i = text.indexOf(a, from);
      if (i < 0) break;
      hits++;
      const block = text.slice(Math.max(0, i - 10000), Math.min(text.length, i + 16000));
      for (const f of parseDecoratorFields(block)) {
        if (f.id >= 51 && f.id <= 130) byId.set(f.id, f);
        else if (f.name) byId.set(f.id, f);
      }
      from = i + a.length;
    }
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function refineTypes(fields) {
  const byId = new Map(fields.map(f => [f.id, { ...f }]));
  const set = (id, patch) => {
    if (!byId.has(id)) return;
    Object.assign(byId.get(id), patch);
  };
  for (const f of byId.values()) {
    if (f.name === 'rl' || f.name === 'gs') {
      f.type = 'int32';
      f.repeated = true;
    }
    if (f.name === 'cs') f.type = 'float';
    if (f.name === 'wp') {
      f.type = 'message';
      f.mapKeyInt32 = true;
    }
    if (f.name === 'lw') {
      f.type = 'float';
      f.mapKeyInt32 = true;
    }
    if (['sc', 'gm', 'ml', 'fb'].includes(f.name)) f.type = 'int32';
  }
  set(51, { type: 'int32' });
  set(52, { type: 'float' });
  set(53, { type: 'int32', repeated: true });
  set(54, { type: 'float' });
  set(55, { type: 'int32' });
  set(56, { type: 'int32', mapKeyInt32: true });
  set(57, { type: 'int32' });
  set(58, { type: 'string' });
  set(59, { type: 'string' });
  set(60, { type: 'int32' });
  set(71, { type: 'uint64' });
  set(101, { type: 'message', mapKeyInt32: true });
  set(102, { type: 'float', mapKeyInt32: true });
  set(103, { type: 'int32', mapKeyInt32: true });
  set(104, { type: 'int32', repeated: true });
  set(105, { type: 'int32', repeated: true });
  set(106, { type: 'int32', repeated: true });
  set(107, { type: 'message', repeated: true });
  set(108, { type: 'int32' });
  set(109, { type: 'int32' });
  set(110, { type: 'int32' });
  set(111, { type: 'int32', repeated: true });
  set(112, { type: 'int32', repeated: true });
  set(113, { type: 'message', repeated: true });
  set(114, { type: 'int32', repeated: true });
  set(115, { type: 'float' });
  set(117, { type: 'float' });
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function findMainJs(gameDir) {
  const mainDir = path.join(gameDir, 'assets', 'main');
  if (!fs.existsSync(mainDir)) return null;
  const files = fs.readdirSync(mainDir).filter(f => /^index\.[a-f0-9]+\.js$/i.test(f));
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(path.join(mainDir, b)).size - fs.statSync(path.join(mainDir, a)).size);
  return path.join(mainDir, files[0]);
}

function detectDisplayName(gameDir) {
  const skip = /^(InfoboardMessage|FeatureBuy|Payout|Rules|History|Symbol)/;
  const counts = new Map();
  for (const f of fs.readdirSync(gameDir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(gameDir, f);
    if (fs.statSync(p).size > 100000) continue;
    const t = fs.readFileSync(p, 'utf8');
    const re = /"([A-Z][A-Za-z0-9]{5,})"\s*:\s*\{\s*"Name"\s*:/g;
    let m;
    while ((m = re.exec(t))) {
      if (skip.test(m[1])) continue;
      counts.set(m[1], (counts.get(m[1]) || 0) + 3);
    }
    const re2 = /"([A-Z][A-Za-z0-9]{8,})"\s*:\s*\{/g;
    while ((m = re2.exec(t))) {
      if (skip.test(m[1]) || /Payout|Rules|Feature|History/.test(m[1])) continue;
      counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0] ? sorted[0][0] : null;
}

function pascalToKebab(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

function mergeFieldUnion(schemas) {
  const byId = new Map();
  for (const s of schemas) {
    for (const f of s.fields || []) {
      if (!byId.has(f.id)) byId.set(f.id, { ...f });
      else {
        const cur = byId.get(f.id);
        if (!cur.name && f.name) cur.name = f.name;
        if (cur.type === 'unknown' && f.type !== 'unknown') cur.type = f.type;
        if (f.repeated) cur.repeated = true;
        if (f.mapKeyInt32) cur.mapKeyInt32 = true;
      }
    }
  }
  return refineTypes([...byId.values()]);
}

function findGameDir(id) {
  for (const root of STATIC_ROOTS) {
    const dir = path.join(root, id);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

/** 同名类（框架基类 + 游戏扩展）合并：含 baseId 的为基类，扩展类同号字段覆盖基类 */
function mergeClassFields(list, baseId) {
  const base = list.filter(c => c.fields.some(f => f.id === baseId));
  const ext = list.filter(c => !base.includes(c));
  const byId = new Map();
  for (const c of [...base, ...ext]) {
    for (const f of c.fields) byId.set(f.id, f);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function toSchemaFields(rawFields, classesByName, depth) {
  return rawFields.map(f => {
    let type = f.type;
    // 源码声明为 bytes，但由 WinThreshold 反序列化器解码
    if (f.name === 'wt' && type === 'bytes' && classesByName.has('WinThreshold')) type = 'WinThreshold';
    const scalar = SCALAR_TYPES.has(type);
    // optional 标量线上是包装消息 {f1: value}（GameInfo maxwm 实测 08 88 27 → {"f1":5000}）
    const wrapped = scalar && f.optional && !f.repeated && !f.mapKey;
    const out = {
      name: f.name,
      id: f.id,
      type: scalar && !wrapped ? type : 'message',
      repeated: f.repeated,
      packed: f.packed || (f.repeated && scalar && type !== 'string' && type !== 'bytes'),
      mapKeyInt32: f.mapKey === 'int32'
    };
    if (f.mapKey && f.mapKey !== 'int32') out.mapKeyType = f.mapKey;
    if (wrapped) {
      out.messageType = `optional ${type}`;
      out.messageSchema = {
        message: `optional ${type}`,
        fields: [{ name: null, id: 1, type, repeated: false, packed: false, mapKeyInt32: false }]
      };
    } else if (!scalar) {
      out.messageType = type;
      const sub = resolveMessageSchema(type, classesByName, depth + 1);
      if (sub) out.messageSchema = sub;
    }
    return out;
  });
}

function resolveMessageSchema(name, classesByName, depth) {
  if (depth > 8) return null;
  const raw = BUILTIN_MESSAGES[name] || (classesByName.has(name) ? mergeClassFields(classesByName.get(name), -1) : null);
  if (!raw) return null;
  return { message: name, fields: toSchemaFields(raw, classesByName, depth) };
}

function buildPreciseSchema(id, gameDir, mainJs, text) {
  const classes = extractProtoClasses(text);
  if (!classes || !classes.length) throw new Error('no proto classes');
  const classesByName = new Map();
  for (const c of classes) {
    if (!classesByName.has(c.name)) classesByName.set(c.name, []);
    classesByName.get(c.name).push(c);
  }
  if (!classesByName.has('SlotCommonResponse')) throw new Error('SlotCommonResponse missing');

  const prefixClass = classes.find(c => /(FreeSpin|BetRequest)$/.test(c.name));
  const displayName = prefixClass ? prefixClass.name.replace(/(FreeSpin|BetRequest)$/, '') : null;
  const slug = KNOWN_API_SLUGS[id] || (displayName ? pascalToKebab(displayName) : `game-${id}`);

  const spinFields = toSchemaFields(mergeClassFields(classesByName.get('SlotCommonResponse'), 53), classesByName, 0);
  // GameInfo 响应顶层同 Spin（上一局结果），游戏配置嵌在 f900（线上实测）
  if (classesByName.has('SlotGameInfoResponse')) {
    spinFields.push({
      name: 'gi',
      id: 900,
      type: 'message',
      repeated: false,
      packed: false,
      mapKeyInt32: false,
      messageType: 'SlotGameInfoResponse',
      messageSchema: {
        message: 'SlotGameInfoResponse',
        fields: toSchemaFields(mergeClassFields(classesByName.get('SlotGameInfoResponse'), 11), classesByName, 0)
      }
    });
  }

  return {
    source: `Protoutils classes (deobfuscated) in ${path.relative(path.dirname(gameDir), mainJs).replace(/\\/g, '/')}`,
    game: slug,
    displayName,
    staticId: id,
    matchPageGameId: true,
    apiPathIncludes: `/game-api/${slug}/`,
    apiPathIncludesAny: [`/game-api/${slug}/`],
    message: 'SlotCommonResponse',
    decorator: '(name, fieldId, type, repeated, packed, optional, mapKeyType?)',
    fields: spinFields
  };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const extracted = [];
  const index = [];

  for (const id of GAME_IDS) {
    const t0 = Date.now();
    const gameDir = findGameDir(id);
    if (!gameDir) {
      console.log(`[skip] ${id}: static dir missing`);
      continue;
    }
    const mainJs = findMainJs(gameDir);
    if (!mainJs) {
      console.log(`[skip] ${id}: no main js`);
      continue;
    }
    const text = fs.readFileSync(mainJs, 'utf8');
    const fields = refineTypes(extractSpinFields(text));
    const displayName = detectDisplayName(gameDir);
    const slugGuess = displayName ? pascalToKebab(displayName) : null;
    const slug = KNOWN_API_SLUGS[id] || null;
    const game = slug || slugGuess || `game-${id}`;
    const relSource = path.relative(path.dirname(gameDir), mainJs).replace(/\\/g, '/');

    const apiHints = [];
    if (slug) apiHints.push(`/game-api/${slug}/`);
    if (slugGuess && slugGuess !== slug) apiHints.push(`/game-api/${slugGuess}/`);

    const schema = {
      source: `Protoutils field meta in ${relSource}`,
      game,
      displayName: displayName || null,
      staticId: id,
      apiPathIncludes: apiHints[0] || null,
      apiPathIncludesAny: apiHints.length ? apiHints : null,
      staticPathIncludes: `/${id}/`,
      decorator: '(name, fieldId, type, repeated, packed, flag3, mapKeyType?)',
      fields
    };
    const outName = `spin-${id}.json`;
    fs.writeFileSync(path.join(OUT_DIR, outName), JSON.stringify(schema, null, 2));
    extracted.push(schema);
    index.push({
      id,
      game,
      displayName,
      file: outName,
      fields: fields.length,
      apiHints
    });
    console.log(`[ok] ${id} ${displayName || '-'} fields=${fields.length} ${Date.now() - t0}ms`);
  }

  for (const id of PRECISE_GAME_IDS) {
    const gameDir = findGameDir(id);
    const mainJs = gameDir && findMainJs(gameDir);
    if (!mainJs) {
      console.log(`[skip] ${id}: static dir or main js missing`);
      continue;
    }
    let schema;
    try {
      schema = buildPreciseSchema(id, gameDir, mainJs, fs.readFileSync(mainJs, 'utf8'));
    } catch (e) {
      console.log(`[fail] ${id}: ${e.message}`);
      continue;
    }
    const outName = `spin-${id}.json`;
    fs.writeFileSync(path.join(OUT_DIR, outName), JSON.stringify(schema, null, 2));
    index.push({
      id,
      game: schema.game,
      displayName: schema.displayName,
      file: outName,
      fields: schema.fields.length,
      apiHints: schema.apiPathIncludesAny,
      note: 'precise; also matched by page URL /<staticId>/'
    });
    console.log(`[precise] ${id} ${schema.displayName} slug=${schema.game} fields=${schema.fields.length}`);
  }

  const commonFields = mergeFieldUnion(extracted.filter(s => s.fields.length));
  const common = {
    source: 'union of extracted PG v4 Spin field roles (static packs)',
    game: 'pg-v4-spin-common',
    genericPgV4Spin: true,
    apiPathIncludes: '/game-api/',
    matchGameApiV4: true,
    decorator: '(name, fieldId, type, repeated, packed, flag3, mapKeyType?)',
    fields: commonFields
  };
  fs.writeFileSync(path.join(OUT_DIR, 'pg-v4-spin-common.json'), JSON.stringify(common, null, 2));
  index.unshift({
    id: 'common',
    game: 'pg-v4-spin-common',
    file: 'pg-v4-spin-common.json',
    fields: commonFields.length,
    note: 'fallback for all /game-api/*/v4/*'
  });

  fs.writeFileSync(path.join(OUT_DIR, '_index.json'), JSON.stringify(index, null, 2));
  console.log('done common fields=', commonFields.length);
}

main();
