// ===== 检索索引构建器（供全站模糊搜索使用）=====
// 用法：node scripts/build-index.js   →  生成 assets/search-index.json
// 新增内容（新板块 HTML / 每周模考）后重跑一次即可让新内容被顶部搜索检索到。
//
// 【给审阅者的约定】【需求】用户要求“顶部搜索能搜到正文任意知识点”，所以这份脚本是
//   搜索能不能用的前提；改了板块页结构必须重跑，否则搜索会静默少结果。
//   【易错】SEC_META 里的 id 必须与 index.html 的 SECTIONS[].id 完全一致（全局主键）。
//   【易错】可搜索卡片的 class 白名单（默认 kp / unit，可在 SEC_META 里按板块覆盖）
//     必须与板块页里卡片容器的 class 对应，板块页改了类名这里不跟着改 = 索引里直接少一大片内容，
//     而且没有任何报错。
//   【性能】每条只截 900 字符、总量约 561KB：抄进索引的正文越长，首页搜索越慢，
//     调整截断长度前先看 index.html 的 warmIndex（它是按需加载的）。
//   【数据】输出结构 { v, at, items[] }，item = { s:板块id, n:板块名, f:文件, i:锚点id, t:标题, x:正文片段 }，
//     index.html 的 renderSearch / openSection 直接吃这些字段，改名要同时改前端。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 【数据】【易错】板块主键表：id 必须与 index.html 的 SECTIONS[].id 完全一致；
// 这里漏加一个板块 = 该板块正文搜不到（没有任何报错，最难发现的一类问题）。
const SEC_META = [
  { file: '常识判断.html', id: 'cs', name: '常识判断' },
  { file: '政治理论.html', id: 'zz', name: '政治理论' },
  { file: '言语理解.html', id: 'yy', name: '言语理解' },
  { file: '数量关系.html', id: 'sl', name: '数量关系' },
  { file: '判断推理.html', id: 'pd', name: '判断推理' },
  { file: '资料分析.html', id: 'zl', name: '资料分析' },
  /* 申论五大题型（2026-09-15 新增）：页面在 sections/申论/ 下，
     卡片容器统一是 section.unit，所以 wanted 用默认白名单之外的 ['unit']。
     【易错】申论页里的「待录入」槽位也是 section.unit，会一并进索引 —— 这是有意的：
     录入真题后只要重跑本脚本，新内容自动可搜，不需要再动这里。 */
  { file: '申论/概括题.html', id: 'sngk', name: '申论·概括题', wanted: ['unit'] },
  { file: '申论/分析题.html', id: 'snfx', name: '申论·分析题', wanted: ['unit'] },
  { file: '申论/对策题.html', id: 'sndc', name: '申论·对策题', wanted: ['unit'] },
  { file: '申论/公文写作.html', id: 'sngw', name: '申论·公文写作', wanted: ['unit'] },
  { file: '申论/大作文.html', id: 'sndz', name: '申论·大作文', wanted: ['unit'] },
  { file: '申论/范文.html', id: 'snfw', name: '申论·范文', wanted: ['unit'] },
  { file: '日常积累.html', id: 'rj', name: '日常积累', wanted: ['unit'] }
  /* 【易错】模考真题（侧栏专区 mkx）刻意没有登记在这里，别再试：
     它下面的「模考总览」（id: mk）与各期次（id: mk-YYMMDD）都指向同一份
     sections/每周模考.html，而那一页的正文是 render() 用 MOCK_DATES 在前端拼出来的
     （HTML 里只有一个空的 #wrap），本脚本只扒静态 HTML —— 登记进去也只会得到 0 条，
     白让人以为已经索引了。模考正文（行测 / 申论 / 错题集合）在子页面里，
     外壳索引里的锚点也点不过去，所以同样不登记。
     想让模考内容可全文检索，正确做法是给每期子页面在 index.html 里加叶子条目。 */
];

