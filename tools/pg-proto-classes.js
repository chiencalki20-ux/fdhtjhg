/**
 * 解混淆 PG 游戏主包（obfuscator 字符串表），读取 Protoutils 装饰器声明的 proto 类：
 *   __decorate([X.api(name, fieldId, type, repeated, packed, optional, mapKeyType?)], Cls.prototype, prop)
 *   __decorate([X.messageName(className)], Cls)
 */
const vm = require('vm');

function sliceBalanced(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function buildDecoder(text) {
  const head = /^!\(function\(\)\{'use strict';var (\w+)=(\w+);/.exec(text);
  if (!head) return null;
  const dec = head[2];
  const decIdx = text.indexOf(`function ${dec}(`);
  if (decIdx < 0) return null;
  const decSrc = sliceBalanced(text, decIdx);
  const arrMatch = decSrc && /var \w+=(\w+)\(\);/.exec(decSrc);
  if (!arrMatch) return null;
  const arrIdx = text.indexOf(`function ${arrMatch[1]}(`);
  if (arrIdx < 0) return null;
  const arrSrc = sliceBalanced(text, arrIdx);
  const ctx = {};
  vm.runInNewContext(`${arrSrc}\n${decSrc}\nthis.d=${dec};`, ctx, { timeout: 5000 });

  const pairs = [];
  const pairRe = /(?:var |,)(\w+)=(\w+)(?=[;,])/g;
  let m;
  while ((m = pairRe.exec(text))) pairs.push([m[1], m[2]]);
  const aliases = new Set([dec]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [a, b] of pairs) {
      if (aliases.has(b) && !aliases.has(a)) {
        aliases.add(a);
        grew = true;
      }
    }
  }
  return { decode: ctx.d, aliases: [...aliases] };
}

const LIT = `(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`;
const STR = `(?:\\(?${LIT}\\)?(?:\\+\\(?${LIT}\\)?)*)`;
const BOOL = '!0x[01]|!0|!1';

function evalStr(expr) {
  if (!expr) return null;
  const parts = expr.match(new RegExp(LIT, 'g'));
  if (!parts) return expr;
  return parts
    .map(p => (p[0] === "'" ? JSON.parse('"' + p.slice(1, -1).replace(/"/g, '\\"') + '"') : JSON.parse(p)))
    .join('');
}

const isTrue = s => s === '!0x0' || s === '!0';

/** @returns {{name:string, fields:object[]}[] | null} */
function extractProtoClasses(text) {
  const decoder = buildDecoder(text);
  if (!decoder) return null;
  const re = new RegExp(`\\b(${decoder.aliases.join('|')})\\((0x[0-9a-f]+)\\)`, 'g');
  const d = text.replace(re, (_, a, n) => JSON.stringify(String(decoder.decode(parseInt(n, 16)))));

  const fieldRe = new RegExp(
    `__decorate\\(\\[\\w+\\[${STR}\\]\\((${STR}),(0x[0-9a-f]+|\\d+),(${STR}),(${BOOL}),(${BOOL}),(${BOOL})(?:,(${STR}))?\\)\\],(\\w+)\\[${STR}\\],(${STR})`,
    'g'
  );
  const classRe = new RegExp(`__decorate\\(\\[\\w+\\[(${STR})\\]\\((${STR})\\)\\],(\\w+)\\)`, 'g');

  const events = [];
  let m;
  while ((m = fieldRe.exec(d))) {
    events.push({
      at: m.index,
      kind: 'field',
      target: m[8],
      field: {
        name: evalStr(m[1]),
        id: Number(m[2]),
        type: evalStr(m[3]),
        repeated: isTrue(m[4]),
        packed: isTrue(m[5]),
        optional: isTrue(m[6]),
        mapKey: evalStr(m[7]),
        prop: evalStr(m[9])
      }
    });
  }
  while ((m = classRe.exec(d))) {
    if (evalStr(m[1]) !== 'messageName') continue;
    events.push({ at: m.index, kind: 'class', name: evalStr(m[2]), target: m[3] });
  }
  events.sort((a, b) => a.at - b.at);

  const classes = [];
  let pending = [];
  for (const e of events) {
    if (e.kind === 'field') {
      pending.push(e);
      continue;
    }
    const own = pending.filter(f => f.target === e.target);
    if (own.length) classes.push({ name: e.name, fields: own.map(f => f.field) });
    pending = pending.filter(f => f.target !== e.target);
  }
  return classes;
}

module.exports = { extractProtoClasses };
