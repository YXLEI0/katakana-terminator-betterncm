/*
 * Katakana Terminator for BetterNCM —— 浮层注音（与 jp-furigana 共存用）
 *
 * 为什么需要它：
 *   另一个常用插件 jp-furigana 会给汉字标振假名，它的做法是把**整行**内容
 *   换成自己的 <span class="fg-line">，并检查 `h.childNodes.length !== 1`
 *   来判断"这行有没有被外人动过"。只要我往它管的行里插节点，它就会判定行脏、
 *   重建整行，我插的注音随之被抹掉 —— 两边来回就是抽搐（实测轨迹里
 *   changed=18 restored=18 每秒四次）。
 *
 *   结论：同一行上"它的振假名"和"我的英文注音"无法靠改 DOM 共存。
 *
 * 所以这里完全不碰歌词 DOM：把英文注音画在一个独立的浮层上，
 * 用 Range.getBoundingClientRect() 量出每个片假名词的位置，再绝对定位过去。
 * 对 jp-furigana 来说，歌词 DOM 一个字节都没变。
 *
 * 代价（如实说明）：
 *   - 浮层是画上去的，不参与排版：页面缩放/换行/滚动需要重新测量；
 *   - 看不见的歌词行不画（省性能，也避免堆积）；
 *   - 复制歌词不会带上英文注音（DOM 里没有）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KTOverlay = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var G = typeof globalThis !== "undefined" ? globalThis : {};

  var LAYER_ID = "katakana-terminator-overlay";
  var STYLE_ID = "katakana-terminator-overlay-style";

  function createOverlay(options) {
    options = options || {};
    var doc = options.document || (typeof document !== "undefined" ? document : null);
    var win = doc ? doc.defaultView : null;
    var lookup = options.lookup;
    if (typeof lookup !== "function") throw new Error("createOverlay 需要 lookup(word) 函数");
    if (doc && win && typeof win.Range === "undefined") throw new Error("环境不支持 Range");

    var matcher = G.KTMatcher || (typeof require === "function" ? safeRequire() : null);
    function safeRequire() {
      try {
        return require("./matcher.js");
      } catch (e) {
        return null;
      }
    }
    if (!matcher) throw new Error("KTMatcher 未加载");

    var rtSize = options.rtSize == null ? 60 : options.rtSize;
    var rtOpacity = options.rtOpacity == null ? 80 : options.rtOpacity;

    // 浮层容器：固定在视口上，坐标直接用 getBoundingClientRect 的值
    var layer = null;
    // 当前画出来的标签：{ el, token, line }
    var labels = [];
    var running = false;
    var rafId = null;
    var observers = [];
    var listeners = [];

    function ensureLayer() {
      if (layer && layer.isConnected) return layer;
      layer = doc.getElementById(LAYER_ID);
      if (!layer) {
        layer = doc.createElement("div");
        layer.id = LAYER_ID;
        // 绝不吃事件：否则会挡住歌词点击/滚动
        layer.setAttribute("aria-hidden", "true");
        layer.style.cssText =
          "position:fixed;left:0;top:0;width:0;height:0;overflow:visible;" +
          "pointer-events:none;z-index:2147483000;contain:layout style;";
        doc.body.appendChild(layer);
      }
      var style = doc.getElementById(STYLE_ID);
      if (!style) {
        style = doc.createElement("style");
        style.id = STYLE_ID;
        style.textContent =
          "#" +
          LAYER_ID +
          " .kt-ov-label{" +
          "position:absolute;white-space:nowrap;pointer-events:none;" +
          "font-weight:normal;font-style:normal;letter-spacing:0;line-height:1.1;" +
          "text-align:center;transform:translateX(-50%);" +
          "user-select:none;-webkit-user-select:none;" +
          "}";
        doc.head.appendChild(style);
      }
      return layer;
    }

    /** 该行/区域是否值得处理：可见、且不在被忽略的容器里 */
    function isRenderable(el) {
      if (!el || !el.isConnected) return false;
      for (var p = el; p && p !== doc.body; p = p.parentElement) {
        var s;
        try {
          s = win.getComputedStyle(p);
        } catch (e) {
          continue;
        }
        if (!s || !s.display) continue;
        if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return false;
      }
      return true;
    }

    /** 只处理落在视口附近的行，避免给几百行都建标签 */
    function isNearViewport(rect) {
      var h = win.innerHeight || 800;
      return rect.bottom > -80 && rect.top < h + 80;
    }

    function collectTextNodes(regions) {
      var out = [];
      for (var i = 0; i < regions.length; i++) {
        var r = regions[i];
        if (!r || r.nodeType !== 1 || !isRenderable(r)) continue;
        var walker = doc.createTreeWalker(r, NodeFilter.SHOW_TEXT, {
          acceptNode: function (node) {
            // 跳过别的插件/我们自己的注音文本
            for (var p = node.parentNode; p && p !== r.parentNode; p = p.parentNode) {
              if (!p.tagName) return NodeFilter.FILTER_ACCEPT;
              if (p.tagName === "RT" || p.tagName === "RP") return NodeFilter.FILTER_REJECT;
              var cls = p.className;
              if (typeof cls === "string" && /(^|\s)(fg-rt|kt-rt|kt-ov-label)(\s|$)/.test(cls)) {
                return NodeFilter.FILTER_REJECT;
              }
              if (p.id === LAYER_ID) return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        });
        while (walker.nextNode()) out.push(walker.currentNode);
      }
      return out;
    }

    /** 建一个标签元素 */
    function makeLabel(gloss) {
      var el = doc.createElement("span");
      el.className = "kt-ov-label";
      el.textContent = gloss;
      el.style.fontSize = rtSize + "%";
      el.style.opacity = String(rtOpacity / 100);
      return el;
    }

    /**
     * 重新扫描并画出标签。
     * 返回 { tokens, placed, skipped } 便于排障。
     */
    function render(regions) {
      var list = regions || [];
      var lyr = ensureLayer();
      if (!lyr) return { tokens: 0, placed: 0, skipped: 0 };

      // 先全部撤掉重画。歌词滚动时位置一直在变，增量更新反而容易错位。
      clearLabels();

      var nodes = collectTextNodes(list);
      var tokens = 0;
      var placed = 0;
      var skipped = 0;

      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var text = node.nodeValue;
        if (!text || text.length < 2) continue;
        if (!matcher.hasKatakana(text)) continue;
        var scan = matcher.scan(text);
        if (!scan.length) continue;

        for (var j = 0; j < scan.length; j++) {
          var tk = scan[j];
          if (!matcher.looksTranslatable(tk)) continue;
          var gloss = lookup(tk.norm);
          if (!gloss) continue;
          tokens++;

          var rect;
          try {
            var range = doc.createRange();
            range.setStart(node, tk.start);
            range.setEnd(node, tk.end);
            rect = range.getBoundingClientRect();
          } catch (e) {
            skipped++;
            continue;
          }
          if (!rect || (!rect.width && !rect.height)) {
            skipped++;
            continue;
          }
          if (!isNearViewport(rect)) {
            skipped++;
            continue;
          }

          var label = makeLabel(gloss);
          label.style.left = rect.left + rect.width / 2 + "px";
          // 画在底字上方：top 减去标签自身高度
          label.style.top = rect.top + "px";
          label.style.transform = "translate(-50%, -100%)";
          lyr.appendChild(label);
          labels.push({ el: label, token: tk.text });
          placed++;
        }
      }
      return { tokens: tokens, placed: placed, skipped: skipped };
    }

    function clearLabels() {
      for (var i = 0; i < labels.length; i++) {
        var el = labels[i].el;
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }
      labels.length = 0;
    }

    function start(regionsFn) {
      if (running) return;
      running = true;
      ensureLayer();

      var schedule = function () {
        if (rafId != null || !running) return;
        rafId = (win.requestAnimationFrame || win.setTimeout)(function () {
          rafId = null;
          if (!running) return;
          try {
            render(regionsFn());
          } catch (e) {
            if (options.log) options.log("浮层渲染失败：" + ((e && e.message) || e));
          }
        }, 16);
      };

      // 滚动（捕获阶段，兼容内部滚动容器）、尺寸变化都要重新定位
      var onScroll = function () {
        schedule();
      };
      win.addEventListener("scroll", onScroll, true);
      listeners.push(["scroll", onScroll, true]);
      win.addEventListener("resize", onScroll);
      listeners.push(["resize", onScroll, false]);

      // 歌词 DOM 变化（换行、换歌）也重新定位
      if (typeof win.MutationObserver === "function") {
        var mo = new win.MutationObserver(schedule);
        mo.observe(doc.body, { childList: true, subtree: true, characterData: true });
        observers.push(mo);
      }
      // 周期兜底：逐字动画/transform 滚动不一定触发上面的事件
      var timer = win.setInterval(schedule, 250);
      listeners.push(["interval", timer, false]);

      schedule();
    }

    function stop() {
      running = false;
      if (rafId != null) {
        (win.cancelAnimationFrame || win.clearTimeout)(rafId);
        rafId = null;
      }
      for (var i = 0; i < listeners.length; i++) {
        var l = listeners[i];
        if (l[0] === "interval") win.clearInterval(l[1]);
        else win.removeEventListener(l[0], l[1], l[2]);
      }
      listeners.length = 0;
      for (var j = 0; j < observers.length; j++) observers[j].disconnect();
      observers.length = 0;
      clearLabels();
    }

    function destroy() {
      stop();
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
      layer = null;
      var style = doc.getElementById(STYLE_ID);
      if (style && style.parentNode) style.parentNode.removeChild(style);
    }

    return {
      render: render,
      start: start,
      stop: stop,
      destroy: destroy,
      labelCount: function () {
        return labels.length;
      },
      isRunning: function () {
        return running;
      },
      layerId: LAYER_ID,
    };
  }

  return { createOverlay: createOverlay, LAYER_ID: LAYER_ID };
});
