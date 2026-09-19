// ===== 检索索引构建器（供全站模糊搜索使用）=====
// 用法：node scripts/build-index.js   →  生成 assets/search-index.json
// 新增内容（新板块 HTML / 新一期模考）后重跑一次即可让新内容被顶部搜索检索到。
//
// 【设计】三处关键约定，改之前先读完：
//   ① 板块表不再手写，而是从 index.html 的 NAV（XC_SECTIONS / SN_SECTIONS / RJ_SECTION /
//      MK_SECTIONS）里读出来 —— 过去 NAV 与 SEC_META 是两份手写的主键表，漏一处只会
//      “静默少结果”，最难排查；现在只有一个来源，脚本末尾会打印每个板块的条目数供核对。
//   ② 正文按“句子边界”切片，每片 ≤ CHUNK 字符，全部入库（不再整段截断）。
//      旧版每条只留 900 字符，实测判断推理板块的索引覆盖率只有 10%（正文 185.8 千字 →
//      索引 19.1 千字），"一笔画""横竖线"这类正文里反复出现的概念根本搜不到。
//      切片后每片都带所属卡片的锚点 id，命中即可直达原卡片并由板块页高亮。
//   ③ 模考子页（行测 / 申论 / 行测错题集合）也会入库：它们不是 <section> 而是
//      <div class="qcard" id="q061"> / <div class="shen" id="sq1"> 结构，所以块提取器
//      同时支持 section 与 div 两种容器（见 extractBlocks）。它们有自己的文件路径，
//      前端用 item.f 直接打开子页，而不是回到模考总览页。
//
// 【产物】分两个文件族，解决“要全覆盖”与“首屏要轻”的矛盾：
//   ① assets/search-index.json —— 核心索引：每张卡片一条，只有标题（无正文），约 30KB gzip。
//      用户刚聚焦搜索框时先加载它，标题级命中立刻可见，也能给首页当“回车兜底路由”。
//   ② assets/search-full/<key>.json —— 每个板块一份全文切片，约 15~250KB gzip 不等。
//      前端先加载“当前正在看的板块”，其余按需在后台逐个补齐（见 index.html 的 wsPump）。
//      全量加载后覆盖率 100%（旧版单文件只覆盖 10%~78%，且一次要下 1.33MB gzip）。
//
// 【数据】核心索引 { v, at, rev, files[], items[] }：
//   files[] = { k:全文索引文件名, s:板块id, n:显示名, f:页面文件, c:卡片数 }
//   items[] = { s:板块id, n:显示名, f:页面文件(相对仓库根), i:锚点id, t:标题 }
// 全文索引 { v, at, rev, k, items[] }：item 在上面基础上多一个 x:正文片段。
// index.html 的 wsSearch / wsSnippet / openTarget 直接吃这些字段，改名要同时改前端。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHUNK = 900;          // 每片正文的目标长度（字符）
const FULL_DIR = 'search-full';

/* 【易错】把 HTML 扒成纯文本：规则要与板块页真实结构保持兼容（图片只取 alt、
   script/style 整体丢弃）。板块页新增内联组件后要回来看这里会不会把正文一起吃掉
   —— 症状是搜索命中率突然下降，但不报错。 */
