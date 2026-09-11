/* =========================================================
   行测知识工作站 · 全局演算层（透明手写画布）
   用途：在任意板块页面上叠加一层几乎全透明的画布，透过它看题目、随手演算。
   低内存设计：
     1) 单画布，只做视口大小（不是整页高度），无离屏副本
     2) 笔画是唯一数据源，坐标用 Float32Array 紧凑存（x,y,压力 各 4 字节）
     3) 撤销栈只存引用与上一版坐标，不存 ImageData 位图快照
     4) devicePixelRatio 上限 2，3x 屏可省一半以上像素内存
     5) 书写中只重绘“脏矩形”；笔画按视口可视范围过滤，页面再长也不额外吃内存
     6) 页面隐藏/切走时释放画布缓冲并落盘；零第三方依赖
   坐标：一律用“文档坐标”（滚动后依然贴在同一道题旁边），渲染时整体平移 scrollY。
   ========================================================= */
(function () {
  'use strict';
  if (window.__xzScratchLoaded) return;
  window.__xzScratchLoaded = true;

  var DPR = Math.min(window.devicePixelRatio || 1, 2);
  var MAX_PTS = 12000, PT_MIN = 0.35;
  var PALETTE = ['#111827', '#dc2626', '#2563eb', '#16a34a', '#f59e0b'];
  var PALETTE_NAME = ['黑', '红', '蓝', '绿', '橙'];
  var FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif';

  /* 本层不落盘：所有笔迹只存在于当前页面内存中，退出演算即清空 */

  /* ---------- 构建隔离的 UI（Shadow DOM，不污染板块页样式） ---------- */
  var host = document.createElement('div');
  host.setAttribute('data-xz-scratch', '');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    '*{box-sizing:border-box}' +
    'canvas{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;touch-action:none}' +
    'canvas.on{pointer-events:auto;cursor:crosshair}' +
    'canvas.pick{cursor:default}' +
    '.fab{position:absolute;top:12px;right:16px;pointer-events:auto;border:0;border-radius:999px;padding:9px 15px;' +
    'font:600 13px/1 ' + FONT + ';color:#fff;background:rgba(29,111,184,.92);cursor:pointer;' +
    'box-shadow:0 6px 16px -8px rgba(15,23,42,.55);transition:background .18s}' +
    '@media (max-width:920px){.fab{top:62px}}' +   /* 窄屏时让开顶部工具栏换行区域 */
    '.fab:hover{background:rgba(29,111,184,1)}' +
    '.fab.live{background:rgba(100,116,139,.9)}' +
    '.fab.has::after{content:"";position:absolute;top:6px;right:9px;width:6px;height:6px;border-radius:50%;background:#f59e0b}' +
    '.bar{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);display:none;align-items:center;gap:8px;' +
    'padding:6px 10px;border-radius:14px;background:rgba(255,255,255,.95);pointer-events:auto;' +
    'box-shadow:0 10px 30px -14px rgba(15,23,42,.55),0 0 0 1px rgba(15,23,42,.08);' +
    'font:400 13px/1 ' + FONT + ';color:#0f172a;white-space:nowrap;max-width:calc(100vw - 20px);overflow:auto}' +
    '.bar.show{display:flex}' +
    '.g{display:flex;gap:2px;padding:2px;border-radius:9px;background:#f1f5f9;flex:none}' +
    '.bar button{border:0;background:transparent;color:#475569;font:600 12.5px/1 ' + FONT + ';padding:7px 9px;' +
    'border-radius:7px;cursor:pointer;white-space:nowrap}' +
    '.bar button:hover{background:rgba(255,255,255,.9)}' +
    '.bar button.on{background:#fff;color:#1d6fb8;box-shadow:0 1px 3px rgba(15,23,42,.14)}' +
    '.bar button.warn{color:#b91c1c}' +
    '.sws{display:flex;align-items:center;gap:5px;flex:none}' +
    '.sw{width:22px;height:22px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(15,23,42,.16);cursor:pointer;padding:0;flex:none}' +
    '.sw.on{box-shadow:0 0 0 2px #1d6fb8}' +
    '.hint{color:#94a3b8;font-size:11.5px;padding-left:2px}' +
    '.toast{position:absolute;left:50%;bottom:66px;transform:translateX(-50%);background:rgba(15,23,42,.86);color:#fff;' +
    'font:400 12.5px/1 ' + FONT + ';padding:8px 14px;border-radius:999px;opacity:0;transition:opacity .22s;' +
    'pointer-events:none;white-space:nowrap}' +
    '.toast.on{opacity:1}' +
    '</style>' +
    '<canvas id="cv"></canvas>' +
    '<div class="bar" id="bar">' +
      '<div class="g" id="tools">' +
        '<button type="button" data-tool="pen" class="on" title="钢笔：压感变粗细">钢笔</button>' +
        '<button type="button" data-tool="pencil" title="铅笔：等宽轻描">铅笔</button>' +
        '<button type="button" data-tool="eraser" title="橡皮擦：擦掉笔迹">橡皮</button>' +
        '<button type="button" data-tool="pick" title="指针：点选、拖动、删除笔画">指针</button>' +
      '</div>' +
      '<div class="sws" id="colors"></div>' +
      '<div class="g">' +
        '<button type="button" id="undo" title="Ctrl+Z">撤销</button>' +
        '<button type="button" id="redo" title="Ctrl+Y">重做</button>' +
      '</div>' +
      '<button type="button" id="clear" class="warn">清空</button>' +
      '<button type="button" id="hidenote">收起</button>' +
      '<span class="hint">滚轮翻页 · 退出即清空（不保存）</span>' +
    '</div>' +
    '<button type="button" class="fab" id="fab">演算</button>' +
    '<div class="toast" id="toast"></div>';
  (document.documentElement || document.body).appendChild(host);

  var cv = root.getElementById('cv'), ctx = cv.getContext('2d', { alpha: true });
  var bar = root.getElementById('bar'), fab = root.getElementById('fab');
  var toolsBox = root.getElementById('tools'), colorsBox = root.getElementById('colors');
  var undoBtn = root.getElementById('undo'), redoBtn = root.getElementById('redo');
  var toastEl = root.getElementById('toast');
  var toastTimer = 0;
  function toastMsg(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 1800);
  }

  /* ---------- 状态 ---------- */
  var W = 0, H = 0, scrollY = 0;
  var mode = false;                       // 演算模式：画布接管指针
  var tool = 'pen';
  var state = { pen: { c: PALETTE[0], w: 2.2 }, pencil: { c: PALETTE[0], w: 1.6 }, eraser: { w: 18 } };
  var strokes = [], undoStack = [], redoStack = [];
  var live = null, drawing = false, lastPr = 1;
  var markIdx = 1, prevDirty = null, rafLive = 0, rafDraw = 0;
  var selected = null, drag = null, rectCache = null, resizeTimer = 0;

  /* ---------- 尺寸与坐标 ---------- */
  function readScroll() {
    scrollY = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
  }
  function resize() {
    W = Math.max(1, window.innerWidth || document.documentElement.clientWidth);
    H = Math.max(1, window.innerHeight || document.documentElement.clientHeight);
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    rectCache = null;
  }
  function applyT() { ctx.setTransform(DPR, 0, 0, DPR, 0, -scrollY * DPR); }
  function ptOf(e) {
    if (!rectCache) rectCache = cv.getBoundingClientRect();
    return {
      x: e.clientX - rectCache.left,
      y: e.clientY - rectCache.top + scrollY,
      pr: (e.pointerType === 'pen') ? (e.pressure > 0 ? e.pressure : 0.5) : 1
    };
  }

  /* ---------- 几何 ---------- */
  function padOf(s) { return s.w * 0.5 + 2; }
  function computeBB(s) {
    var p = s.p, n = p.length / 3;
    if (!n) { s.bb = null; return; }
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < n; i++) {
      var x = p[i * 3], y = p[i * 3 + 1];
      if (x < x0) x0 = x; if (y < y0) y0 = y;
      if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    s.bb = { x0: x0, y0: y0, x1: x1, y1: y1 };
  }
  function hitBB(b, x0, y0, x1, y1, pad) {
    return !(b.x1 + pad < x0 || b.x0 - pad > x1 || b.y1 + pad < y0 || b.y0 - pad > y1);
  }
  function distToSeg(px, py, x0, y0, x1, y1) {
    var dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
    var t = l2 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var qx = x0 + t * dx - px, qy = y0 + t * dy - py;
    return Math.sqrt(qx * qx + qy * qy);
  }

  /* ---------- 绘制 ---------- */
  function buildPath(s, i0, i1) {
    var p = s.p, n = p.length / 3, path = new Path2D(), aX, aY, bX, bY;
    for (var i = i0; i <= i1; i++) {
      if (i === 1) { aX = p[0]; aY = p[1]; }
      else { aX = (p[(i - 1) * 3] + p[i * 3]) / 2; aY = (p[(i - 1) * 3 + 1] + p[i * 3 + 1]) / 2; }
      var cX = p[i * 3], cY = p[i * 3 + 1];
      if (i === n - 1) { bX = cX; bY = cY; }
      else { bX = (p[i * 3] + p[(i + 1) * 3]) / 2; bY = (p[i * 3 + 1] + p[(i + 1) * 3 + 1]) / 2; }
      if (i === i0) path.moveTo(aX, aY);
      path.quadraticCurveTo(cX, cY, bX, bY);
    }
    return path;
  }
  function drawStroke(c, s) {
    var p = s.p, n = p.length / 3;
    if (!n) return;
    c.lineCap = 'round'; c.lineJoin = 'round';
    if (s.t === 'eraser') {
      c.globalCompositeOperation = 'destination-out';
      c.globalAlpha = 1; c.strokeStyle = '#000'; c.fillStyle = '#000';
    } else {
      c.globalCompositeOperation = 'source-over';
      c.globalAlpha = (s.t === 'pencil') ? 0.88 : 1;
      c.strokeStyle = s.c; c.fillStyle = s.c;
    }
    if (n === 1) {
      c.beginPath();
      c.arc(p[0], p[1], Math.max(s.w * (s.t === 'pen' ? p[2] : 1) / 2, 0.5), 0, 6.2832);
      c.fill();
    } else if (s.t === 'pen') {
      var lv = Math.round(p[2] * 4) / 4, start = 1, i;
      for (i = 2; i < n; i++) {
        var q = Math.round(p[i * 3 + 2] * 4) / 4;
        if (q !== lv) {
          c.lineWidth = Math.max(0.6, s.w * lv);
          c.stroke(buildPath(s, start, i - 1));
          lv = q; start = i;
        }
      }
      c.lineWidth = Math.max(0.6, s.w * lv);
      c.stroke(buildPath(s, start, n - 1));
    } else {
      c.lineWidth = s.w;
      c.stroke(buildPath(s, 1, n - 1));
    }
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  }
  /* 局部重绘：矩形用文档坐标；clearRect 会清成透明，从而露出下方题目 */
  function paintRect(x0, y0, x1, y1) {
    if (x1 <= x0 || y1 <= y0) return;
    applyT();
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
    for (var i = 0; i < strokes.length; i++) {
      var s = strokes[i];
      if (!s.bb || !hitBB(s.bb, x0, y0, x1, y1, padOf(s))) continue;
      drawStroke(ctx, s);
    }
    if (live) drawStroke(ctx, live);
    ctx.restore();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  function drawSel(s) {
    var b = s.bb; if (!b) return;
    var pd = padOf(s) + 3;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#1d6fb8';
    ctx.strokeRect(b.x0 - pd, b.y0 - pd, (b.x1 - b.x0) + pd * 2, (b.y1 - b.y0) + pd * 2);
    ctx.restore();
  }
  /* 只画视口内的笔画：页面再长，单帧成本也只跟“看得见的笔画”有关 */
  function renderAll() {
    readScroll();
    applyT();
    ctx.clearRect(0, scrollY, W, H);
    var y0 = scrollY, y1 = scrollY + H;
    for (var i = 0; i < strokes.length; i++) {
      var s = strokes[i];
      if (!s.bb || !hitBB(s.bb, 0, y0, W, y1, padOf(s))) continue;
      drawStroke(ctx, s);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if (selected) drawSel(selected);
  }
  function scheduleDraw() {
    if (rafDraw) return;
    rafDraw = requestAnimationFrame(function () { rafDraw = 0; renderAll(); });
  }

  /* ---------- 采样 ---------- */
  function pushPoint(s, x, y, pr) {
    var n = s.p.length;
    if (n >= MAX_PTS * 3) return false;
    if (n >= 3) {
      var dx = x - s.p[n - 3], dy = y - s.p[n - 2];
      if (dx * dx + dy * dy < PT_MIN * PT_MIN) return false;
    }
    if (s.t === 'pencil') { x += (Math.random() - 0.5) * 0.7; y += (Math.random() - 0.5) * 0.7; }
    s.p.push(x, y, pr);
    var b = s.bb;
    if (!b) s.bb = { x0: x, y0: y, x1: x, y1: y };
    else { if (x < b.x0) b.x0 = x; if (y < b.y0) b.y0 = y; if (x > b.x1) b.x1 = x; if (y > b.y1) b.y1 = y; }
    return true;
  }
  function liveFrame() {
    rafLive = 0;
    if (!live) return;
    var p = live.p, n = p.length / 3;
    if (n < 2) return;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = Math.max(1, markIdx - 1); i < n; i++) {
      var x = p[i * 3], y = p[i * 3 + 1];
      if (x < x0) x0 = x; if (y < y0) y0 = y;
      if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    var pd = padOf(live) + 1;
    var nr = { x0: x0 - pd, y0: y0 - pd, x1: x1 + pd, y1: y1 + pd };
    if (prevDirty) paintRect(prevDirty.x0, prevDirty.y0, prevDirty.x1, prevDirty.y1);
    paintRect(nr.x0, nr.y0, nr.x1, nr.y1);
    prevDirty = nr;
    markIdx = n;
  }
  function scheduleLive() {
    if (rafLive) return;
    rafLive = requestAnimationFrame(liveFrame);
  }

  /* ---------- 交互 ---------- */
  function curColor() { return (tool === 'eraser') ? '#000' : state[tool].c; }
  function curWidth() { return (tool === 'eraser') ? state.eraser.w : state[tool].w; }
  function hitTest(x, y) {
    for (var i = strokes.length - 1; i >= 0; i--) {
      var s = strokes[i], b = s.bb;
      if (!b) continue;
      var pd = padOf(s) + 6;
      if (x < b.x0 - pd || x > b.x1 + pd || y < b.y0 - pd || y > b.y1 + pd) continue;
      var p = s.p, n = p.length / 3, lim = Math.max(s.w, 8) / 2 + 4;
      if (n === 1) {
        var dx = x - p[0], dy = y - p[1];
        if (dx * dx + dy * dy <= lim * lim) return s;
        continue;
      }
      for (var j = 1; j < n; j++) {
        if (distToSeg(x, y, p[(j - 1) * 3], p[(j - 1) * 3 + 1], p[j * 3], p[j * 3 + 1]) <= lim) return s;
      }
    }
    return null;
  }
  function translate(s, dx, dy) {
    var p = s.p;
    for (var i = 0; i < p.length; i += 3) { p[i] += dx; p[i + 1] += dy; }
    var b = s.bb;
    if (b) { b.x0 += dx; b.x1 += dx; b.y0 += dy; b.y1 += dy; }
  }
  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    rectCache = null;
    var o = ptOf(e);
    if (tool === 'pick') {
      var hit = hitTest(o.x, o.y);
      if (hit !== selected) { selected = hit; renderAll(); }
      if (selected) {
        drag = { s: selected, x: o.x, y: o.y, moved: false, prev: selected.p.slice() };
        try { cv.setPointerCapture(e.pointerId); } catch (err) {}
      }
      return;
    }
    try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    drawing = true;
    lastPr = o.pr;
    live = { t: tool, c: curColor(), w: curWidth(), p: [], bb: null };
    markIdx = 1; prevDirty = null;
    pushPoint(live, o.x, o.y, o.pr);
    scheduleLive();
  }
  function onMove(e) {
    if (drag) {
      var o = ptOf(e);
      var dx = o.x - drag.x, dy = o.y - drag.y;
      if (dx || dy) {
        drag.moved = true;
        translate(drag.s, dx, dy);
        drag.x = o.x; drag.y = o.y;
        scheduleDraw();
      }
      return;
    }
    if (!drawing || !live) return;
    e.preventDefault();
    var evs = null;
    if (e.getCoalescedEvents) { try { evs = e.getCoalescedEvents(); } catch (err) { evs = null; } }
    if (!evs || !evs.length) evs = [e];
    for (var i = 0; i < evs.length; i++) {
      var q = ptOf(evs[i]);
      lastPr = lastPr * 0.65 + q.pr * 0.35;
      pushPoint(live, q.x, q.y, lastPr);
    }
    scheduleLive();
  }
  function endStroke() {
    if (!drawing || !live) return;
    if (live.p.length >= 3) {
      live.p = Float32Array.from(live.p);
      if (live.bb) {
        var pd = padOf(live) + 1;
        paintRect(live.bb.x0 - pd, live.bb.y0 - pd, live.bb.x1 + pd, live.bb.y1 + pd);
      }
      strokes.push(live);
      undoStack.push({ t: 'add', s: live });
      redoStack.length = 0;
    }
    live = null; drawing = false; prevDirty = null;
    syncUI();
  }
  function onUp() {
    if (drag) {
      var d = drag; drag = null;
      if (d.moved) {
        undoStack.push({ t: 'move', s: d.s, prev: d.prev, next: d.s.p.slice() });
        redoStack.length = 0;
        syncUI();
      }
      return;
    }
    endStroke();
  }
  /* 演算模式下用滚轮翻页：把滚轮交给下方真正的内容容器 */
  function onWheel(e) {
    var el = null;
    cv.style.pointerEvents = 'none';
    try { el = document.elementFromPoint(e.clientX, e.clientY); } catch (err) { el = null; }
    cv.style.pointerEvents = '';
    var node = el, target = null;
    while (node && node !== document.body && node !== document.documentElement) {
      var st = null;
      try { st = window.getComputedStyle(node); } catch (err) { st = null; }
      if (st && /(auto|scroll)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 2) { target = node; break; }
      node = node.parentElement;
    }
    if (target) target.scrollTop += e.deltaY;
    else window.scrollBy(0, e.deltaY);
    e.preventDefault();
  }
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointercancel', onUp);
  cv.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('blur', function () { if (drawing) endStroke(); });

  /* ---------- 撤销 / 重做 / 清空 ---------- */
  function doUndo() {
    var op = undoStack.pop();
    if (!op) return;
    if (op.t === 'add') {
      var i = strokes.lastIndexOf(op.s);
      if (i >= 0) strokes.splice(i, 1);
    } else if (op.t === 'del') {
      strokes.splice(Math.min(op.i, strokes.length), 0, op.s);
    } else if (op.t === 'move') {
      op.s.p = op.prev.slice(); computeBB(op.s);
    } else if (op.t === 'clear') {
      strokes = op.arr.slice();
    }
    redoStack.push(op);
    selected = null;
    renderAll(); syncUI();
  }
  function doRedo() {
    var op = redoStack.pop();
    if (!op) return;
    if (op.t === 'add') {
      strokes.push(op.s);
    } else if (op.t === 'move') {
      op.s.p = op.next.slice(); computeBB(op.s);
    } else if (op.t === 'clear') {
      op.arr = strokes.slice(); strokes = [];
    }
    undoStack.push(op);
    selected = null;
    renderAll(); syncUI();
  }

  /* ---------- UI 同步 ---------- */
  function syncUI() {
    fab.className = 'fab' + (mode ? ' live' : '') + (strokes.length ? ' has' : '');
    fab.textContent = mode ? '退出演算' : '演算';
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
  }
  function setMode(on) {
    var wasOn = mode;
    mode = !!on;
    if (!mode && drawing) endStroke();
    if (!mode) {
      selected = null;
      drag = null;
      /* 退出即清空：笔迹不保存、不保留 */
      if (wasOn && strokes.length) {
        strokes = [];
        undoStack.length = 0;
        redoStack.length = 0;
        toastMsg('已清空本页演算（不保存）');
      }
    }
    cv.classList.toggle('on', mode);
    cv.classList.toggle('pick', mode && tool === 'pick');
    bar.classList.toggle('show', mode);
    syncUI();
    renderAll();
  }
  function setTool(t) {
    if (drawing) endStroke();
    tool = t;
    selected = null;
    Array.prototype.forEach.call(toolsBox.children, function (b) {
      b.classList.toggle('on', b.getAttribute('data-tool') === t);
    });
    cv.classList.toggle('pick', t === 'pick');
    renderAll();
  }
  function syncColors() {
    var c = (tool === 'pencil') ? state.pencil.c : state.pen.c;
    Array.prototype.forEach.call(colorsBox.children, function (b) {
      b.classList.toggle('on', b.getAttribute('data-c') === c);
    });
  }

  /* ---------- 事件绑定 ---------- */
  fab.addEventListener('click', function () { setMode(!mode); });
  root.getElementById('hidenote').addEventListener('click', function () { setMode(false); });
  toolsBox.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (b) setTool(b.getAttribute('data-tool'));
  });
  undoBtn.addEventListener('click', doUndo);
  redoBtn.addEventListener('click', doRedo);
  root.getElementById('clear').addEventListener('click', function () {
    if (!strokes.length) return;
    undoStack.push({ t: 'clear', arr: strokes.slice() });
    redoStack.length = 0;
    strokes = [];
    selected = null;
    renderAll(); syncUI();
  });
  PALETTE.forEach(function (c, i) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'sw' + (i === 0 ? ' on' : '');
    b.style.background = c;
    b.title = PALETTE_NAME[i];
    b.setAttribute('data-c', c);
    b.addEventListener('click', function () {
      if (tool === 'pencil') state.pencil.c = c;
      else if (tool === 'pen') state.pen.c = c;
      else { state.pen.c = c; state.pencil.c = c; }
      syncColors();
    });
    colorsBox.appendChild(b);
  });
  document.addEventListener('keydown', function (e) {
    if (!mode) return;                                    // 非演算模式完全不影响页面快捷键
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var k = e.key;
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
    } else if ((e.ctrlKey || e.metaKey) && (k === 'y' || k === 'Y')) {
      e.preventDefault(); doRedo();
    } else if (k === 'Escape') {
      setMode(false);
    } else if (k === 'Delete' || k === 'Backspace') {
      if (selected) {
        e.preventDefault();
        var i = strokes.lastIndexOf(selected);
        if (i >= 0) {
          strokes.splice(i, 1);
          undoStack.push({ t: 'del', s: selected, i: i });
          redoStack.length = 0;
          selected = null;
          renderAll(); syncUI();
        }
      }
    } else if (k >= '1' && k <= '5') {
      var c = PALETTE[Number(k) - 1];
      if (tool === 'pencil') state.pencil.c = c;
      else if (tool === 'pen') state.pen.c = c;
      else { state.pen.c = c; state.pencil.c = c; }
      syncColors();
    }
  });
  /* ---------- 滚动 / 尺寸 / 生命周期 ---------- */
  function onScroll() { readScroll(); scheduleDraw(); }
  window.addEventListener('scroll', onScroll, true);
  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { resize(); renderAll(); }, 120);
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (rafLive) { cancelAnimationFrame(rafLive); rafLive = 0; }
      if (rafDraw) { cancelAnimationFrame(rafDraw); rafDraw = 0; }
      if (drawing) endStroke();
    } else {
      renderAll();
    }
  });
  window.addEventListener('pagehide', function () {
    try { cv.width = 1; cv.height = 1; } catch (e) {}    // 立即归还画布缓存
  });
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) { resize(); renderAll(); }
  });

  /* ---------- 启动 ----------
     分两段：先让标识立刻出现在屏幕上；画布尺寸与首帧渲染放到下一帧，
     这样即便板块页有好几 MB，标识也不会被解析和绘制拖住。
     本层不读写任何存储：每次打开都是干净画布，退出即清空。              */
  var booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    /* 清掉早期版本遗留的草稿存档：本层不再保留任何笔迹 */
    try {
      var dead = [], i, k;
      for (i = 0; i < localStorage.length; i++) {
        k = localStorage.key(i);
        if (k && k.indexOf('xz-scratch') === 0) dead.push(k);
      }
      for (i = 0; i < dead.length; i++) localStorage.removeItem(dead[i]);
    } catch (e) {}
    readScroll();
    resize();
    syncColors();
    syncUI();
    renderAll();
  }
  window.__xzScratch = {
    count: function () { return strokes.length; },
    mode: function () { return mode; },
    ready: function () { return booted; },
    setMode: setMode,
    clear: function () { strokes = []; undoStack = []; redoStack = []; renderAll(); syncUI(); }
  };

  syncColors();
  syncUI();                                   // 标识先亮出来
  if (window.requestAnimationFrame) requestAnimationFrame(boot);
  else setTimeout(boot, 0);
})();
