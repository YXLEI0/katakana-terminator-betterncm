/*
 * Katakana Terminator for BetterNCM —— 注音注入与还原
 *
 * 职责：在指定区域里找到片假名词，给它们套上 <ruby>词<rt>english</rt></ruby>。
 *
 * 设计取舍（都是踩过的坑）：
 *
 *  1. 不动「行」的 DOM，只动「文本节点」。
 *     jp-furigana 是整行重写（把自己的 span 塞进去替代整行内容），因为振假名要按
 *     分词重新切整行。片假名注音不需要：逐个文本节点替换即可，React 重建时
 *     要还原的东西也少得多（只有我们插的那几个节点）。
 *
 *  2. 还原靠 isConnected，不靠"文本内容相等"。
 *     React 重渲染时会换掉整个元素；我们插进去的节点随之脱离文档。
 *     所以判断「原文是否回来」只需要看我们插的节点还连不连着。这也顺带解决了
 *     jp-furigana 注释里提到的麻烦（React 会去改已脱离文档的旧文本节点，
 *     MutationObserver 不会触发，只能靠内容比对兜底）。
 *
 *  3. 内核不支持 ruby 排版时降级。
 *     NCM 用的是 CEF，某些版本里 <rt> 会退化成 block，把行高撑坏。
 *     这里沿用 jp-furigana 的实测探针（不能用 CSS.supports('display','ruby')，
 *     那玩意儿对新版内核恒返回 false），不支持时用绝对定位的 span。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KTAnnotate = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 同 translate.js：factory 里没有 UMD 壳的 root，统一用 globalThis
  var G = typeof globalThis !== "undefined" ? globalThis : {};

  var matcher = G.KTMatcher || (typeof require === "function" && safeRequire("./matcher.js"));
  function safeRequire(p) {
    try {
      return require(p);
    } catch (e) {
      return null;
    }
  }

  if (!matcher) {
    // 没有匹配器就什么都做不了；返回一个空壳，让上层能优雅降级
    return { createAnnotator: function () { throw new Error("KTMatcher 未加载"); } };
  }

  /** 歌手/制作信息行不标（「作詞: アニメ太郎」这类注了没意义还碍眼） */
  var RE_CREDIT = /^\s*(作[词詞曲編编][:：\s]|Lyric|Music|Arrang|Compos|混音|录音|録音|母带|制作人|Produced|Written|Guitar|Bass|Drum|Piano|Vocal|Mixing|Mastering)/i;

  // ---------------------------------------------------------------- 注入

  var styleCache = null;

  /** 实测内核认不认 ruby 排版（探针只在第一次跑） */
  function hasRubyLayout(doc) {
    // 测试用开关：jsdom 没有布局引擎，量不出宽度，只能打桩
    if (typeof G.__KT_FORCE_RUBY__ === "boolean") return G.__KT_FORCE_RUBY__;
    if (styleCache !== null) return styleCache;
    try {
      if (!doc.body) return true; // 还没到能量的时候，先当支持
      var probe = doc.createElement("div");
      probe.style.cssText =
        "position:absolute;left:-9999px;top:-9999px;width:300px;" +
        "font-size:20px;line-height:1.2;visibility:hidden;";
      probe.innerHTML = '<ruby>\u6f22<rt style="font-size:60%">kanji</rt></ruby>';
      doc.body.appendChild(probe);
      var rt = probe.querySelector("rt");
      var rtWidth = rt ? rt.getBoundingClientRect().width : 0;
      var height = probe.getBoundingClientRect().height;
      probe.remove();
      styleCache = rtWidth > 0 && rtWidth < 150 && height < 20 * 1.2 * 1.9;
      return styleCache;
    } catch (e) {
      return (styleCache = true);
    }
  }

  function createAnnotator(options) {
    options = options || {};
    var doc = options.document || (typeof document !== "undefined" ? document : null);
    var lookup = options.lookup;
    if (typeof lookup !== "function") throw new Error("createAnnotator 需要 lookup(word) 函数");

    var annotateAll = options.annotateAll !== false; // false = 只标歌词区域

    // 记录我们改过的文本节点： node -> { host, nodes, plain, region }
    var records = new Map();

    // 不进去的标签
    var SKIP_TAGS = {
      SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1,
      OPTION: 1, TITLE: 1, HEAD: 1, RUBY: 1, RT: 1, RP: 1, CODE: 1, PRE: 1,
      SVG: 1, CANVAS: 1, IFRAME: 1, VIDEO: 1, AUDIO: 1,
    };

    // 歌词区域选择器（NCM 3.x 实测 + 2.x + 常见第三方歌词插件）
    var LYRIC_SELECTORS = [
      "ul.lyric > li",
      "ul.lyric li p",
      ".lyric-line",
      ".lyric-next-p",
      'div[class^="rnp-lyrics-line"]',
      'div[class^="lyric-bar-inner"] div[class^="rnp-lyrics-line"]',
      'div[class^="lyricMainLine"]',
      'div[class*="lyric-line"]',
    ];

    function isSkippable(el) {
      if (!el || el.nodeType !== 1) return true;
      if (SKIP_TAGS[el.tagName]) return true;
      if (el.isContentEditable) return true;
      if (el.classList && el.classList.contains("kt-ruby")) return true;
      // 我们自己插的注音节点
      if (el.tagName === "RT" || (el.classList && el.classList.contains("kt-rt"))) return true;
      return false;
    }

    /** 收集要处理区域里的所有文本节点（一次 TreeWalker，按文档顺序） */
    function collectTextNodes(regions) {
      var out = [];
      for (var i = 0; i < regions.length; i++) {
        var region = regions[i];
        if (!region || region.nodeType !== 1) continue;
        if (isSkippable(region)) continue;
        var walker = doc.createTreeWalker(region, NodeFilter.SHOW_TEXT, {
          acceptNode: function (node) {
            for (var p = node.parentNode; p && p !== region.parentNode; p = p.parentNode) {
              if (isSkippable(p)) return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        });
        while (walker.nextNode()) out.push(walker.currentNode);
      }
      return out;
    }

    /**
     * 一个文本节点 -> 注入后续节点。返回是否改动。
     * 只处理这个节点自己的 nodeValue，不碰别的节点。
     */
    function annotateNode(node, region) {
      var text = node.nodeValue;
      if (!text || text.length < 2) return false;
      if (!matcher.hasKatakana(text)) return false;

      var tokens = matcher.scan(text);
      if (!tokens.length) return false;

      var glosses = [];
      var any = false;
      for (var i = 0; i < tokens.length; i++) {
        var g = null;
        if (matcher.looksTranslatable(tokens[i])) g = lookup(tokens[i].norm);
        glosses.push(g);
        if (g) any = true;
      }
      if (!any) return false;

      // 有词要标，才建 fragment
      var frag = doc.createDocumentFragment();
      var pos = 0;
      var inserted = [];
      for (var j = 0; j < tokens.length; j++) {
        var tk = tokens[j];
        if (tk.start > pos) frag.appendChild(doc.createTextNode(text.slice(pos, tk.start)));
        if (!glosses[j]) {
          frag.appendChild(doc.createTextNode(tk.text));
        } else {
          var ruby = buildRuby(tk.text, glosses[j]);
          frag.appendChild(ruby);
          inserted.push(ruby);
        }
        pos = tk.end;
      }
      if (pos < text.length) frag.appendChild(doc.createTextNode(text.slice(pos)));

      if (!inserted.length) return false;

      var host = node.parentNode;
      if (!host) return false;

      // 记下注入前 host 的子节点。还原时把这些节点按原顺序整体放回，
      // 就能逐字节回到原样；比"把原节点 insertBefore 到某个锚点前面"这种
      // 按位置猜测的做法可靠（原节点和它后面的尾巴节点常常是相邻的，
      // 按下标逐个 insertBefore 会把自己又挪一遍）。
      var siblings = [];
      for (var ci = 0; ci < host.childNodes.length; ci++) siblings.push(host.childNodes[ci]);
      host.__ktOrig = siblings;

      host.insertBefore(frag, node);
      host.removeChild(node);

      records.set(node, {
        host: host,
        nodes: inserted,
        plain: text,
        region: region,
        // 注入后 host 应有的文本（用于识别 React 原地改内容的情形）
        expected: host.textContent,
      });

      if (!hasRubyLayout(doc) && host.classList && !host.classList.contains("kt-fallback")) {
        host.classList.add("kt-fallback");
      }

      return true;
    }

    /** 建 <ruby>カナ<rt>Kana</rt></ruby>；内核不支持时用 span 绝对定位 */
    function buildRuby(base, gloss) {
      var ruby = doc.createElement("ruby");
      ruby.className = "kt-ruby";
      ruby.appendChild(doc.createTextNode(base));
      if (hasRubyLayout(doc)) {
        var rt = doc.createElement("rt");
        rt.className = "kt-rt";
        rt.textContent = gloss;
        ruby.appendChild(rt);
      } else {
        var span = doc.createElement("span");
        span.className = "kt-rt";
        span.textContent = gloss;
        ruby.appendChild(span);
      }
      return ruby;
    }

    /** 还原某个文本节点：撤掉我们插的节点，把原文本按原顺序放回去 */
    function restoreRecord(node, rec) {
      var host = rec.host;
      var i;
      var siblings = host && host.__ktOrig;
      if (host && host.isConnected && siblings) {
        // 先把 host 清空，再按注入前记下的顺序整体放回。
        // 「清空 + 重放」而不是「逐个 insertBefore」：原节点和它后面的尾巴
        // 文本节点经常是相邻的，按下标插会把自己再挪一次，结果重复。
        while (host.firstChild) host.removeChild(host.firstChild);
        for (i = 0; i < siblings.length; i++) {
          var child = siblings[i];
          if (child === node) {
            node.nodeValue = rec.plain;
            host.appendChild(node);
          } else {
            host.appendChild(child);
          }
        }
      }
      // 把还挂在文档里的注入节点移除（host 被 React 换掉时它们会变成孤儿，
      // 但通常还连在别处，兜一道）
      for (i = 0; i < rec.nodes.length; i++) {
        var n = rec.nodes[i];
        if (n.parentNode) n.parentNode.removeChild(n);
      }
      node.nodeValue = rec.plain;
      records.delete(node);
      // 区域里没有我们的节点了就把标记撤掉
      var region = rec.region;
      if (region && region.isConnected && !region.querySelector("ruby.kt-ruby")) {
        untag(region, "kt-region");
      }
      if (host && host.isConnected && !host.querySelector("ruby.kt-ruby")) {
        untag(host, "kt-fallback");
        host.__ktOrig = null;
      }
    }

    /**
     * 摘掉某个元素上的标记，并把 classList 操作留下的空 class="" 清掉。
     * 直接 classList.remove 只清值、不清属性，innerHTML 里会留下 class=""，
     * 对「还原后与原文逐字节一致」来说是脏的。
     */
    function untag(el, cls) {
      if (!el || !el.classList || !el.classList.contains(cls)) return;
      el.classList.remove(cls);
      if (el.getAttribute("class") === "") el.removeAttribute("class");
    }

    /**
     * 区域标记 + 降级标记的收尾。
     * kt-region 只加在真正含注音的区域上，还原后立刻摘掉 —— 往不属于我们的
     * 元素上挂 class 会留下痕迹，既脏又可能被别人读取。
     */
    function cleanup() {
      var regions = doc.querySelectorAll(".kt-region");
      for (var i = 0; i < regions.length; i++) {
        if (!regions[i].querySelector("ruby.kt-ruby")) untag(regions[i], "kt-region");
      }
      var fallbacks = doc.querySelectorAll(".kt-fallback");
      for (var j = 0; j < fallbacks.length; j++) {
        var el = fallbacks[j];
        if (!el.querySelector("ruby.kt-ruby")) {
          untag(el, "kt-fallback");
          el.__ktOrig = null;
        }
      }
    }

    /** 全量还原（禁用插件 / 设置变更时调用） */
    function restoreAll() {
      records.forEach(function (rec, node) {
        restoreRecord(node, rec);
      });
      records.clear();
      cleanup();
    }

    /**
     * 处理被 React 重建过的记录：原文已经回来，我们插进去的节点成了孤儿。
     * 注意 stillApplied 用 isConnected 判断 —— 元素被整体替换后，我们插的节点
     * 还挂在"那棵被丢弃的子树"里，所以还连在它的宿主上，只是宿主脱离了文档。
     * 这种情况下节点不是马上 isConnected=false，得看宿主还在不在文档里。
     */
    function orphaned(rec) {
      var host = rec.host;
      if (host && !host.isConnected) return true;
      for (var i = 0; i < rec.nodes.length; i++) {
        if (rec.nodes[i].isConnected) return false;
      }
      return true;
    }

    /** 撤掉孤儿记录（连带把丢弃子树里的注入节点摘掉，免得 React 复用时看到过期注音） */
    function dropDetached() {
      var dead = [];
      records.forEach(function (rec, node) {
        if (orphaned(rec)) dead.push(node);
      });
      for (var i = 0; i < dead.length; i++) {
        var rec = records.get(dead[i]);
        for (var j = 0; j < rec.nodes.length; j++) {
          var n = rec.nodes[j];
          if (n.parentNode) n.parentNode.removeChild(n);
        }
        if (rec.host && rec.host.__ktOrig && !rec.host.querySelector("ruby.kt-ruby")) {
          rec.host.__ktOrig = null;
        }
        records.delete(dead[i]);
      }
      return dead.length;
    }

    /**
     * 判断某条记录是不是"馊了"：React 可能原地改掉文本值，
     * 这时我们插的节点还连着（stillApplied 看不出来），但 host 的内容
     * 已经和我们注入前记的不一样了（jp-furigana 里的 hostsText 检查）。
     */
    function isStale(rec) {
      var host = rec.host;
      if (!host || !host.isConnected || !rec.expected) return false;
      return host.textContent !== rec.expected;
    }

    /**
     * 找出要处理的区域。
     *   onlyLyrics=true  -> 只找歌词容器（找不到就返回空数组，交给上层决定回退）
     *   onlyLyrics=false -> 整页 body，歌词自然也包含在内
     *
     * 为什么要分开：之前这里先找歌词、找到就返回，导致「标注全部」这个开关
     * 实际失效 —— 只要页面上有歌词，标题/歌手就永远轮不到。现在由调用方
     * 按用户设置决定要哪一种。
     */
    function findRegions(onlyLyrics) {
      if (!doc || !doc.body) return [];
      if (!onlyLyrics) return [doc.body];

      var regions = [];
      var seen = [];
      for (var i = 0; i < LYRIC_SELECTORS.length; i++) {
        var found;
        try {
          found = doc.querySelectorAll(LYRIC_SELECTORS[i]);
        } catch (e) {
          continue;
        }
        for (var j = 0; j < found.length; j++) {
          var el = found[j];
          if (!el.isConnected) continue;
          // 去掉被别的已选区域包含的元素，避免重复扫
          var covered = false;
          for (var s = 0; s < seen.length; s++) {
            if (seen[s].contains(el)) {
              covered = true;
              break;
            }
          }
          if (covered) continue;
          seen.push(el);
          regions.push(el);
        }
      }
      return regions;
    }

    // 用户传来的 CSS 选择器可能非法，非法时返回空数组而不是抛异常
    function customRegions(selector) {
      try {
        var found = doc.querySelectorAll(selector);
        var out = [];
        for (var i = 0; i < found.length; i++) if (found[i].isConnected) out.push(found[i]);
        return out;
      } catch (e) {
        if (options.log) options.log("选择器无效：" + selector);
        return [];
      }
    }

    /**
     * 跑一遍。
     *   regions 传了 -> 只扫这些区域
     *   没传         -> 按 scope 自己找（annotateAll / scope=lyrics / scope=custom）
     * 返回 { scanned, changed, restored }
     */
    function pass(regions) {
      if (!doc || !doc.body) return { scanned: 0, changed: 0, restored: 0 };

      // 先把 React 已经重建掉的记录清掉
      var restored = dropDetached();

      // 内容被 React 原地改掉的，先还原成原文，再重新处理
      var stale = [];
      records.forEach(function (rec, node) {
        if (isStale(rec)) stale.push(node);
      });
      for (var si = 0; si < stale.length; si++) {
        restoreRecord(stale[si], records.get(stale[si]));
        restored++;
      }

      var list = regions && regions.length ? regions : findRegions(false);
      if (!list.length) return { scanned: 0, changed: 0, restored: restored };

      var changed = 0;
      for (var r = 0; r < list.length; r++) {
        if (!list[r].isConnected) continue;
        var nodes = collectTextNodes([list[r]]);
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          if (records.has(node)) continue; // 已经是注音版了
          // 制作信息行跳过
          if (RE_CREDIT.test(node.nodeValue || "")) continue;
          try {
            if (annotateNode(node, list[r])) {
              changed++;
              // 只在真的注了音之后才打区域标记
              if (list[r].classList && !list[r].classList.contains("kt-region")) {
                list[r].classList.add("kt-region");
              }
            }
          } catch (e) {
            // 单个节点失败不影响其它节点
            if (options.log) options.log("注音失败：", e && e.message);
          }
        }
      }
      return { scanned: list.length, changed: changed, restored: restored };
    }

    function injectedCount() {
      return records.size;
    }

    return {
      pass: pass,
      restoreAll: restoreAll,
      findRegions: findRegions,
      customRegions: customRegions,
      injectedCount: injectedCount,
      cleanup: cleanup,
    };
  }

  // ---------------------------------------------------------------- 样式

  function styles(opts) {
    opts = opts || {};
    var size = opts.rtSize == null ? 60 : opts.rtSize;
    var opacity = (opts.rtOpacity == null ? 80 : opts.rtOpacity) / 100;
    var focus = !!opts.focus;
    return [
      "ruby.kt-ruby {",
      "  ruby-position: over;",
      "  -webkit-ruby-position: before;",
      "  ruby-align: center;",
      "}",
      "rt.kt-rt, .kt-rt {",
      "  font-size: " + size + "%;",
      "  opacity: " + opacity + ";",
      "  font-weight: normal;",
      "  font-style: normal;",
      "  letter-spacing: 0;",
      "  line-height: 1.1;",
      "  text-align: center;",
      "  white-space: nowrap;",
      "  text-transform: none;",
      "  user-select: none;",
      "  -webkit-user-select: none;",
      "}",
      // 内核不支持 ruby 排版：注音脱离文档流，免得 <rt> 退化成 block 撑坏行高
      ".kt-fallback { position: relative; }",
      ".kt-fallback > ruby.kt-ruby { position: relative; display: inline-block; }",
      ".kt-fallback > ruby.kt-ruby > .kt-rt {",
      "  position: absolute;",
      "  left: 50%;",
      "  bottom: 100%;",
      "  transform: translateX(-50%);",
      "  -webkit-transform: translateX(-50%);",
      "  display: block;",
      "  pointer-events: none;",
      "}",
      // 这几条是为了对抗 RefinedNowPlaying 之类的逐字歌词插件：它给嵌套 span 打
      // opacity，嵌套相乘会把注音压得几乎看不见，所以对注音强制不透明。
      "ruby.kt-ruby, rt.kt-rt { opacity: 1 !important; }",
      focus ? ".kt-region { outline: 1px dashed rgba(255,80,80,.5); }" : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  function styleEl(doc, id) {
    var el = doc.getElementById(id);
    if (!el) {
      el = doc.createElement("style");
      el.id = id;
      doc.head.appendChild(el);
    }
    return el;
  }

  function applyStyles(doc, opts) {
    if (!doc || !doc.head) return;
    styleEl(doc, "katakana-terminator-style").textContent = styles(opts);
  }

  function removeStyles(doc) {
    var el = doc && doc.getElementById("katakana-terminator-style");
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  return {
    createAnnotator: createAnnotator,
    styles: styles,
    applyStyles: applyStyles,
    removeStyles: removeStyles,
    hasRubyLayout: hasRubyLayout,
    RE_CREDIT: RE_CREDIT,
  };
});
