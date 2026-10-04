// ===== 一条命令把「新增板块 / 新增内容」之后该做的事全做完 =====
//
//   node scripts/refresh-site.js
//
// 依次做三件事：
//   ① 重建检索索引（scripts/build-index.js）—— 新增的题目/卡片/说明文字进索引
//   ② 自动打缓存版本（CACHE_V 与 assets 的 ?v= 都换成内容哈希）—— iPad 才会拿到新页面
//   ③ 跑索引自检（scripts/check-index.js）—— 搜不到、锚点失效、版本没升都会被拦下
//
// 参数：
//   --no-stamp   只重建 + 自检，不改版本号（一般不用）
//   --quiet      只输出结论与问题
//
// 之后的发布流程不变：.\publish.cmd --check → .\publish.cmd
// （publish.py 在真正提交前也会跑一遍 check-index.js，不通过就不发布。）
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const noStamp = args.includes('--no-stamp');
const quiet = args.includes('--quiet');
const say = (m) => { if (!quiet) { console.log(m); } };

function run(script, extra) {
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...(extra || [])], {
    cwd: ROOT, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8'
  });
  return r;
}

const t0 = Date.now();
say('[1/3] 重建检索索引 …');
let r = run('build-index.js');
if (r.status !== 0) {
  console.error('✗ 索引构建失败（退出码 ' + r.status + '）');
  process.exit(r.status || 1);
}
if (quiet && r.stdout) {
  const lines = r.stdout.split('\n').filter((l) => /CORE|FULL|WARN|SKIP/.test(l));
  for (const l of lines) { console.log('   ' + l.trim()); }
}

say('[2/3] 打缓存版本 …');
if (noStamp) {
  say('   已跳过（--no-stamp）');
} else {
  const stamp = require('./lib/stamp');
  const res = stamp.apply(ROOT);
  say('   CACHE_V = ' + res.cacheV + '；更新了 ' + res.changed.length + ' 个文件'
    + (res.changed.length ? '（' + res.changed.slice(0, 3).join(', ') + (res.changed.length > 3 ? ' …' : '') + '）' : ''));
  if (res.unknown.length) {
    say('   ! 有 ' + res.unknown.length + ' 个 assets 引用找不到对应文件，已跳过：' + res.unknown.slice(0, 4).join(', '));
  }
}

say('[3/3] 索引自检 …');
r = run('check-index.js', quiet ? ['--quiet'] : []);
if (r.status !== 0) {
  console.error('\n✗ 索引自检未通过 —— 先按上面的提示修好（或把词加进 scripts/search-fixtures.json 后再看），再发布。');
  process.exit(r.status || 1);
}

say('\n✓ 全部完成（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
say('  下一步：.\\publish.cmd --check   看差异 →  .\\publish.cmd   发布');
