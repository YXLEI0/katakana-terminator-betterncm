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

    /*
     * 只处理「不含汉字」的行，把含汉字的行让给振假名插件（jp-furigana）。
     *
     * 为什么要让：jp-furigana 会把整行内容换成自己的 wrap，并用
     * `h.childNodes.length !== 1` 判断"这行有没有被外人动过"。我往它管的行里
     * 插节点，它就判定行脏、还原、重建整行，我的注音随之被抹掉，来回就是抽搐。
     * 而它的判据里有一条 `if (!hasKanji(text)) { line.__fgHosts = []; return; }`
     * —— **纯假名行它压根不管**。所以按"含不含汉字"分工，两边永远不碰同一个元素。
     */
    // 默认不跳过：这是为「与振假名插件共存」准备的可选项，
    // 由上层在"直接写进歌词行"时打开。默认打开会让含汉字的歌词行全都不标，
    // 那是行为变更，不该由底层模块擅自决定。
    var skipKanjiLinesOption = options.skipKanjiLines != null ? options.skipKanjiLines : false;
    /** 每次扫描时重新求值：设置可能随时变，所以允许传函数 */
    function shouldSkipKanjiLines() {
      return typeof skipKanjiLinesOption === "function" ? !!skipKanjiLinesOption() : !!skipKanjiLinesOption;
    }

    // 装了共存补丁时，含汉字的歌词行也可以标（两种注音同一行）。
    // 默认 false：没打补丁的 jp-furigana 会重建整行，硬标只会互相打架。
    // 和 skipKanjiLines 一样允许传函数：这是设置页里的开关，改完必须立刻生效，
    // 而 annotator 只在初始化时创建一次，所以不能在这里把值抄下来。
    var coexistOption = options.coexistWithFurigana;
    function coexistWithFurigana() {
      return typeof coexistOption === "function" ? !!coexistOption() : coexistOption === true;
    }
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

    /*
     * 自动避让：认输，别再跟一个"无条件重建这一行"的插件对打。
     *
     * 背景（真机轨迹）：jp-furigana 的共存补丁一旦失效（例如它自己升级，
     * .plugin 被换掉，补丁没了），它会把我们引起的每一次 DOM 变更都当成
     * "行被外人改过"，于是它重建、我们重注、它再重建 —— 轨迹里
     * `[pass] changed=18 restored=18` 每秒重复，肉眼就是一直抽搐。
     *
     * 这种循环我们永远追不上，唯一有用的动作是**松手**。判据是：
     * 「可见文本一个字都没变，我们却反复判定注音失效」——正常的换行是文本变了，
     * 不算；正常的一秒一行也不会触发。只有对方在无条件重建才会出现这个特征。
     *
     * 键用**文本**而不是元素：对方每次重建都换一个新元素（wrap 是新建的 span），
     * 按元素记永远归不了零，按文本才能跨重建累计。
     *
     * 认输不是永久的：退避时间按 4 倍递增（15s → 1min → 4min → 封顶 10min），
     * 每轮只闪一下就退回去。这样对方修好（补丁打上）之后会自动恢复，
     * 而不需要我们重启插件。
     */
    var churnByText = new Map(); // 文本 -> { count, since, strikes }
    var churnUntil = new Map(); // 文本 -> 退避截止时间戳
    /*
     * 窗口 1.5s、阈值 3 次 —— 这两个数是拿真机轨迹对出来的，别随手改小。
     *
     * 真机反例（2.0.2 的「4s 内 2 次」误伤了它）：
     *   16:36:09 已注音 文本="ジオラマに"          ← 这行刚变成当前行，注上
     *   16:36:10 已注音 文本="ジオラマに"          ← 被重绘掉，补一次
     *   16:36:10 churn 放弃这一行 60s             ← 才两轮就认输，行首 60s 没注音
     * 这只是"歌词行切换时被重绘两次"，属于正常，重绘完就稳定了，不该放弃。
     *
     * 真正的死循环长这样（1.2.3 之前的实测轨迹）：3 秒里重建 5 轮，
     * 也就是 1.5s 窗口里稳定有 3 轮以上 —— 所以窗口收到 1.5s、阈值提到 3，
     * 既能跳过"正常的两次重绘"，又能抓住死循环。
     */
    var CHURN_WINDOW_MS = 1500; // 计数窗口
    var CHURN_LIMIT = 3; // 窗口内超过这个次数才认输
    /*
     * 首次退避 2s，之后按 4 倍递增（2s → 8s → 32s → 2min → 10min 封顶）。
     *
     * 为什么不直接给 60s：真机上持续重写的只是**正在唱的那一两秒**
     * （逐字动画在改写"当前字"所在的那个片段），唱完就不动了。退避给 60s 会
     * 整段错过窗口，用户看到的就是"这一句的行首一直没注音"——实测事故：
     *   :41:38 已注音 文本="ジオラマに"
     *   :41:39 已注音 文本="ジオラマに"     ← 被逐字动画抹掉，补一次
     *   :41:40 churn 放弃 60s 文本="ジオラマに"
     *   :42:40 已注音 文本="ジオラマに"     ← 整整 60s 里那一行首都没有注音
     * 短退避 + 递增：唱完那一瞬间的重试就能把注音稳稳补上；对方还在动的话，
     * 下一次退避翻 4 倍，也不会退化成"一直闪"。
     */
    var CHURN_BASE_MS = typeof options.churnBaseMs === "number" ? options.churnBaseMs : 2000;
    var CHURN_MAX_MS = 600000; // 退避上限
    var CHURN_MAX_ENTRIES = 200; // 兜底：别让 Map 无限长

    function churnPrune() {
      if (churnByText.size <= CHURN_MAX_ENTRIES && churnUntil.size <= CHURN_MAX_ENTRIES) return;
      var now = Date.now();
      churnUntil.forEach(function (until, k) {
        if (now >= until) churnUntil.delete(k);
      });
      var over = churnByText.size - CHURN_MAX_ENTRIES;
      if (over > 0) {
        var it = churnByText.keys();
        for (var i = 0; i < over; i++) {
          var k2 = it.next();
          if (k2.done) break;
          churnByText.delete(k2.value);
        }
      }
    }

    /** 这段文本是不是正在"认输期"，这一轮别碰它 */
    function churnSuppressed(text) {
      if (!text) return false;
      var until = churnUntil.get(text);
      if (until == null) return false;
      if (Date.now() < until) return true;
      churnUntil.delete(text); // 退避结束，再试一次
      return false;
    }

    /** 记一次"文本没变但注音失效"；到达阈值就进入退避 */
    function noteChurn(text, where) {
      if (!text) return;
      var now = Date.now();
      var c = churnByText.get(text);
      if (!c || now - c.since > CHURN_WINDOW_MS) c = { count: 0, since: now, strikes: (c && c.strikes) || 0 };
      c.count++;
      /*
       * 第一次遇到这个片段，给 CHURN_LIMIT 次机会（正常行切换会被重绘一两次，
       * 不能一上来就放弃）；但已经判定过它爱打架之后，每次重试只试 1 轮 ——
       * 退避很短（2s 起），重试会比较频繁，每次多试一轮就多闪一次。
       */
      var limit = c.strikes > 0 ? 1 : CHURN_LIMIT;
      if (c.count < limit) {
        churnByText.set(text, c);
        return;
      }
      c.strikes++;
      /*
       * 退避策略：第一次认输只退 2s（给对方"其实只是正在唱那一两秒"的机会，
       * 唱完补上就稳了）；**第二次起直接顶到上限 10 分钟**。
       *
       * 为什么不继续按 4 倍递增（2s→8s→32s→2min→10min）：那样每次重试都会让
       * 那个片段再闪一下，用户看到的是"隔几秒闪一下、隔几秒闪一下"——
       * 真机反馈正是"只有ジオラマ在闪，其他正常"。一次机会足够区分两种情况：
       * 真能稳的，2s 后就稳了；稳不了的，再试也没用，索性长时间让开。
       */
      var wait = c.strikes === 1 ? CHURN_BASE_MS : CHURN_MAX_MS;
      churnUntil.set(text, now + wait);
      /*
       * 注意：这里**不能**把记录删掉。strikes 必须跨退避留着，否则下次
       * 重新计数时它又从 0 开始 —— 于是"已经判过它爱打架"永远不成立、
       * 退避也永远停在第 1 档（2.0.5 的实际 bug：每 2s 就再闪一下）。
       * 只把窗口计数清零，保留 strikes。
       */
      churnByText.set(text, { count: 0, since: now, strikes: c.strikes });
      if (options.log) {
        options.log(
          "churn 放弃这一行 " +
            Math.round(wait / 1000) +
            "s（注音反复被重建掉" +
            (where ? "，宿主 " + where : "") +
            "）文本=" +
            JSON.stringify(String(text).slice(0, 40)) +
            " " +
            describePeer(churnProbe)
        );
      }
      churnPrune();
    }

    // noteChurn 调用时传给 describePeer 的探针元素（宿主还在手上，能顺着往上找到行）
    var churnProbe = null;

    /**
     * 诊断用：把 jp-furigana **自己**的状态读出来，看它为什么会重建这一行。
     *
     * 只读别人的 expando，不改任何东西。要回答的是它 isClean() 里那几条判据
     * 到底哪条不成立 —— 光看我们自己的轨迹猜不出来：
     *   dirty     它自己标脏了（有 DOM 变更被它当成"行被外人改过"）
     *   无wrap    有宿主没挂着它的 wrap（那它会重建）
     *   ktOwn     按它的口径数"属于自己的子节点"，正常应该恰好是 1
     *   原文一致  hostsText(line) === line.__fgText —— 这条最容易被我们的
     *             <ruby> 污染：它求和用的是 host.__fgOrig 的 textContent，
     *             我们的 rt 文字会被算进去，于是这一行永远"不干净"、永远重建
     */
    function describePeer(el) {
      try {
        var line = el;
        while (line && line.__fgText == null && line.parentElement) line = line.parentElement;
        if (!line || line.__fgText == null) return "peer=无标记";
        var hosts = line.__fgHosts || [];
        var noWrap = 0;
        var orig = "";
        for (var i = 0; i < hosts.length; i++) {
          var h = hosts[i];
          if (!h.isConnected || !h.__fgWrap || h.__fgWrap.parentNode !== h) noWrap++;
          var o = h.__fgOrig || [];
          for (var j = 0; j < o.length; j++) orig += o[j].textContent || "";
        }
        var fg = String(line.__fgText == null ? "" : line.__fgText);
        var same = orig === fg;
        return (
          "peer{dirty=" +
          !!line.__fgDirty +
          " hosts=" +
          hosts.length +
          " 无wrap=" +
          noWrap +
          " mirrors=" +
          ((line.__fgMirrors || []).length) +
          " ktOwn=" +
          (hosts.length ? ownChildCountLikePeer(hosts[0]) : "-") +
          " 原文一致=" +
          same +
          (same ? "" : " orig=" + JSON.stringify(orig.slice(0, 24)) + " fgText=" + JSON.stringify(fg.slice(0, 24))) +
          "}"
        );
      } catch (e) {
        return "peer=err:" + ((e && e.message) || e);
      }
    }

    /** 按 jp-furigana 打补丁后的口径数"属于它的"子节点（正常恰好 1 个 wrap） */
    function ownChildCountLikePeer(h) {
      var n = 0;
      for (var i = 0; i < h.childNodes.length; i++) {
        var c = h.childNodes[i];
        if (c.nodeType === 1) {
          var cls = typeof c.className === "string" ? c.className : "";
          if (/(^|\s)(kt-ruby|kt-rt|kt-ov-label)(\s|$)/.test(cls)) continue;
          if (c.tagName === "RT" && c.parentNode) {
            var pc = typeof c.parentNode.className === "string" ? c.parentNode.className : "";
            if (/(^|\s)kt-ruby(\s|$)/.test(pc)) continue;
          }
        }
        n++;
      }
      return n;
    }

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

      // 原节点在 host 里的下标。必须在动 DOM 之前算好：leadIsRuby 时原节点
      // 会被摘掉，摘完再遍历就找不到它，index 会留在 0，还原时整段原文
      // 会被插到宿主行首（和上面 refNode 是同一类坑）。
      var origIndex = 0;
      for (var ci = 0; ci < host.childNodes.length; ci++) {
        if (host.childNodes[ci] === node) {
          origIndex = ci;
          break;
        }
      }

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
      /*
       * 插入位置必须在动 DOM **之前**取好。
       *
       * leadIsRuby 时下面会把原节点从 host 里摘掉，摘掉之后 `node.nextSibling`
       * 恒为 null，于是 `host.insertBefore(tail, null)` 等价于「挂到 host 末尾」——
       * 以片假名词开头的文本会被整段挪到宿主的结尾。真机上就是：中文/汉字部分
       * 在行首、片假名注音跑到行尾；下一轮还原又把原节点按原下标放回行首，
       * 再注音又挪到行尾，肉眼正是「注音在行首和行尾来回横跳」。
       */
      var refNode = node.nextSibling;
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
        // 给"我们自己造出来的"节点打标记：别的插件（jp-furigana）的
        // MutationObserver 靠它区分"这是片假名终结者插的"从而不把行标脏。
        // 见 tools/patch-jp-furigana.js 的 __ktRecordIsOurs。
        if (childNode.nodeType === 3) childNode.__ktOwned = true;
        tail.appendChild(childNode);
        inserted.push(childNode);
      }
      host.insertBefore(tail, refNode);
      // 原文本节点（保留下来那条）的值也被我们改写过，同样算我们的
      if (!leadIsRuby) node.__ktOwned = true;

      // 记录：原节点是否还留在 host 里（leadIsRuby 时它已被移除）、
      // 注音节点清单，以及它原来插在哪个位置（host 的子节点下标）。
      // 记下标是为了让 kept=false 的形态能原样还原 —— 还原时我们插的节点
      // 会被逐个摘掉，届时再想找"插回哪儿"就已经晚了。
      // 数值同样要在动 DOM 之前算：原节点摘掉之后遍历就再也找不到它，
      // index 会留在 0，还原时把整段原文插到宿主行首。
      records.set(node, {
        host: host,
        nodes: inserted,
        plain: text,
        region: region,
        kept: !leadIsRuby,
        index: origIndex,
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
        // 记下区域和宿主的身份。真机排障时最关键的就是这个 host：
        // 它是 jp-furigana 的 wrap（fg-line）、RNP 的逐字 span（rnp-*），
        // 还是整行 div —— 决定了我们的注音会不会被对方重建掉。
        options.log(
          "已注音 region=" + idOf(region) + " host=" + idOf(host) + " 文本=" + JSON.stringify(text.slice(0, 30))
        );
      }

      /*
       * 消费 jp-furigana 的「暂存」交接（见 tools/patch-jp-furigana.js）。
       *
       * 它 restore() 时会把我们上一轮插进它 wrap 里的注音节点挂到 host.__ktForeign。
       * 这些节点**只取走、不再挂回去**，两个原因：
       *
       *   1. 位置信息已经没了。它们属于一个刚被拆掉的 wrap，原来的邻居节点
       *      大多已经不在了。以前这里是 `host.insertBefore(fnode, node.nextSibling)`，
       *      而 node 是"这一轮碰巧处理到的文本节点"—— 行首片假名的注音会被挂到
       *      行尾去，肉眼就是注音在行首/行尾来回横跳。
       *   2. 不需要它们。那一段的原文一定还在 host.__fgOrig 里（wrap 之前的内容），
       *      restore() 已经把它放回 DOM 了；而且下面紧接着就是正常注音流程，
       *      会按当前 DOM 重新标一遍，位置自然是对的。挂回去只会多出一个重复注音。
       *
       * 清空是为了别把已经脱离文档的节点一直挂在 expando 上。
       */
      if (host.__ktForeign) host.__ktForeign = null;

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

    /**
     * 这个区域是不是「歌词行」。
     * 只有歌词行才需要按"含不含汉字"和振假名插件分工 ——
     * 播放栏的歌曲名/歌手它根本不管，含汉字也照标。
     *
     * 判据：祖先里出现歌词相关的 class（lyric / line / rnp-）；
     * 但玩家栏（playbar）本身带 "line"？不会——所以额外排除播放栏那几类，
     * 免得把歌曲名误判成歌词行。
     */
    function isLyricRegion(el) {
      for (var p = el; p && p !== doc.body; p = p.parentElement) {
        var cn = typeof p.className === "string" ? p.className : "";
        if (/playbar|nowplaying|now-playing|player-bar/i.test(cn)) return false;
        if (/\bline\b|lyric|rnp-/.test(cn)) return true;
      }
      return false;
    }

    /**
     * 这行「看得见的原文」里有没有汉字。
     *
     * 不能直接用 textContent：振假名插件插的 <rt> 文字也算 textContent，
     * 那会让纯片假名行被误判成"含汉字"，于是该我们管的行反而被让出去。
     * 所以照 jp-furigana 的口径剔除 RT/RP 再判断。
     */
    function lineHasKanji(lineEl) {
      var out = "";
      var walker = doc.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          for (var p = node.parentNode; p && p !== lineEl; p = p.parentNode) {
            if (p.tagName === "RT" || p.tagName === "RP") return NodeFilter.FILTER_REJECT;
            var c = typeof p.className === "string" ? p.className : "";
            if (/(^|\s)(fg-rt|kt-rt|kt-ov-label)(\s|$)/.test(c)) return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      while (walker.nextNode()) out += walker.currentNode.nodeValue || "";
      return matcher.hasKanji(out);
    }

    /**
     * 这一行是不是「被振假名插件（jp-furigana）接管了」。
     *
     * 判据用它的标记：fg-line / fg-ruby / data-fg-* / __fgWrap。
     * 打了共存补丁之后，它会容忍我们插进它 wrap 的节点、不再重建整行，
     * 这时两种注音可以同处一行 —— 见 docs/jp-furigana-coexist.patch。
     */
    function isFuriganaManaged(el) {
      for (var p = el; p && p !== doc.body; p = p.parentElement) {
        var cn = typeof p.className === "string" ? p.className : "";
        if (/fg-line|fg-ruby|fg-word/.test(cn)) return true;
        if (p.__fgWrap || p.__fgText != null) return true;
      }
      return false;
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
        // 宿主整个被摘掉 = 我们刚注的那段文字连同容器一起被对方丢弃了。
        // 真机轨迹里 restored 全部来自这里（一条"失效[...]"都没有），
        // 说明闪烁的形态就是"宿主被反复删掉重建"，而不是判定逻辑出错。
        churnProbe = rec.host;
        noteChurn(rec.plain, idOf(rec.host));
        churnProbe = null;
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
      if (!host || !host.isConnected) {
        logStale(rec, "宿主脱链");
        return true;
      }
      // 只有「保留了原节点」的记录才检查它还在不在；
      // 文本以片假名开头时原节点本来就被移除了，不能拿这个当失效依据
      // （否则每轮都会判定为馊了，变成一直闪）。
      if (rec.kept && node.parentNode !== host) {
        logStale(rec, "原文本节点被摘走");
        return true;
      }
      var now = visibleText(host);
      if (now !== rec.plain) {
        // 记下失败现场：到底算出什么、原文是什么、DOM 长什么样。
        logStale(rec, "可见文本变了", now);
        return true;
      }
      return false;
    }

    /** 诊断用：把「为什么判定失效」写进轨迹（只在给了 log 时） */
    function logStale(rec, why, now) {
      if (!options.log) return;
      options.log(
        "失效[" +
          why +
          "] plain=" +
          JSON.stringify(String(rec.plain == null ? "" : rec.plain).slice(0, 40)) +
          " now=" +
          JSON.stringify(String(now == null ? "" : now).slice(0, 40)) +
          " kept=" +
          !!rec.kept
      );
    }

    /**
     * 元素的简短身份（tag + 前两个 class），写进轨迹用。
     *
     * 排障时最要紧的就是**宿主到底是谁**：jp-furigana 的 wrap（fg-line）、
     * RNP 的逐字 span（rnp-karaoke-word）、还是整行 div —— 我们的注音
     * 稳不稳，全看这个宿主会不会被对方重建。
     */
    function idOf(el) {
      if (!el || el.nodeType !== 1) return "?";
      var c = String(el.className || "")
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .join(".");
      return (el.tagName || "?") + (c ? "." + c : "");
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
      var kanjiSkipped = 0;
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

        // 按「行」分工：含汉字的**歌词行**整个让给振假名插件（见 skipKanjiLines 说明）。
        // 只对歌词行生效 —— 播放栏的歌曲名/歌手它不管，含汉字也要照标。
        // 必须在行级别判断并尽早 continue：只跳过半个行，会让这一行其余部分
        // 仍被我们改写，等于又去碰别人管的元素。
        if (shouldSkipKanjiLines() && isLyricRegion(region)) {
          var lineEl = node.parentNode;
          for (var up = 0; up < 4 && lineEl && lineEl !== doc.body; up++) {
            var cn = typeof lineEl.className === "string" ? lineEl.className : "";
            if (lineEl.tagName === "LI" || /\bline\b|lyric-line/.test(cn)) break;
            lineEl = lineEl.parentNode;
          }
          // 例外：装了共存补丁的 jp-furigana 能容忍我们，含汉字的行也照标。
          // 判据是它自己的标记；没打补丁时遇到它管的行仍然让开（否则互相重建）。
          if (
            lineEl &&
            lineEl.nodeType === 1 &&
            lineHasKanji(lineEl) &&
            !(coexistWithFurigana() && isFuriganaManaged(lineEl))
          ) {
            kanjiSkipped++;
            continue;
          }
        }

        // 这个 host 我们注过音。判断当前这段可见内容属于哪种情况：
        //   annotated —— 我们的注音还在，内容也没变 -> 什么都不用做
        //   plain     —— React 把我们插的节点丢掉了，文字没变 -> 补一次（只补一次）
        //   其它      —— 文字真的变了 -> 丢掉旧记录，重新注音
        var hostEl = node.parentNode;
        var visibleNow = hostEl ? visibleText(hostEl) : "";

        // 这一行已经被判定为"跟我们打架"：认输期内不再碰它。
        // 认输的判据是「同一段文字被我们注了又失效、反复好几次」——
        // 键必须用**文字**：对方每次重建都新建一个 <span> 当宿主
        // （我们的 rec.host 就是它那个 wrap），按元素记永远归不了零。
        if (churnSuppressed(node.nodeValue || "")) {
          unstable++;
          continue;
        }

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
          // 文本一模一样却判定失效 —— 这是"对方在无条件重建这一行"的特征。
          // 注意要在 restore / 删记录**之前**判断：restoreRecord 会把原文写回去，
          // 之后就分不清到底是"文本变了"还是"文本没变"了。
          if (rec.plain != null) {
            churnProbe = rec.host;
            noteChurn(rec.plain, idOf(rec.host));
            churnProbe = null;
          }
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
        kanjiSkipped: kanjiSkipped,
      };
    }

    function injectedCount() {
      return records.size;
    }

    /** 当前处于"认输期"的行数 —— 这些行是**故意**不注音的，不是漏了 */
    function churnedCount() {
      return churnUntil.size;
    }

    return {
      pass: pass,
      restoreAll: restoreAll,
      findRegions: findRegions,
      customRegions: customRegions,
      injectedCount: injectedCount,
      churnedCount: churnedCount,
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