const clean = (s) => String(s || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, ' $1 ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
  .replace(/\s+/g, ' ').trim();

/* ========== ① 板块表：从 index.html 的 NAV 派生（唯一来源） ==========
   【易错】解析的是 NAV 各分区的对象字面量，形如
     { id:'zl', name:'资料分析', en:'...', file:'sections/资料分析.html', ... , hit:'9月18日模考' }
   只要保持「id 在前、file 在后、对象以单独一行 } 收尾」就稳定；若哪天把 file 挪到 id 前面，
   这里会静默少索引该板块，所以脚本结束会打印每个板块的卡片/片段数，跑完扫一眼即可。
   【坑】hit 字段是模考期次的关键字（如 '9月18日模考'）。模考子页的板块 id 必须用它反查，
     不能自己拼 'mk-0918'：NAV 里的 id 是 'mk-260918'（带年份），对不上时前端的 getSection
     会静默返回第一个板块，症状是「点搜索结果跳对了页面，侧边栏却高亮在常识判断」。 */
function readNavSections() {
  const home = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const list = [];
  /* 【易错】用「大括号配对」而不是正则截取对象：NAV 条目里嵌着 keywords 数组，
     正则的非贪婪匹配会停在数组内部的第一个 }，导致只认出第一个板块。
     （实测症状：18 个板块只索引到 1 个。）配对时跳过字符串字面量，避免正文里的
     花括号把深度算错。 */
  const re = /\{\s*id:\s*'/g;
  let m;
  while ((m = re.exec(home)) !== null) {
    const start = m.index;
    let depth = 0, i = start, inStr = false, quote = '';
    for (; i < home.length; i++) {
      const ch = home.charAt(i);
      if (inStr) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) { inStr = false; }
        continue;
      }
      if (ch === "'" || ch === '"') { inStr = true; quote = ch; continue; }
      if (ch === '{') { depth++; }
      else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    const body = home.slice(start, i);
    re.lastIndex = i;
    const id = (body.match(/id:\s*'([^']+)'/) || [])[1] || '';
    const name = (body.match(/name:\s*'([^']+)'/) || [])[1] || '';
    const file = (body.match(/file:\s*'([^']+)'/) || [])[1] || '';
    if (!id || !name || file.indexOf('sections/') !== 0) { continue; }
    const hit = (body.match(/hit:\s*'([^']+)'/) || [])[1] || '';
    list.push({ id: id, name: name, file: file.replace('sections/', ''), hit: hit });
  }
  return list;
}

/* ========== ② 块提取：section / div 两种容器都支持 ==========
   wanted 是 class 白名单；命中后一直扫到同名闭合标签为止（带同名标签计数），
   因此卡片之间可以任意嵌套。命中的卡片内部不再重复提取（避免“单元”里又切出“知识点”
   导致同段正文入两次索引）。 */
function findClose(html, tag, from) {
  const re = new RegExp('<' + tag + '\\b|</' + tag + '\\s*>', 'gi');
  re.lastIndex = from;
  let depth = 1, m;
  while ((m = re.exec(html)) !== null) {
    if (m[0].charAt(1) === '/') { depth--; if (depth === 0) { return m.index; } }
    else { depth++; }
  }
  return -1;
}

function extractBlocks(html, wanted) {
  const out = [];
  const tagRe = /<(section|div)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const cls = (attrs.match(/class="([^"]*)"/) || [])[1] || '';
    const classes = cls.split(/\s+/).filter(Boolean);
    const hit = classes.find((c) => wanted.has(c));
    if (!hit) { continue; }
    const id = (attrs.match(/id="([^"]*)"/) || [])[1] || '';
    const start = m.index + m[0].length;
    const end = findClose(html, tag, start);
    if (end < 0) { continue; }
    out.push({ cls: hit, id, attrs, html: html.slice(start, end) });
    tagRe.lastIndex = end;
  }
  return out;
}

/* 标题优先级：data-title → 卡片内第一个 h2/h3/h4 → 常见标题 div → 正文前 24 字兜底 */
function blockTitle(attrs, body, cls) {
  const dt = (attrs.match(/data-title="([^"]*)"/) || [])[1];
  if (dt) { return clean(dt); }
  const h = body.match(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/);
  if (h) { return clean(h[1]); }
  const d = body.match(/<div class="(?:qhead|unit-head|mod-banner|mathead|qh)"[^>]*>([\s\S]*?)<\/div>/);
  if (d) { return clean(d[1]).slice(0, 60); }
  const text = clean(body);
  if (text) { return text.slice(0, 24); }
  return cls === 'kp' ? '知识点' : '单元';
}

