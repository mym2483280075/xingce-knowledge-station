/* =========================================================
   公考工作站 · 主题层（白天 / 夜晚 / 跟随系统）
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

/* ===================================================================
   给后续审阅者的阅读约定 —— 改代码前先看这一段
   ---------------------------------------------------------------
   【需求】用户明确提出的要求 / 已确认的行为，改动不要违背
   【易错】最容易引入 bug 的地方：动它之前请把整段连同调用方一起读完
   【坑】  浏览器 / 平台差异陷阱（iOS、iPadOS、WebKit）
   【接口】对外暴露、被其它文件依赖的名字与语义，改名等于破坏调用方
   【数据】localStorage 持久化格式，改字段必须兼容旧数据
   本文件的三条关键契约（动任何一条都要全站回归）：
     ① html 上的类与属性：xz-dark（样式钩子）+ data-xz-theme="dark|light"（语义）
     ② document 事件：xz-theme-change，detail = {dark, mode} —— 演算层靠它切色板
     ③ 跨层同步：postMessage 'xz-theme' / 'xz-theme-set' / 'xz-theme-query'，外加
        localStorage 的 storage 事件兜底（外壳、iframe、另一个标签页都能互相带动）
   =================================================================== */
(function () {
  'use strict';
  if (window.__xzThemeLoaded) return;
  window.__xzThemeLoaded = true;

  /* 【数据】主题存储键，值只允许 auto / light / dark 三个；非法值一律按 auto 处理
     （所以改动 MODES 时，旧用户存着的值要能安全落到默认值，否则老设备打开会异常）。 */
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
  /* 【接口】isDark() 是“最终用不用深色”的唯一判据：mode=dark 恒真，
     mode=auto 时看系统；演算层、各板块页的钩子都按这个语义取值，不要在别处再算一遍。 */
  function isDark() { return mode === 'dark' || (mode === 'auto' && sysDark()); }

  /* ===================== 样式 =====================
     【易错】下面是一个 JS 数组拼出来的 CSS 文本：里面只能放样式，不能插 // 注释，
     也不要用反引号模板串（本文件统一用单引号 + 逗号拼接）。
     【需求】夜晚模式不是反色，而是“保留各板块主色调、把浅色体系整体压暗”：
     所有强调色都用 color-mix 从该页既有的 --primary / --primary2 / --accent 派生，
     所以常识判断是青、政治理论是红、数量关系是橙，夜里也分得清板块。
     改这里的变量名要同时检查板块页是否真的定义了同名变量。 */
  var CSS = [
    /* 【架构】配色不再靠「逐条 !important 覆盖」：亮暗两套值全部在
       assets/design-tokens.css 里以变量给出，组件只引用变量（--xz-* / --accent-*）。
       所以这里只保留两件令牌表达不了的事：选中色和「没有主题开关的页面」的浮标。 */
    'html.xz-dark ::selection{background:color-mix(in srgb,var(--primary,#4f7cff) 45%,#0b1120);color:#f4f8ff}',
    '.xz-theme-fab{position:fixed;left:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:2147482000;',
      'display:flex;align-items:center;gap:7px;border:1px solid var(--xz-line);border-radius:999px;',
      'background:var(--xz-elev);color:var(--xz-ink-2);font:600 12.5px/1 ' + FONT + ';padding:9px 14px 9px 11px;cursor:pointer;',
      'box-shadow:var(--sh-2);-webkit-tap-highlight-color:transparent;touch-action:manipulation}',
    '.xz-theme-fab .xz-ico{width:16px;height:16px;flex:none}',
    '.xz-theme-fab:active{transform:scale(.96)}',
    '@media(max-width:640px){',
      '.xz-theme-fab{left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px))}',
    '}'
  ].join('');

  /* 【接口】样式表 id 固定为 xz-theme-css（调试和外部覆盖都靠它）。
     同步创建、立刻插入 head：这是“解析阶段就定好颜色、不闪白”的关键，
     不要挪到 DOMContentLoaded 之后再插。 */
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

  /* 【坑】同步 iOS 的地址栏 / 状态栏配色（theme-color meta），没有就现建一个。
     颜色必须是和页面底色一致的实色，否则 iPad 顶部会露出突兀的色条。
     换品牌底色时这里和 CSS 里的 --bg 要一起改。 */
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

  /* 【接口】【易错】把当前模式落到 DOM 上，是全局最重要的一处副作用：
       · html.xz-dark            样式钩子（本文件的 CSS 全靠它）
       · html[data-xz-theme]     语义标记（外部脚本可读）
       · meta[name=theme-color]  iOS 状态栏
       · document 的 xz-theme-change 事件  【接口】演算层据此换调色板，事件丢了画布会留在旧配色
     注意事件与 listeners 只在“深浅色真的变了”时触发（changed 判定），
     别把那个判定删掉：否则每次 setMode 都全站重绘，iPad 上正在写的笔画会跟着闪。 */
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

  /* 【接口】对外广播主题：给父窗口（外壳）和 iframe 各发一条 postMessage。
     接收方按 { type:'xz-theme', mode, dark } 解析；改字段名等于要同时改 index.html。 */
  function tell() {
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'xz-theme', mode: mode, dark: dark }, '*'); } catch (e) {}
    if (frameEl) { try { frameEl.contentWindow.postMessage({ type: 'xz-theme', mode: mode, dark: dark }, '*'); } catch (e2) {} }
  }

  /* 【易错】silent=true 表示“只改本地、不广播”，专门给 message 监听用，
     否则外壳与 iframe 会来回互发形成死循环。
     新增调用点时请想清楚：用户主动切换 → 不传 silent；被动跟随别人 → silent。 */
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
    /* 【需求】页面自己已经有开关（工作站的顶栏分段控件 / data-xz-theme-set）就不要再冒浮标，
       内嵌 iframe 里也不显示（由外壳统一控制）。两个 if 都是刻意的，别合成一个。 */
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

  /* 【接口】页面按下 [data-xz-theme-set="auto|light|dark"] 的元素即切换主题（事件委托，
     所以动态插入的开关也能用，不需要重新绑定）。这是各板块页/外壳接入主题的唯一约定。 */
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-xz-theme-set]') : null;
    if (!el) return;
    e.preventDefault();
    setMode(el.getAttribute('data-xz-theme-set'));
  });

  /* 【需求】系统深浅色变化：auto 模式实时跟随（light/dark 是用户显式选择，不跟随）。 */
  function onSys() {
    if (mode === 'auto') { paint(); tell(); }
  }
  if (mql) {
    if (mql.addEventListener) mql.addEventListener('change', onSys);
    else if (mql.addListener) mql.addListener(onSys);
  }

  /* 【接口】其它页面（外壳 / iframe / 另一个标签页）改了主题：跟着变。
     【易错】storage 事件在 localStorage.clear() 时 e.key 为 null，所以下面必须写成
     “key 存在且不等于 KEY 才 return”，否则清空存储时会漏同步一次。 */
  window.addEventListener('storage', function (e) {
    if (e && e.key && e.key !== KEY) return;
    var v = load(KEY);
    if (MODES.indexOf(v) < 0) v = 'auto';
    if (v !== mode) { mode = v; paint(); }
  });
  /* 【接口】接收外部主题指令：'xz-theme-set'（别人改了我的模式，必须以 silent 应用，
     否则会和对方来回互发）与 'xz-theme-query'（问我当前状态，回一条 'xz-theme'）。
     协议字段被 index.html 与各板块页共同遵守，改名要全局搜一遍。 */
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

  /* 【接口】对外接口，被 index.html（外壳）与演算层依赖，改名等于破坏调用方：
     modes / getMode / isDark / setMode / cycle / on(fn) / bindFrame(el) / mount() / broadcast()。
     · bindFrame(el)  index.html 把内嵌的 iframe 交给本层，后续广播才会带上它
     · mount()       非内嵌页面（直接打开板块页）手动挂浮标
     · on(fn)        订阅变化，回调签名 (dark, mode)
     新增方法请在下面补一行说明。 */
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

  /* 【需求】DOM 就绪后补挂浮标：只在“非内嵌且页面自己没有开关”时才出现（见 buildFab）。
     内嵌时改为 tell() 通知外壳，保证两边状态一致。 */
  if (embedded) {
    /* 内嵌时由外壳统一控制，但通知外壳当前状态，保证两边一致 */
    tell();
  } else {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { buildFab(); syncUI(); tell(); });
    } else { buildFab(); syncUI(); tell(); }
  }
  /* 【易错】这里不要再补一次 tell()：上面两条分支各自已经广播过一次，
     多出来的那次会让每个内嵌 iframe 加载时连发两条 'xz-theme'，
     外壳收到后会多走一遍 setMode（顺带多写一次 localStorage）。 */
})();
