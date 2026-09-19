/* =====================================================================
   板块页脚本（全站所有板块页共用这一份，2026-09-19 完成统一）
   ---------------------------------------------------------------
   为什么是这一份：过去 12 个板块页各自内联了一段“页内交互脚本”，注释里写着
   「改动时请同步全部 10 个板块页」，实际已经分叉成 6 个版本 ——
     常识判断/政治理论：自测模式 + 展开全部答案 + 收起卡片（.kp-body/.qblock）
     数量关系/判断推理/资料分析：隐藏答案解析（.ansline/.expline）+ 收起卡片
     言语理解：多一处“命中词在折叠块里就自动展开”
     模考三页：精简版，没有命中面板、也没有按 id 直达，且各自的选择器都不同
   统一后：页面只留一行 <script src=".../板块页脚本.js?v=…">，
   各页差异靠“自动探测”吸收（卡片选择器、按钮是否存在、折叠块类型），
   新增板块页不需要再复制脚本 —— 这也正是当初申论/日常积累页的做法。

   【需求】一份脚本负责六件事：
     ① 页内搜索：mark.shl 高亮 + 命中计数 + 多处命中时的定位面板
     ② 隐藏 / 显示答案解析（按页面结构自动选 .ansline,.expline 或 details.ansbox）
     ③ 收起 / 展开卡片（.kp-body/.qblock 或 .unit 的内容块）
     ④ 回到顶部
     ⑤ 接收外壳 index.html 下发的 {type:'ws-search', q, id} 指令（含按 id 直达）
     ⑥ 目录高亮（nav.toc 存在时）+ 自测模式（#selftest 存在时）

   【接口】页面里可以出现这些元素，缺任何一个都只是该功能不生效，不影响其它功能：
     #q 搜索框 · #hitcount 命中数 · #hideans 隐藏/展开答案 · #closeall 收起/展开卡片
     #openans 展开全部答案（details.ans）· #selftest 自测模式 · #backtop 回到顶部
   【易错】卡片选择器按数组顺序取第一个“页面上存在”的组合，与
     scripts/build-index.js 的索引粒度保持一致：.kp/.unit → .qcard/.matcard → .shen/.matcard。
     新增卡片类型时，这里的 CARD_SETS 与构建脚本要一起改，否则搜索会静默漏内容。
   【坑】注入的面板样式自带 html.xz-dark 覆盖，夜间模式不是白块；调色用
     --xz-surface / --xz-line / --xz-ink / --xz-a1 这些主题层变量，不要写死颜色。
   【易错】本文件必须保持幂等：同一个页面被重复引入只执行一次（见文件头的哨兵变量）。
   ===================================================================== */
