/* =========================================================
   行测知识工作站 · 定位层（目录 / 锚点 / 搜索跳转的精确落点）
   一份脚本同时服务全部板块页，不改动任何板块页的样式与既有逻辑。

   要解决的问题（用户反馈：“根据目录点击定位到正文，时常出错，
   定位错误，定位点与原文差距过大”）——排查出的四条根因：

     ① 【主因】各板块页 <head> 里的 xz-perf 给 section.kp / section.unit 加了
        content-visibility:auto + contain-intrinsic-size:auto 700px。
        屏幕外的知识块不参与排版，一律按 700px 估高。跳到靠后的锚点时，
        浏览器拿“估算高度”算目标位置：估 700、实际 3000，差多少就偏多少。
        这就是“落点与原文差距过大”的主因，越靠后的目录项偏得越离谱。

     ② .toolbar 是 position:sticky;top:0，且 flex-wrap:wrap 会换行，
        实测高度在 50~100px 之间浮动；而各板块页写死的
        scroll-margin-top:70px 只是个常量猜测，窄屏换行后落点会被吸顶栏吃掉一截。

     ③ 判断推理.html 与 每周模考/行测.html 里有 580+ 张 loading="lazy" 图片，
        跳转完成后才解码撑开，上方内容整体下移，落点再次跑掉。

     ④ html{scroll-behavior:smooth}：原生锚点只在点击那一刻算一次终点，
        平滑动画期间布局一直在变，动画停下的位置本身就是错的。

   做法（借鉴 GitHub 成熟方案）：
     · scroll-into-view/scroll-into-view-if-needed（1.4k★）与
       tscanlin/tocbot（1.5k★）的共识是：不要指望浏览器“一次算准”，
       而是「自己算目标位置 → 滚动 → 重新量 → 再修正」，
       并且吸顶偏移必须用运行时实测值，而不是 CSS 常量。
     · 本文件在此基础上补一层“回流收敛”：每帧用 getBoundingClientRect()
       重新量目标的真实位置，直到连续两帧误差 < 1.2px 才收手；
       落点后再盯 1.6s，图片解码 / 字体回流造成的位移会被自动补正。
   ========================================================= */

/* ===================================================================
   给后续审阅者的阅读约定 —— 改代码前先看这一段
   ---------------------------------------------------------------
   【需求】用户明确提出的要求：点目录 / 点锚点必须“指哪到哪”。
   【易错】最容易引入 bug 的地方：动它之前请把整段连同调用方一起读完。
   【坑】  iPad / WebKit、iframe 内滚动、content-visibility、懒加载图片。
   【接口】window.__xzNav（goTo / offset / diag）；原型补丁可用
           window.__xzNavPatchSIV === false 关掉。
   -------------------------------------------------------------------
   三条关键契约（动任何一条都要全站回归）：
     ① 本脚本必须放在 <head> 里、各板块页既有脚本之后同步加载，
        不能等 DOMContentLoaded 才注册点击劫持（否则首屏点击会漏）。
     ② 只接管“本文档内的纯锚点链接”和“本框架内的 scrollIntoView”，
        外链、跨页链接、新窗口链接一律放行给浏览器原生行为。
     ③ 程序化滚动期间临时把 scroll-behavior 设成 auto、overflow-anchor 设成 none，
        结束后必须原样还原 —— 否则会污染用户手动滚动的体验。
   =================================================================== */
