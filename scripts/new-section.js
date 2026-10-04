// ===== 新板块脚手架：一行命令生成板块页 + 登记到侧栏 NAV =====
//
//   node scripts/new-section.js --zone xc --id zcfg --name 政策法规 --desc "法律法规与政策文件速查"
//   node scripts/new-section.js --zone xc --id zcfg --name 政策法规 --desc "……" --apply
//
// 默认只打印「会新建什么 / 会插哪一行」，加 --apply 才真正写盘。
// 生成后要做的三步（见 README「新增板块 / 新增内容」）：
//   ① 往新页面里填内容（卡片用 <section class="kp" id="…" data-title="…">，
//      题本用 <div class="qcard" id="…">，材料用 <div class="matcard" id="mat-…">）
//   ② node scripts/refresh-site.js   （重建索引 + 自动打缓存版本 + 自检）
//   ③ .\publish.cmd --check  →  .\publish.cmd
//
// 【为什么要有它】新板块要同时改三处才「能用」：页面文件、index.html 的 NAV（侧栏/封面/搜索都认它）、
// 缓存版本。漏掉 NAV 搜索就静默少一个板块；漏掉版本 iPad 就一直看旧页面。
// 这个脚手架把这三件事一次做对，页面里该引的样式/脚本（含当前版本号）也都齐了。
const fs = require('fs');
const path = require('path');
const stamp = require('./lib/stamp');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? (args[i + 1] === undefined ? '' : args[i + 1]) : def;
}
const APPLY = args.includes('--apply');
const zone = (arg('zone', '') || '').trim();
const id = (arg('id', '') || '').trim();
const name = (arg('name', '') || '').trim();
const desc = (arg('desc', '') || '').trim();
const sub = (arg('sub', '') || '').trim();
const en = (arg('en', '') || '').trim();
const color = (arg('color', '') || '').trim();
const fileArg = (arg('file', '') || '').trim();

const ZONES = {
  xc: { label: '行测', array: 'XC_SECTIONS', theme: 'blue', color: '#4f7cff', en: 'NEW SECTION',
        sub: '板块简介', cnt: '待录入', keywords: ['关键词1', '关键词2'] },
  sn: { label: '申论', array: 'SN_SECTIONS', theme: 'teal', color: '#0d9488', en: 'ESSAY SECTION',
        sub: '题型框架 · 待录入', cnt: '待录入', keywords: ['申论', '关键词'] }
};

function fail(msg) { console.log('✗ ' + msg); process.exit(1); }
if (!ZONES[zone]) { fail('--zone 只支持 xc（行测）/ sn（申论）。要加单页专区或模考期次，见 操作说明-新增题目识别与入库.md'); }
if (!/^[a-z][a-z0-9]{1,15}$/.test(id)) { fail('--id 只能用小写字母开头 + 小写字母/数字（2~16 位，全站唯一），例如 zcfg'); }
if (!name) { fail('缺 --name，例如 --name 政策法规'); }
const z = ZONES[zone];
const fileName = fileArg || (name + '.html');
if (!/\.html$/.test(fileName)) { fail('--file 必须以 .html 结尾'); }
const fileRel = 'sections/' + fileName;
const pageAbs = path.join(ROOT, fileRel);
const shellAbs = path.join(ROOT, 'index.html');
const shell = fs.readFileSync(shellAbs, 'utf8');