(function () {
  'use strict';
  if (window.__xzBoardScriptLoaded) { return; }
  window.__xzBoardScriptLoaded = true;

  var q = document.getElementById('q');
  var hit = document.getElementById('hitcount');
  var selftestOn = function () { return document.body.classList.contains('selftest'); };

  /* ================= 卡片集合自动探测 ================= */
  /* 顺序即优先级：先看知识点/单元卡片（行测六大板块），再看题目卡（模考题本），
     最后看申论大题卡。取到第一个非空组合就用它，避免把嵌套的题目卡当成卡片。 */
  /* 【坑】最后一档是「空槽位」页（如 9月7日模考·行测错题集合：六个分类只有 .slot 占位，
     还没有任何题目）。没有这一档时 CARD_SEL 会是空串，后面用它去 querySelectorAll
     会直接抛 DOMException，整页脚本失效 —— 页面看上去“能打开但按钮全没反应”。 */
  var CARD_SETS = ['.kp,.unit', '.qcard,.matcard', '.shen,.matcard', '.slot'];
  function pickCardSel() {
    for (var i = 0; i < CARD_SETS.length; i++) {
      if (document.querySelector(CARD_SETS[i])) { return CARD_SETS[i]; }
    }
    return '';
  }
  var CARD_SEL = pickCardSel();

  function cardList() {
    return CARD_SEL ? Array.prototype.slice.call(document.querySelectorAll(CARD_SEL)) : [];
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function labelOf(card) {
    var t = '';
    if (card.getAttribute && card.getAttribute('data-title')) { t = card.getAttribute('data-title'); }
    if (!t) {
      var h = card.querySelector('.unit-head h3,.unit-head h2,.unit-head,.kp-head h3,.qhead,.mod-banner h2,h2,h3,h4');
      if (h && h.textContent) { t = h.textContent; }
    }
    if (!t) { t = card.id ? card.id : '定位'; }
    return t.replace(/\s+/g, ' ').trim().slice(0, 28);
  }

  /* 滚动落位统一走定位层（assets/定位层.js）：它会把吸顶工具条的高度算进去。
     拿不到定位层就退回原生 scrollIntoView。 */
  function goTo(el) {
    if (!el) { return; }
    if (window.__xzNav && window.__xzNav.goTo) {
      try { if (window.__xzNav.goTo(el, { align: 'start', smooth: true })) { return; } } catch (e) {}
    }
    var h = document.documentElement, b = document.body;
    var hs = h ? h.style.scrollBehavior : '', bs = b ? b.style.scrollBehavior : '';
    if (h) { h.style.scrollBehavior = 'auto'; }
    if (b) { b.style.scrollBehavior = 'auto'; }
    try { el.scrollIntoView({ block: 'start' }); } catch (e1) { try { el.scrollIntoView(); } catch (e2) {} }
    if (h) { h.style.scrollBehavior = hs; }
    if (b) { b.style.scrollBehavior = bs; }
  }

  /* ================= 搜索面板样式（一次性注入） ================= */
  function ensureStyle() {
    if (document.getElementById('_wsStyle')) { return; }
    var st = document.createElement('style');
    st.id = '_wsStyle';
    st.textContent =
      '#_wsPanel{position:fixed;right:14px;top:70px;width:320px;max-width:88vw;z-index:9999;background:#fff;' +
      'border:1px solid #dce3f0;border-radius:14px;box-shadow:0 16px 44px -14px rgba(15,23,42,.4);overflow:hidden;' +
      'font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:12.5px;color:#0f172a}' +
      '#_wsPanel ._hd{display:flex;align-items:center;gap:5px;padding:10px 12px;background:#f4f7fd;border-bottom:1px solid #e9eef7;font-weight:700;font-size:13px}' +
      '#_wsPanel ._hd em{color:#2563eb;font-style:normal;margin:0 2px}' +
      '#_wsPanel ._x{margin-left:auto;border:0;background:rgba(100,116,139,.14);width:21px;height:21px;line-height:1;border-radius:50%;cursor:pointer;color:#475569;font-size:12px}' +
      '#_wsPanel ._lst{max-height:320px;overflow:auto}' +
      '#_wsPanel ._it{display:flex;gap:9px;padding:9px 12px;cursor:pointer;border-bottom:1px solid #f2f5fb;align-items:flex-start}' +
      '#_wsPanel ._it:last-child{border-bottom:0}' +
      '#_wsPanel ._it:hover{background:#f2f6ff}' +
      '#_wsPanel ._no{flex:none;width:20px;height:20px;border-radius:50%;background:#e5eeff;color:#2563eb;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px}' +
      '#_wsPanel ._tt{font-weight:600;color:#1e293b}' +
      '#_wsPanel ._tc{color:#64748b;font-size:11.5px;margin-top:2px;line-height:1.55;word-break:break-all;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}' +
      '#_wsPanel ._tc mark{background:transparent;color:#dc2626;font-weight:700}' +
      'mark.shl{background:#ffe066;border-radius:2px}' +
      'mark.shl._cur{outline:2px solid #f59e0b;outline-offset:1px;animation:_wsb 1.8s ease-out 1}' +
      '@keyframes _wsb{0%{box-shadow:0 0 0 0 rgba(245,158,11,.55)}70%{box-shadow:0 0 0 13px rgba(245,158,11,0)}100%{box-shadow:0 0 0 0 rgba(245,158,11,0)}}' +
      'html.xz-dark #_wsPanel{background:var(--xz-surface,#141d2e);border-color:var(--xz-line,#28344a);color:var(--xz-ink,#e8eff9)}' +
      'html.xz-dark #_wsPanel ._hd{background:var(--xz-surface2,#1a2434);border-bottom-color:var(--xz-line,#28344a)}' +
      'html.xz-dark #_wsPanel ._hd em{color:var(--xz-a1,#7fb2ff)}' +
      'html.xz-dark #_wsPanel ._x{background:rgba(148,163,184,.18);color:var(--xz-ink2,#b6c3d4)}' +
      'html.xz-dark #_wsPanel ._it{border-bottom-color:#26334a}' +
      'html.xz-dark #_wsPanel ._it:hover{background:#1c2740}' +
      'html.xz-dark #_wsPanel ._no{background:#1e2a45;color:#a8b6d8}' +
      'html.xz-dark #_wsPanel ._tt{color:var(--xz-ink,#e8eff9)}' +
      'html.xz-dark #_wsPanel ._tc{color:var(--xz-ink3,#93a3b8)}' +
      'html.xz-dark #_wsPanel ._tc mark{color:#ffb4b4}';
    (document.head || document.documentElement).appendChild(st);
  }

  function closePanel() {
    var p = document.getElementById('_wsPanel');
    if (p && p.parentNode) { p.parentNode.removeChild(p); }
  }

  function flash(mk) {
    if (!mk) { return; }
    try { mk.classList.add('_cur'); } catch (e) {}
    window.setTimeout(function () { try { mk.classList.remove('_cur'); } catch (e) {} }, 1900);
  }

  function gotoMark(o) { goTo(o.mk); flash(o.mk); }

  /* ================= 页内搜索 ================= */
  function resetView() {
    var marks = document.querySelectorAll('mark.shl');
    for (var i = 0; i < marks.length; i++) {
      var tt = document.createTextNode(marks[i].textContent);
      marks[i].parentNode.replaceChild(tt, marks[i]);
    }
    var cards = cardList();
    for (var c = 0; c < cards.length; c++) { cards[c].classList.remove('hidden'); }
    var mods = document.querySelectorAll('.module');
    for (var m = 0; m < mods.length; m++) { mods[m].classList.remove('hidden'); }
  }

  /* 【易错】命中词落在折叠块（<details>）里时必须自动展开，否则高亮在屏幕外，
     用户会以为“明明搜到了却看不到”。自测模式下刻意不展开（那正是它要藏起来的答案）。 */
  function revealDetails(card, word) {
    if (selftestOn()) { return; }
    var ds = card.querySelectorAll('details');
    for (var i = 0; i < ds.length; i++) {
      if (ds[i].textContent.indexOf(word) !== -1) { ds[i].open = true; }
    }
  }

  function doSearch(word) {
    word = (word || '').trim();
    ensureStyle();
    closePanel();
    resetView();
    if (!word) { if (hit) { hit.textContent = ''; } return; }
    /* 【易错】页面里一个可搜索卡片都没有（纯占位页）时直接收工：
       下面的 querySelectorAll(CARD_SEL) 在空串上会抛异常。 */
    if (!CARD_SEL) { if (hit) { hit.textContent = '本页暂无可检索内容'; } return; }

    var cards = cardList();
    var occs = [], hitCards = 0, LIM = 120;
    for (var k = 0; k < cards.length; k++) {
      var card = cards[k];
      if (card.textContent.indexOf(word) === -1) { card.classList.add('hidden'); continue; }
      hitCards++;
      revealDetails(card, word);
      if (occs.length >= LIM) { continue; }
      var label = labelOf(card);
      var walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          if (!n.nodeValue || n.nodeValue.indexOf(word) === -1) { return NodeFilter.FILTER_REJECT; }
          var p = n.parentNode;
          if (!p || /^(SCRIPT|STYLE|MARK)$/.test(p.tagName)) { return NodeFilter.FILTER_REJECT; }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var tn, tns = [], guard = 0;
      while ((tn = walker.nextNode())) { tns.push(tn); if (++guard >= 600) { break; } }
      for (var m = 0; m < tns.length && occs.length < LIM; m++) {
        var txt = tns[m].nodeValue, idxs = [], sp = 0, fi, g2 = 0;
        while ((fi = txt.indexOf(word, sp)) !== -1) { idxs.push(fi); sp = fi + word.length; if (++g2 >= 50) { break; } }
        for (var s = idxs.length - 1; s >= 0 && occs.length < LIM; s--) {
          var at = idxs[s];
          var after = tns[m].splitText(at);
          after.splitText(word.length);
          var mk = document.createElement('mark');
          mk.className = 'shl'; mk.textContent = after.textContent;
          after.parentNode.replaceChild(mk, after);
          occs.push({
            mk: mk, label: label,
            a: txt.slice(Math.max(0, at - 10), at).replace(/\s+/g, ' '),
            b: txt.slice(at + word.length, at + word.length + 14).replace(/\s+/g, ' ')
          });
        }
      }
    }

    /* 分组容器（.module）里一张命中的卡片都没有，就把整个分组收起来 ——
       否则筛完之后会看到一堆空标题，读者要一直往下划。 */
    var mods = document.querySelectorAll('.module');
    for (var mm = 0; mm < mods.length; mm++) {
      var inner = mods[mm].querySelectorAll(CARD_SEL);
      if (!inner.length) { continue; }
      var any = false;
      for (var ii = 0; ii < inner.length; ii++) {
        if (inner[ii].textContent.indexOf(word) !== -1) { any = true; break; }
      }
      if (!any) { mods[mm].classList.add('hidden'); }
    }

    if (!occs.length) { if (hit) { hit.textContent = '未命中「' + word + '」'; } return; }
    if (hit) { hit.textContent = '命中 ' + occs.length + ' 处 · 分布于 ' + hitCards + ' 个位置'; }
    if (occs.length === 1) { gotoMark(occs[0]); return; }

    var panel = document.createElement('div');
    panel.id = '_wsPanel';
    var rows = '';
    for (var r = 0; r < occs.length; r++) {
      rows += '<div class="_it" data-r="' + r + '"><span class="_no">' + (r + 1) + '</span>' +
        '<div style="min-width:0"><div class="_tt">' + esc(occs[r].label) + '</div>' +
        '<div class="_tc">' + esc(occs[r].a) + '<mark>' + esc(word) + '</mark>' + esc(occs[r].b) + '</div></div></div>';
    }
    panel.innerHTML = '<div class="_hd">「' + esc(word) + '」命中 <em>' + occs.length + '</em> 处，点击定位' +
      '<button class="_x" title="关闭">✕</button></div><div class="_lst">' + rows + '</div>';
    document.body.appendChild(panel);
    panel.querySelector('._x').addEventListener('click', closePanel);
    Array.prototype.forEach.call(panel.querySelectorAll('._it'), function (row) {
      row.addEventListener('click', function () {
        gotoMark(occs[parseInt(row.getAttribute('data-r'), 10)]);
        closePanel();
      });
    });
  }

  /* ================= 输入框 / 回车 / Esc ================= */
  if (q) {
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { doSearch(q.value); } });
    q.addEventListener('input', function () { if (!q.value.trim()) { doSearch(''); } });
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closePanel(); } });

  /* ================= 隐藏 / 展开答案 ================= */
  /* 两种结构两种做法，页面不用配置：
     ① 有 details.ansbox（模考题本）：展开/收起全部答案；
     ② 有 .ansline/.expline（行测板块、申论、错题集合）：切换显隐。
     按钮文案不用写死 —— 从按钮初始文字推出「点过之后」的说法，
     于是「隐藏答案解析 / 展开全部答案 / 隐藏正确与复盘」都能各自保持原措辞。 */
  function labelPair(initial) {
    var m = String(initial || '').match(/^\s*(隐藏|显示|展开|收起)([\s\S]*)$/);
    if (!m) { return { off: initial || '隐藏答案', on: '显示答案' }; }
    var opp = { '隐藏': '显示', '显示': '隐藏', '展开': '收起', '收起': '展开' }[m[1]];
    return { off: initial, on: opp + m[2] };
  }
  var ansBtn = document.getElementById('hideans');
  if (ansBtn) {
    var ansPair = labelPair(ansBtn.textContent);
    var ansOn = false;
    ansBtn.addEventListener('click', function () {
      ansOn = !ansOn;
      if (document.querySelector('details.ansbox')) {
        Array.prototype.forEach.call(document.querySelectorAll('details.ansbox'), function (d) { d.open = ansOn; });
      } else {
        /* details.fold / .ph 是「给定资料 / 材料逻辑解析」这类折叠块，跟着一起隐藏 */
        Array.prototype.forEach.call(document.querySelectorAll('.ansline,.expline,.ph,details.fold'), function (b) {
          b.style.display = ansOn ? 'none' : '';
        });
      }
      ansBtn.textContent = ansOn ? ansPair.on : ansPair.off;
      ansBtn.classList.toggle('on', ansOn);
    });
  }

  /* #openans：常识判断/政治理论的「展开全部答案」（details.ans，一次性全开） */
  var openAnsBtn = document.getElementById('openans');
  if (openAnsBtn) {
    openAnsBtn.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('details.ans'), function (d) { d.open = true; });
    });
  }

  /* ================= 收起 / 展开卡片 ================= */
  /* 内容块 = .kp-body/.qblock（知识点页）+ .unit 里除标题头与描述之外的直接子元素（单元页）。
     两类都算进来，页面用哪种结构都能对上。 */
  function contentBlocks() {
    var out = Array.prototype.slice.call(document.querySelectorAll('.kp-body,.qblock'));
    Array.prototype.forEach.call(document.querySelectorAll('.unit'), function (u) {
      Array.prototype.forEach.call(u.children, function (ch) {
        if (!ch.classList.contains('unit-head') && !ch.classList.contains('unit-desc')) { out.push(ch); }
      });
    });
    return out;
  }
  var closeBtn = document.getElementById('closeall');
  if (closeBtn) {
    var collapsed = false;
    closeBtn.addEventListener('click', function () {
      collapsed = !collapsed;
      Array.prototype.forEach.call(contentBlocks(), function (b) { b.style.display = collapsed ? 'none' : ''; });
      closeBtn.textContent = collapsed ? '展开卡片' : '收起卡片';
    });
  }

  /* ================= 自测模式（仅常识判断/政治理论有该按钮） ================= */
  var stBtn = document.getElementById('selftest');
  if (stBtn) {
    stBtn.addEventListener('click', function () {
      document.body.classList.toggle('selftest');
      var on = selftestOn();
      stBtn.textContent = '自测模式：' + (on ? '开' : '关');
      stBtn.classList.toggle('on', on);
    });
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (selftestOn() && t && t.tagName === 'MARK' && t.classList.contains('fill')) {
        t.classList.toggle('show');
      }
    });
  }

  /* ================= 回到顶部 ================= */
  var bt = document.getElementById('backtop');
  if (bt) {
    window.addEventListener('scroll', function () { bt.classList.toggle('show', window.scrollY > 500); });
    bt.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  }

  /* ================= 目录高亮（nav.toc 存在时） ================= */
  (function tocActive() {
    var toc = document.querySelector('nav.toc');
    if (!toc || !window.IntersectionObserver) { return; }
    var links = Array.prototype.slice.call(toc.querySelectorAll('a[href^="#"]'));
    if (!links.length) { return; }
    var byId = {};
    links.forEach(function (l) { byId[l.getAttribute('href').slice(1)] = l; });
    var watched = cardList().filter(function (c) { return c.id && byId[c.id]; });
    if (!watched.length) { return; }
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (en) {
        if (!en.isIntersecting) { return; }
        links.forEach(function (l) { l.classList.remove('active'); });
        var cur = byId[en.target.id];
        if (cur) { cur.classList.add('active'); }
      });
    }, { rootMargin: '-20% 0px -70% 0px' });
    watched.forEach(function (c) { io.observe(c); });
  })();

  /* ================= 外壳直达：{type:'ws-search', q, id} ================= */
  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type !== 'ws-search') { return; }
    var qq = (d.q || '').trim();
    if (!qq) { return; }
    if (q) { q.value = qq; }
    doSearch(qq);
    var el = d.id ? document.getElementById(d.id) : null;
    if (!el) { return; }
    closePanel();
    /* 直达时用定位层精确落位（吸顶条高度已知），落点后再闪一下命中的高亮 */
    goTo(el);
    try {
      var mks = el.querySelectorAll('mark.shl');
      if (mks.length) { flash(mks[0]); }
    } catch (e3) {}
  });
})();
