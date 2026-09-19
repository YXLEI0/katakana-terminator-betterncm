/*
 * Katakana Terminator for BetterNCM —— 插件入口
 *
 * 把「片假名终结者」（Arnie97/katakana-terminator, MIT）的外观与用途搬到网易云音乐：
 * 页面上的片假名外来语上方标注英文原词。
 *
 * 与浏览器扩展版的区别：
 *   - 原版每个文本节点都触发一次翻译请求，网易云页面结构复杂得多，这里改成
 *     攒批 + 缓存 + 只扫歌词与标题区域；
 *   - 原版完全依赖在线翻译（GM_xmlhttpRequest），这里加了离线词典兜底；
 *   - 原版用 GM_addStyle，这里自己插 <style>，并且实测内核的 ruby 支持再决定
 *     用 <ruby> 还是绝对定位降级。
 *
 * 依赖 manifest.json 的 injects 顺序：matcher.js -> dict.js -> translate.js
 * -> annotate.js -> main.js
 */
(function () {
  "use strict";

  var LOG = "[katakana-terminator]";
  var CONFIG_KEY = "katakana-terminator.config";
  var CONFIG_VERSION = 1;
  var REPO_URL = "https://github.com/YXLEI0/katakana-terminator-betterncm";

  var DEFAULTS = {
    enabled: true,
    online: true, // 词典没有的词是否联网翻译
    annotateAll: true, // 是否标播放栏的歌曲名/歌手
    scope: "all", // titles | lyrics | all | custom
    customSelector: "",
    // 含汉字的歌词行默认让给振假名插件（jp-furigana），纯假名行归我们。
    // 打了共存补丁（tools/patch-jp-furigana.js）后打开 coexistWithFurigana，
    // 同一行上就能两种注音并存。
    coexistWithFurigana: false,
    rtSize: 60, // 注音字号（相对底字百分比）
    rtOpacity: 80, // 注音不透明度
    focusDebug: false, // 给已注音区域描边，用来排障
    verbose: false,
  };

  // ------------------------------------------------------------ 基础工具

  function log() {
    var msg = "";
    try {
      msg = Array.prototype.join.call(arguments, " ");
    } catch (e) {
      msg = "(unserializable)";
    }
    trace("log", msg);
    if (!config || config.verbose) {
      try {
        console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
      } catch (e) {
        /* ignore */
      }
    }
  }

  function warn() {
    var msg = "";
    try {
      msg = Array.prototype.join.call(arguments, " ");
    } catch (e) {
      msg = "(unserializable)";
    }
    trace("WARN", msg);
    try {
      console.warn.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
    } catch (e) {
      /* ignore */
    }
  }

  /*
   * 运行轨迹信标。
   *
   * 插件把每次扫描的关键信息和异常写进 localStorage，出问题后即使开发者工具
   * 不方便看，也能从网易云的 Local Storage 里把现场读出来（tools 里有读取脚本）。
   * 上限 250 行，超出丢最旧的，避免把配额写爆。
   */
  var TRACE_KEY = "katakana-terminator.trace";
  var TRACE_MAX = 250;

  function trace(kind, msg) {
    try {
      if (typeof localStorage === "undefined") return;
      var arr = [];
      try {
        arr = JSON.parse(localStorage.getItem(TRACE_KEY)) || [];
      } catch (e) {
        arr = [];
      }
      var t = new Date();
      var pad = function (n) {
        return (n < 10 ? "0" : "") + n;
      };
      var stamp = pad(t.getHours()) + ":" + pad(t.getMinutes()) + ":" + pad(t.getSeconds());
      arr.push(stamp + " [" + kind + "] " + String(msg).slice(0, 300));
      if (arr.length > TRACE_MAX) arr = arr.slice(arr.length - TRACE_MAX);
      localStorage.setItem(TRACE_KEY, JSON.stringify(arr));
    } catch (e) {
      /* 写不进去就算了，绝不能因为记录日志把插件搞崩 */
    }
  }

  // 改了默认值就 +1，用来把旧版本存下来的设置迁移掉
  var CONFIG_VERSION = 4;

  function loadConfig() {
    var saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(CONFIG_KEY)) || {};
    } catch (e) {
      /* 坏了就用默认值 */
    }
    var cfg = {};
    for (var k in DEFAULTS) cfg[k] = DEFAULTS[k];
    for (var k2 in saved) if (k2 in DEFAULTS) cfg[k2] = saved[k2];

    // v1 -> v2：歌词改为「按行分工」——含汉字的行让给振假名插件，纯假名行归我们。
    // 旧配置里可能存着别的插件版本遗留的组合，迁移时统一按新默认来，
    // 冲突由分工规则 + 共存补丁避免。
    if (!(saved.configVersion >= 4)) {
      cfg.scope = DEFAULTS.scope;
    }
    cfg.configVersion = CONFIG_VERSION;
    return cfg;
  }

  function saveConfig() {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    } catch (e) {
      warn("设置保存失败", e && e.message);
    }
  }

  var config = loadConfig();

  /*
   * 紧急开关：插件一旦把页面搞崩，设置面板也进不去，所以留一个不依赖 UI 的
   * 关闭方式。在网易云的开发者工具控制台执行：
   *     localStorage['katakana-terminator.off'] = '1'   // 并重启
   * 插件会完全不启动，DOM 一个字节都不动。
   */
  function emergencyOff() {
    try {
      return localStorage.getItem("katakana-terminator.off") === "1";
    } catch (e) {
      return false;
    }
  }

  function devMode() {
    try {
      if (typeof plugin !== "undefined" && plugin.devMode) return true;
      return localStorage.getItem("katakana-terminator.dev") === "1";
    } catch (e) {
      return false;
    }
  }
  var DEV = devMode();

  // ------------------------------------------------------------ 状态

  var state = {
    translator: null,
    annotator: null,
    observer: null,
    timer: null,
    tickTimer: null,
    applied: false,
    lastPassMs: 0,
    lastPassAt: 0,
    timerIsRaf: false,
    lastResult: null,
    error: null,
    betterncmVersion: null,
  };

  var configRefreshers = new Set();

  function notifyConfigUI() {
    configRefreshers.forEach(function (fn) {
      try {
        fn();
      } catch (e) {
        warn("刷新设置面板失败", e && e.message);
      }
    });
  }

  // ------------------------------------------------------------ 扫描

  function buildRegions() {
    if (!state.annotator) return [];
    // 自定义选择器优先；匹配不到就退回下面的模式
    if (config.scope === "custom" && config.customSelector) {
      var custom = state.annotator.customRegions(config.customSelector);
      if (custom.length) return custom;
      log("自定义选择器没匹配到元素，回退自动模式");
    }
    // 只标播放栏的歌曲名/歌手
    if (config.scope === "titles") {
      return config.annotateAll === false ? [] : state.annotator.findRegions("titles");
    }
    // 只标歌词
    if (config.scope === "lyrics") return state.annotator.findRegions("lyrics");
    // 歌词 + 播放栏
    return state.annotator.findRegions("safe");
  }

  function pass() {
    if (!config.enabled || !state.annotator) return;
    // 改动 localStorage 后不重启也能立刻停手（下一轮扫描前生效）
    if (emergencyOff()) {
      warn("检测到紧急开关，停用插件");
      disable();
      return;
    }
    var t0 = performance.now();
    try {
      var regions = buildRegions();
      var n = 0;
      for (var ri = 0; ri < regions.length; ri++) if (regions[ri].isConnected) n++;
      state.lastResult = state.annotator.pass(regions);
      state.error = null;
      // 只在「真的做了什么」时记录。稳定状态下每 250ms 一条 pass 日志会把
      // 轨迹缓冲（250 行）冲干净，真正有用的异常现场反而看不到 —— 之前就吃过
      // 这个亏：诊断日志确实写了，但被 pass 刷掉了。
      if (
        state.lastResult.changed ||
        state.lastResult.restored ||
        state.lastResult.skipped ||
        state.lastResult.unstable
      ) {
        trace(
          "pass",
          "regions=" +
            n +
            " changed=" +
            state.lastResult.changed +
            " restored=" +
            state.lastResult.restored +
            (state.lastResult.skipped ? " skipped=" + state.lastResult.skipped : "") +
            (state.lastResult.unstable ? " unstable=" + state.lastResult.unstable : "")
        );
      }
    } catch (e) {
      state.error = (e && e.message) || String(e);
      trace("pass-ERROR", state.error + " @ " + ((e && e.stack) || "").slice(0, 400));
      warn("扫描失败", e);
      // 连续出错就自动停手：宁可插件不工作，也不能把宿主页面拖垮。
      state.consecutiveErrors = (state.consecutiveErrors || 0) + 1;
      if (state.consecutiveErrors >= 5) {
        warn("连续 " + state.consecutiveErrors + " 轮扫描出错，自动停用并还原 DOM。");
        trace("circuit-breaker", "连续出错 " + state.consecutiveErrors + " 次，已自动停用");
        config.enabled = false;
        saveConfig();
        disable();
        return;
      }
    } finally {
      // MutationObserver 的回调在本轮同步任务之后才跑，光靠标志位挡不住
      // 我们自己造成的变更；把记录队列清空，否则会自激成死循环。
      if (state.observer) state.observer.takeRecords();
      state.lastPassMs = Math.round(performance.now() - t0);
      state.lastPassAt = Date.now();
    }
    state.consecutiveErrors = 0;
  }

  /**
   * 合并短时间内的多次触发，最多排一个待执行的 pass。
   *
   * delay=0 表示「观测到 DOM 变了，要立刻补注音」。这种情况必须**赶在下一帧
   * 绘制之前**跑完，否则那一帧画出来就是没有注音的样子 —— 肉眼就是一闪。
   * 真机轨迹里量到：RNP 歌词行出现后会分几次补齐（罗马音层陆续到达），
   * 每次都让 jp-furigana 重建该行，我们的注音 age≈500ms 就被毁一次；
   * 而重扫延迟 250ms（≈15 帧）就足以让这一闪被看见。所以走 requestAnimationFrame。
   *
   * 仍然保留最小间隔，避免自己在同一帧里反复触发把自己拖成风暴。
   */
  var MIN_PASS_GAP_MS = 40;
  function schedule(delay) {
    if (state.timer) return;
    var d = delay == null ? 250 : delay;
    if (d > 0) {
      state.timer = setTimeout(function () {
        state.timer = null;
        pass();
      }, d);
      return;
    }
    var since = Date.now() - (state.lastPassAt || 0);
    var wait = since < MIN_PASS_GAP_MS ? MIN_PASS_GAP_MS - since : 0;
    var run = function () {
      state.timer = null;
      pass();
    };
    if (wait > 0) {
      state.timer = setTimeout(run, wait);
      return;
    }
    if (typeof requestAnimationFrame === "function") {
      // 下一帧绘制前执行 —— 这一帧画出来时注音已经补回去了
      state.timer = requestAnimationFrame(run);
      state.timerIsRaf = true;
    } else {
      state.timer = setTimeout(run, 0);
    }
  }

  function startObserver() {
    if (state.observer) return;
    var observer = new MutationObserver(function (records) {
      // 回调里出错会变成未捕获异常，可能连带把宿主页面搞崩；这里兜住。
      try {
        var relevant = false;
        for (var i = 0; i < records.length; i++) {
          var r = records[i];
          if (r.type === "characterData" || r.type === "childList") {
            relevant = true;
            break;
          }
        }
        if (relevant) schedule(0);
      } catch (e) {
        warn("MutationObserver 回调异常", e);
      }
    });
    state.observer = observer;
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // 兜底：observer 可能漏掉（React 换了元素、或我们自己在 pass 里清了记录）。
    // 1.5 秒核对一次，发现原文回来了就重扫。
    state.tickTimer = setInterval(function () {
      if (!config.enabled || !state.annotator) return;
      schedule(0);
    }, 1500);
    // Node（单元测试）里定时器会让进程不退出；浏览器里没有 unref，忽略即可
    if (state.tickTimer && typeof state.tickTimer.unref === "function") state.tickTimer.unref();
  }

  // ------------------------------------------------------------ 启用/禁用

  function enable() {
    if (!state.annotator) return;
    if (!state.applied) {
      state.applied = true;
      startObserver();
    }
    schedule(0);
  }

  function disable() {
    state.applied = false;
    if (state.timer) {
      // 可能是 rAF 的 id：clearTimeout 对它无效，但那只是多跑一次 pass，
      // 而 pass 开头会检查 enabled，不会有副作用。两个都清一遍更省心。
      clearTimeout(state.timer);
      if (state.timerIsRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(state.timer);
      state.timer = null;
      state.timerIsRaf = false;
    }
    if (state.annotator) state.annotator.restoreAll();
  }

  function rescan() {
    if (state.annotator) state.annotator.restoreAll();
    if (state.translator) state.translator.retryMisses();
    schedule(0);
  }

  function updateStyles() {
    if (typeof KTAnnotate !== "undefined" && KTAnnotate.applyStyles) {
      KTAnnotate.applyStyles(document, {
        rtSize: config.rtSize,
        rtOpacity: config.rtOpacity,
        focus: config.focusDebug,
      });
    }
  }

  // ------------------------------------------------------------ 设置面板

  function buildConfigUI() {
    var root = document.createElement("div");
    root.id = "katakana-terminator-config";
    root.innerHTML =
      '<style>' +
      "#katakana-terminator-config { font-size: 14px; line-height: 2; }" +
      "#katakana-terminator-config h3 { margin: 14px 0 6px; font-size: 15px; }" +
      "#katakana-terminator-config .kt-row { margin: 4px 0; }" +
      "#katakana-terminator-config .kt-hint { opacity: .65; font-size: 12px; line-height: 1.6; }" +
      "#katakana-terminator-config input[type=text] { width: 320px; padding: 2px 6px; }" +
      "#katakana-terminator-config .kt-preview { padding: 10px 12px; border: 1px solid rgba(128,128,128,.35); border-radius: 6px; font-size: 18px; }" +
      "#katakana-terminator-config .kt-status { white-space: pre-wrap; font-family: monospace; font-size: 12px; opacity: .8; }" +
      "#katakana-terminator-config .kt-links a { margin-right: 14px; }" +
      "</style>" +
      '<div class="kt-links">' +
      '<a href="#" data-open="' + REPO_URL + '">源码仓库</a>' +
      '<a href="#" data-open="' + REPO_URL + '/issues">反馈问题</a>' +
      "</div>" +
      "<h3>预览</h3>" +
      '<div class="kt-preview"></div>' +
      "<h3>开关</h3>" +
      '<div class="kt-row"><label><input type="checkbox" data-k="enabled"> 启用片假名注音</label></div>' +
      '<div class="kt-row"><label><input type="checkbox" data-k="online"> 词典没有的词联网翻译（关掉则完全离线）</label></div>' +
      '<div class="kt-row"><label><input type="checkbox" data-k="annotateAll"> 除歌词外，也标注播放栏的歌曲名 / 歌手</label></div>' +
      '<div class="kt-hint">出于稳定考虑，插件只处理歌词容器和播放栏的标题——不会扫描整个页面。' +
      "早期版本扫整页会把侧边栏、搜索框、歌单名一起改掉，导致网易云报「应用出错了」。</div>" +
      "<h3>外观</h3>" +
      '<div class="kt-row"><label>注音字号 <input type="range" data-k="rtSize" min="30" max="120" step="1"> <span data-v="rtSize"></span></label></div>' +
      '<div class="kt-row"><label>注音不透明度 <input type="range" data-k="rtOpacity" min="10" max="100" step="1"> <span data-v="rtOpacity"></span></label></div>' +
      "<h3>范围</h3>" +
      '<div class="kt-row"><label>标注范围 <select data-k="scope">' +
      '<option value="titles">只标播放栏的歌曲名 / 歌手</option>' +
      '<option value="lyrics">只标歌词</option>' +
      '<option value="all">歌词 + 播放栏（默认）</option>' +
      '<option value="custom">自定义选择器</option>' +
      "</select></label></div>" +
      '<div class="kt-hint">歌词行会被网易云和别的歌词插件高频重建，注音可能被反复丢掉。' +
      "插件会自动放弃「一直在变」的行（宁可少标也不闪）。如果歌词抽搐，把它切回「只标播放栏」即可。</div>" +
      '<div class="kt-row"><label><input type="checkbox" data-k="coexistWithFurigana"> ' +
      "与振假名插件共用同一行（需先给 jp-furigana 打补丁）</label></div>" +
      '<div class="kt-hint">默认情况下含汉字的歌词行整个让给 jp-furigana，' +
      "所以那种行里的片假名标不上英文。给 jp-furigana 打上共存补丁" +
      "（<code>node tools/patch-jp-furigana.js</code>）后打开这个开关，" +
      "含汉字的行也能两种注音并存。</div>" +
      '<div class="kt-row"><label>自定义选择器 <input type="text" data-k="customSelector" placeholder="例如 ul.lyric > li"></label></div>' +
      '<div class="kt-hint">选择器留空或匹配不到元素时会自动回退。</div>' +
      "<h3>操作</h3>" +
      '<div class="kt-row">' +
      '<button data-a="rescan">重新扫描</button> ' +
      '<button data-a="retry">重试未翻译的词</button> ' +
      '<button data-a="clearCache">清除翻译缓存</button>' +
      "</div>" +
      '<div class="kt-status"></div>';

    function fmt(key) {
      return config[key] + "%";
    }

    var preview = root.querySelector(".kt-preview");
    var status = root.querySelector(".kt-status");

    function refreshPreview() {
      preview.innerHTML = "";
      // 用真实的 matcher + 注入逻辑做预览，保证预览和实际效果一致
      if (typeof KTMatcher === "undefined") {
        preview.textContent = "核心模块未加载";
        return;
      }
      var demo = "コーヒーとコンピューター、それからスマホ。";
      var frag = document.createDocumentFragment();
      var pos = 0;
      var tokens = KTMatcher.scan(demo);
      var got = 0;
      for (var i = 0; i < tokens.length; i++) {
        var tk = tokens[i];
        var g = state.translator ? state.translator.lookup(tk.norm) : null;
        if (tk.start > pos) frag.appendChild(document.createTextNode(demo.slice(pos, tk.start)));
        if (g) {
          var ruby = document.createElement("ruby");
          ruby.className = "kt-ruby";
          ruby.appendChild(document.createTextNode(tk.text));
          var rt = document.createElement("rt");
          rt.className = "kt-rt";
          rt.textContent = g;
          ruby.appendChild(rt);
          frag.appendChild(ruby);
          got++;
        } else {
          frag.appendChild(document.createTextNode(tk.text));
        }
        pos = tk.end;
      }
      if (pos < demo.length) frag.appendChild(document.createTextNode(demo.slice(pos)));
      preview.appendChild(frag);
      if (!got) {
        var hint = document.createElement("div");
        hint.className = "kt-hint";
        hint.textContent = state.translator ? "词典与缓存里都没有这些词的译文（可在控制台调 KT.lookup('コーヒー') 查看）" : "翻译器尚未初始化";
        preview.appendChild(hint);
      }
    }

    function refreshStatus() {
      if (!status) return;
      if (!DEV) return; // 状态区只在开发模式显示
      var lines = [];
      var s = state.translator ? state.translator.stats() : null;
      lines.push("BetterNCM: " + (state.betterncmVersion || "未知"));
      lines.push("离线词典: " + (typeof KTDict !== "undefined" ? KTDict.count : "未加载") + " 条");
      lines.push("已注音节点: " + (state.annotator ? state.annotator.injectedCount() : 0));
      if (state.annotator && state.annotator.churnedCount && state.annotator.churnedCount() > 0) {
        // 这些行是插件主动放弃的（对方插件在反复重建这一行，追着重注就是闪）。
        // 明确写出来，免得看起来像"漏标了"。
        lines.push("已避让: " + state.annotator.churnedCount() + " 行（对方反复重建，见轨迹里的 churn）");
      }
      lines.push("上一轮: " + state.lastPassMs + "ms " + JSON.stringify(state.lastResult || {}));
      if (s) {
        lines.push(
          "命中/未命中: 词典 " + s.dictHits + " / 缓存 " + s.memoryHits + " / 在线 " + s.onlineHits + " / 缺 " + s.misses
        );
        lines.push("在线请求: " + s.requests + " 次，失败 " + s.failures + " 次" + (s.lastError ? "（" + s.lastError + "）" : ""));
        lines.push("待翻译队列: " + (state.translator ? state.translator.pending() : 0) + "，缓存条目 " + s.cached);
      }
      if (state.error) lines.push("错误: " + state.error);
      status.textContent = lines.join("\n");
    }

    function refreshAll() {
      refreshPreview();
      refreshStatus();
    }

    if (!DEV) {
      // 非开发模式隐藏状态区，避免设置页太吵
      if (status) status.style.display = "none";
    }

    var NEEDS_RESCAN = ["annotateAll", "scope", "customSelector", "coexistWithFurigana"];
    var NEEDS_RESTYLE = ["rtSize", "rtOpacity", "focusDebug"];

    var inputs = root.querySelectorAll("[data-k]");
    for (var i = 0; i < inputs.length; i++) {
      (function (el) {
        var key = el.dataset.k;
        if (el.type === "checkbox") el.checked = !!config[key];
        else el.value = config[key];

        var commit = function () {
          if (el.type === "checkbox") config[key] = el.checked;
          else if (el.type === "range") config[key] = Number(el.value);
          else config[key] = el.value;
          saveConfig();
          var out = root.querySelector('[data-v="' + key + '"]');
          if (out) out.textContent = fmt(key);
          updateStyles();
          if (key === "enabled") {
            config.enabled ? enable() : disable();
          } else if (key === "online") {
            if (state.translator) state.translator.setOnline(config.online);
            if (config.online) rescan();
          } else if (NEEDS_RESCAN.indexOf(key) >= 0) {
            rescan();
          } else if (NEEDS_RESTYLE.indexOf(key) >= 0) {
            if (state.annotator) state.annotator.restoreAll();
            schedule(0);
          }
          refreshAll();
        };
        el.addEventListener("change", commit);
        if (el.type === "range") el.addEventListener("input", commit);

        var out0 = root.querySelector('[data-v="' + key + '"]');
        if (out0) out0.textContent = fmt(key);
      })(inputs[i]);
    }

    // 外链交给系统浏览器，直接跳会把网易云本身导航走
    var links = root.querySelectorAll("[data-open]");
    for (var li = 0; li < links.length; li++) {
      (function (el) {
        el.onclick = function (e) {
          e.preventDefault();
          try {
            betterncm.ncm.openUrl(el.dataset.open);
          } catch (err) {
            warn("打开链接失败", err && err.message);
          }
        };
      })(links[li]);
    }

    function onClick(action, handler) {
      var el = root.querySelector('[data-a="' + action + '"]');
      if (el) el.onclick = handler;
    }
    onClick("rescan", function () {
      rescan();
      setTimeout(refreshStatus, 500);
    });
    onClick("retry", function (e) {
      var n = state.translator ? state.translator.retryMisses() : 0;
      e.target.textContent = "已重新排队 " + n + " 个";
      setTimeout(function () {
        e.target.textContent = "重试未翻译的词";
      }, 2000);
      if (n) rescan();
      refreshStatus();
    });
    onClick("clearCache", function (e) {
      if (state.translator) state.translator.clearCache();
      e.target.textContent = "已清除";
      setTimeout(function () {
        e.target.textContent = "清除翻译缓存";
      }, 2000);
      rescan();
      refreshStatus();
    });

    refreshAll();
    configRefreshers.add(refreshAll);

    // BetterNCM 会先调 onConfig 建好面板、之后才插进 DOM，所以刚开始 root 是游离的。
    // 不能一看到没连上就清定时器，否则面板会永远停在初始状态。
    var seenConnected = false;
    var ticks = 0;
    var iv = setInterval(function () {
      if (root.isConnected) seenConnected = true;
      else if (seenConnected || ++ticks > 120) {
        clearInterval(iv);
        configRefreshers.delete(refreshAll);
        return;
      }
      refreshAll();
    }, 1000);

    return root;
  }

  // ------------------------------------------------------------ 入口

  plugin.onConfig(function () {
    return buildConfigUI();
  });

  plugin.onLoad(function () {
    trace(
      "boot",
      "onLoad 开始 off=" +
        emergencyOff() +
        " enabled=" +
        config.enabled +
        " scope=" +
        config.scope +
        " annotateAll=" +
        config.annotateAll +
        " cfgVer=" +
        config.configVersion +
        " 模块 matcher=" +
        (typeof KTMatcher) +
        " annotate=" +
        (typeof KTAnnotate)
    );
    // 捕获未处理异常，这样即使崩溃也能在轨迹里留下线索
    try {
      window.addEventListener("error", function (ev) {
        trace(
          "window-error",
          (ev && ev.message ? ev.message : "(no message)") +
            " @ " +
            ((ev && ev.filename) || "?") +
            ":" +
            ((ev && ev.lineno) || 0) +
            " stack=" +
            (((ev && ev.error && ev.error.stack) || "") + "").slice(0, 300)
        );
      });
      window.addEventListener("unhandledrejection", function (ev) {
        var r = ev && ev.reason;
        trace("unhandled-rejection", ((r && (r.message || r)) + "").slice(0, 300));
      });
    } catch (e) {
      /* 加不上就算了 */
    }
    if (emergencyOff()) {
      warn("已设置 localStorage['katakana-terminator.off']=1，本次不启动。清掉这个键并重启即可恢复。");
      return;
    }
    // BetterNCM 有安全模式（localStorage['betterncm.safemode']）。
    // 它在安全模式下通常不会加载插件，这里再确认一次，避免我们还是动了 DOM。
    try {
      if (localStorage.getItem("betterncm.safemode") === "true") {
        trace("boot", "BetterNCM 处于安全模式，跳过启动");
        return;
      }
    } catch (e) {
      /* 读不到就算了 */
    }
    if (typeof KTMatcher === "undefined" || typeof KTAnnotate === "undefined") {
      warn("核心模块未注入，检查 manifest.json 的 injects 顺序");
      return;
    }
    try {
      betterncm.app.getBetterNCMVersion().then(
        function (v) {
          state.betterncmVersion = v;
        },
        function () {
          /* 只是给状态区看的，拿不到就算了 */
        }
      );
    } catch (e) {
      /* ignore */
    }

    try {
      updateStyles();
      state.translator = KTTranslate.createTranslator({
        online: config.online,
        log: function () {
          if (config.verbose) console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
        },
        onStatus: function (msg) {
          log(msg);
          notifyConfigUI();
        },
        onUpdate: function () {
          // 在线翻译回来了：把已有的注音撤掉重扫，新词就能标上
          if (!config.enabled) return;
          if (state.annotator) state.annotator.restoreAll();
          schedule(0);
          notifyConfigUI();
        },
      });
      state.annotator = KTAnnotate.createAnnotator({
        lookup: function (word) {
          return state.translator.lookup(word);
        },
        annotateAll: config.annotateAll !== false,
        // 含汉字的歌词行默认让给振假名插件（jp-furigana）：两边都往同一行插节点
        // 会互相重建，来回闪烁。纯假名行没有振假名可注，本来就没有冲突。
        // 打了共存补丁后打开 coexistWithFurigana，同一行上两种注音才能并存。
        skipKanjiLines: true,
        // 打了共存补丁后才允许在含汉字的行上也注音（两种注音同一行）。
        // 传函数而不是布尔值：这是设置页里的开关，改了要立刻生效。
        coexistWithFurigana: function () {
          return !!config.coexistWithFurigana;
        },
        log: function () {
          // 走 trace：注音明细只在出问题时才有价值，默认不进 console，但一定要留痕
          trace("annotate", Array.prototype.join.call(arguments, " "));
        },
      });
    } catch (e) {
      state.error = (e && e.message) || String(e);
      warn("初始化失败", e);
      return;
    }

    if (config.enabled) enable();
    else state.annotator.restoreAll();

    trace("boot", "初始化完成，annotator=" + !!state.annotator + " translator=" + !!state.translator);

    window.KatakanaTerminator = {
      config: config,
      state: state,
      set: function (key, value) {
        config[key] = value;
        saveConfig();
        updateStyles();
        if (key === "enabled") config.enabled ? enable() : disable();
        else rescan();
        return config[key];
      },
      lookup: function (word) {
        return state.translator ? state.translator.lookup(word) : null;
      },
      dict: function () {
        return typeof KTDict !== "undefined" ? KTDict.words : {};
      },
      stats: function () {
        return state.translator ? state.translator.stats() : null;
      },
      scan: function (text) {
        return KTMatcher.scan(text);
      },
      pass: pass,
      rescan: rescan,
      enable: enable,
      disable: disable,
      clearCache: function () {
        if (state.translator) state.translator.clearCache();
        rescan();
      },
      rubyLayout: function () {
        return KTAnnotate.hasRubyLayout(document);
      },
    };

    log(
      "已加载" +
        (DEV ? "（开发模式）" : "") +
        "，控制台可用 KT.stats() 看统计、KT.lookup('コーヒー') 单独查词、KT.rubyLayout() 看内核 ruby 支持"
    );
    notifyConfigUI();
  });
})();