if (fs.existsSync(pageAbs)) { fail('页面已存在：' + fileRel + '（换个 --name 或 --file）'); }
if (new RegExp("id:\\s*'" + id + "'").test(shell)) { fail('index.html 里已经有 id → ' + id + ' 的板块了，换一个 --id'); }
if (new RegExp("file:\\s*'sections/" + fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'").test(shell)) {
  fail('index.html 里已经有板块登记了这个页面：' + fileRel);
}

/* ---------- 生成页面 ---------- */
const V = stamp.assetVersions(ROOT);
const asset = (n) => 'assets/' + n + '?v=' + (V[decodeURIComponent(n)] || 'dev');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const themeJs = asset(encodeURIComponent('主题.js'));
const calcJs = asset(encodeURIComponent('演算层.js'));
const navJs = asset(encodeURIComponent('定位层.js'));
const boardJs = asset(encodeURIComponent('板块页脚本.js'));
const tokensCss = asset('design-tokens.css');
const pageCss = asset(encodeURIComponent('板块页样式.css'));
const c1 = id + '-1-1';

const page = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${z.theme}">
<head><style id="xz-perf">/* 长页面打开提速：屏幕外的知识点块不做排版与绘制 */section.kp,section.unit{content-visibility:auto;contain-intrinsic-size:auto 700px}</style>
<meta charset="UTF-8">
<link rel="icon" href="data:,"><script src="../${themeJs}"></script><script src="../${calcJs}"></script><script src="../${navJs}"></script>
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<title>${esc(name)} · 公考工作站</title>
<link rel="stylesheet" href="../${tokensCss}"><link rel="stylesheet" href="../${pageCss}">
<style>
/* 本页专属样式（骨架与通用组件来自 assets/板块页样式.css，颜色一律走令牌）
   下面三行主色是调色板本体，按需改；组件里不要再写十六进制颜色。 */
:root{--primary:${z.color};--primary2:${z.color};--accent:${z.color}}
</style>
</head>
<body>
<header>
  <h1>${esc(name)}</h1>
  <div class="en">${esc(en || z.en)}</div>
  <div class="intro">${esc(desc || (name + '：把内容按卡片录进来，顶部全局搜索与页内搜索都会直接命中。'))}</div>
  <div class="meta"><span>${esc(z.label)} · 新板块</span><span>一张卡一个知识点</span><span>全局搜索可直达</span></div>
</header>
<div class="toolbar">
  <input id="q" placeholder="搜索本板块考点 / 关键词，回车定位…">
  <span class="hitcount" id="hitcount"></span>
  <button class="btn" id="hideans">隐藏答案</button>
  <button class="btn" id="closeall">收起卡片</button>
</div>
<div class="layout">
<nav class="toc" id="toc">
<a class="t-item t-lead" href="#overview">★ 板块总览 · 内容地图</a>
<div class="t-pian"><a href="#${id}-m1">一、${esc(name)}</a></div>
<a class="t-item" href="#${c1}" data-t="1.1 第一条知识点">1.1 第一条知识点</a>
</nav>
<main id="main">
<div class="ov" id="overview"><h2 class="ov-title">板块总览 · 内容地图</h2><div class="ov-grid"><div class="ov-card"><h3>一、${esc(name)}</h3><ul><li><a href="#${c1}"><b>1.1 第一条知识点</b></a></li></ul></div></div></div>
<div class="module" id="${id}-m1"><div class="mod-banner"><h2>一、${esc(name)}</h2></div>
<section class="kp" id="${c1}" data-title="1.1 第一条知识点">
<div class="kp-head"><h3>1.1 第一条知识点</h3><div class="chips"><span class="chip b">待录入</span></div></div>
<div class="kp-body">
<p>把这一条的内容写在这里。需要填空/自测时用 <b>&lt;mark class="fill"&gt;答案&lt;/mark&gt;</b>。</p>
<details class="ans"><summary>查看答案</summary><div class="ans-body">答案：……</div></details>
</div>
</section>
</div>
</main>
</div>
<button class="backtop" id="backtop" title="回到顶部">↑</button>
<script src="../${boardJs}"></script>
</body>
</html>
`;

/* ---------- 生成 NAV 行 ---------- */
const kwList = (sub || '').trim() ? z.keywords.concat([name]) : z.keywords.concat([name]);
const navLine = "  { id:'" + id + "', name:'" + name + "', en:'" + (en || z.en) + "', file:'" + fileRel
  + "', color:'" + (color || z.color) + "',\n    sub:'" + (sub || z.sub) + "', cnt:'" + z.cnt + "',\n    desc:'"
  + (desc || (name + '：待录入。')) + "',\n    keywords:[" + kwList.map((k) => "'" + k + "'").join(',') + "] }";

/* 找到目标数组（var XC_SECTIONS = [ … ];）并在结尾 ]; 之前插入 */
function insertNav(src, arrayName) {
  const start = src.indexOf('var ' + arrayName + ' = [');
  if (start < 0) { fail('在 index.html 里找不到 ' + arrayName + '，请手工登记 NAV'); }
  const end = src.indexOf('\n];', start);
  if (end < 0) { fail('找不到 ' + arrayName + ' 的结尾，请手工登记 NAV'); }
  return src.slice(0, end) + ',\n' + navLine + src.slice(end);
}

console.log('板块  : ' + name + '  (' + id + ')   专区：' + z.label + '   取色：' + (color || z.color));
console.log('页面  : ' + fileRel + (fs.existsSync(pageAbs) ? '（已存在，会报错）' : '（新建）'));
console.log('NAV   : 插入 ' + z.array + ' 末尾：');
console.log(navLine.split('\n').map((l) => '        ' + l).join('\n'));
console.log('脚本/样式版本：' + [themeJs, calcJs, navJs, boardJs, tokensCss, pageCss].map((u) => u.split('?v=')[1]).join(' / '));

if (!APPLY) {
  console.log('\n（这是干跑。确认无误后加 --apply 写盘，然后：node scripts/refresh-site.js）');
  process.exit(0);
}
const newShell = insertNav(shell, z.array);
fs.writeFileSync(pageAbs, page);
fs.writeFileSync(shellAbs, newShell);
console.log('\n✓ 已生成 ' + fileRel + '，并把 NAV 登记写进 index.html 的 ' + z.array + '。');
console.log('  下一步：① 往页面里填内容  ② node scripts/refresh-site.js  ③ .\\publish.cmd --check');