(function () {
  'use strict';
  if (window.__xzNavLoaded) return;
  window.__xzNavLoaded = true;

  /* 【数据】可调参数：改这里就够，别把数字散落到函数体里 */
  var GAP = 12;         // 落点与吸顶栏下沿之间留出的呼吸间距（px）
  var FALLBACK = 56;    // 量不到吸顶栏时的兜底遮挡高度（px，与 CSS 默认 70 呼应）
  var TWEEN = 0.3;      // 平滑逼近系数：每帧走完剩余距离的 30%
  var MAX_FRAMES = 90;  // 收敛上限定帧数（≈1.5s），防极端布局抖动时死循环
  var STABLE_NEED = 2;  // 连续稳定多少帧算收敛
  var EPS = 1.2;        // 收敛阈值（px）
  var WATCH_MS = 1600;  // 落点后继续盯布局变化的时长（懒加载图片回流）
  var BAR_MIN_RATIO = 0.55; // 横条宽度 / 视口宽度 的判定阈值，用于排除侧栏

  /* 【易错】选择器只列“可能压在正文上方的横条”。nav.toc 虽然是 sticky，
     但它是侧栏、且窄屏会变 static，靠宽度阈值和吸附位置双重排除。 */
  var STICKY_SEL = '.toolbar,.subnav,.xz-bar,[data-xz-sticky]';

  function docEl() { return document.documentElement; }
  function bodyEl() { return document.body; }

  function scrollTop() {
    var d = docEl();
    if (window.pageYOffset != null) return window.pageYOffset;
    if (d && d.scrollTop) return d.scrollTop;
    return (bodyEl() && bodyEl().scrollTop) || 0;
  }
  function viewH() {
    var d = docEl();
    return window.innerHeight || (d && d.clientHeight) || 0;
  }
  function viewW() {
    var d = docEl();
    return window.innerWidth || (d && d.clientWidth) || 0;
  }
  function maxScroll() {
    var d = docEl(), b = bodyEl();
    var h = Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0);
    return Math.max(0, h - viewH());
  }

  /* 【坑】不要用 scrollTo({behavior:'smooth'}) 做修正：动画期间量不到终点。
     这里一律写绝对坐标，并且夹在 [0, maxScroll] 之间。 */
  function hardTo(y) {
    var v = Math.max(0, Math.min(Math.round(y), maxScroll()));
    try {
      window.scrollTo(0, v);
    } catch (e) {
      var d = docEl(), b = bodyEl();
      if (d) d.scrollTop = v;
      if (b) b.scrollTop = v;
    }
    return v;
  }

  function raf(fn) {
    if (window.requestAnimationFrame) return window.requestAnimationFrame(fn);
    return window.setTimeout(function () { fn(Date.now()); }, 16);
  }
  function cancelRaf(id) {
    if (window.cancelAnimationFrame) { try { window.cancelAnimationFrame(id); } catch (e) {} }
    else { try { window.clearTimeout(id); } catch (e2) {} }
  }

  function prefersReduced() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  /* ================= 吸顶遮挡高度（运行时实测） ================= */
  /* 【易错】必须在“已经滚到目标附近”之后再量：
     吸顶栏未吸附时 rect.top 是它在文档流里的位置，量不出遮挡高度。
     收敛循环每帧都会调它，所以真正生效的是吸附后的那一帧。 */
  function barCover() {
    var cover = 0, list;
    try { list = document.querySelectorAll(STICKY_SEL); } catch (e) { return 0; }
    var vw = viewW();
    for (var i = 0; i < list.length; i++) {
      var el = list[i], st;
      try { st = window.getComputedStyle(el); } catch (e2) { continue; }
      if (!st || (st.position !== 'sticky' && st.position !== 'fixed')) continue;
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
      var r = el.getBoundingClientRect();
      if (r.height <= 0) continue;
      if (r.width < vw * BAR_MIN_RATIO) continue;          // 侧栏 / 竖条排除
      if (r.bottom <= 2) continue;                          // 已滚出视口上方
      if (r.top <= 4) {                                     // 已吸附在顶部 → 它盖住 r.bottom
        if (r.bottom > cover) cover = r.bottom;
      } else if (st.position === 'sticky') {
        /* 还没吸附：说明目标在它上面，或本次跳转后会把它顶到顶部。
           跳转到下方时它必然吸附，遮挡高度就是它自己的高度。 */
        if (r.height > cover) cover = r.height;
      }
    }
    return cover;
  }

  /* 对外语义：落点需要往下让出多少像素 */
  function anchorOffset() {
    var c = barCover();
    return (c > 0 ? c : FALLBACK) + GAP;
  }

  /* ================= 目标位置计算 ================= */
  function effectiveAlign(el, align) {
    if (align !== 'center') return align || 'start';
    /* 目标比视口还高时，居中会把它顶部推到屏幕外，退回 start 更合理 */
    try { if (el.getBoundingClientRect().height > viewH() * 0.9) return 'start'; } catch (e) {}
    return 'center';
  }

  function desiredTop(el, align, offset) {
    var r = el.getBoundingClientRect(), top = scrollTop(), vh = viewH();
    if (align === 'center') return Math.max(0, Math.round(r.top + top - (vh - r.height) / 2));
    if (align === 'end') return Math.max(0, Math.round(r.top + top - vh + r.height + offset));
    return Math.max(0, Math.round(r.top + top - offset));
  }

  /* ================= “实测模式”：临时关掉 content-visibility ================= */
  /* 【坑】这是本次修复最关键的一处，别删。各板块页给 section.kp/.unit 加了
     contain-intrinsic-size:auto 700px，屏幕外的块按 700px 算高度 —— 这同时
     也把 documentElement.scrollHeight 一起算小了（页面上估算高度远小于真实高度时，
     整页“可滚动范围”都是假的）。于是跳到很靠后的锚点时，window.scrollTo 会被
     浏览器夹在一个偏小的 maxScroll 上，怎么滚都到不了目标，落点就会差上万像素。
     解决办法：一旦发现“目标位置 > 当前可滚动上限”，就把 content-visibility 临时
     改成 visible 并强制一次同步布局 —— 此时所有占位尺寸都变成真实尺寸，
     scrollHeight 也变准，一次就能滚到位。
     代价：这一次跳转会付一次全页布局（判断推理那种 10k 行的页面约几百毫秒），
     所以只在“确实被夹住”时才开，不做无谓的全页布局。
     好处：contain-intrinsic-size 的 auto 关键字会记住已渲染过的真实尺寸，
     退出实测模式后布局不会回退 —— 同一板块里第二次跳转通常就不再需要它了。 */
  var measureDepth = 0;
  function measureOn() { return measureDepth > 0; }
  function enterMeasure() {
    if (measureDepth++ > 0) return;
    try { if (docEl()) docEl().classList.add('xz-nav-measure'); } catch (e) {}
    forceLayout();
  }
  function exitMeasure() {
    if (measureDepth === 0) return;
    if (--measureDepth > 0) return;
    try { if (docEl()) docEl().classList.remove('xz-nav-measure'); } catch (e) {}
    forceLayout();
  }
  function forceLayout() {
    try {
      if (docEl()) { void docEl().offsetHeight; void docEl().scrollHeight; }
      if (bodyEl()) { void bodyEl().offsetHeight; }
    } catch (e) {}
  }

  /* ================= 滚动期样式接管 ================= */
  var lockDepth = 0;
  function lockStyles() {
    var d = docEl(), b = bodyEl();
    if (lockDepth++ > 0) return null;
    var snap = {
      d: d ? { sb: d.style.scrollBehavior, oa: d.style.overflowAnchor } : null,
      b: b ? { sb: b.style.scrollBehavior } : null
    };
    if (d) { d.style.scrollBehavior = 'auto'; d.style.overflowAnchor = 'none'; }
    if (b) { b.style.scrollBehavior = 'auto'; }
    return snap;
  }
  function unlockStyles(snap) {
    if (lockDepth > 0) lockDepth--;
    if (!snap || lockDepth > 0) return;
    try {
      if (snap.d && docEl()) {
        docEl().style.scrollBehavior = snap.d.sb;
        docEl().style.overflowAnchor = snap.d.oa;
      }
      if (snap.b && bodyEl()) bodyEl().style.scrollBehavior = snap.b.sb;
    } catch (e) {}
  }

  /* ================= 主流程：滚动 + 收敛校正 ================= */
  var running = null;
  /* 【易错】每次跳转自增一次序号，看门狗靠它判断“自己是不是过期的那一次”。
     用户连点两下目录时就靠这个防止旧的那次回头把落点又改回去。 */
  var runSeq = 0;

  function run(el, opts) {
    if (!el || !el.getBoundingClientRect) return;
    opts = opts || {};
    if (running && running.abort) { try { running.abort(); } catch (e) {} }

    var seq = ++runSeq;
    var align = opts.align || 'start';
    var smooth = (opts.smooth !== false) && !prefersReduced();
    var snap = lockStyles();
    var frames = 0, stable = 0;
    var handle = null, aborted = false;
    var lastTarget = -1, lastCur = -1;

    running = {
      abort: function () {
        aborted = true;
        if (handle) cancelRaf(handle);
        unlockStyles(snap);
        snap = null;
        /* 实测模式是全局开关，中途被取消时必须还回去，否则整页会一直不做跳过渲染 */
        exitMeasure();
      }
    };

    function tick() {
      if (aborted) return;
      var a = effectiveAlign(el, align);
      var off = (a === 'center' || a === 'end') ? GAP : anchorOffset();
      var d = desiredTop(el, a, off);

      /* 【坑】目标超出了当前“可滚动上限”，说明 scrollHeight 被 content-visibility
         估算小了 —— 开了实测模式重新量，下一帧继续。不这么做的后果见上面注释。 */
      if (d > maxScroll() + 2 && !measureOn()) {
        enterMeasure();
        handle = raf(tick);
        return;
      }

      var cur = Math.round(scrollTop());
      var diff = d - cur;

      if (Math.abs(diff) < EPS) {
        /* 【易错】连续稳定两帧才收手：content-visibility 的块在同一帧内
           可能先给估算尺寸、下一帧才给真实尺寸，只判一帧会把“假收敛”当成功。 */
        stable++;
        if (stable >= STABLE_NEED || frames >= MAX_FRAMES) { finish(d); return; }
        frames++; handle = raf(tick); return;
      }

      stable = 0;

      if (frames >= MAX_FRAMES) { hardTo(d); finish(d); return; }
      frames++;

      if (smooth) {
        /* 距离很近时直接吸附：指数逼近在最后几像素上会磨很久 */
        if (Math.abs(diff) < 24) hardTo(d);
        else hardTo(cur + diff * TWEEN);
      } else {
        hardTo(d);
      }

      var after = Math.round(scrollTop());
      /* 已经贴到文档顶/底，怎么滚都动不了，就别再空转 */
      if (after === lastCur && d === lastTarget) { finish(after); return; }
      lastCur = after; lastTarget = d;

      handle = raf(tick);
    }

    function finish() {
      if (aborted) return;
      var a = effectiveAlign(el, align);
      var off = (a === 'center' || a === 'end') ? GAP : anchorOffset();
      hardTo(desiredTop(el, a, off));
      unlockStyles(snap); snap = null;
      running = null;
      watch(el, align, opts, seq);
      if (typeof opts.done === 'function') { try { opts.done(el); } catch (e) {} }
    }

    handle = raf(tick);
  }

  /* ================= 落点后的“看门狗” ================= */
  /* 懒加载图片解码 / 字体替换 / 展开收起 都可能在落点后改变上方高度。
     这里用事件 + 几个定时检查点补正，代价远低于一直跑 rAF。 */
  function watch(el, align, opts, seq) {
    var endAt = Date.now() + WATCH_MS;
    var timers = [], listeners = [], done = false;

    function recheck() {
      if (done) return;
      if (seq !== runSeq) { cleanup(); return; }   /* 已经开了新的一次跳转，别插手 */
      if (Date.now() > endAt) { cleanup(); return; }
      if (!el.isConnected) { cleanup(); return; }
      correctPass(4);
    }

    /* 【易错】一次补正不够：落点后内容可能分几帧陆续撑开（图片逐张解码、
       content-visibility 的块逐个渲染），每撑开一次就把目标往下顶一次。
       所以这里连做最多 4 次「量→滚」，而不是只滚一次就收工。 */
    function correctPass(left) {
      if (done || seq !== runSeq || !el.isConnected) return;
      var a = effectiveAlign(el, align);
      var off = (a === 'center' || a === 'end') ? GAP : anchorOffset();
      var d = desiredTop(el, a, off);
      if (Math.abs(d - Math.round(scrollTop())) <= 1.5) return;
      var snap = lockStyles();
      hardTo(d);
      unlockStyles(snap);
      if (left > 1) raf(function () { correctPass(left - 1); });
    }

    /* 节流：一次布局回流可能同时触发多张图片 load */
    var pending = false;
    function schedule() {
      if (done) return;
      if (pending) return;
      pending = true;
      raf(function () { pending = false; recheck(); });
    }

    try {
      window.addEventListener('load', schedule, true);   // 捕获阶段接住 <img> 的 load
      window.addEventListener('error', schedule, true);
      window.addEventListener('resize', schedule, false);
      listeners.push(['load', schedule, true], ['error', schedule, true], ['resize', schedule, false]);
    } catch (e) {}

    var ro = null;
    if (window.ResizeObserver) {
      try {
        /* 【坑】ResizeObserver 只看尺寸不看位置：目标块因上方内容变化而整体位移时
           它并不触发，所以真正的兜底是下面那几个定时检查点；这里观察 body 只为
           接住“页面总高度变了”这一类明显的回流。 */
        ro = new ResizeObserver(schedule);
        ro.observe(document.body);
      } catch (e2) { ro = null; }
    }

    [120, 320, 640, 1100, 1600].forEach(function (ms) {
      timers.push(window.setTimeout(function () { recheck(); }, ms));
    });

    function cleanup() {
      if (done) return;
      done = true;
      for (var i = 0; i < listeners.length; i++) {
        var L = listeners[i];
        try { window.removeEventListener(L[0], L[1], L[2]); } catch (e) {}
      }
      for (var j = 0; j < timers.length; j++) {
        try { window.clearTimeout(timers[j]); } catch (e2) {}
      }
      if (ro) { try { ro.disconnect(); } catch (e3) {} ro = null; }
      finalize();
    }

    /* 收尾：退出「实测模式」，再补最后一次落点。
       顺序很重要 —— 先关实测模式、强制一次同步布局，再量目标位置：
       这样最后这次错位校正是在“最终布局”上做的，不会在校正完又被布局变化顶走。 */
    function finalize() {
      if (seq !== runSeq) return;                  /* 过期的那次不准再动滚动条 */
      if (!el || !el.isConnected) { exitMeasure(); return; }
      exitMeasure();
      forceLayout();
      var a = effectiveAlign(el, align);
      var off = (a === 'center' || a === 'end') ? GAP : anchorOffset();
      var d = desiredTop(el, a, off);
      if (Math.abs(d - Math.round(scrollTop())) <= 1.5) return;
      var snap = lockStyles();
      hardTo(d);
      unlockStyles(snap);
    }

    /* 到点自动收尾，避免监听器长期挂着 */
    window.setTimeout(cleanup, WATCH_MS + 60);
  }

  /* ================= 落点高亮 ================= */
  var flashTimer = null;
  function flash(el) {
    if (!el || !el.classList) return;
    var box = el;
    if (!/^(SECTION|DIV|ARTICLE)$/.test(box.tagName)) {
      var p = el.closest ? el.closest('section.unit,section.kp,.module,.ov') : null;
      if (p) box = p;
    }
    try { box.classList.add('xz-land'); } catch (e) { return; }
    if (flashTimer) { try { window.clearTimeout(flashTimer); } catch (e2) {} }
    flashTimer = window.setTimeout(function () {
      try { box.classList.remove('xz-land'); } catch (e3) {}
    }, 1900);
  }

  /* ================= 对外接口 ================= */
  function goTo(target, opts) {
    var el = null;
    if (typeof target === 'string') {
      var id = target.charAt(0) === '#' ? target.slice(1) : target;
      try { id = decodeURIComponent(id); } catch (e) {}
      el = document.getElementById(id);
    } else {
      el = target;
    }
    if (!el) return false;
    run(el, opts);
    if (!opts || opts.flash !== false) flash(el);
    return true;
  }

  /* ================= ① 接管目录 / 锚点点击 ================= */
  /* 【需求】目录（nav.toc 的 .t-item）、板块总览卡片（.ov-card 的链接）
     都是纯 #hash 链接，统一走这里，保证落点一致。 */
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var t = e.target;
    if (!t || !t.closest) return;
    var a = t.closest('a[href]');
    if (!a) return;
    if (a.target && a.target !== '' && a.target !== '_self') return;
    if (a.hasAttribute('download') || a.getAttribute('rel') === 'external') return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) !== '#' || href.length < 2) return;

    var id = href.slice(1);
    try { id = decodeURIComponent(id); } catch (e2) {}
    var el = document.getElementById(id);
    if (!el) return;               /* 找不到就交还浏览器原生行为 */

    e.preventDefault();
    run(el, { align: 'start' });
    flash(el);
    /* 保留“地址栏可分享 / 可回退”的既有体验（原生锚点本来也会压历史） */
    try { history.pushState(null, '', '#' + href.slice(1)); }
    catch (e3) { try { location.hash = href.slice(1); } catch (e4) {} }
  }, false);

  /* ================= ② 接管框架内的 scrollIntoView ================= */
  /* 【易错】各板块页的搜索实现里有 28 处 scrollIntoView（含 <mark> 命中跳转），
     它们同样受 content-visibility 影响。这里只做“补正”，不改对齐语义：
     先按原生参数滚一次，再用同一套收敛循环把落点修准。
     只处理“在文档主滚动流里”的元素，侧栏、搜索面板等嵌套滚动容器一律放行。 */
  function inDocFlow(el) {
    var p = el.parentElement, guard = 0;
    var vh = viewH();
    while (p && guard++ < 60) {
      var st = null;
      try { st = window.getComputedStyle(p); } catch (e) { return true; }
      if (st && /(auto|scroll|overlay)/.test(st.overflowY)) {
        /* 找到的是能独立滚动的祖先 → 交给原生行为，别用 window.scrollTo 去猜 */
        if (p.scrollHeight > p.clientHeight + 4 && p.clientHeight < vh) return false;
      }
      p = p.parentElement;
    }
    return true;
  }

  var nativeSIV = window.Element && Element.prototype && Element.prototype.scrollIntoView;
  if (nativeSIV && window.__xzNavPatchSIV !== false) {
    try {
      Element.prototype.scrollIntoView = function (arg) {
        var res;
        try { res = nativeSIV.apply(this, arguments); } catch (e) { throw e; }
        try {
          if (this !== document.body && this !== docEl() && inDocFlow(this)) {
            var align = 'start';
            var smooth = false;
            if (arg && typeof arg === 'object') {
              if (arg.block) {
                align = (arg.block === 'center') ? 'center' : (arg.block === 'end' ? 'end' : 'start');
              }
              /* 调用方原本要 smooth 就保持 smooth（本层自带的平滑逼近也是缓动），
                 否则一律即时落位 —— 即时落位在收敛校正下才不会出现“动画停错位置”。 */
              if (arg.behavior === 'smooth') smooth = true;
            }
            run(this, { align: align, smooth: smooth });
          }
        } catch (e2) {}
        return res;
      };
      window.__xzNavPatched = true;
    } catch (e3) {}
  }

  /* ================= ③ 深链接 / 前进后退也走同一套 ================= */
  var lastHashRun = 0;
  function onHashChange() {
    var h = location.hash || '';
    if (h.length < 2) return;
    var now = Date.now();
    if (now - lastHashRun < 260) return;    /* popstate + hashchange 会双触发，去重 */
    lastHashRun = now;
    var id = h.slice(1);
    try { id = decodeURIComponent(id); } catch (e) {}
    var el = document.getElementById(id);
    if (!el) return;
    run(el, { align: 'start', smooth: false });
    flash(el);
  }
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('popstate', onHashChange);

  /* ================= ④ 样式注入 ================= */
  function injectCSS() {
    if (document.getElementById('xz-nav-style')) return;
    var st = document.createElement('style');
    st.id = 'xz-nav-style';
    st.textContent =
      /* 吸顶偏移做成变量：原生锚点（浏览器回退、外部深链）也吃到实测值 */
      'html{--xz-anchor-offset:70px}' +
      '.ov,.unit,.kp,.module,[id]{scroll-margin-top:var(--xz-anchor-offset)}' +
      /* 实测模式：临时把 content-visibility 关掉，让 scrollHeight / 占位尺寸变成真值
         （选择器比板块页 xz-perf 的 section.kp,section.unit 更具体，能盖过它） */
      'html.xz-nav-measure section.kp,html.xz-nav-measure section.unit' +
      '{content-visibility:visible;contain-intrinsic-size:auto}' +
      /* 落点高亮：与既有 mark.shl._cur 的橙色区分开，用蓝色轮廓呼吸
         【坑】只用 outline（不参与排版）+ 颜色渐变，别用 box-shadow 扩散：
         板块块高度动辄两三千像素，大盒子的阴影扩散动画在 iPad 上会明显掉帧。 */
      '.xz-land{animation:xzLand 1.8s ease-out 1}' +
      '@keyframes xzLand{' +
      '0%{outline:3px solid rgba(37,99,235,.62);outline-offset:2px}' +
      '60%{outline:3px solid rgba(37,99,235,.26);outline-offset:2px}' +
      '100%{outline:3px solid rgba(37,99,235,0);outline-offset:2px}}' +
      /* 【坑】iPad 上开启“减弱动态效果”时，平滑滚动会让人眩晕，直接关掉 */
      '@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}}';
    (document.head || docEl() || document).appendChild(st);
  }

  function syncOffsetVar() {
    try {
      var v = anchorOffset();
      if (docEl() && docEl().style && docEl().style.setProperty) {
        docEl().style.setProperty('--xz-anchor-offset', v + 'px');
      }
    } catch (e) {}
  }

  /* ================= 启动 ================= */
  injectCSS();

  function boot() {
    syncOffsetVar();
    /* 首屏带 hash 打开：浏览器会先按估算尺寸滚一次，这里补正到真实位置 */
    if (location.hash && location.hash.length > 1) {
      window.setTimeout(onHashChange, 80);
    }
    /* 懒加载图片全部就位后，再补一次（只在前 4s 内，避免长期占用） */
    var t0 = Date.now();
    window.addEventListener('load', function () {
      if (Date.now() - t0 < 4000 && location.hash && location.hash.length > 1) {
        window.setTimeout(onHashChange, 60);
      }
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, false);
  } else {
    boot();
  }

  var syncTimer = null;
  window.addEventListener('resize', function () {
    if (syncTimer) { try { window.clearTimeout(syncTimer); } catch (e) {} }
    syncTimer = window.setTimeout(syncOffsetVar, 120);
  });

  /* 【接口】window.__xzNav
       goTo(idOrEl, {align:'start'|'center'|'end', smooth:bool, flash:bool})
       offset()  取当前实测吸顶遮挡高度
       diag()    取快照 —— iPad 上报问题时先跑它 */
  window.__xzNav = {
    version: '20260914a',
    goTo: goTo,
    offset: anchorOffset,
    diag: function () {
      return {
        version: '20260914a',
        offset: anchorOffset(),
        barCover: barCover(),
        viewH: viewH(),
        scrollTop: Math.round(scrollTop()),
        maxScroll: maxScroll(),
        hasHash: !!location.hash,
        siePatched: !!window.__xzNavPatched,
        inFrame: window.top !== window.self
      };
    }
  };
})();
