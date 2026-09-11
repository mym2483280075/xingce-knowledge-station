// ===== 检索索引构建器（供全站模糊搜索使用）=====
// 用法：node scripts/build-index.js   →  生成 assets/search-index.json
// 新增内容（新板块 HTML / 每周模考）后重跑一次即可让新内容被顶部搜索检索到。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SEC_META = [
  { file: '常识判断.html', id: 'cs', name: '常识判断' },
  { file: '政治理论.html', id: 'zz', name: '政治理论' },
  { file: '言语理解.html', id: 'yy', name: '言语理解' },
  { file: '数量关系.html', id: 'sl', name: '数量关系' },
  { file: '判断推理.html', id: 'pd', name: '判断推理' },
  { file: '资料分析.html', id: 'zl', name: '资料分析' }
];

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
  const wanted = new Set(['kp', 'unit']);
  const blocks = extractSections(html, wanted);
  let kpCount = 0, unitCount = 0;
  for (const b of blocks) {
    const attrsMatch = '';
    if (b.cls === 'kp') {
      kpCount++;
      const t = (b.attrs.match(/data-title="([^"]*)"/) || [])[1] || titleOfBody(b.html) || '知识点';
      items.push({ s: sec.id, n: sec.name, f: 'sections/' + sec.file, i: b.id, t, x: clean(b.html).slice(0, 900) });
    } else {
      unitCount++;
      const t = titleOfBody(b.html) || '单元';
      items.push({ s: sec.id, n: sec.name, f: 'sections/' + sec.file, i: b.id, t, x: clean(b.html).slice(0, 900) });
    }
  }
  console.log(sec.file, '-> kp:', kpCount, 'unit:', unitCount);
}

const outDir = path.join(ROOT, 'assets');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'search-index.json');
fs.writeFileSync(outPath, JSON.stringify({ v: 1, at: new Date().toISOString().slice(0, 10), items }));
const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log('TOTAL items:', items.length, '| size:', sizeKb + ' KB', '| ->', path.relative(ROOT, outPath));
