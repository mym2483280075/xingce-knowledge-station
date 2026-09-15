/* =====================================================================
   板块页脚本（申论 · 日常积累等新板块页共用）
   ---------------------------------------------------------------
   为什么单独抽一份：
     原有 10 个板块页各自内联了同一份页内交互脚本（“改动时请同步全部 10 个
     板块页”）。新增的 6 个页面（申论 5 个 + 日常积累 1 个）结构完全一致，
     与其复制 6 份，不如共用这一份 —— 改一次，6 个页面同时生效。

   【需求】这份脚本负责五件事：
     ① 页内搜索（mark.shl 高亮 + 命中计数 + 多处命中时的定位面板）
     ② 隐藏 / 显示参考答案（.ansline / .expline）
     ③ 收起 / 展开卡片（.unit 内除标题头之外的内容）
     ④ 回到顶部按钮
     ⑤ 接收外壳 index.html 下发的搜索指令

   【接口】与外壳 index.html 的协议：window.postMessage({type:'ws-search', q, id})
     q  = 关键词；id = 要直达的元素 id（可不带，那就只搜索）。
   【接口】本脚本要求页面里存在：#q、#hitcount、#hideans、#closeall、#backtop，
     缺任何一个都只是该功能不生效，不会影响其它功能（每一处都做了判空）。
   【易错】可搜索卡片的选择器是 .kp / .unit —— 与 scripts/build-index.js 的
     白名单保持一致；新增卡片类型时两边要一起改，否则搜索会静默漏内容。
   【坑】注入的搜索面板样式已随附 html.xz-dark 覆盖，夜间模式下不是白块；
     要调色请继续用主题层变量（--xz-surface / --xz-line / --xz-ink / --xz-a1）。
   ===================================================================== */
(function () {
  'use strict';
  if (window.__xzBoardScriptLoaded) { return; }
  window.__xzBoardScriptLoaded = true;

  var q = document.getElementById('q');
  var hit = document.getElementById('hitcount');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function labelOf(card) {
    var t = '';
    if (card.getAttribute && card.getAttribute('data-title')) { t = card.getAttribute('data-title'); }
    if (!t) {
      var h = card.querySelector('.unit-head h3,.unit-head h2,.unit-head,.kp-head h3,h2,h3,h4');
      if (h && h.textContent) { t = h.textContent; }
    }
    if (!t) { t = card.id ? card.id : '定位'; }
    return t.replace(/\s+/g, ' ').trim().slice(0, 28);
  }

  /* 滚动落位统一走定位层（assets/定位层.js），拿不到就退回原生 scrollIntoView */
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

  function gotoMark(o) {
    goTo(o.mk);
    try { o.mk.classList.add('_cur'); } catch (e) {}
    window.setTimeout(function () { try { o.mk.classList.remove('_cur'); } catch (e) {} }, 1900);
  }

  /* ================= 页内搜索 ================= */
  function doSearch(word) {
    word = (word || '').trim();
    ensureStyle();
    closePanel();

    var marks = document.querySelectorAll('mark.shl');
    for (var i = 0; i < marks.length; i++) {
      var tt = document.createTextNode(marks[i].textContent);
      marks[i].parentNode.replaceChild(tt, marks[i]);
    }
    var cards = document.querySelectorAll('.kp,.unit');
    for (var c0 = 0; c0 < cards.length; c0++) { cards[c0].classList.remove('hidden'); }

    if (!word) { if (hit) { hit.textContent = ''; } return; }

    var occs = [], hitCards = 0, LIM = 120;
    for (var k = 0; k < cards.length; k++) {
      var card = cards[k];
      if (occs.length >= LIM) {
        if (card.textContent.indexOf(word) === -1) { card.classList.add('hidden'); }
        continue;
      }
      if (card.textContent.indexOf(word) === -1) { card.classList.add('hidden'); continue; }
      hitCards++;
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

  /* ================= 输入框 / 回车 ================= */
  if (q) {
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { doSearch(q.value); } });
    q.addEventListener('input', function () { if (!q.value.trim()) { doSearch(''); } });
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closePanel(); } });

  /* ================= 隐藏答案 / 收起卡片 ================= */
  var hideBtn = document.getElementById('hideans');
  if (hideBtn) {
    var hidden = false;
    hideBtn.addEventListener('click', function () {
      hidden = !hidden;
      /* details.fold 是「给定资料 / 材料逻辑解析 / 复盘」这类折叠块，一并隐藏 */
      Array.prototype.forEach.call(document.querySelectorAll('.ansline,.expline,.ph,details.fold'), function (b) {
        b.style.display = hidden ? 'none' : '';
      });
      hideBtn.textContent = hidden ? '显示参考答案' : '隐藏参考答案';
      hideBtn.classList.toggle('on', hidden);
    });
  }

  var closeBtn = document.getElementById('closeall');
  if (closeBtn) {
    var collapsed = false;
    closeBtn.addEventListener('click', function () {
      collapsed = !collapsed;
      Array.prototype.forEach.call(document.querySelectorAll('.unit'), function (u) {
        Array.prototype.forEach.call(u.children, function (ch) {
          if (!ch.classList.contains('unit-head') && !ch.classList.contains('unit-desc')) {
            ch.style.display = collapsed ? 'none' : '';
          }
        });
      });
      closeBtn.textContent = collapsed ? '展开卡片' : '收起卡片';
    });
  }

  /* ================= 回到顶部 ================= */
  var bt = document.getElementById('backtop');
  if (bt) {
    window.addEventListener('scroll', function () { bt.classList.toggle('show', window.scrollY > 500); });
    bt.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  }

  /* ================= 外壳直达：{type:'ws-search', q, id} ================= */
  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type !== 'ws-search') { return; }
    var qq = (d.q || '').trim();
    if (!qq) { return; }
    if (q) { q.value = qq; }
    doSearch(qq);
    var el = d.id ? document.getElementById(d.id) : null;
    if (el) {
      closePanel();
      goTo(el);
      try {
        var mks = el.querySelectorAll('mark.shl');
        if (mks.length) {
          mks[0].classList.add('_cur');
          window.setTimeout(function () { mks[0].classList.remove('_cur'); }, 1900);
        }
      } catch (e3) {}
    }
  });
})();
