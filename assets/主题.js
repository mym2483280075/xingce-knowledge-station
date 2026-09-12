/* =========================================================
   行测知识工作站 · 主题层（白天 / 夜晚 / 跟随系统）
   一份脚本同时服务「工作站外壳」与「各板块页」，不改动板块页原有样式表。

   设计要点：
     1) 同步执行：脚本放在 <head> 里同步加载，解析阶段就把 html.xz-dark 打上，
        不会出现先白后黑的闪烁。
     2) 夜晚模式不是简单反色，而是“保留各板块主色调、把浅色体系整体压暗”：
        所有强调色都用 color-mix 从该页既有的 --primary / --primary2 / --accent 派生，
        因此常识判断是青、政治理论是红、数量关系是橙……夜晚模式下依旧分得清板块。
     3) 三种模式：auto（跟随系统）/ light（白天）/ dark（夜晚），存 localStorage；
        系统深浅色切换时 auto 模式会实时跟随。
     4) 外壳与内嵌 iframe 双向同步：postMessage 立即同步 + storage 事件兜底，
        所以在任意一层切换，另一层立刻跟着变。
     5) 顺带做一组移动端基础适配：去点按延迟、防止输入框聚焦被 iOS 放大、
        表格窄屏横向滚动、底部安全区。
     6) 对外接口：window.__xzTheme（getMode / setMode / cycle / isDark / onChange），
        并派发 document 上的 xz-theme-change 事件，供演算层等其他模块取用。
   ========================================================= */
