// ===== 缓存版本自动打戳（供 refresh-site.js / check-index.js / new-section.js 共用）=====
// 目的：以后新增板块或内容时不用再手工数「CACHE_V 该升到第几档」。
//   · assets/*.js、assets/*.css 的 ?v= 直接换成「该文件内容的 sha1 前 8 位」——
//     文件没改 → 版本不变（不会白让 iPad 重下）；改了 → 自动变。
//   · index.html 的 CACHE_V 换成「全部板块页 HTML 内容 + 文件名」的 sha1 前 8 位——
//     iframe 里的板块页只要有一个字变了，iPad 就会重新下载（这正是 CACHE_V 的职责）。
// 【易错】板块页里的资源引用有三种写法（assets/…、../assets/…、../../../assets/…），
// 资产名还可能是百分号编码的中文；这里统一「先解码再按文件名比对」，只动 assets 下真实存在的
// *.js / *.css，其它 URL（图片、外链、search-full/<key>.json?v=<rev> 等）一概不碰。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* 只认「属性里的 assets 引用」：src="…/assets/xx.js?v=…" / href="…/assets/xx.css?v=…"。
   不去动注释、字符串、代码里提到的 assets/xxx（例如外壳注释里写的文件名）。 */
const ASSET_RE = /(="[^"]*?assets\/(?:%[0-9A-Fa-f]{2}|[^"'?#%])*?\.(?:js|css))(\?v=[^"]*)?"/g;

function sha(s, n) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, n || 8);
}

function walk(dir, filter) {
  if (!fs.existsSync(dir)) { return []; }
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...walk(p, filter)); }
    else if (!filter || filter(e.name)) { out.push(p); }
  }
  return out;
}

function pages(root) {
  return walk(path.join(root, 'sections'), (n) => n.endsWith('.html')).sort();
}

function assetVersions(root) {
  const dir = path.join(root, 'assets');
  const out = {};
  if (!fs.existsSync(dir)) { return out; }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !/\.(js|css)$/i.test(e.name)) { continue; }
    out[e.name] = sha(fs.readFileSync(path.join(dir, e.name)));
  }
  return out;
}

function cacheVersion(root) {
  /* CACHE_V 覆盖「板块页内容 + 所有资源版本」两件事：
     · 页面内容变了 → 换新值（iPad 重新下载 iframe 里的页面）；
     · 只改了 assets/*.js|css → 各页面的 ?v= 会变，但缓存里的旧页面 HTML 仍指向旧 URL，
       浏览器会继续用旧脚本 —— 所以资源的哈希也必须进 CACHE_V，逼 iPad 重取页面 HTML。 */
  const parts = [];
  for (const p of pages(root)) {
    const rel = path.relative(root, p).replace(/\\/g, '/');
    /* 【易错】把页面里的 ?v=… 抹掉再算：版本号本身就是由这份内容 + 资源哈希算出来的，
       不抹掉就会「打一次戳 → 哈希变化 → 下次又要打戳」，永远收敛不了。 */
    const text = fs.readFileSync(p, 'utf8').replace(/\?v=[^"'&\s>]*/g, '');
    parts.push(rel + ':' + sha(text));
  }
  const av = assetVersions(root);
  for (const name of Object.keys(av).sort()) { parts.push(name + ':' + av[name]); }
  return 'v' + sha(parts.join('|'));
}

/* 把一段 HTML/CSS/JS 文本里的 assets 引用换成当前内容哈希；返回 {text, changed, unknown} */
function applyAssets(text, root, versions) {
  const unknown = [];
  const out = text.replace(ASSET_RE, (m, prefix) => {
    const url = prefix.slice(2);           /* 去掉开头的 =" */
    let name = url;
    try { name = decodeURIComponent(url); } catch (e) { /* 保持原样 */ }
    name = name.slice(name.lastIndexOf('/') + 1);
    if (!Object.prototype.hasOwnProperty.call(versions, name)) {
      if (!unknown.includes(name)) { unknown.push(name); }
      return m;
    }
    return prefix + '?v=' + versions[name] + '"';
  });
  return { text: out, changed: out !== text, unknown };
}

/* 需要打戳的文件：外壳 + 所有板块页 */
function stampTargets(root) {
  const list = [path.join(root, 'index.html')];
  for (const p of pages(root)) { list.push(p); }
  return list.filter((p) => fs.existsSync(p));
}

function apply(root, opts) {
  const dryRun = !!(opts && opts.dryRun);
  const versions = assetVersions(root);
  const cacheV = cacheVersion(root);
  const changed = [];
  const unknown = [];
  for (const file of stampTargets(root)) {
    const orig = fs.readFileSync(file, 'utf8');
    const res = applyAssets(orig, root, versions);
    let out = res.text;
    for (const u of res.unknown) { if (!unknown.includes(u)) { unknown.push(u); } }
    if (path.basename(file) === 'index.html') {
      out = out.replace(/var CACHE_V = 'v[^']*';/, "var CACHE_V = '" + cacheV + "';");
    }
    if (out !== orig) {
      changed.push(path.relative(root, file).replace(/\\/g, '/'));
      if (!dryRun) { fs.writeFileSync(file, out); }
    }
  }
  return { changed, cacheV, versions, unknown };
}

module.exports = { sha, walk, pages, assetVersions, cacheVersion, applyAssets, apply, ASSET_RE };
