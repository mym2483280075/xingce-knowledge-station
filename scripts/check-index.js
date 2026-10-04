// ===== 检索索引自检（新增板块 / 新增内容后跑一遍）=====
// 用法：
//   node scripts/check-index.js                 # 全量自检（发布前跑）
//   node scripts/check-index.js --query 增长率   # 查一个词落在哪些板块（新增内容后核对用）
//   node scripts/check-index.js --quiet          # 只输出问题与结论
//
// 【为什么要有它】索引最怕「静默漏内容」：新页面用了没登记的卡片类名、
// 新卡片忘了写 id、说明文字塞进了 JS 模板、忘了重跑构建……页面能打开、搜索却搜不到，
// 而且不报错。这个脚本把六件事一次查完，任何一项不过就退出码 1（publish.cmd 会拦住不发布）：
//   ① 板块登记：NAV 里每个板块都能找到页面文件
//   ② 页面覆盖：每页的卡片数、正文覆盖率（索引里的字数 / 页面上可见字数）
//   ③ 锚点：索引里每条命中的 f + i 在页面上真实存在（否则跳过去落不了位）
//   ④ 索引文件：该有的都有、没有多余的（防止改名/删页后残留旧切片）
//   ⑤ 词形用例：search-fixtures.json 里每条查询都必须能搜到（新增内容时把关键词加进去）
//   ⑥ 缓存版本：CACHE_V 与 assets 的 ?v= 是否是最新内容哈希（不是就提示跑 refresh-site.js）
const fs = require('fs');
const path = require('path');
const stamp = require('./lib/stamp');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const queryArg = (() => {
  const i = args.indexOf('--query');
  return i >= 0 ? (args[i + 1] || '') : '';
})();

const errors = [];
const warns = [];
const infos = [];
function err(msg) { errors.push(msg); }
function warn(msg) { warns.push(msg); }
function info(msg) { infos.push(msg); }
function say(msg) { if (!QUIET) { console.log(msg); } }

/* ---------- 与 index.html 的 wsSig 保持一致（直接从外壳里抽函数体，避免两边写法漂移） ---------- */
function buildSig() {
  const shell = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = /function wsSig\(s\)\{([\s\S]*?)\n\}/.exec(shell);
  if (!m) { warn('没能从 index.html 里抽出 wsSig()，词形用例改用内置归一化实现'); return null; }
  try { return new Function('s', m[1]); } catch (e) { warn('wsSig() 解析失败：' + e.message); return null; }
}
const sigFn = buildSig();
const sig = (s) => (sigFn ? sigFn(s) : String(s == null ? '' : s).toLowerCase().replace(/[^0-9a-z\u4e00-\u9fa5]+/g, ''));
const termsOf = (q) => String(q || '').toLowerCase().split(/[^0-9a-z\u4e00-\u9fa5]+/).filter(Boolean);

/* ---------- 读索引与页面 ---------- */
const indexPath = path.join(ROOT, 'assets', 'search-index.json');
if (!fs.existsSync(indexPath)) {
  console.log('✗ 找不到 assets/search-index.json —— 先跑 node scripts/build-index.js');
  process.exit(1);
}
const core = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const htmlCache = {};
function pageHtml(rel) {
  if (htmlCache[rel] === undefined) {
    const p = path.join(ROOT, rel);
    htmlCache[rel] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
  return htmlCache[rel];
}
function pageText(rel) {
  const html = pageHtml(rel);
  if (html === null) { return null; }
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, '');
}
function pageIds(rel) {
  const html = pageHtml(rel);
  if (html === null) { return null; }
  const ids = new Set();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) { ids.add(m[1]); }
  return ids;
}

/* ---------- 全量条目表（核心 + 各板块全文） ---------- */
const allItems = [];
for (const it of core.items) { allItems.push({ ...it, _src: 'core' }); }
const fullKeys = new Set();
for (const f of core.files) {
  fullKeys.add(f.k);
  const p = path.join(ROOT, 'assets', 'search-full', f.k + '.json');
  if (!fs.existsSync(p)) { err('索引文件缺失：assets/search-full/' + f.k + '.json（核心索引在引用它）'); continue; }
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const it of d.items) { allItems.push({ ...it, _src: 'full:' + f.k }); }
  const want = f.c;
  if (typeof want === 'number' && d.items.length !== want) {
    warn('切片数对不上：' + f.k + ' 核心索引写 ' + want + '，实际 ' + d.items.length + '（重跑 build-index 即可）');
  }
}

