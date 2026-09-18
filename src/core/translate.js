/*
 * Katakana Terminator for BetterNCM —— 翻译层
 *
 * 三级来源，按顺序：
 *   1. 会话缓存（内存 Map）—— 命中就同步返回，零延迟；
 *   2. 离线词典（core/dict.js）—— 断网也能标，同步返回；
 *   3. 在线翻译（Google 的 dict-chrome-ex 接口）—— 批量、去重、按需排队。
 *
 * 为什么第 2 步在在线之前：原版 Katakana Terminator 完全依赖在线接口，
 * 接口一挂插件就废了（参考 jp-furigana 的在线 API 失效记录）。这里把
 * 词典放在在线前面，保证「离线可用、在线更准」：词典里没有的词才发请求。
 *
 * 在线部分是非阻塞的：lookup() 永远立刻返回（可能返回 null）。
 * 未命中的词进队列，攒一小会儿再批量请求，拿到结果后通过 onUpdate 通知
 * 调用方重扫，所以「先不标 -> 稍后补上」是预期行为。
 *
 * 缓存落 localStorage，带 TTL 和条数上限。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KTTranslate = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 注意：不能直接用上面 UMD 壳里的 root —— 仓库里 require 这份文件时
  // factory 是在模块作用域里跑的，那里没有 root。统一用 globalThis。
  var G = typeof globalThis !== "undefined" ? globalThis : {};

  var DICTS = G.KTDict || (typeof require === "function" ? safeRequire() : null);
  function safeRequire() {
    try {
      return require("./dict.js");
    } catch (e) {
      return null;
    }
  }
  var CACHE_KEY = "katakana-terminator.cache.v1";
  var CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
  var CACHE_MAX = 4000;
  var FLUSH_DELAY_MS = 1200; // 攒批窗口
  var BATCH_SIZE = 50;
  var REQUEST_TIMEOUT_MS = 12000;
  var MAX_ATTEMPTS = 2;

  /*
   * 依次尝试的接口。都用同一个路径形状，只是换 host：
   *   /translate_a/t?client=dict-chrome-ex&dt=t&sl=ja&tl=en&q=...
   * 返回 ["行1\n行2\n..."]，按 \n 拆开与请求顺序一一对应。
   * 实测（2026-02）translate.google.cn 最快；googleapis 的 gtx 接口会被限流，
   * 所以不作为首选。
   */
  var HOSTS = ["translate.google.cn", "translate.google.com"];

  function createTranslator(options) {
    options = options || {};
    var onUpdate = options.onUpdate || function () {};
    var onStatus = options.onStatus || function () {};
    var onlineEnabled = options.online !== false;
    var log = options.log || function () {};

    var mem = new Map(); // word -> gloss | null(null 表示查过但没有)
    var persisted = loadCache();
    var queue = new Set();
    var inflight = new Set();
    var timer = null;
    var dirty = false;
    var stats = { dictHits: 0, memoryHits: 0, onlineHits: 0, misses: 0, requests: 0, failures: 0 };
    var lastError = null;

    for (var k in persisted) mem.set(k, persisted[k]);

    // ------------------------------------------------------------ 缓存

    function loadCache() {
      try {
        if (typeof localStorage === "undefined") return {};
        var raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return {};
        var obj = JSON.parse(raw);
        var now = Date.now();
        var out = {};
        for (var key in obj) {
          var rec = obj[key];
          if (!rec || typeof rec.t !== "number") continue;
          if (now - rec.t > CACHE_TTL_MS) continue;
          if (typeof rec.g === "string" && rec.g) out[key] = rec.g;
        }
        return out;
      } catch (e) {
        return {};
      }
    }

    var flushTimer = null;
    function flushCache(force) {
      if (!dirty) return;
      if (flushTimer && !force) return;
      clearTimeout(flushTimer);
      flushTimer = setTimeout(function () {
        flushTimer = null;
        dirty = false;
        try {
          if (typeof localStorage === "undefined") return;
          var now = Date.now();
          var entries = [];
          mem.forEach(function (gloss, word) {
            if (typeof gloss === "string" && gloss) entries.push([word, { g: gloss, t: now }]);
          });
          if (entries.length > CACHE_MAX) entries = entries.slice(entries.length - CACHE_MAX);
          var obj = {};
          for (var i = 0; i < entries.length; i++) obj[entries[i][0]] = entries[i][1];
          localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
        } catch (e) {
          log("缓存写入失败（配额？）：", e && e.message);
        }
      }, force ? 0 : 2000);
    }

    function clearCache() {
      mem.clear();
      dirty = false;
      try {
        if (typeof localStorage !== "undefined") localStorage.removeItem(CACHE_KEY);
      } catch (e) {
        /* ignore */
      }
      stats.dictHits = stats.memoryHits = stats.onlineHits = stats.misses = 0;
    }

    // ------------------------------------------------------------ 查询

    function dictLookup(word) {
      var words = DICTS && DICTS.words;
      if (!words) return null;
      var hit = words[word];
      return typeof hit === "string" && hit ? hit : null;
    }

    /**
     * 同步查询。返回英文字符串或 null（null 表示「暂时没有，稍后可能补上」）。
     * 只有同时启用在线、且确实排进了队列，才需要等 onUpdate。
     */
    function lookup(word) {
      if (!word) return null;

      // 1. 会话/持久缓存
      if (mem.has(word)) {
        var cached = mem.get(word);
        // 有译文就直接给；记的是 null 表示「查过了、没有」——这是终态，
        // 直接返回 null 并且不再排队。否则每次扫描都会把同一个查不到的词
        // 重新排队，接口一慢就变成请求风暴。想再给一次机会走 retryMisses()。
        if (cached) stats.memoryHits++;
        return cached || null;
      }

      // 2. 离线词典
      var dictHit = dictLookup(word);
      if (dictHit) {
        mem.set(word, dictHit);
        dirty = true;
        stats.dictHits++;
        return dictHit;
      }

      // 3. 在线：排队，本次先返回 null
      stats.misses++;
      // 关键：立刻记成「查过、没有」。否则同一个词在每个扫描周期都会被重新
      // 排队（lookup 每次都走到这里），接口一慢就是请求风暴。
      // 成功后会被真正的译文覆盖；想再试走 retryMisses()。
      mem.set(word, null);
      dirty = true;
      if (onlineEnabled && !inflight.has(word)) {
        queue.add(word);
        scheduleFlush();
      }
      return null;
    }

    // ------------------------------------------------------------ 在线请求

    function scheduleFlush() {
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        flush();
      }, FLUSH_DELAY_MS);
    }

    /**
     * 取一批待翻译的词，并把它们从队列移到 inflight。
     * 一个词同时只应存在于 queue 或 inflight 之一 —— 早些时候是先 add(inflight)
     * 再从 queue 删除候选，结果每次 flush 都会把同一批词重发一遍。
     */
    function takeBatch() {
      var words = [];
      queue.forEach(function (w) {
        if (words.length < BATCH_SIZE && !inflight.has(w)) words.push(w);
      });
      for (var i = 0; i < words.length; i++) {
        queue.delete(words[i]);
        inflight.add(words[i]);
      }
      return words;
    }

    function flush() {
      if (!onlineEnabled) return;
      var words = takeBatch();
      if (!words.length) return;
      request(words).then(
        function (glosses) {
          var got = 0;
          for (var i = 0; i < words.length; i++) {
            var g = glosses[i];
            inflight.delete(words[i]);
            if (typeof g === "string" && g) {
              mem.set(words[i], g);
              dirty = true;
              got++;
            }
          }
          stats.onlineHits += got;
          stats.requests++;
          lastError = null;
          if (got) {
            flushCache();
            onStatus("在线翻译：" + got + " 个词");
            onUpdate();
          }
          // 还有积压就接着发
          if (queue.size) scheduleFlush();
        },
        function (err) {
          stats.requests++;
          stats.failures++;
          lastError = (err && err.message) || String(err);
          for (var i = 0; i < words.length; i++) {
            inflight.delete(words[i]);
            // 记成「查过、没有」，否则每个扫描周期都会重新排队同一个词，
            // 接口一挂就变成无限请求。
            // 记 null 之后：lookup 直接返回 null 不再排队；想再给一次机会
            // 走 retryMisses()（设置面板的「重试未翻译的词」）。
            mem.set(words[i], null);
          }
          dirty = true;
          flushCache();
          onStatus("在线翻译失败：" + lastError);
          log("在线翻译失败：", lastError);
          // 失败后不再自动重排队，避免接口挂了以后疯狂重试。
          // 用户改设置或手动 rescan 时会重新排队。
        }
      );
    }

    function buildUrl(host, words) {
      return (
        "https://" +
        host +
        "/translate_a/t?client=dict-chrome-ex&dt=t&sl=ja&tl=en&q=" +
        encodeURIComponent(words.join("\n"))
      );
    }

    function parseResponse(json, expected) {
      var joined = Array.isArray(json) && Array.isArray(json[0]) ? json[0][0] : json[0];
      if (typeof joined !== "string") throw new Error("响应形状异常");
      var lines = joined.split("\n");
      if (lines.length !== expected) throw new Error("行数对不上（要 " + expected + " 行，回 " + lines.length + " 行）");
      return lines.map(cleanGloss);
    }

    function cleanGloss(s) {
      return String(s == null ? "" : s)
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[.。]+$/, "");
    }

    function requestOnce(host, words) {
      var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      var t = setTimeout(function () {
        if (ctrl) ctrl.abort();
      }, REQUEST_TIMEOUT_MS);
      return fetch(buildUrl(host, words), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: ctrl ? ctrl.signal : undefined,
      })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (json) {
          return parseResponse(json, words.length);
        })
        .finally(function () {
          clearTimeout(t);
        });
    }

    function request(words, attempt) {
      attempt = attempt || 0;
      var host = HOSTS[Math.min(attempt, HOSTS.length - 1)];
      return requestOnce(host, words).catch(function (err) {
        if (attempt + 1 < MAX_ATTEMPTS) {
          log("接口 " + host + " 失败（" + err.message + "），换一个再试");
          // 注意参数顺序：这里是 (words, attempt)，别把 host 当成了 words
          return request(words, attempt + 1);
        }
        throw err;
      });
    }

    // ------------------------------------------------------------ 对外

    return {
      lookup: lookup,
      clearCache: clearCache,
      flushCache: function () {
        flushCache(true);
      },
      setOnline: function (on) {
        onlineEnabled = !!on;
        if (!onlineEnabled) {
          queue.clear();
        } else {
          // 重新排队所有「在词典里查不到」的历史 miss，让用户打开开关就生效
          mem.forEach(function (v, k) {
            if (!v) queue.add(k);
          });
          scheduleFlush();
        }
      },
      /** 忘了曾经查不到的结论，重新排队（接口恢复后再给一次机会） */
      retryMisses: function () {
        var n = 0;
        mem.forEach(function (v, k) {
          if (!v) {
            mem.delete(k);
            if (onlineEnabled) {
              queue.add(k);
              n++;
            }
          }
        });
        if (n) scheduleFlush();
        return n;
      },
      /** 已排队/在飞的词数，给设置面板显示 */
      pending: function () {
        return queue.size + inflight.size;
      },
      stats: function () {
        var s = {};
        for (var k in stats) s[k] = stats[k];
        s.cached = mem.size;
        s.dictSize = (DICTS && DICTS.count) || 0;
        s.lastError = lastError;
        return s;
      },
    };
  }

  return { createTranslator: createTranslator, CACHE_KEY: CACHE_KEY, HOSTS: HOSTS };
});