/* ========== ③ 正文切片：按句子边界切，保证不漏内容 ========== */
function splitChunks(text, max) {
  if (!text) { return []; }
  if (text.length <= max) { return [text]; }
  const segs = text.match(/[^。！？；!?;]*[。！？；!?;]?/g) || [text];
  const parts = [];
  let buf = '';
  const flush = () => { if (buf) { parts.push(buf); buf = ''; } };
  for (const s of segs) {
    if (!s) { continue; }
    if (buf.length + s.length <= max) { buf += s; continue; }
    flush();
    if (s.length <= max) { buf = s; continue; }
    for (let i = 0; i < s.length; i += max) { parts.push(s.slice(i, i + max)); }
  }
  flush();
  return parts.length ? parts : [text.slice(0, max)];
}

/* ========== 主流程 ========== */
const sections = readNavSections();
if (!sections.length) { throw new Error('未能从 index.html 解析出任何板块，请检查 NAV 的写法'); }

const coreItems = [];       // 每张卡片一条（只有标题）
const fullFiles = [];       // 每个板块一份全文切片
const seenCards = new Set();

/* filed = 全文索引的 key（文件名）。板块页用板块 id，模考子页用 mk-260918-xc 这类组合。 */
function indexFile(fileRel, secId, secName, wanted, key) {
  const abs = path.join(ROOT, 'sections', fileRel);
  if (!fs.existsSync(abs)) { console.log('  SKIP missing ' + fileRel); return; }
  const html = fs.readFileSync(abs, 'utf8');
  const blocks = extractBlocks(html, wanted);
  const full = [];
  const seenChunks = new Set();
  /* 【需求】页内目录（nav.toc 的链接文字）也要进索引：它是用户最可能输入的词
     ——「分论点润色」「六提示」这类叫法经常只出现在目录里，正文卡片用的是别的措辞。
     条目的 x 直接用目录文字，命中后结果摘要不会显示成“正文索引加载中”。 */
  const tocHtml = (html.match(/<nav class="toc"[\s\S]*?<\/nav>/) || [''])[0];
  if (tocHtml) {
    for (const a of tocHtml.matchAll(/<a[^>]*href="#([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const label = clean(a[2]);
      if (!label) { continue; }
      const ck = 'TOC|' + a[1] + '|' + label.slice(0, 40);
      if (seenChunks.has(ck)) { continue; }
      seenChunks.add(ck);
      full.push({ s: secId, n: secName, f: 'sections/' + fileRel, i: a[1], t: label, x: label });
    }
  }
  for (const b of blocks) {
    const title = blockTitle(b.attrs, b.html, b.cls);
    const cardKey = fileRel + '#' + (b.id || title);
    if (!seenCards.has(cardKey)) {
      seenCards.add(cardKey);
      coreItems.push({ s: secId, n: secName, f: 'sections/' + fileRel, i: b.id, t: title });
    }
    for (const part of splitChunks(clean(b.html), CHUNK)) {
      /* 同一张卡片里若出现完全一样的两片（排版重复），只留一片 */
      const ck = part.slice(0, 60);
      if (seenChunks.has(ck)) { continue; }
      seenChunks.add(ck);
      full.push({ s: secId, n: secName, f: 'sections/' + fileRel, i: b.id, t: title, x: part });
    }
  }
  if (!full.length) { console.log('  ' + fileRel + ' -> 0 张卡片（空槽位页面，可忽略）'); return; }
  fullFiles.push({ k: key, s: secId, n: secName, f: 'sections/' + fileRel, items: full });
  console.log('  ' + fileRel + ' -> ' + blocks.length + ' 张卡片 / ' + full.length + ' 片');
}

console.log('=== 板块页 ===');
const DEFAULT_WANTED = new Set(['kp', 'unit']);
for (const sec of sections) {
  /* 每周模考总览页的正文是前端拼出来的（HTML 里只有一个空 #wrap），没有可索引的卡片；
     各期次的正文在子页里，见下面的「模考子页」。 */
  if (sec.file === '每周模考.html') { continue; }
  indexFile(sec.file, sec.id, sec.name, DEFAULT_WANTED, sec.id);
}

/* ========== 模考子页：按期次自动发现 ==========
   【需求】模考是站内体量最大的一块内容（一期 120 题 + 申论 5 大题 + 错题集合），
   整卷题本与错题集合都有稳定的 id（q001 / sq1），命中后可直接跳进去高亮。
   期次文件夹命名固定为「M月D日模考」，与 sections/每周模考.html 的 MOCK_DATES 对应。 */
console.log('=== 模考子页 ===');
const MK_ROOT = path.join(ROOT, 'sections', '每周模考');
/* 【坑】期次文件夹名（9月18日模考）必须用 NAV 的 hit 字段反查期次 id（mk-260918），
   不能自己拼 'mk-0918'：NAV 里的 id 带年份，对不上时前端 getSection 会静默返回第一个板块，
   症状是「点搜索结果跳对了页面，侧边栏却高亮在常识判断」。 */
const hitMap = {};
for (const s of sections) { if (s.hit) { hitMap[s.hit] = s.id; } }
const MK_FILES = [
  { f: '行测.html', tag: '行测', sfx: 'xc', wanted: new Set(['qcard']) },
  { f: '申论.html', tag: '申论', sfx: 'sn', wanted: new Set(['shen', 'matcard']) },
  { f: '行测错题集合.html', tag: '行测错题', sfx: 'ct', wanted: new Set(['qcard']) }
];
if (fs.existsSync(MK_ROOT)) {
  const dirs = fs.readdirSync(MK_ROOT).filter((d) => fs.statSync(path.join(MK_ROOT, d)).isDirectory());
  for (const dir of dirs) {
    const secId = hitMap[dir] || 'mk';
    if (!hitMap[dir]) { console.log('  WARN 期次「' + dir + '」未在 index.html 的 NAV 登记期次条目，退回 mk'); }
    for (const mf of MK_FILES) {
      const rel = '每周模考/' + dir + '/' + mf.f;
      if (!fs.existsSync(path.join(ROOT, 'sections', rel))) { continue; }
      indexFile(rel, secId, '模考 · ' + dir.replace('模考', '') + ' · ' + mf.tag, mf.wanted, secId + '-' + mf.sfx);
    }
  }
}

const outDir = path.join(ROOT, 'assets');
fs.mkdirSync(outDir, { recursive: true });
const rev = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);   // yyyyMMddHHmm，作为缓存版本