(function () {
  'use strict';
  if (window.__xzThemeLoaded) return;
  window.__xzThemeLoaded = true;

  var KEY = 'xz-theme-mode';
  var MODES = ['auto', 'light', 'dark'];
  var LABEL = { auto: '跟随系统', light: '白天', dark: '夜晚' };
  var ICON = {
    auto: '<svg class="xz-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.2"/><path d="M12 3.8v16.4"/><path d="M12 6.4a5.6 5.6 0 0 1 0 11.2z" fill="currentColor" stroke="none"/></svg>',
    light: '<svg class="xz-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.6"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/></svg>',
    dark: '<svg class="xz-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.6A8.6 8.6 0 1 1 9.4 3.5a6.9 6.9 0 0 0 11.1 11.1z"/></svg>'
  };
  var FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif';

  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function sysDark() { return !!(mql && mql.matches); }

  var mode = (function () {
    var v = load(KEY);
    return MODES.indexOf(v) >= 0 ? v : 'auto';
  })();
  function isDark() { return mode === 'dark' || (mode === 'auto' && sysDark()); }

  /* ===================== 样式 ===================== */
  var CSS = [
    /* ---------- 夜晚模式的变量重映射 ----------
       注意：板块页会把 --fill-* 写在 html[data-theme="..."] 上，
       选择器权重要压过它，否则填空高亮会残留浅黄底。 */
    'html.xz-dark,html.xz-dark[data-theme]{',
      /* 外壳（index.html） */
      '--ink:#e8eff9;--muted:#93a3b8;--bg:#0c1322;--panel:#121b2b;--rule:#26334a;',
      '--rail:#0a101c;--rail-2:#111a2e;',
      '--shadow:0 2px 10px rgba(0,0,0,.45),0 18px 40px -20px rgba(0,0,0,.75);',
      /* 板块页的填空高亮色 */
      '--fill-bg:#3b2f0b;--fill-ink:#ffe08a;--fill-line:#b8891a;',
      /* 主题层自有 */
      '--xz-bg:#0c1322;--xz-surface:#141d2e;--xz-surface2:#1a2434;--xz-elev:#101a2b;',
      '--xz-line:#28344a;--xz-line2:#35435a;',
      '--xz-ink:#e8eff9;--xz-ink2:#bcc9da;--xz-ink3:#8b9bb1;',
      '--xz-a1:color-mix(in srgb,var(--primary,#4f7cff) 62%,#ffffff);',
      '--xz-a2:color-mix(in srgb,var(--primary2,#4f7cff) 62%,#ffffff);',
      '--xz-a3:color-mix(in srgb,var(--accent,#4f7cff) 52%,#ffffff);',
      'color-scheme:dark;',
    '}',
    'html:not(.xz-dark){color-scheme:light}',

    /* ---------- 基础底色 ---------- */
    'html.xz-dark,html.xz-dark body{background-color:var(--xz-bg)!important}',
    'html.xz-dark body{background-image:radial-gradient(120% 70% at 10% -6%,color-mix(in srgb,var(--accent,#4f7cff) 9%,transparent) 0%,transparent 62%),linear-gradient(180deg,#0d1526 0%,#0c1322 48%,#0a1120 100%)!important;color:var(--xz-ink2)!important}',
    'html.xz-dark ::selection{background:color-mix(in srgb,var(--primary,#4f7cff) 45%,#0b1120);color:#f4f8ff}',
    'html.xz-dark *{scrollbar-color:#3b4a63 #121b2b}',
    'html.xz-dark ::-webkit-scrollbar{width:10px;height:10px}',
    'html.xz-dark ::-webkit-scrollbar-track{background:#121b2b}',
    'html.xz-dark ::-webkit-scrollbar-thumb{background:#33415a;border-radius:999px;border:2px solid #121b2b}',
    'html.xz-dark ::-webkit-scrollbar-thumb:hover{background:#43536e}',

    /* ---------- 板块页：顶部玻璃卡片 ---------- */
    'html.xz-dark header{background:linear-gradient(180deg,rgba(31,42,61,.88),rgba(19,28,44,.72))!important;',
      'border-color:rgba(148,163,184,.16)!important;color:var(--xz-ink)!important;',
      'box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 24px 50px -34px rgba(0,0,0,.9)!important}',
    'html.xz-dark header h1{color:color-mix(in srgb,var(--mc,var(--primary,#4f7cff)) 58%,#f8fafc)!important}',
    'html.xz-dark header .en{color:color-mix(in srgb,var(--primary2,#4f7cff) 52%,#93a3b8)!important}',
    'html.xz-dark header .intro{color:var(--xz-ink2)!important}',
    'html.xz-dark header .meta span{background:color-mix(in srgb,var(--primary2,#4f7cff) 18%,rgba(148,163,184,.12))!important;',
      'border-color:color-mix(in srgb,var(--primary2,#4f7cff) 28%,rgba(148,163,184,.18))!important;color:var(--xz-ink2)!important}',

    /* ---------- 板块页：工具条 / 子导航 / 按钮 / 输入框 ---------- */
    'html.xz-dark .toolbar,html.xz-dark .subnav{background:rgba(15,23,40,.93)!important;border-color:var(--xz-line)!important;color:var(--xz-ink2)!important}',
    'html.xz-dark .toolbar input{background:var(--xz-elev)!important;border-color:var(--xz-line)!important;color:var(--xz-ink)!important}',
    'html.xz-dark .toolbar input::placeholder{color:var(--xz-ink3)!important}',
    'html.xz-dark .btn{background:var(--xz-surface2)!important;border-color:var(--xz-line)!important;color:var(--xz-ink2)!important}',
    'html.xz-dark .btn:hover{border-color:var(--xz-a1)!important;color:var(--xz-a1)!important}',
    'html.xz-dark .btn.on{background:linear-gradient(135deg,var(--primary,#4f7cff),var(--primary2,#6d5cff))!important;',
      'border-color:transparent!important;color:#fff!important;font-weight:700}',
    'html.xz-dark .hitcount{color:var(--xz-ink3)!important}',
    'html.xz-dark .subnav a{background:var(--xz-surface2)!important;border-color:var(--xz-line)!important;color:var(--xz-a2)!important}',
    'html.xz-dark .subnav a:hover{border-color:var(--xz-a2)!important;color:var(--xz-a1)!important}',
    'html.xz-dark .subnav a.on{background:linear-gradient(135deg,var(--primary,#4f7cff),var(--primary2,#6d5cff))!important;',
      'border-color:transparent!important;color:#fff!important}',
    'html.xz-dark .backtop{background:linear-gradient(135deg,color-mix(in srgb,var(--primary,#4f7cff) 78%,#0b1120),color-mix(in srgb,var(--primary2,#4f7cff) 78%,#0b1120))!important;',
      'color:#fff!important;box-shadow:0 8px 20px rgba(0,0,0,.6)!important}',

    /* ---------- 板块页：目录 ---------- */
    'html.xz-dark nav.toc{background:var(--xz-surface)!important;border-color:var(--xz-line)!important;color:var(--xz-ink2)!important}',
    'html.xz-dark nav.toc .t-pian{color:var(--xz-a1)!important;border-top-color:var(--xz-a3)!important}',
    'html.xz-dark nav.toc .t-zhang{color:var(--xz-ink2)!important}',
    'html.xz-dark nav.toc a.t-item{color:var(--xz-ink3)!important}',
    'html.xz-dark nav.toc a.t-item:hover{background:#1e2a3d!important;color:var(--xz-a1)!important}',
    'html.xz-dark nav.toc a.t-item.active{background:color-mix(in srgb,var(--primary,#4f7cff) 22%,#141d2e)!important;color:var(--xz-a1)!important}',
    'html.xz-dark nav.toc .t-cat{color:var(--xz-ink3)!important}',
    'html.xz-dark nav.toc .t-cat:hover{background:#1e2a3d!important;color:var(--xz-a1)!important}',
    'html.xz-dark nav.toc .t-cat b{color:var(--xz-a1)!important}',
    'html.xz-dark nav.toc .t-cat i{background:color-mix(in srgb,var(--accent,#4f7cff) 16%,#141d2e)!important;color:var(--xz-ink3)!important}',

    /* ---------- 板块页：卡片 / 面板 ---------- */
    'html.xz-dark .kp,html.xz-dark .unit,html.xz-dark .kbox,html.xz-dark .ov,html.xz-dark .ov-card,',
    'html.xz-dark .exam,html.xz-dark .mod-body,html.xz-dark .ref,html.xz-dark .refbd,html.xz-dark .fig,',
    'html.xz-dark .figbox,html.xz-dark .mm,html.xz-dark .part,html.xz-dark .guide,html.xz-dark .tbwrap,',
    'html.xz-dark .shen,html.xz-dark .matpage,html.xz-dark .ans-body{',
      'background:var(--xz-surface)!important;border-color:var(--xz-line)!important;color:var(--xz-ink2)!important;box-shadow:none!important}',
    'html.xz-dark .matcard{background:#1b2036!important;border-color:#343c62!important;color:var(--xz-ink2)!important}',
    /* 把上一条压掉的强调边再补回来 */
    'html.xz-dark .kbox{border-left-color:var(--xz-a3)!important}',
    'html.xz-dark .unit{border-left-color:var(--xz-a3)!important;border-bottom-color:var(--xz-a3)!important}',
    'html.xz-dark .mm{border-top-color:var(--xz-a3)!important;border-color:color-mix(in srgb,var(--accent,#4f7cff) 34%,#28344a)!important}',
    'html.xz-dark .kp-head{border-left-color:var(--xz-a1)!important}',
    'html.xz-dark .unit-head{border-left-color:var(--xz-a1)!important}',
    'html.xz-dark .sec{border-left-color:var(--xz-a3)!important}',
    'html.xz-dark .ov-card{border-bottom-color:var(--xz-a3)!important}',
    'html.xz-dark .chap,html.xz-dark .quiz-title{border-bottom-color:var(--xz-a3)!important}',
    'html.xz-dark .exam{border-color:color-mix(in srgb,var(--primary,#4f7cff) 28%,#28344a)!important}',

    /* ---------- 板块页：正文与标题 ---------- */
    'html.xz-dark .kp-body,html.xz-dark .kp-body p,html.xz-dark .qblock,html.xz-dark .qcard,html.xz-dark .opt,',
    'html.xz-dark .mtr,html.xz-dark .matcard,html.xz-dark .vocab,html.xz-dark .bar-row,html.xz-dark .bn,',
    'html.xz-dark .bv,html.xz-dark .mn{color:var(--xz-ink2)!important}',
    'html.xz-dark .kp-body h5.sub2,html.xz-dark h5.sub2{color:var(--xz-ink)!important}',
    'html.xz-dark .kp-body h5.sub3,html.xz-dark h5.sub3{color:var(--xz-ink2)!important}',
    'html.xz-dark .kp-head,html.xz-dark .kp-head h3,html.xz-dark .kp-body h4.sub1,html.xz-dark .sub1,',
    'html.xz-dark .unit-head,html.xz-dark .unit-head b,html.xz-dark .unit-head h2,html.xz-dark .unit-head h3,',
    'html.xz-dark .ov-title,html.xz-dark .kl,html.xz-dark .ml,html.xz-dark .key,html.xz-dark .sec,',
    'html.xz-dark .chap,html.xz-dark .quiz-title,html.xz-dark .block-title h2,html.xz-dark .exam-top h3,',
    'html.xz-dark .guide h3,html.xz-dark .mathead{color:var(--xz-a1)!important}',
    'html.xz-dark .dim,html.xz-dark .unit-desc,html.xz-dark .exam-desc,html.xz-dark .figcap,',
    'html.xz-dark .kp-crumb,html.xz-dark .src,html.xz-dark .t-zhang,html.xz-dark .foot-tip,html.xz-dark .e-s{',
      'color:var(--xz-ink3)!important}',
    'html.xz-dark .stem{color:var(--xz-ink)!important}',
    'html.xz-dark .e-t,html.xz-dark .state{color:#f0a7a7!important}',
    'html.xz-dark .key{background:none!important}',

    /* ---------- 板块页：卡片里的小标题 / 说明文字（各页写法不一，统一兜住） ---------- */
    'html.xz-dark .ov-card h3,html.xz-dark .ov-card h4,html.xz-dark .ov-card b,html.xz-dark .ov-card strong{color:var(--xz-a1)!important}',
    'html.xz-dark .ov-card li a,html.xz-dark .ov-card li a b,html.xz-dark .ov-card li a strong{color:var(--xz-ink)!important}',
    'html.xz-dark .ov-card li span,html.xz-dark .ov-card li em,html.xz-dark .ov-card p{color:var(--xz-ink3)!important}',
    'html.xz-dark .h1,html.xz-dark .h2,html.xz-dark .h3{color:var(--xz-ink2)!important}',
    'html.xz-dark .unit h4.h1,html.xz-dark .unit h5.h2{color:var(--xz-ink2)!important}',
    'html.xz-dark .matcard p,html.xz-dark .matcard li,html.xz-dark .matcard span{color:var(--xz-ink2)!important}',
    'html.xz-dark .guide ol,html.xz-dark .guide li{color:var(--xz-ink2)!important}',
    'html.xz-dark nav.toc a{color:var(--xz-ink2)!important}',
    'html.xz-dark nav.toc .t-pian a{color:var(--xz-a1)!important}',
    /* 词汇卡片：页面上每个词都是一个浅底小圆角块，夜里要整片压暗 */
    'html.xz-dark .unit.vocab p{background:#131c2b!important;border-color:var(--xz-line)!important;color:var(--xz-ink2)!important}',
    'html.xz-dark .mtr{background:#131c2b!important}',
    'html.xz-dark .tmpl{background:color-mix(in srgb,var(--primary,#4f7cff) 13%,#141d2e)!important;border-color:color-mix(in srgb,var(--primary,#4f7cff) 26%,#28344a)!important}',
    'html.xz-dark .tmpl summary{color:var(--xz-a1)!important}',
    'html.xz-dark .tmpl i,html.xz-dark .chips i,html.xz-dark .slot i{background:#33232a!important;border-color:#5c3a44!important;color:#eeb7c4!important}',
    'html.xz-dark .tmpl pre{background:#0b1120!important;color:#ffd9d9!important;border:1px solid var(--xz-line)}',
    'html.xz-dark .guide code,html.xz-dark .tmpl code{background:#33280f!important;color:#fcd34d!important}',

    /* ---------- 板块页：标签 / 小色块 ---------- */
    'html.xz-dark .chip{background:color-mix(in srgb,var(--primary,#4f7cff) 20%,#141d2e)!important;',
      'color:var(--xz-a1)!important;border-color:color-mix(in srgb,var(--primary,#4f7cff) 34%,#28344a)!important}',
    'html.xz-dark .chip.b{background:var(--fill-bg)!important;color:var(--fill-ink)!important;border-color:var(--fill-line)!important}',
    'html.xz-dark .chip.k{background:#16233f!important;color:#9dc0f7!important;border-color:#2d4a7a!important}',
    'html.xz-dark .chip.m{background:#122e1f!important;color:#74e0b0!important;border-color:#245c3a!important}',
    'html.xz-dark .ext-tag,html.xz-dark .kp-tag,html.xz-dark .mathead{background:#231f3d!important;border-color:#3d3768!important;color:#c4b5fd!important}',
    'html.xz-dark .rtag{background:#331a1a!important;border-color:#5c2b2b!important;color:#fca5a5!important}',
    /* 实心小标签在原设计里用白字，夜里把底色压深一点，白字才够清楚 */
    'html.xz-dark .ans-tag{background:#0f7a58!important;color:#fff!important}',
    'html.xz-dark .exp-tag{background:#9c5f06!important;color:#fff!important}',
    'html.xz-dark .mine{background:#331a1a!important;border-color:#5c2b2b!important}',
    'html.xz-dark details.ansbox summary{color:var(--xz-a1)!important}',
    'html.xz-dark .mathead span{background:#1e2447!important;color:#b5bdf7!important}',
    'html.xz-dark .fx b,html.xz-dark .fx strong{color:var(--xz-a2)!important}',
    'html.xz-dark .ansbox{background:#1b2036!important;border-color:#373d63!important;color:#b8c0f5!important}',
    'html.xz-dark .ansline{background:#12291f!important;border-color:#2d6047!important;color:#6ee7b7!important}',
    'html.xz-dark .expline,html.xz-dark .warnbox{background:#2f2510!important;border-color:#5c4a12!important;color:#e7d9b4!important}',
    'html.xz-dark .note{background:color-mix(in srgb,var(--accent,#4f7cff) 15%,#141d2e)!important;',
      'color:color-mix(in srgb,var(--accent,#4f7cff) 40%,#e8eff9)!important}',
    'html.xz-dark .slot,html.xz-dark .chips,html.xz-dark .tpl,html.xz-dark .guide{',
      'background:color-mix(in srgb,var(--primary,#4f7cff) 13%,#141d2e)!important;',
      'border-color:color-mix(in srgb,var(--primary,#4f7cff) 26%,#28344a)!important;',
      'color:color-mix(in srgb,var(--primary,#4f7cff) 32%,#c9d5e6)!important}',
    'html.xz-dark .zt-banner{background:repeating-linear-gradient(45deg,#241d07,#241d07 12px,#2c2409 12px,#2c2409 24px)!important;border-color:#5c4a12!important;color:#fcd34d!important}',
    'html.xz-dark .qtag,html.xz-dark .kcq .qtag{background:#1c2f52!important;color:#9dc0f7!important}',
    'html.xz-dark .mtq .qtag{background:#123a2a!important;color:#74e0b0!important}',
    'html.xz-dark .fx{background:color-mix(in srgb,var(--primary,#4f7cff) 16%,#141d2e)!important;',
      'border-color:color-mix(in srgb,var(--primary,#4f7cff) 30%,#28344a)!important;color:var(--xz-a1)!important}',
    'html.xz-dark .bt{background:color-mix(in srgb,var(--accent,#4f7cff) 20%,#141d2e)!important}',
    'html.xz-dark .bars{border-color:var(--xz-line)!important}',

    /* ---------- 板块页：题块 / 答案 ---------- */
    'html.xz-dark .qblock,html.xz-dark .kcq{background:#131c2b!important;border-color:var(--xz-line)!important;color:var(--xz-ink2)!important}',
    'html.xz-dark .mtq{background:#12211c!important;border-color:#26503f!important;color:var(--xz-ink2)!important}',
    'html.xz-dark .qcard{background:#131c2b!important;border-color:var(--xz-line)!important}',
    'html.xz-dark .qhead,html.xz-dark .qh,html.xz-dark .no{background:color-mix(in srgb,var(--primary2,#4f7cff) 80%,#0b1120)!important;color:#fff!important}',
    'html.xz-dark details.ans .ans-body{background:#131c2b!important;border-color:var(--xz-a3)!important;color:var(--xz-ink2)!important}',
    'html.xz-dark details.ans summary{color:var(--xz-a1)!important}',

    /* ---------- 板块页：表格 ---------- */
    'html.xz-dark .kp-body table.tbl th,html.xz-dark table.tbl th{background:#1b2739!important;color:var(--xz-a1)!important;border-color:var(--xz-line)!important}',
    'html.xz-dark .kp-body table.tbl td,html.xz-dark table.tbl td{background:transparent!important;color:var(--xz-ink2)!important;border-color:var(--xz-line)!important}',
    'html.xz-dark .kp-body table.tbl tr:nth-child(even) td{background:#111a29!important}',
    'html.xz-dark .tbwrap th{background:linear-gradient(135deg,color-mix(in srgb,var(--primary,#4f7cff) 76%,#0b1120),color-mix(in srgb,var(--primary2,#4f7cff) 76%,#0b1120))!important;color:#fff!important}',
    'html.xz-dark .tbwrap td{border-color:var(--xz-line)!important;color:var(--xz-ink2)!important}',
    'html.xz-dark .tbwrap tbody tr:nth-child(even) td{background:#111a29!important}',
    'html.xz-dark .mtr{border-left-color:var(--xz-line2)!important}',

    /* ---------- 板块页：填空 / 高亮 ---------- */
    'html.xz-dark mark.fill{background:var(--fill-bg)!important;color:var(--fill-ink)!important;border-bottom-color:var(--fill-line)!important}',
    'html.xz-dark body.selftest mark.fill{background:#2b3648!important;border-bottom-color:#4a5a72!important;color:transparent!important;',
      'text-shadow:0 0 9px rgba(226,232,240,.45)!important}',
    'html.xz-dark body.selftest mark.fill:hover,html.xz-dark body.selftest mark.fill.show{',
      'color:var(--fill-ink)!important;text-shadow:none!important;background:var(--fill-bg)!important;border-bottom-color:var(--fill-line)!important}',
    'html.xz-dark mark.shl{background:#7d6210!important;color:#ffeaa0!important}',
    'html.xz-dark span.blank{color:#3d4b60!important;border-bottom-color:#3d4b60!important}',

    /* ---------- 板块页：图（扫描件）少刺眼一点，但不反色 ---------- */
    'html.xz-dark figure.fig,html.xz-dark .figbox{border-color:var(--xz-line)!important;background:#101828!important}',
    'html.xz-dark figure.fig img,html.xz-dark .figbox img,html.xz-dark .matpage img,html.xz-dark img.zoomable{filter:brightness(.9) contrast(1.02)}',

    /* ---------- 板块页：模考页专属 ---------- */
    'html.xz-dark .exam-top .no{background:color-mix(in srgb,var(--primary2,#4f7cff) 80%,#0b1120)!important}',
    'html.xz-dark .block-title em{background:#33280f!important;color:#fcd34d!important}',
    'html.xz-dark .part b{color:var(--xz-a1)!important}',
    'html.xz-dark .part span{color:var(--xz-ink2)!important}',
    'html.xz-dark .part .pi{background:linear-gradient(135deg,var(--primary,#4f7cff),var(--primary2,#6d5cff))!important;color:#fff!important}',
    'html.xz-dark .part .cnt{background:#33280f!important;color:#fcd34d!important}',
    'html.xz-dark .guide code{background:#33280f!important;color:#fcd34d!important}',
    'html.xz-dark .mod-banner{background:linear-gradient(135deg,color-mix(in srgb,var(--primary,#4f7cff) 72%,#0b1120),color-mix(in srgb,var(--primary2,#4f7cff) 72%,#0b1120))!important;border-color:rgba(255,255,255,.16)!important;color:#fff!important}',
    'html.xz-dark .mtag{background:color-mix(in srgb,var(--primary2,#4f7cff) 78%,#0b1120)!important;color:#fff!important}',

    /* ---------- 工作站外壳（index.html） ---------- */
    'html.xz-dark .sidebar{background:linear-gradient(90deg,rgba(20,29,45,.95) 0%,rgba(20,29,45,.84) 34%,rgba(20,29,45,.62) 64%,rgba(20,29,45,.36) 100%)!important;',
      'box-shadow:0 0 0 .5px rgba(148,163,184,.12),inset 0 1px 0 rgba(255,255,255,.05),18px 0 48px -36px rgba(0,0,0,.9)!important}',
    'html.xz-dark .sidebar .brand{border-bottom-color:rgba(148,163,184,.12)!important}',
    'html.xz-dark .brand h1,html.xz-dark .crumb .tt{color:var(--xz-ink)!important}',
    'html.xz-dark .brand .tag,html.xz-dark .brand .desc,html.xz-dark .sidebar-foot,html.xz-dark .sidebar-foot .ver{color:var(--xz-ink3)!important}',
    'html.xz-dark .sidebar-foot b{color:var(--xz-ink2)!important}',
    'html.xz-dark .nav .group{color:#7d8ea5!important}',
    'html.xz-dark .nav-item{color:var(--xz-ink2)!important}',
    'html.xz-dark .nav-item:hover{background:rgba(148,163,184,.12)!important}',
    'html.xz-dark .nav-item.active{background:rgba(148,163,184,.17)!important;',
      'box-shadow:0 0 0 .5px rgba(148,163,184,.16),inset 0 1px 0 rgba(255,255,255,.06)!important}',
    'html.xz-dark .nav-item .nm .cn{color:color-mix(in srgb,var(--c,var(--brand)) 66%,#e8eff9)!important}',
    'html.xz-dark .nav-item .cnt{color:var(--xz-ink3)!important;background:rgba(148,163,184,.14)!important;',
      'border-color:rgba(148,163,184,.16)!important;box-shadow:none!important}',
    'html.xz-dark .nav-item.active .cnt{color:var(--xz-ink2)!important;background:rgba(148,163,184,.2)!important}',
    'html.xz-dark .topbar{background:var(--panel)!important;border-bottom-color:var(--rule)!important}',
    'html.xz-dark .menu-btn{color:var(--xz-ink)!important}',
    'html.xz-dark .crumb .en{color:var(--xz-ink3)!important}',
    'html.xz-dark .vbadge{background:rgba(148,163,184,.12)!important;border-color:rgba(148,163,184,.18)!important;color:var(--xz-ink3)!important}',
    'html.xz-dark .app .searchbox{background:var(--xz-elev)!important;border-color:var(--rule)!important}',
    'html.xz-dark .app .searchbox:focus-within{background:#101c2e!important;border-color:var(--brand)!important;box-shadow:0 0 0 3px rgba(79,124,255,.18)!important}',
    'html.xz-dark .app .searchbox .ic{color:var(--xz-ink3)!important}',
    'html.xz-dark .app .searchbox input{color:var(--xz-ink)!important}',
    'html.xz-dark .app .searchbox input::placeholder{color:var(--xz-ink3)!important}',
    'html.xz-dark .app .searchbox .kbd{background:var(--xz-surface2)!important;border-color:var(--rule)!important;color:var(--xz-ink3)!important}',
    'html.xz-dark .app .search-drop{background:var(--xz-surface)!important;border-color:var(--rule)!important}',
    'html.xz-dark .app .search-drop .row{border-bottom-color:#1f2b3e!important}',
    'html.xz-dark .app .search-drop .row:hover{background:var(--xz-surface2)!important}',
    'html.xz-dark .app .search-drop .row .t1{color:var(--xz-ink)!important}',
    'html.xz-dark .app .search-drop .row .t2{color:var(--xz-ink3)!important}',
    'html.xz-dark .app .search-drop .ghead{background:#111a29!important;border-bottom-color:#1f2b3e!important;color:var(--xz-ink3)!important}',
    'html.xz-dark .app .search-drop .sc{background:#1e2a45!important;color:#a8b6d8!important}',
    'html.xz-dark .app .search-drop .t2 b,html.xz-dark .app .search-drop .t2 mark{background:#4a3a08!important;color:#ffe08a!important}',
    'html.xz-dark .app .search-drop .empty,html.xz-dark .empty{color:var(--xz-ink3)!important}',
    'html.xz-dark .app .content{background:var(--bg)!important}',
    'html.xz-dark .app .content iframe{background:var(--bg)!important}',

    /* ---------- 主题层自己的控件 ---------- */
    '.xz-theme-btn{display:inline-flex;align-items:center;gap:6px;line-height:1}',
    '.xz-theme-btn .xz-ico{width:15px;height:15px;flex:none}',
    '.xz-theme-fab{position:fixed;left:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:2147482000;',
      'display:flex;align-items:center;gap:7px;border:1px solid rgba(15,23,42,.1);border-radius:999px;',
      'background:rgba(255,255,255,.92);color:#33404f;font:600 12.5px/1 ' + FONT + ';padding:9px 14px 9px 11px;cursor:pointer;',
      '-webkit-backdrop-filter:blur(18px) saturate(160%);backdrop-filter:blur(18px) saturate(160%);',
      'box-shadow:0 10px 26px -14px rgba(15,23,42,.55);-webkit-tap-highlight-color:transparent;touch-action:manipulation}',
    '.xz-theme-fab .xz-ico{width:16px;height:16px;flex:none}',
    '.xz-theme-fab:active{transform:scale(.96)}',
    'html.xz-dark .xz-theme-fab{background:rgba(23,32,49,.92);border-color:rgba(148,163,184,.22);color:#dbe5f2;',
      'box-shadow:0 10px 26px -14px rgba(0,0,0,.9)}',

    /* ---------- 移动端基础适配（明暗通用） ---------- */
    'html{-webkit-text-size-adjust:100%}',
    'button,a,input,summary,label{-webkit-tap-highlight-color:transparent;touch-action:manipulation}',
    '.backtop{bottom:calc(18px + env(safe-area-inset-bottom,0px))!important;right:calc(18px + env(safe-area-inset-right,0px))!important}',
    /* 窄屏下 .layout 会变成纵向 flex，而 align-items:flex-start 会让卡片按“最大内容宽度”撑开：
       一张宽表就能把整页顶出 700px+。这里统一改成占满宽度，再让宽表自己在卡片里横向滚动。 */
    '@media(max-width:900px){',
      '.layout{align-items:stretch!important}',
      '.layout>*{width:100%!important;min-width:0!important;max-width:100%!important}',
      'main{min-width:0!important;max-width:100%!important}',
      '.wrap,.matpage,.matcard{width:100%!important;max-width:100%!important}',
      'body{overflow-wrap:break-word}',
      'table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}',
      '.tbwrap table{display:table;max-width:none}',
      'img,video{max-width:100%!important;height:auto}',
      'pre{overflow-x:auto;max-width:100%}',
    '}',
    '@media(max-width:640px){',
      '.layout{padding-left:12px!important;padding-right:12px!important}',
      '.toolbar,.subnav{padding-left:12px!important;padding-right:12px!important;gap:8px!important}',
      /* iOS 上 <16px 的输入框聚焦会被整页放大，这里提到 16px 避免跳版 */
      '.toolbar input,.subnav input,.app .searchbox input{font-size:16px!important}',
      '.kp{padding:14px 14px 12px!important;border-radius:12px!important}',
      '.unit{padding:14px!important}',
      'nav.toc{max-height:250px!important}',
      'header h1{font-size:21px!important}',
      '.xz-theme-fab{left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px))}',
    '}',
    '@media(max-width:420px){',
      'body{font-size:14.5px!important}',
      'header h1{font-size:19px!important}',
      '.kp-head h3{font-size:16.5px!important}',
    '}'
  ].join('');

  var styleEl = document.createElement('style');
  styleEl.id = 'xz-theme-css';
  styleEl.textContent = CSS;
  (document.head || document.documentElement).appendChild(styleEl);

  /* ===================== 应用 ===================== */
  var root = document.documentElement;
  var dark = isDark();
  var first = true;
  var listeners = [];
  var fab = null;

  function metaTheme(color) {
    var m = document.querySelector('meta[name="theme-color"]');
    if (!m) {
      m = document.createElement('meta');
      m.setAttribute('name', 'theme-color');
      (document.head || root).appendChild(m);
    }
    m.setAttribute('content', color);
  }

  function syncUI() {
    if (fab) {
      fab.innerHTML = ICON[mode] + '<span>' + LABEL[mode] + '</span>';
      fab.setAttribute('aria-label', '当前：' + LABEL[mode] + '（点按切换）');
      fab.setAttribute('title', '显示模式：' + LABEL[mode] + '（点按切换）');
    }
    var segs = document.querySelectorAll('[data-xz-theme-set]');
    for (var i = 0; i < segs.length; i++) {
      segs[i].classList.toggle('on', segs[i].getAttribute('data-xz-theme-set') === mode);
      segs[i].setAttribute('aria-pressed', segs[i].getAttribute('data-xz-theme-set') === mode ? 'true' : 'false');
    }
  }

  function paint() {
    var d = isDark();
    var changed = (d !== dark) || first;
    first = false;
    dark = d;
    root.classList.toggle('xz-dark', dark);
    root.setAttribute('data-xz-theme', dark ? 'dark' : 'light');
    metaTheme(dark ? '#0c1322' : '#f4f6fb');
    syncUI();
    if (changed) {
      var ev;
      try { ev = new CustomEvent('xz-theme-change', { detail: { dark: dark, mode: mode } }); }
      catch (e) { ev = document.createEvent('Event'); ev.initEvent('xz-theme-change', true, true); ev.detail = { dark: dark, mode: mode }; }
      try { document.dispatchEvent(ev); } catch (e2) {}
      for (var i = 0; i < listeners.length; i++) { try { listeners[i](dark, mode); } catch (e3) {} }
    }
  }

  function tell() {
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'xz-theme', mode: mode, dark: dark }, '*'); } catch (e) {}
    if (frameEl) { try { frameEl.contentWindow.postMessage({ type: 'xz-theme', mode: mode, dark: dark }, '*'); } catch (e2) {} }
  }

  function setMode(m, silent) {
    if (MODES.indexOf(m) < 0) return;
    mode = m;
    save(KEY, m);
    paint();
    if (!silent) tell();
  }

  /* 内嵌 iframe（外壳模式下由 index.html 调用 setFrames 指定） */
  var frameEl = null;

  /* ===================== 挂载控件 ===================== */
  var embedded = false;
  try { embedded = (window.top !== window.self); } catch (e) { embedded = true; }

  function buildFab() {
    /* 页面自己已经有开关（工作站的顶栏分段控件）就不要再冒一个浮标出来 */
    if (fab || embedded) return;
    try { if (document.querySelector('[data-xz-theme-set]')) return; } catch (e) {}
    fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'xz-theme-fab';
    fab.addEventListener('click', function () { cycle(); });
    (document.body || root).appendChild(fab);
    syncUI();
  }

  function cycle() {
    var i = MODES.indexOf(mode);
    setMode(MODES[(i + 1) % MODES.length]);
  }

  /* 点按 [data-xz-theme-set] 切换 */
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-xz-theme-set]') : null;
    if (!el) return;
    e.preventDefault();
    setMode(el.getAttribute('data-xz-theme-set'));
  });

  /* 系统深浅色变化：auto 模式实时跟随 */
  function onSys() {
    if (mode === 'auto') { paint(); tell(); }
  }
  if (mql) {
    if (mql.addEventListener) mql.addEventListener('change', onSys);
    else if (mql.addListener) mql.addListener(onSys);
  }

  /* 其它页面（外壳 / iframe / 另一个标签页）改了主题：跟着变 */
  window.addEventListener('storage', function (e) {
    if (e && e.key && e.key !== KEY) return;
    var v = load(KEY);
    if (MODES.indexOf(v) < 0) v = 'auto';
    if (v !== mode) { mode = v; paint(); }
  });
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'xz-theme-set' && MODES.indexOf(d.mode) >= 0) { setMode(d.mode, true); return; }
    if (d.type === 'xz-theme-query') {
      try { e.source.postMessage({ type: 'xz-theme', mode: mode, dark: dark }, '*'); } catch (err) {}
    }
  });

  /* 首次渲染：脚本在 <head> 同步执行，这里就把类打上，避免闪白 */
  paint();

  window.__xzTheme = {
    modes: MODES.slice(),
    getMode: function () { return mode; },
    isDark: function () { return dark; },
    setMode: setMode,
    cycle: cycle,
    on: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    /* 供 index.html 调用：注册内嵌容器 + 挂载底部浮标（非内嵌时才显示） */
    bindFrame: function (el) { frameEl = el; },
    mount: function () { buildFab(); },
    broadcast: function () { tell(); }
  };

  /* DOM 就绪后补挂浮标（非内嵌场景，例如直接打开某个板块页） */
  if (embedded) {
    /* 内嵌时由外壳统一控制，但通知外壳当前状态，保证两边一致 */
    tell();
  } else {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { buildFab(); syncUI(); tell(); });
    } else { buildFab(); syncUI(); tell(); }
  }
  tell();
})();