// 【易错】把 HTML 扒成纯文本：规则要与板块页真实结构保持兼容（图片只取 alt、
// script/style 整体丢弃）。板块页新增内联组件后要回来看这里会不会把正文一起吃掉
// —— 症状是搜索命中率突然下降，但不报错。
const clean = (s) => String(s || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, ' $1 ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
  .replace(/\s+/g, ' ').trim();

const titleOfBody = (body) => {
  const m = body.match(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/);
  return m ? clean(m[1]) : '';
};

// 栈式 section 提取：正确处理任意嵌套，返回 {cls, id, title, html}[]
// 【易错】只认 wanted 里的 class；实现上遇到 </section> 只弹出栈顶一项（并非按名字配对），
// 所以板块页里的 section 必须严格成对闭合：漏一个闭标签会让后面所有卡片集体错位，
// 表现为“某些知识点搜不到、或者标题张冠李戴”。
function extractSections(html, wanted) {
  const blocks = [];
  const stack = [];
  const re = /<\/?section\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const open = tag.charAt(1) !== '/';
    if (open) {
      const attrs = m[0].slice(8, -1);
      const cls = (attrs.match(/class="([^"]*)"/) || [])[1] || '';
      const id = (attrs.match(/id="([^"]*)"/) || [])[1] || '';
      const classes = cls.split(/\s+/).filter(Boolean);
      stack.push({ tagStart: m.index + m[0].length, attrs, id, classes });
    } else {
      for (let i = stack.length - 1; i >= 0; i--) {
        const top = stack[i];
        if (top.id !== '__needle__') {
          const hit = top.classes.find((c) => wanted.has(c));
          if (hit) {
            const body = html.slice(top.tagStart, m.index);
            blocks.push({ cls: hit, id: top.id, attrs: top.attrs || '', html: body });
          }
        }
        stack.pop();
        break;
      }
    }
  }
  return blocks;
}

const items = [];
for (const sec of SEC_META) {
  const filePath = path.join(ROOT, 'sections', sec.file);
  if (!fs.existsSync(filePath)) { console.log('SKIP missing', sec.file); continue; }
  const html = fs.readFileSync(filePath, 'utf8');
  /* 【易错】“可被搜索的卡片” = 白名单里的 class，与板块页的容器 class 一一对应；
     板块页改了类名而这里不改，索引会静默少掉一大片内容（没有任何报错）。
     默认白名单是 kp / unit；结构不同的板块（如每周模考的期次卡）在 SEC_META 里单独声明。 */
  const wanted = new Set(sec.wanted || ['kp', 'unit']);
  const blocks = extractSections(html, wanted);
  const counts = {};
  for (const b of blocks) {
    /* 标题优先级：data-title → 卡片里第一个 h2/h3/h4 → 按 class 兜底 */
    const t = (b.attrs.match(/data-title="([^"]*)"/) || [])[1] || titleOfBody(b.html) || (b.cls === 'kp' ? '知识点' : '单元');
    items.push({ s: sec.id, n: sec.name, f: 'sections/' + sec.file, i: b.id, t, x: clean(b.html).slice(0, 900) });
    counts[b.cls] = (counts[b.cls] || 0) + 1;
  }
  console.log(sec.file, '->', JSON.stringify(counts));
}

const outDir = path.join(ROOT, 'assets');
fs.mkdirSync(outDir, { recursive: true });
// 【数据】写出的索引由 index.html 直接 fetch('assets/search-index.json') 消费；
// 即使手工改这个 JSON，也要保持 { v, at, items } 结构与 s/n/f/i/t/x 字段名不变。
const outPath = path.join(outDir, 'search-index.json');
fs.writeFileSync(outPath, JSON.stringify({ v: 1, at: new Date().toISOString().slice(0, 10), items }));
const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log('TOTAL items:', items.length, '| size:', sizeKb + ' KB', '| ->', path.relative(ROOT, outPath));
