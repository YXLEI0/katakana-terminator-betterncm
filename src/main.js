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
    annotateAll: true, // 除歌词外，也标标题/歌手/专辑/列表
    scope: "auto", // auto | lyrics | custom
    customSelector: "",
    rtSize: 60, // 注音字号（相对底字百分比）
    rtOpacity: 80, // 注音不透明度
    focusDebug: false, // 给已注音区域描边，用来排障
    verbose: false,
  };

  // ------------------------------------------------------------ 基础工具

  function log() {
    if (!config || config.verbose) {
      try {
        console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
      } catch (e) {
        /* ignore */
      }
    }
  }

  function warn() {
    try {
      console.warn.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
    } catch (e) {
      /* ignore */
    }
  }

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
    // 自定义选择器优先；匹配不到就退回自动模式
    if (config.scope === "custom" && config.customSelector) {
      var custom = state.annotator.customRegions(config.customSelector);
      if (custom.length) return custom;
      log("自定义选择器没匹配到元素，回退自动模式");
    }
    // 「只标歌词」：只找歌词容器；一个都没有时退回整页，免得什么都不标
    if (config.scope === "lyrics") {
      var lyrics = state.annotator.findRegions(true);
      if (lyrics.length) return lyrics;
      return state.annotator.findRegions(false);
    }
    // 自动：annotateAll 决定是整页（含标题/歌手/列表）还是只标歌词
    if (config.annotateAll !== false) return state.annotator.findRegions(false);
    var onlyLyrics = state.annotator.findRegions(true);
    return onlyLyrics.length ? onlyLyrics : state.annotator.findRegions(false);
  }

  function pass() {
    if (!config.enabled || !state.annotator) return;
    // 改动 localStorage 后不重启也能立刻停手（下一轮扫描前生效）
    if (emergencyOff()) {
      disable();
      return;
    }
    var t0 = performance.now();
    try {
      var regions = buildRegions();
      state.lastResult = state.annotator.pass(regions);
      state.error = null;
    } catch (e) {
      state.error = (e && e.message) || String(e);
      warn("扫描失败", e);
    } finally {
      // MutationObserver 的回调在本轮同步任务之后才跑，光靠标志位挡不住
      // 我们自己造成的变更；把记录队列清空，否则会自激成死循环。
      if (state.observer) state.observer.takeRecords();
      state.lastPassMs = Math.round(performance.now() - t0);
      if (state.lastResult && state.lastResult.changed) log("本轮新增注音", state.lastResult.changed);
    }
  }

  /** 合并短时间内的多次触发，最多排一个待执行的 pass */
  function schedule(delay) {
    if (state.timer) return;
    state.timer = setTimeout(function () {
      state.timer = null;
      pass();
    }, delay == null ? 250 : delay);
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
        if (relevant) schedule();
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
      clearTimeout(state.timer);
      state.timer = null;
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
      '<div class="kt-row"><label><input type="checkbox" data-k="annotateAll"> 除歌词外也标注标题 / 歌手 / 专辑</label></div>' +
      "<h3>外观</h3>" +
      '<div class="kt-row"><label>注音字号 <input type="range" data-k="rtSize" min="30" max="120" step="1"> <span data-v="rtSize"></span></label></div>' +
      '<div class="kt-row"><label>注音不透明度 <input type="range" data-k="rtOpacity" min="10" max="100" step="1"> <span data-v="rtOpacity"></span></label></div>' +
      "<h3>范围</h3>" +
      '<div class="kt-row"><label>标注范围 <select data-k="scope">' +
      '<option value="auto">自动（歌词 + 标题）</option>' +
      '<option value="lyrics">只标歌词</option>' +
      '<option value="custom">自定义选择器</option>' +
      "</select></label></div>" +
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

    var NEEDS_RESCAN = ["annotateAll", "scope", "customSelector"];
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
    if (emergencyOff()) {
      warn("已设置 localStorage['katakana-terminator.off']=1，本次不启动。清掉这个键并重启即可恢复。");
      return;
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
        log: function () {
          if (config.verbose) console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
        },
      });
    } catch (e) {
      state.error = (e && e.message) || String(e);
      warn("初始化失败", e);
      return;
    }

    if (config.enabled) enable();
    else state.annotator.restoreAll();

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
