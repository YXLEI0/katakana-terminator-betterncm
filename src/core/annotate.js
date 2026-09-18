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

    var annotateAll = options.annotateAll !== false; // false = 只标歌词
    // 记录我们改过的文本节点： node -> { host, nodes, plain, region }
    var records = new Map();

    /*
     * host 元素 -> 我们为它处理过的两种「可见原文」：{ plain, annotated }。
     *
     * 为什么需要它：React（以及 RefinedNowPlaying 这类插件）会把整行元素
     * **内部子节点全部换新**，文字却一模一样。此时记录里的文本节点已经作废，
     * 新文本节点没有记录，如果只看 records 就会把它当成"新的一行"重新注音 ——
     * React 一重建我们就注一次，来回触发，永远不收敛。这就是真机轨迹里
     * 「18 行每 250ms 重注一次」的原因。
     *
     * 记两种形态是因为 React 丢节点前后可见文本不同：
     *   annotated = 注音在位时的可见底字（= 原文）
     *   plain     = React 把我们插的节点丢掉后的可见底字（可能只剩前半截）
     * 这两种都说明"这段内容我们已经处理过"，不该再动。
     */
    /*
     * host 元素 -> { text, changes }：这段可见文本最近变了多少次。
     *
     * 用途：真机上歌词行的内容每 250ms 就会被重建/改写（逐字动画、逐行滚动、
     * 别的插件在重排）。这种"一直在动"的元素，我们注进去的注音下一秒就会被
     * 丢掉，追着重注就是抽搐。所以对反复变化的 host 直接放弃，不再碰它 ——
     * 稳定性优先于覆盖率。
     */
    var motionByHost = new WeakMap();
    var MOTION_LIMIT = 3; // 连续变化超过这个次数就判定为"在动"，放弃

    var decidedByHost = new WeakMap();

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

    /*
     * 标题/歌手等「顺带标注」的容器白名单。
     *
     * 这里刻意不用 body —— 早期版本用 body 当区域，结果把侧边栏、搜索框、
     * 歌单名、评论正文全都改了，直接把网易云干到错误页（有运行轨迹为证：
     * 一轮 pass 里 changed=8，命中的全是 BODY 下的各种文字）。
     * 只碰这些语义明确、内容稳定的容器，宁可漏标也不要越界。
     */
    var TARGET_SELECTORS = [
      ".m-playbar .words .name",
      ".m-playbar .words .by",
      '[class*="playbar"] [class*="songName"]',
      '[class*="playbar"] [class*="artist"]',
      '[class*="nowPlaying"] [class*="title"]',
      '[class*="nowPlaying"] [class*="artist"]',
      '[class*="songTitle"]',
      '[class*="songName"]',
      '[class*="artistName"]',
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

      // 有词要标，才动手
      var host = node.parentNode;
      if (!host) return false;

      // 关键：不替换原文本节点，只把它「切短」，注音作为兄弟节点插在中间。
      //
      // 为什么这样做：React 更新纯文本时执行的是 setTextContent(node)，
      // node 是它内部持有的那个文本节点引用。如果这个节点被我们删掉/换成
      // 别的节点，React 的引用就失效了，commit 阶段可能直接抛错，
      // 整个页面会掉进 NMC 的错误页（"应用出错了…重启下试试吧"）。
      // 保留原节点既能满足 React，也不影响我们的注音排版。
      var pieces = [];
      var pos = 0;
      var inserted = [];
      for (var j = 0; j < tokens.length; j++) {
        var tk = tokens[j];
        if (tk.start > pos) pieces.push({ text: text.slice(pos, tk.start) });
        if (!glosses[j]) {
          pieces.push({ text: tk.text });
        } else {
          var ruby = buildRuby(tk.text, glosses[j]);
          pieces.push({ text: tk.text, ruby: ruby });
          inserted.push(ruby);
        }
        pos = tk.end;
      }
      if (pos < text.length) pieces.push({ text: text.slice(pos) });

      if (!inserted.length) return false;

      // 注入方式：尽量保留 React 持有的那个原文本节点，只把它「切短」，
      // 注音和其他段落作为兄弟节点插到它后面。
      //
      // 为什么优先保留原节点：React 更新纯文本时执行 setTextContent(node)，
      // node 是它内部持有的引用。如果这个节点被删掉换成别的节点，React 的引用
      // 就失效了，commit 阶段可能直接抛错，整页掉进 NMC 的错误页
      // （"应用出错了…重启下试试吧"）。保留它既能满足 React，也不影响排版。
      //
      // 例外：文本正好以片假名词开头时，第 0 段本身带注音，不能既留原文又插注音
      // （那样底字会渲染两遍）。这种情况直接移除原节点，注音从第 0 段开始排。
      var leadIsRuby = !!pieces[0].ruby;
      var tail = doc.createDocumentFragment();
      var startIndex = 0;
      if (!leadIsRuby) {
        node.nodeValue = pieces[0].text;
        startIndex = 1;
      } else if (node.parentNode === host) {
        host.removeChild(node);
      }
      // inserted 要记「我们插进去的每一个节点」—— 包括那些纯文本分段。
      // 只记注音的话，还原时这些分段会留在 DOM 里，原文就会重复一遍。
      for (var k = startIndex; k < pieces.length; k++) {
        var piece = pieces[k];
        var childNode = piece.ruby || doc.createTextNode(piece.text);
        tail.appendChild(childNode);
        inserted.push(childNode);
      }
      host.insertBefore(tail, leadIsRuby ? null : node.nextSibling);

      // 记录：原节点是否还留在 host 里（leadIsRuby 时它已被移除）、
      // 注音节点清单，以及它原来插在哪个位置（host 的子节点下标）。
      // 记下标是为了让 kept=false 的形态能原样还原 —— 还原时我们插的节点
      // 会被逐个摘掉，届时再想找"插回哪儿"就已经晚了。
      var index = 0;
      var cn = host.childNodes;
      for (var ci = 0; ci < cn.length; ci++) {
        if (cn[ci] === node) {
          index = ci;
          break;
        }
      }
      records.set(node, {
        host: host,
        nodes: inserted,
        plain: text,
        region: region,
        kept: !leadIsRuby,
        index: index,
      });
      // 记下"这个 host 的这段内容已经注过音了"，两种可见形态都记，
      // 因为 React 丢掉我们插的节点前后，可见底字不一样。
      // reAnnotated 表示这次是「补回来的第二次」，用来止住无限来回。
      var prevDecision = decidedByHost.get(host);
      decidedByHost.set(host, {
        plain: text,
        annotated: visibleText(host),
        reAnnotated: !!(prevDecision && prevDecision.plain === text),
      });

      if (options.log && records.size <= 40) {
        // 记下区域的身份：真机排障时，光看文字分不清是歌词还是标题，
        // 必须能看出命中的是哪些 class。
        options.log(
          "已注音 region=" +
            (region.tagName || "?") +
            "." +
            String(region.className || "").split(" ").slice(0, 2).join(".") +
            " host=" +
            (host.tagName || "?") +
            " 文本=" +
            JSON.stringify(text.slice(0, 30))
        );
      }

      if (!hasRubyLayout(doc) && host.setAttribute && !host.hasAttribute("data-kt-fallback")) {
        host.setAttribute("data-kt-fallback", "1");
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

    /**
     * 还原某条记录。
     *
     * 注入时有两种形态，还原也要分两种情况：
     *   kept=true  —— 原文本节点还在（被切短了），注音插在它后面：
     *                 摘掉注音，把后面残留的纯文本兄弟并回原节点。
     *   kept=false —— 文本以片假名词开头，原节点已被移除、注音取而代之：
     *                 摘掉注音，把原节点（值是完整原文）插回原位置。
     */
    function restoreRecord(node, rec) {
      var host = rec.host;
      var i;

      if (host && host.isConnected && node.parentNode === host) {
        // 原节点还在 host 里（kept=true 的形态），把原文写回去
        node.nodeValue = rec.plain;
      } else if (host && host.isConnected && rec.kept) {
        // kept=true 却找不到原节点：说明 React 把整棵子树重建过了，
        // 原文已经在 DOM 里。这时绝对不能再把我们的旧节点插回去 ——
        // 那会和 React 的新节点并存，同一句话渲染两遍。
        // 只清掉我们插的节点，DOM 让 React 说了算。
        removeInjected(rec);
        records.delete(node);
        untagIfClean(host, rec.region);
        return;
      } else if (host && host.isConnected && !rec.kept) {
        // kept=false（文本以片假名开头，注入时移除了原节点）：
        // 按注入前记下的下标把原节点插回去。
        var ref = host.childNodes[rec.index] || null;
        host.insertBefore(node, ref);
        node.nodeValue = rec.plain;
      } else {
        node.nodeValue = rec.plain;
      }

      removeInjected(rec);
      records.delete(node);
      untagIfClean(host, rec.region);
    }

    /** 我们插进去的注音节点是否还都挂在 DOM 上 */
    function annotationsIntact(rec) {
      for (var i = 0; i < rec.nodes.length; i++) {
        if (!rec.nodes[i].isConnected) return false;
      }
      return rec.nodes.length > 0;
    }

    /** 摘掉我们插进去的所有节点（注音 + 文本分段） */
    function removeInjected(rec) {
      for (var i = 0; i < rec.nodes.length; i++) {
        var n = rec.nodes[i];
        if (n.parentNode) n.parentNode.removeChild(n);
      }
    }

    /** 宿主/区域里已经没有我们的注音了，就把标记摘干净 */
    function untagIfClean(host, region) {
      if (region && region.isConnected && !region.querySelector("ruby.kt-ruby")) {
        untagData(region, "data-kt-region");
      }
      if (host && host.isConnected && !host.querySelector("ruby.kt-ruby")) {
        untagData(host, "data-kt-fallback");
      }
    }

    /**
     * 摘掉我们挂的 data 标记（不回写 className）。
     * 为什么不挂 class：歌词行元素是和别的插件（jp-furigana 等）共用的，
     * 改它的 className 会让对方的渲染检查失效、重建整行，进而把我们的注音
     * 也一起丢掉 —— 两边互相触发就是一直抽搐。data-* 属性不影响 className，
     * 也不会被对方的检查逻辑看在眼里。
     */
    function untagData(el, name) {
      if (el && el.removeAttribute && el.hasAttribute(name)) el.removeAttribute(name);
    }

    /**
     * 区域标记 + 降级标记的收尾。
     * 标记只加在真正含注音的元素上，还原后立刻摘掉 —— 往不属于我们的
     * 元素上留痕迹，既脏又可能被别人读取。
     *
     * 用 data-* 而不是 class：这些元素常常和别的歌词插件共用，改 className
     * 会让对方的渲染检查失效、重建整行，两边互相触发就会一直抽搐。
     */
    function cleanup() {
      var regions = doc.querySelectorAll("[data-kt-region]");
      for (var i = 0; i < regions.length; i++) {
        if (!regions[i].querySelector("ruby.kt-ruby")) untagData(regions[i], "data-kt-region");
      }
      var fallbacks = doc.querySelectorAll("[data-kt-fallback]");
      for (var j = 0; j < fallbacks.length; j++) {
        var el = fallbacks[j];
        if (!el.querySelector("ruby.kt-ruby")) untagData(el, "data-kt-fallback");
      }
    }

    /** 全量还原（禁用插件 / 设置变更时调用） */
    function restoreAll() {
      records.forEach(function (rec, node) {
        restoreRecord(node, rec);
      });
      records.clear();
      // 同时清掉"这段内容处理过"的记忆。
      // 否则用户手动禁用再启用（或改设置触发 rescan）后，插件会认为
      // 「已经处理过、不用再动」，结果就是怎么都不再注音。
      decidedByHost = new WeakMap();
      cleanup();
    }

    /**
     * 记录是否已经作废。
     *
     * 判据只有一条：**宿主不在文档里了**。
     *
     * 不能拿「我们插的节点都不见了」当依据 —— 宿主还在、只是 React 把我们的
     * 注音节点摘掉了，这是最常见的情况，而它恰恰需要重新注音，不是丢弃记录。
     * 早期版本在这里判错，导致被摘掉注音的歌词行再也标不回来
     * （restore 完就把记录删了，同一轮里不会再注一次）。
     */
    function orphaned(rec) {
      return !(rec.host && rec.host.isConnected);
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
        records.delete(dead[i]);
      }
      return dead.length;
    }

    /**
     * 某条记录对应的「可见原文」——把注音（<rt>/.kt-rt）排除掉，只看底字。
     * 用来判断注音是否仍然有效。
     */
    function visibleText(el) {
      var out = "";
      var walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          for (var p = node.parentNode; p && p !== el; p = p.parentNode) {
            if (p.tagName === "RT" || (p.classList && p.classList.contains("kt-rt"))) {
              return NodeFilter.FILTER_REJECT;
            }
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      while (walker.nextNode()) out += walker.currentNode.nodeValue || "";
      return out;
    }

    /**
     * 判断某条记录是不是「馊了」。
     *
     * 只用 isConnected 判断会误伤：网易云（以及 RefinedNowPlaying 这类歌词插件）
     * 几乎每 250ms 就会重建一次歌词行的 DOM，我们插的节点时连时断，于是每轮扫描
     * 都「还原 -> 重新注音」一遍。实测轨迹里就是这个样子：
     *
     *   [pass] regions=50 changed=20 restored=20   ← 每秒重复四次
     *
     * 肉眼看到的就是歌词一直在闪（抽搐）。
     *
     * 所以判断标准换成「可见原文有没有变」：只要底字还是我们注音时那句话，
     * 注音就依然有效，哪怕插进去的节点被 React 换过也无所谓 —— 让它留着，
     * 不要动 DOM，这样才不会闪。
     */
    function isStale(rec, node) {
      var host = rec.host;
      if (!host || !host.isConnected) return true;
      // 只有「保留了原节点」的记录才检查它还在不在；
      // 文本以片假名开头时原节点本来就被移除了，不能拿这个当失效依据
      // （否则每轮都会判定为馊了，变成一直闪）。
      if (rec.kept && node.parentNode !== host) return true;
      var now = visibleText(host);
      if (now !== rec.plain) {
        // 记下失败现场：到底算出什么、原文是什么、DOM 长什么样。
        if (options.log) {
          options.log(
            "失效 plain=" +
              JSON.stringify(rec.plain.slice(0, 50)) +
              " now=" +
              JSON.stringify(now.slice(0, 50)) +
              " kept=" +
              rec.kept +
              " html=" +
              JSON.stringify(String(host.innerHTML || "").slice(0, 160))
          );
        }
        return true;
      }
      return false;
    }

    /**
     * 元素当前是否可见。
     *
     * 为什么必须判：换歌时上一首的歌词容器（以及 RefinedNowPlaying 的淡出副本）
     * 还会在 DOM 里挂一会儿。如果照样给它注音，换歌过程中就会看到
     * 「上一首的歌词」和正在播放的歌词同时出现，而且两个容器来回被 React
     * 重建、我们也来回重注，表现就是一直抽搐。只处理可见的容器即可。
     *
     * 判定从严：只有「明确隐藏」才排除。
     * - 行内 style 的 display:none / visibility:hidden、hidden 属性：一定可信；
     * - getComputedStyle 拿不到有效值时（jsdom 之类）一律当可见，
     *   不能因为环境测不出来就把正常内容漏掉。
     */
    function isVisible(el) {
      if (!el || el.nodeType !== 1) return false;
      for (var p = el; p && p !== doc.body; p = p.parentElement) {
        if (p.hidden === true) return false;
        var inline = p.style;
        if (inline) {
          if (inline.display === "none") return false;
          if (inline.visibility === "hidden" || inline.visibility === "collapse") return false;
        }
        var s;
        try {
          s = getComputedStyle(p);
        } catch (e) {
          continue; // 拿不到样式就当可见
        }
        if (!s || !s.display) continue;
        if (s.display === "none") return false;
        if (s.visibility === "hidden" || s.visibility === "collapse") return false;
      }
      return true;
    }

    /**
     * 按一组选择器收集元素，去掉互相包含的重复项。
     * 选择器写错不会抛异常（用户自定义选择器可能非法）。
     */
    function collectBySelectors(selectors) {
      var regions = [];
      var seen = [];
      for (var i = 0; i < selectors.length; i++) {
        var found;
        try {
          found = doc.querySelectorAll(selectors[i]);
        } catch (e) {
          continue;
        }
        for (var j = 0; j < found.length; j++) {
          var el = found[j];
          if (!el.isConnected) continue;
          if (!isVisible(el)) continue; // 隐藏的副本（换歌残留）不碰
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

    /**
     * 找出要处理的区域。
     *
     *   "lyrics" —— 只找歌词容器
     *   "titles" —— 只找播放栏的歌曲名/歌手（DOM 稳定，默认用它）
     *   "safe"   —— 歌词 + 标题白名单
     *
     * 为什么没有"整页 body"：实测它会把侧边栏/搜索框/歌单名全改了，
     * 直接把应用干崩（见 TARGET_SELECTORS 上面的注释）。宁可少标，不可越界。
     */
    function findRegions(mode) {
      if (!doc || !doc.body) return [];
      if (mode === "titles") return collectBySelectors(TARGET_SELECTORS);
      if (mode === "safe") return collectBySelectors(LYRIC_SELECTORS.concat(TARGET_SELECTORS));
      return collectBySelectors(LYRIC_SELECTORS);
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

      // 只清掉宿主已经脱离文档的记录（那块 DOM 已经没了）
      var restored = dropDetached();

      // 注意判断顺序：传了数组就用传进来的，**哪怕是空数组**。
      // 旧写法 `regions && regions.length ? regions : findRegions(...)`
      // 会把空数组当成"没传"，于是"不标任何区域"反而变成了"扫默认区域"——
      // 设置里关掉播放栏标注后它还在注音，就是这个 bug。
      var list = regions ? regions : findRegions("safe");
      if (!list.length) {
        // 一个区域都没有（例如用户把范围改成"不标"）：
        // 要把已有的注音撤掉，而不是什么都不做 —— 否则关掉开关后
        // 页面上还留着之前注的音，看起来像"关不掉"。
        if (records.size) {
          var removed = records.size;
          restoreAll();
          return { scanned: 0, changed: 0, restored: removed, skipped: 0, unstable: 0 };
        }
        return { scanned: 0, changed: 0, restored: restored };
      }

      // 先收集一遍待检查的文本节点。
      // 注意：还原（restoreRecord）会改变 host 的子节点结构，但那些文本节点
      // 本身还是原来那些对象——原节点、我们插入的文本分段都还是同一批。
      // 所以这里先收集、循环里再读 node.nodeValue 是安全的；
      // 反过来先在循环内收集就会漏掉「刚被还原成原文」的节点
      // （快照拍在还原之前，拿到的是"今日は"这种被切短的半截文本，
      // 于是那一行永远标不回来）。
      var candidates = collectTextNodes(list);

      var changed = 0;
      var skipped = 0;
      var unstable = 0;
      for (var i = 0; i < candidates.length; i++) {
        var node = candidates[i];
        // 所属区域：可能是被包含的子区域，取文档顺序里第一个包含它的
        var region = list[0];
        for (var ri = 0; ri < list.length; ri++) {
          if (list[ri].contains(node)) {
            region = list[ri];
            break;
          }
        }
        if (!region.isConnected || !isVisible(region)) continue;

        // 这个 host 我们注过音。判断当前这段可见内容属于哪种情况：
        //   annotated —— 我们的注音还在，内容也没变 -> 什么都不用做
        //   plain     —— React 把我们插的节点丢掉了，文字没变 -> 补一次（只补一次）
        //   其它      —— 文字真的变了 -> 丢掉旧记录，重新注音
        var hostEl = node.parentNode;
        var visibleNow = hostEl ? visibleText(hostEl) : "";

        // 这个 host 的可见文本是不是一直在变？一直在变就放弃它，
        // 别再追着重注 —— 追就是抽搐。
        if (hostEl) {
          var motion = motionByHost.get(hostEl);
          if (!motion) {
            // 第一次见：只登记，不算变化（否则我们自己注音造成的可见文本变化
            // 会被记成"在动"，把正常的行也放弃掉）
            motion = { text: visibleNow, changes: 0 };
            motionByHost.set(hostEl, motion);
          } else if (motion.text !== visibleNow) {
            motion.text = visibleNow;
            motion.changes++;
          }
          if (motion.changes >= MOTION_LIMIT) {
            unstable++;
            continue;
          }
        }

        var prior = hostEl ? decidedByHost.get(hostEl) : null;
        if (prior) {
          if (prior.annotated === visibleNow) {
            skipped++;
            continue; // 注音在位且内容没变，一个字节都不动
          }
          if (prior.plain === visibleNow) {
            // React 丢掉了我们的节点。补一次；但如果补过还是被丢，
            // 就不再补了 —— 那说明补注音这个动作本身会触发对方重建，
            // 再补就是无限来回（真机上 18 行每 250ms 一次就是这么来的）。
            if (prior.reAnnotated) {
              skipped++;
              continue;
            }
          }
        }

        // 已经注过音的行：只有确认失效了才动它。
        var rec = records.get(node);
        if (rec) {
          if (!isStale(rec, node)) continue; // 依然有效，一个字节都不动
          // 失效了。但要注意：如果 React 已经把我们的节点丢掉/重建，
          // 那 DOM 里已经没有我们的痕迹了，这时**不需要还原** ——
          // 「还原」本身是一连串 DOM 变更（摘节点 + 写回文本），
          // 在真机上就是可见的一闪。直接丢掉记录、往下重新注音即可。
          if (annotationsIntact(rec)) {
            restoreRecord(node, rec);
            restored++;
          } else {
            records.delete(node);
          }
        }

        // 每次重新读值：上面可能刚把原文写回来
        var text = node.nodeValue || "";
        if (text.length < 2) continue;
        if (RE_CREDIT.test(text)) continue; // 制作信息行跳过
        try {
          if (annotateNode(node, region)) {
            changed++;
            // 只在真的注了音之后才打区域标记。
            // 用 data-* 属性而不是 class：区域元素常和别的歌词插件共用，
            // 改它的 className 会让对方判定"这行变了"并重建整行，
            // 我们的注音跟着被丢掉、下一轮再标 —— 来回就是抽搐。
            if (region.setAttribute && !region.hasAttribute("data-kt-region")) {
              region.setAttribute("data-kt-region", "1");
              // 记录改了哪个元素：同一行反复出现在这里就说明没收敛
              if (options.log) {
                options.log(
                  "标记区域 " +
                    (region.tagName || "?") +
                    "." +
                    String(region.className || "").split(" ").slice(0, 2).join(".") +
                    " 文本=" +
                    JSON.stringify(String(region.textContent || "").slice(0, 24))
                );
              }
            }
          }
        } catch (e) {
          // 单个节点失败不影响其它节点；把现场记下来便于定位
          if (options.log) {
            options.log(
              "注音失败 tag=" +
                (region.tagName || "?") +
                " cls=" +
                String(region.className || "").slice(0, 60) +
                " err=" +
                ((e && e.message) || e)
            );
          }
        }
      }
      return {
        scanned: list.length,
        changed: changed,
        restored: restored,
        skipped: skipped,
        unstable: unstable,
      };
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
      '[data-kt-fallback] { position: relative; }',
      '[data-kt-fallback] > ruby.kt-ruby { position: relative; display: inline-block; }',
      '[data-kt-fallback] > ruby.kt-ruby > .kt-rt {',
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
      focus ? "[data-kt-region] { outline: 1px dashed rgba(255,80,80,.5); }" : "",
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