/* 【易错】每次重建都会整目录重写 search-full：老文件留着会让前端加载到过期切片
   （症状是“刚补的内容搜不到，重新输入又有了”）。 */
const fullDir = path.join(outDir, FULL_DIR);
fs.rmSync(fullDir, { recursive: true, force: true });
fs.mkdirSync(fullDir, { recursive: true });
let fullBytes = 0;
for (const f of fullFiles) {
  const p = path.join(fullDir, f.k + '.json');
  fs.writeFileSync(p, JSON.stringify({ v: 3, at: new Date().toISOString().slice(0, 10), rev, k: f.k, items: f.items }));
  fullBytes += fs.statSync(p).size;
}

// 【数据】核心索引由 index.html fetch('assets/search-index.json?v=rev') 消费；
// 即使手工改这个 JSON，也要保持 { v, at, rev, files, items } 结构与 s/n/f/i/t 字段名不变。
const outPath = path.join(outDir, 'search-index.json');
const files = fullFiles.map((f) => ({ k: f.k, s: f.s, n: f.n, f: f.f, c: f.items.length }));
fs.writeFileSync(outPath, JSON.stringify({ v: 3, at: new Date().toISOString().slice(0, 10), rev, files, items: coreItems }));
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log('CORE:', coreItems.length, '张卡片 |', kb(fs.statSync(outPath).size), '->', path.relative(ROOT, outPath));
console.log('FULL:', files.length, '个板块 |', kb(fullBytes), '->', path.relative(ROOT, fullDir) + '/');