/* ---------- ① 板块登记：NAV 的页面都要存在 ---------- */
const navSections = [];
{
  const home = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const re = /\{\s*id:\s*'/g;
  let m;
  while ((m = re.exec(home)) !== null) {
    const start = m.index;
    let depth = 0, i = start, inStr = false, quote = '';
    for (; i < home.length; i++) {
      const ch = home.charAt(i);
      if (inStr) { if (ch === '\\') { i++; continue; } if (ch === quote) { inStr = false; } continue; }
      if (ch === "'" || ch === '"') { inStr = true; quote = ch; continue; }
      if (ch === '{') { depth++; } else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    const body = home.slice(start, i);
    re.lastIndex = i;
    const id = (body.match(/id:\s*'([^']+)'/) || [])[1] || '';
    const name = (body.match(/name:\s*'([^']+)'/) || [])[1] || '';
    const file = (body.match(/file:\s*'([^']+)'/) || [])[1] || '';
    if (!id || !name || file.indexOf('sections/') !== 0) { continue; }
    navSections.push({ id, name, file });
  }
}
say('① 板块登记  ' + navSections.length + ' 个');
for (const s of navSections) {
  if (!fs.existsSync(path.join(ROOT, s.file))) {
    err('板块「' + s.name + '」(' + s.id + ') 登记的页面不存在：' + s.file + '（侧栏会点不开）');
  }
}

/* ---------- ② 页面覆盖：卡片数 + 正文覆盖率 ---------- */
const byPage = {};
for (const it of allItems) {
  const rec = byPage[it.f] || (byPage[it.f] = { chunks: 0, chars: 0, cards: new Set() });
  rec.chunks++;
  rec.chars += (it.x || '').length;
  if (it.i) { rec.cards.add(it.i); }
}
const filesOfInterest = new Set(navSections.map((s) => s.file));
for (const f of core.files) { filesOfInterest.add(f.f); }
say('② 页面覆盖  ' + filesOfInterest.size + ' 页');
for (const rel of [...filesOfInterest].sort()) {
  const text = pageText(rel);
  const rec = byPage[rel];
  if (text === null) { continue; }               /* ①已经报过 */
  const chars = text.length;
  if (!rec || !rec.chunks) {
    if (chars > 400) { err('页面「' + rel + '」有 ' + chars + ' 字正文，但索引里一条都没有（卡片类名没登记？重跑构建？）'); }
    continue;
  }
  const cover = chars ? Math.round((rec.chars / chars) * 100) : 100;
  if (chars > 800 && cover < 70) {
    warn('页面「' + rel + '」正文覆盖率只有 ' + cover + '%（页面 ' + chars + ' 字 / 索引 ' + rec.chars
      + ' 字）—— 新卡片类名要同步加进 build-index.js 的白名单与 assets/板块页脚本.js 的 CARD_SETS');
  }
}
say('   覆盖率最低的几页：');
{
  const rows = [];
  for (const rel of filesOfInterest) {
    const text = pageText(rel); const rec = byPage[rel];
    if (text === null || !rec || text.length < 800) { continue; }
    rows.push([rel, Math.round((rec.chars / text.length) * 100)]);
  }
  rows.sort((a, b) => a[1] - b[1]);
  for (const [rel, pct] of rows.slice(0, 3)) { say('     ' + String(pct).padStart(3) + '%  ' + rel); }
}

/* ---------- ③ 锚点：每条索引的 f + i 在页面上真实存在 ---------- */
say('③ 锚点检查  ' + allItems.length + ' 条');
let missingAnchor = 0, missingFile = 0;
for (const it of allItems) {
  const ids = pageIds(it.f);
  if (ids === null) { missingFile++; if (missingFile <= 5) { err('索引指向不存在的页面：' + it.f); } continue; }
  if (it.i && !ids.has(it.i)) {
    missingAnchor++;
    if (missingAnchor <= 8) { err('索引入口 ' + it.f + '#' + it.i + ' 在页面上找不到（跳过去不会落位）'); }
  }
}
if (missingAnchor > 8) { err('……另有 ' + (missingAnchor - 8) + ' 条锚点缺失'); }

/* ---------- ④ 索引文件：该有的都有、没有多余的 ---------- */
const fullDir = path.join(ROOT, 'assets', 'search-full');
const onDisk = fs.existsSync(fullDir) ? fs.readdirSync(fullDir).filter((n) => n.endsWith('.json')) : [];
const stale = onDisk.filter((n) => !fullKeys.has(n.replace(/\.json$/, '')));
if (stale.length) { err('有 ' + stale.length + ' 个过期切片没清理：' + stale.slice(0, 5).join(', ') + '（重跑 build-index）'); }
say('④ 索引文件  ' + fullKeys.size + ' 个切片，磁盘上 ' + onDisk.length + ' 个');

/* ---------- ⑤ 词形用例 ---------- */
const fixturePath = path.join(__dirname, 'search-fixtures.json');
const fixtures = fs.existsSync(fixturePath)
  ? (JSON.parse(fs.readFileSync(fixturePath, 'utf8')).queries || [])
  : [];
/* 命中判定：归一化子串 → 多词全中 → 跳字（跨度受限），与前端 wsRank 的三档思路一致 */
function hit(item, q) {
  const nq = sig(q);
  if (!nq) { return false; }
  const nt = sig(item.t || ''), nx = sig(item.x || '');
  if (nt.indexOf(nq) > -1 || nx.indexOf(nq) > -1) { return true; }
  const ts = termsOf(q);
  if (ts.length > 1) {
    const hay = nt + '\u0000' + nx;
    if (ts.every((t) => hay.indexOf(t) > -1)) { return true; }
  }
  const spanLimit = nq.length + Math.max(2, Math.ceil(nq.length / 2));
  return spanWithin(nt, nq, spanLimit) || spanWithin(nx, nq, spanLimit);
}
function spanWithin(text, q, limit) {
  if (!text || !q) { return false; }
  for (let s = text.indexOf(q.charAt(0)); s > -1; s = text.indexOf(q.charAt(0), s + 1)) {
    let at = s + 1, ok = true;
    for (let i = 1; i < q.length; i++) {
      at = text.indexOf(q.charAt(i), at);
      if (at < 0) { ok = false; break; }
      at++;
    }
    if (ok && at - s <= limit) { return true; }
  }
  return false;
}
function searchAny(q, filterSection) {
  const out = [];
  for (const it of allItems) {
    if (filterSection && it.s !== filterSection) { continue; }
    if (hit(it, q)) { out.push(it); }
  }
  return out;
}
if (queryArg) {
  const hits = searchAny(queryArg);
  console.log('查「' + queryArg + '」：命中 ' + hits.length + ' 条');
  const seen = new Map();
  for (const h of hits) {
    const key = h.s + '|' + h.f;
    if (!seen.has(key)) { seen.set(key, h); }
  }
  for (const h of [...seen.values()].slice(0, 12)) {
    console.log('   · ' + h.n + ' · ' + h.t + (h.i ? '   (' + h.f + '#' + h.i + ')' : '   (' + h.f + ')'));
  }
  if (!hits.length) { console.log('   （没有命中：检查该内容是否写进了页面、卡片类名是否登记、有没有重跑 build-index）'); }
  process.exit(hits.length ? 0 : 1);
}
say('⑤ 词形用例  ' + fixtures.length + ' 条');
for (const fx of fixtures) {
  const q = fx.q;
  const hits = searchAny(q, fx.section);
  const min = (fx.expect && fx.expect.min) || 1;
  const need = fx.section || (fx.expect && fx.expect.section);
  const ok = need
    ? searchAny(q).some((h) => h.s === need) && hits.length >= min
    : hits.length >= min;
  if (!ok) {
    err('词形用例失败：「' + q + '」期望 ' + (need ? need + ' 板块里 ' : '') + '≥' + min + ' 条，实际 '
      + hits.length + ' 条' + (fx.why ? '（' + fx.why + '）' : ''));
  }
}

/* ---------- ⑥ 缓存版本 ---------- */
const dry = stamp.apply(ROOT, { dryRun: true });
say('⑥ 缓存版本  CACHE_V 应为 ' + dry.cacheV);
if (dry.changed.length) {
  const inIndex = dry.changed.includes('index.html');
  const msg = '有 ' + dry.changed.length + ' 个文件的缓存版本不是最新内容哈希'
    + (inIndex ? '（含 index.html 的 CACHE_V）' : '') + '：'
    + dry.changed.slice(0, 4).join(', ') + (dry.changed.length > 4 ? ' …' : '')
    + ' —— 跑 node scripts/refresh-site.js 自动打戳，否则 iPad 会继续用旧页面';
  if (inIndex) { err(msg); } else { warn(msg); }
}

/* ---------- 汇总 ---------- */
if (!QUIET) {
  console.log('');
  if (warns.length) {
    console.log('⚠ 警告 ' + warns.length + ' 条：');
    for (const w of warns) { console.log('   · ' + w); }
  }
  if (errors.length) {
    console.log('✗ 错误 ' + errors.length + ' 条：');
    for (const e of errors) { console.log('   · ' + e); }
  }
}
if (errors.length) {
  console.log('\n索引自检未通过（' + errors.length + ' 个错误 / ' + warns.length + ' 个警告）');
  process.exit(1);
}
console.log('\n索引自检通过：' + navSections.length + ' 个板块、' + core.files.length + ' 个切片、'
  + allItems.length + ' 条索引' + (warns.length ? '，' + warns.length + ' 个警告' : ''));
process.exit(0);
