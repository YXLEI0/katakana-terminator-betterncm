/*
 * 与 jp-furigana 共存的核心行为。
 *
 * 契约（删除浮层方案后，这几条就是插件对外的承诺）：
 *   1. 含汉字的歌词行默认让给 jp-furigana，我们一个字节都不碰；
 *   2. 纯假名行归我们；
 *   3. 播放栏的歌曲名/歌手我们照标（jp-furigana 不管那里，含汉字也标）；
 *   4. 插进去的节点要打上 __ktOwned / kt-* 标记，便于对方的 observer 识别
 *      （配套补丁见 tools/patch-jp-furigana.js）；
 *   5. 会消费 host.__ktForeign（对方 restore 时摘下的注音）并立刻挂回原位。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { loadCore, forceRubyLayout } = require("./helpers");

const HTML = `<!doctype html><html><head></head><body>
<div class="m-playbar"><div class="words"><span class="name">ギター太郎</span></div></div>
<ul class="lyric">
  <li class="line"><p>取とり戻もどしたい　ヒーローみたいに</p></li>
  <li class="line"><p>ギターとピアノのセッション</p></li>
</ul>
</body></html>`;

function setup(opts) {
  const ctx = loadCore(HTML);
  forceRubyLayout(ctx, true);
  // skipKanjiLines 由上层（main.js）在"直接写进歌词行"时打开；这里模拟那个配置
  const ann = ctx.KTAnnotate.createAnnotator({
    document: ctx.document,
    lookup: (w) => ctx.translator.lookup(w),
    annotateAll: true,
    skipKanjiLines: true,
    coexistWithFurigana: !!(opts && opts.coexist),
  });
  if (opts && opts.peerManages) {
    // 模拟 jp-furigana 已经接管了这一行（它会给行挂 __fgText）
    ctx.document.querySelectorAll("ul.lyric li")[0].__fgText = "取とり戻もどしたい　ヒーローみたいに";
  }
  ann.pass();
  return { ctx, ann, doc: ctx.document };
}

test("对方正在管的含汉字歌词行，整个让给它", () => {
  const { doc } = setup({ peerManages: true });
  const kanjiLine = doc.querySelectorAll("ul.lyric li p")[0];
  assert.strictEqual(kanjiLine.querySelectorAll("ruby.kt-ruby").length, 0, "对方管的行不该被我们改");
  assert.strictEqual(kanjiLine.textContent, "取とり戻もどしたい　ヒーローみたいに", "必须保持原样");
});

test("对方没管的含汉字行要照标 —— 不能因为「有汉字」就整行让开", () => {
  // 真机事故：用户关掉 jp-furigana 之后，默认播放页整页没有注音，
  // RNP 页只有那唯一不含汉字的一行有注音。原因是让位条件写成了
  // `hasKanji && (!coexist || !managed)` —— 共存开关默认是关的，
  // 于是"有汉字"就等于"整行让开"，哪怕对方根本没管这一行。
  const { doc } = setup(); // 没有任何 jp-furigana 标记 = 对方没管
  const kanjiLine = doc.querySelectorAll("ul.lyric li p")[0];
  const pairs = [...kanjiLine.querySelectorAll("ruby.kt-ruby")].map((r) => [
    r.childNodes[0].nodeValue,
    r.querySelector(".kt-rt").textContent,
  ]);
  assert.ok(
    pairs.some((p) => p[0] === "ヒーロー" && p[1] === "hero"),
    "对方没管的行应该有注音：" + JSON.stringify(pairs)
  );
  assert.strictEqual(baseText(kanjiLine), "取とり戻もどしたい　ヒーローみたいに", "底字必须完整");
});

test("纯假名行归我们", () => {
  const { doc } = setup();
  const kataLine = doc.querySelectorAll("ul.lyric li p")[1];
  const pairs = [...kataLine.querySelectorAll("ruby.kt-ruby")].map((r) => [
    r.childNodes[0].nodeValue,
    r.querySelector(".kt-rt").textContent,
  ]);
  assert.ok(
    pairs.some((p) => p[0] === "ギター" && p[1] === "guitar"),
    "纯假名行应该有注音：" + JSON.stringify(pairs)
  );
});

test("播放栏的歌曲名/歌手照标（含汉字也标）", () => {
  const { doc } = setup();
  assert.ok(doc.querySelectorAll(".m-playbar ruby.kt-ruby").length >= 1, "播放栏应该被注音");
});

test("我们插的节点带标记，便于对方的 observer 识别", () => {
  const { doc } = setup();
  const ruby = doc.querySelector("ul.lyric ruby.kt-ruby");
  assert.ok(ruby, "应该有注音");
  assert.ok(ruby.classList.contains("kt-ruby"), "ruby 要有 kt-ruby");
  // 原文本节点（保留下来的那条）要带 __ktOwned，否则对方的 observer 会把行标脏
  const host = ruby.parentNode;
  let owned = false;
  for (const n of host.childNodes) if (n.nodeType === 3 && n.__ktOwned) owned = true;
  assert.ok(owned, "我们改写过/新建的文本节点要带 __ktOwned");
});

test("会消费 host.__ktForeign：清掉暂存，注音由正常流程补回", () => {
  const ctx = loadCore(HTML);
  forceRubyLayout(ctx, true);
  const ann = ctx.KTAnnotate.createAnnotator({
    document: ctx.document,
    lookup: (w) => ctx.translator.lookup(w),
    annotateAll: true,
    skipKanjiLines: true,
  });
  ann.pass();

  const doc = ctx.document;
  const p = doc.querySelectorAll("ul.lyric li p")[1];
  const ruby = p.querySelector("ruby.kt-ruby");
  assert.ok(ruby, "先有注音");

  // 模拟对方的 restore()：把注音摘下暂存到 host.__ktForeign
  const host = ruby.parentNode;
  p.removeChild(ruby);
  host.__ktForeign = [ruby];

  // 我们再跑一轮：暂存必须被清掉，注音由正常注音流程重新标出来
  // （不能把旧节点挂回去 —— 它的位置信息已经丢了，见 annotate.js 里的说明）
  ann.restoreAll();
  ann.pass();
  assert.strictEqual(host.__ktForeign, null, "暂存要被清空，避免越积越多");
  assert.ok(p.querySelectorAll("ruby.kt-ruby").length >= 1, "注音要补回来");
});

test("重复扫描稳定，不会反复重注", () => {
  const { ann } = setup();
  for (let i = 0; i < 3; i++) {
    const r = ann.pass();
    assert.strictEqual(r.changed, 0, `第 ${i + 2} 轮不该改`);
    assert.strictEqual(r.restored, 0, `第 ${i + 2} 轮不该还原`);
  }
});

/*
 * 第三个插件：latin-katakana（拉丁字母片假名注音，拉丁词 -> 片假名读音）。
 *
 * 它注出来的读音**恰恰是片假名** —— 正是本插件的翻译对象。所以那一层必须像
 * 别的注音一样被整棵排除，否则我们会跑到对方的注音节点里面再注一层
 * （"ライト" 上面再挂一个 "light"），而且每轮都认为底字变了。
 */
function checkPeerAnnotation(peerUsesRuby) {
  /*
   * 对方注音节点里放的是「ギター」—— 一个**本插件一定能翻译**的片假名词。
   * 这一点是刻意的：如果放一个字典里没有的词（比如 ライト），
   * 就算我们真的走进了对方的注音节点也注不出东西，测试会假过。
   * 行里的另一个词用 ピアノ，用来确认这一行我们确实处理了。
   */
  const PEER_HTML = `<!doctype html><html><head></head><body>
<ul class="lyric">
  <li class="line"><p>きらめく と ピアノ</p></li>
</ul>
</body></html>`;
  const ctx = loadCore(PEER_HTML);
  forceRubyLayout(ctx, true);
  const ann = annotator(ctx);
  const p = ctx.document.querySelector("ul.lyric li p");
  const wrap = ctx.document.createElement(peerUsesRuby ? "ruby" : "span");
  wrap.className = "lt-ruby";
  wrap.appendChild(ctx.document.createTextNode("light"));
  const rt = ctx.document.createElement(peerUsesRuby ? "rt" : "span");
  rt.className = "lt-rt";
  rt.appendChild(ctx.document.createTextNode("ギター"));
  wrap.appendChild(rt);
  p.insertBefore(wrap, p.firstChild);
  ann.pass();

  assert.strictEqual(
    p.querySelectorAll(".lt-ruby ruby.kt-ruby, .lt-rt ruby.kt-ruby").length,
    0,
    "不能进到对方的注音节点里再注一层（ギター 是能翻译的词，注上就是越界）：" + p.innerHTML
  );
  assert.strictEqual(p.querySelector(".lt-rt").textContent, "ギター", "对方的注音文字不许被改写");
  assert.ok(
    [...p.querySelectorAll("ruby.kt-ruby")].some(
      (r) => r.childNodes[0].nodeValue === "ピアノ" && r.querySelector(".kt-rt").textContent === "piano"
    ),
    "同一行里我们该标的照样标：" + baseText(p)
  );
  for (let i = 0; i < 3; i++) {
    const r = ann.pass();
    assert.strictEqual(r.changed, 0, `第 ${i + 2} 轮不该改（对方注音不该让底字判成变了）`);
    assert.strictEqual(r.restored, 0, `第 ${i + 2} 轮不该还原`);
  }
}

test("同行有 latin-katakana 的注音（真 <ruby>）：不进去注，也不判底字变了", () => {
  checkPeerAnnotation(true);
});

test("同行有 latin-katakana 的注音（降级成 <span>）：靠 class 也要认出来", () => {
  // 内核不支持 ruby 时两家都降级成 span。这条路径上没有 <rt> 可以靠标签名兜底，
  // 只能靠 lt-ruby / lt-rt 这两个 class —— 漏认就是"给它人的注音做注解"。
  checkPeerAnnotation(false);
});

/** 造一个"已被 jp-furigana 接管"的含汉字歌词行 */
function managedKanjiLine(ctx) {
  const li = ctx.document.querySelectorAll("ul.lyric li")[0];
  li.classList.add("fg-line"); // jp-furigana 给自己的行打的标记
  return li;
}

function annotator(ctx, coexist) {
  return ctx.KTAnnotate.createAnnotator({
    document: ctx.document,
    lookup: (w) => ctx.translator.lookup(w),
    annotateAll: true,
    skipKanjiLines: true,
    coexistWithFurigana: coexist,
  });
}

test("打开共存后，含汉字的行也能标上（同一行两种注音）", () => {
  const ctx = loadCore(HTML);
  forceRubyLayout(ctx, true);
  const li = managedKanjiLine(ctx);
  annotator(ctx, true).pass();

  const p = li.querySelector("p");
  const pairs = [...p.querySelectorAll("ruby.kt-ruby")].map((r) => [
    r.childNodes[0].nodeValue,
    r.querySelector(".kt-rt").textContent,
  ]);
  assert.ok(
    pairs.some((x) => x[0] === "ヒーロー" && x[1] === "hero"),
    "共存模式下含汉字的行也该标片假名：" + JSON.stringify(pairs)
  );
  assert.ok(p.textContent.startsWith("取とり戻もどしたい"), "底字必须完整：" + p.textContent);
});

test("共存开关传函数时每轮重算——设置改完不用重启就生效", () => {
  const ctx = loadCore(HTML);
  forceRubyLayout(ctx, true);
  const li = managedKanjiLine(ctx);
  let on = false;
  const ann = annotator(ctx, () => on);

  ann.pass();
  const p = li.querySelector("p");
  assert.strictEqual(p.querySelectorAll("ruby.kt-ruby").length, 0, "关着的时候含汉字的行要整个让出去");

  on = true;
  ann.restoreAll();
  ann.pass();
  assert.ok(
    p.querySelectorAll("ruby.kt-ruby").length >= 1,
    "开关打开后，下一轮扫描就该标上（不能只在初始化时读一次）"
  );
});

// ---------------------------------------------------------------------------
// jp-furigana 的 DOM 改写模型
//
// 真机上「注音在行首和行尾来回横跳」就是这里暴露出来的：它 wrap 一整行时把
// 宿主原有的子节点整批搬进 __fgOrig，然后 replaceChildren(wrap)；
// restore 时再 wrap.remove() + host.append(...__fgOrig)。
// 下面忠实照抄这两步（含 tools/patch-jp-furigana.js 的补丁语义），
// 用来复现"注音位置被挪走"的两种情况。
// ---------------------------------------------------------------------------

const KATAKANA_LINE = `<!doctype html><html><head></head><body>
<ul class="lyric">
  <li class="line"><p id="L">コーヒーを飲みながら</p></li>
</ul>
</body></html>`;

// 片假名在**行首**，汉字在中间 —— 用户报的正是这种行
const SEGMENTS = [{ text: "コーヒーを" }, { text: "飲み", rt: "の" }, { text: "ながら" }];

function fgApplyWrap(doc, host, segments) {
  host.__fgOrig = [...host.childNodes];
  const wrap = doc.createElement("span");
  wrap.className = "fg-line";
  for (const seg of segments) {
    if (seg.rt) {
      const holder = doc.createElement("span");
      holder.className = "fg-ruby";
      const ruby = doc.createElement("ruby");
      ruby.appendChild(doc.createTextNode(seg.text));
      const rt = doc.createElement("rt");
      rt.className = "fg-rt";
      rt.textContent = seg.rt;
      ruby.appendChild(rt);
      holder.appendChild(ruby);
      wrap.appendChild(holder);
    } else {
      wrap.appendChild(doc.createTextNode(seg.text));
    }
  }
  host.replaceChildren(wrap);
  host.__fgWrap = wrap;
}

function fgRestore(host) {
  const wrap = host.__fgWrap;
  if (wrap && wrap.parentNode === host) {
    // 补丁第二条：拆 wrap 前把我们插在里面的注音暂存到 expando
    const foreign = [...wrap.querySelectorAll("ruby.kt-ruby")];
    if (foreign.length) host.__ktForeign = foreign;
    wrap.remove();
    // 只有 host 空了才放回原节点（原版逻辑，靠它把原文还原回来）
    if (!host.hasChildNodes() && host.__fgOrig && host.__fgOrig.length) host.append(...host.__fgOrig);
  }
  host.__fgWrap = null;
}

/** 行内可见底字里，位于第一个片假名注音之前的字符数 —— 越小越靠前 */
function kataOffset(host) {
  const ruby = host.querySelector("ruby.kt-ruby");
  if (!ruby) return -1;
  let pos = 0;
  let found = -1;
  (function walk(n) {
    for (const c of n.childNodes) {
      if (c === ruby) {
        found = pos;
        return true;
      }
      if (c.nodeType === 3) {
        pos += c.nodeValue.replace(/\s/g, "").length;
      } else {
        const cls = typeof c.className === "string" ? c.className : "";
        const isAnnotation = c.tagName === "RT" || /(^|\s)(kt-rt|fg-rt)(\s|$)/.test(cls);
        if (!isAnnotation && walk(c)) return true;
      }
    }
    return false;
  })(host);
  return found;
}

function kataLine(opts) {
  const ctx = loadCore(KATAKANA_LINE);
  forceRubyLayout(ctx, true);
  const doc = ctx.document;
  const li = doc.querySelector("li.line");
  const p = doc.getElementById("L");
  li.__fgText = "コーヒーを飲みながら"; // 这行归 jp-furigana 管
  // 这两个用例测的都是「共存开关已打开 + 补丁已打」的状态
  return { ctx, doc, li, p, ann: annotator(ctx, !(opts && opts.coexist === false)) };
}

test("以片假名开头的行：注音必须落在原位，不能被挪到行尾", () => {
  const { doc, p, ann } = kataLine();
  fgApplyWrap(doc, p, SEGMENTS);

  ann.pass();
  assert.strictEqual(kataOffset(p), 0, "コーヒー 的注音应该在行首，而不是跑到 飲みながら 后面");

  // jp-furigana 因为行脏而还原 + 重新 wrap，我们跟着再注一次
  for (let i = 0; i < 3; i++) {
    fgRestore(p);
    fgApplyWrap(doc, p, SEGMENTS);
    ann.restoreAll();
    ann.pass();
    assert.strictEqual(kataOffset(p), 0, `第 ${i + 1} 轮之后注音位置又跑了`);
    assert.strictEqual(p.querySelectorAll("ruby.kt-ruby").length, 1, "注音不能重复");
  }
});

test("jp-furigana 还原后不再重 wrap 时，不留重复注音", () => {
  const { doc, p, ann } = kataLine();
  fgApplyWrap(doc, p, SEGMENTS);
  ann.pass();
  assert.strictEqual(p.querySelectorAll("ruby.kt-ruby").length, 1);

  // 只剩还原、不再 wrap：它暂存的旧注音（host.__ktForeign）会在我们下一轮被消费
  fgRestore(p);
  assert.strictEqual((p.__ktForeign || []).length, 1, "前提：它确实暂存了旧注音");

  ann.pass();
  const rubies = [...p.querySelectorAll("ruby.kt-ruby")];
  assert.strictEqual(rubies.length, 1, "旧注音不能又被挂回来，变成重复注音");
  assert.strictEqual(kataOffset(p), 0, "重新注音的位置要在原位");
  assert.strictEqual(p.__ktForeign, null, "暂存要清掉，别一直挂着脱离文档的节点");
  assert.strictEqual(p.textContent.replace(/coffee/g, "").trim(), "コーヒーを飲みながら", "底字要完整且不重复");
});

// ---------------------------------------------------------------------------
// 没打补丁的 jp-furigana：它会把我们引起的每一次 DOM 变更都当成「行被外人改过」，
// 于是无条件重建整行，我们的注音随之被丢掉。
// 真机轨迹里就是 `[pass] changed=18 restored=18` 每秒重复 —— 肉眼是抽搐。
// 插件必须自己认输，不能一直跟着重建。
// ---------------------------------------------------------------------------

/** 没打补丁的 restore()：不暂存外来节点，wrap 连同我们的注音一起丢掉 */
function fgRestoreUnpatched(host) {
  const wrap = host.__fgWrap;
  if (wrap && wrap.parentNode === host) {
    wrap.remove();
    if (!host.hasChildNodes() && host.__fgOrig && host.__fgOrig.length) host.append(...host.__fgOrig);
  }
  host.__fgWrap = null;
}

/** 可见底字：把两种注音（我们的 rt 和对方的 fg-rt）都剔掉 */
function baseText(el) {
  const clone = el.cloneNode(true);
  for (const n of clone.querySelectorAll("rt, .kt-rt, .fg-rt")) n.remove();
  return clone.textContent;
}

/** 造好"一行被 jp-furigana 接管的歌词" + 带 log 收集器的 annotator */
function fgLine(opts) {
  const ctx = loadCore(KATAKANA_LINE);
  forceRubyLayout(ctx, true);
  const doc = ctx.document;
  doc.querySelector("li.line").__fgText = "コーヒーを飲みながら"; // 归 jp-furigana 管
  const p = doc.getElementById("L");
  const logs = [];
  const ann = ctx.KTAnnotate.createAnnotator({
    document: doc,
    lookup: (w) => ctx.translator.lookup(w),
    annotateAll: true,
    skipKanjiLines: true,
    coexistWithFurigana: true,
    log: (m) => logs.push(String(m)),
    // 测试里把退避调短，不然要真等 2s
    churnBaseMs: (opts && opts.churnBaseMs) || 2,
  });
  return { ctx, doc, p, ann, logs };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("对手无条件重建时，插件会认输停手，而不是无限对打", () => {
  // 退避给足，保证这一轮循环里不会到期（否则测的就不是"停手"而是"重试"了）
  const { doc, p, ann, logs } = fgLine({ churnBaseMs: 60000 });

  // 前几轮：对方重建 → 我们的宿主（它那个 wrap span）整个没了 → 我们重注 → 它又重建……
  fgApplyWrap(doc, p, SEGMENTS);
  let fought = 0;
  let roundsWithChange = 0;
  for (let i = 0; i < 10; i++) {
    const r = ann.pass();
    if (r.changed > 0) roundsWithChange++;
    fought += r.changed + r.restored;
    fgRestoreUnpatched(p);
    fgApplyWrap(doc, p, SEGMENTS);
  }
  assert.ok(fought >= 3, "前提：这个对手确实在和我们反复对打（changed+restored=" + fought + "）");
  assert.ok(
    roundsWithChange <= 3,
    "认输必须在三轮内生效，否则用户看到的就是连闪 —— 实际有 " + roundsWithChange + " 轮在改 DOM"
  );
  assert.ok(
    logs.some((l) => l.indexOf("churn 放弃这一行") === 0),
    "对打到阈值后应该主动认输，并留下轨迹：" + JSON.stringify(logs.slice(-3))
  );
  // 诊断必须真的读到对端状态：宿主在 dropDetached 里已经脱链，
  // 所以要靠注音时存下来的行元素，不能顺着脱链的宿主往上找（那样只会输出"无标记"）
  const churnLine = logs.find((l) => l.indexOf("churn 放弃这一行") === 0);
  assert.ok(churnLine.indexOf("peer{") > 0, "churn 日志应该带上对端状态：" + churnLine);
  assert.ok(churnLine.indexOf("peer=无标记") < 0, "不能退化成读不到行元素：" + churnLine);

  // 认输之后对方再怎么重建，我们也不再跟着注 —— 这就是"停手"
  let after = 0;
  for (let i = 0; i < 6; i++) {
    const r = ann.pass();
    after += r.changed + r.restored;
  }
  assert.strictEqual(after, 0, `认输之后不该再往这一行插注音（changed+restored=${after}）`);
  assert.strictEqual(baseText(p).trim(), "コーヒーを飲みながら", "底字不能被打乱");
});

test("歌词行刚变成当前行、被重绘两次 —— 不能被当成打架而放弃", () => {
  // 真机事故（2.0.2 的「4s 内 2 次」误伤）：
  //   16:36:09 已注音 文本="ジオラマに"    ← 这行刚变成当前行
  //   16:36:10 已注音 文本="ジオラマに"    ← 被重绘掉，补一次
  //   16:36:10 churn 放弃这一行 60s       ← 才两轮就认输，行首 60s 没注音
  // 重绘两次之后这行就稳定了，不该放弃。
  const { doc, p, ann, logs } = fgLine();

  fgApplyWrap(doc, p, SEGMENTS);
  ann.pass(); // 第一次注上
  fgRestoreUnpatched(p); // 行切换 → 对方重绘
  fgApplyWrap(doc, p, SEGMENTS);
  ann.pass(); // 补一次
  fgRestoreUnpatched(p); // 又重绘一次
  fgApplyWrap(doc, p, SEGMENTS);
  const r = ann.pass(); // 补第二次
  assert.ok(r.changed >= 1, "第二次重绘之后还应该补上注音");

  // 之后这行稳定下来：注音必须留在原位，而且不能因为前面两次重绘就进认输期
  const idle = ann.pass();
  assert.strictEqual(idle.changed + idle.restored, 0, "稳定之后不该再动它");
  assert.strictEqual(
    logs.filter((l) => l.indexOf("churn 放弃这一行") === 0).length,
    0,
    "两次重绘是正常换行行为，不该触发认输：" + JSON.stringify(logs.slice(-3))
  );
  assert.strictEqual(kataOffset(p), 0, "行首的注音必须还在");
});

test("认输只是暂时的：对方不再重建之后，注音要自己回来", async () => {
  // 真机事故：正在唱的那一两秒里，RNP 的逐字动画一直在改写当前片段所在的 wrap，
  // 我们怎么注都会被抹掉。唱完就停了 —— 所以退避必须短，否则那一句
  // 直到整行滚走都不会有注音（用户看到的就是"行首一直没注上"）。
  const { doc, p, ann, logs } = fgLine({ churnBaseMs: 30 });

  // 1. 先打起来，并且认输
  fgApplyWrap(doc, p, SEGMENTS);
  for (let i = 0; i < 5; i++) {
    ann.pass();
    fgRestoreUnpatched(p);
    fgApplyWrap(doc, p, SEGMENTS);
  }
  assert.ok(
    logs.some((l) => l.indexOf("churn 放弃这一行") === 0),
    "前提：应该先判定为打架并认输：" + JSON.stringify(logs.slice(-3))
  );
  assert.strictEqual(p.querySelectorAll("ruby.kt-ruby").length, 0, "认输期内不该有注音");

  // 2. 对方停了（逐字动画过了那一段），退避到期后应该自己补上
  await sleep(60);
  const r = ann.pass();
  assert.ok(r.changed >= 1, "退避结束后应该重新注上（changed=" + r.changed + "）");
  assert.strictEqual(kataOffset(p), 0, "补回来的注音要在行首原位");

  // 3. 恢复之后如果对方又停了，注音要留在那儿
  const idle = ann.pass();
  assert.strictEqual(idle.changed + idle.restored, 0, "稳定之后不该再动它");
  assert.strictEqual(p.querySelectorAll("ruby.kt-ruby").length, 1, "注音应该留着");
});

test("短暂的几轮重绘之后要自己稳住 —— 不能一上来就退避十分钟", async () => {
  // 用户反馈："ジオラマ的英文消失了"、"ライト一直没有"。
  // 真机轨迹（2.0.8）：
  //   17:04:09 churn 2s   peer{dirty=false 无wrap=0 ktOwn=1 原文一致=true}
  //   17:04:12 churn 600s peer{dirty=false 无wrap=0 ktOwn=1 原文一致=true}
  // 对端状态是健康的、两次之间隔了 3 秒 —— 那是正常重绘，却被当成死循环退了 600s。
  const { doc, p, ann, logs } = fgLine({ churnBaseMs: 30 });

  // 三轮重绘（正常行切换的量级），然后对方就安静了
  fgApplyWrap(doc, p, SEGMENTS);
  for (let i = 0; i < 3; i++) {
    ann.pass();
    fgRestoreUnpatched(p);
    fgApplyWrap(doc, p, SEGMENTS);
  }
  // 对方安静下来之后，最多几轮之内必须自己把注音补回来
  // （注意 dropDetached 在每轮开头跑，会把退避"续上"，所以不是一次 pass 就能补回）
  let ok = false;
  for (let i = 0; i < 8 && !ok; i++) {
    await sleep(120);
    ann.pass();
    ok = p.querySelectorAll("ruby.kt-ruby").length === 1;
  }
  assert.ok(ok, "对方安静后应该自己补上注音");
  assert.strictEqual(kataOffset(p), 0, "补回来的注音要在行首原位");

  const idle = ann.pass();
  assert.strictEqual(idle.changed + idle.restored, 0, "稳住之后不该再动它");

  // 关键：不能出现"分钟级"的长退避（正常重绘不该被当成死循环）
  assert.strictEqual(
    logs.filter((l) => /churn 放弃这一行 (\d+)ms/.test(l) && Number(/churn 放弃这一行 (\d+)ms/.exec(l)[1]) >= 60000).length,
    0,
    "正常重绘不该触发长时间退避：" + JSON.stringify(logs.filter((l) => l.indexOf("churn") === 0))
  );
});

test("一直打个不停时，退避要按倍数退到上限", async () => {
  const { doc, p, ann, logs } = fgLine({ churnBaseMs: 20 });

  // 每一轮都推倒重建，退避又极短 —— 连续打十几轮，看退避有没有层层退开
  for (let i = 0; i < 60; i++) {
    ann.pass();
    fgRestoreUnpatched(p);
    fgApplyWrap(doc, p, SEGMENTS);
    await sleep(3);
  }

  const waits = logs
    .filter((l) => l.indexOf("churn 放弃这一行") === 0)
    .map((l) => Number((/churn 放弃这一行 (\d+)ms/.exec(l) || [])[1] || 0));
  assert.ok(waits.length >= 3, "应该判定为打架并多次退避：" + JSON.stringify(waits));
  for (let i = 1; i < waits.length; i++) {
    assert.ok(waits[i] > waits[i - 1], "退避时间必须一轮比一轮长：" + JSON.stringify(waits));
  }
  assert.ok(
    waits[waits.length - 1] >= waits[0] * 8,
    "一直打个不停时要按倍数退开，不能永远按秒重试：" + JSON.stringify(waits)
  );
  // 上限（600000ms）在真机上要连打十几轮才摸得到，这里只守住"不会退到离谱的值"
  assert.ok(
    waits.every((w) => w <= 600000),
    "退避不能超过上限 600000ms：" + JSON.stringify(waits)
  );
});

test("没有译文的片段必须留下「跳过原因」，不能无声无息", () => {
  // 用户说"某处没注上"时，以前只有成功注音才留痕，于是完全看不到原因，
  // 只能靠猜（这几轮反复猜错）。现在每种跳过都要写进轨迹。
  const ctx = loadCore(`<!doctype html><html><head></head><body>
<ul class="lyric"><li class="line"><p>ゾルバニアに</p></li></ul>
</body></html>`);
  forceRubyLayout(ctx, true);
  const logs = [];
  const ann = ctx.KTAnnotate.createAnnotator({
    document: ctx.document,
    lookup: () => null, // 一个词都查不到
    annotateAll: true,
    log: (m) => logs.push(String(m)),
  });
  ann.pass();

  const note = logs.find((l) => l.indexOf("未注音") === 0);
  assert.ok(note, "应该有「未注音」这一行：" + JSON.stringify(logs));
  assert.ok(note.indexOf("无译文") > 0, "要写明是没译文：" + note);
  assert.ok(note.indexOf("ゾルバニア") > 0, "要把查不到的词打出来：" + note);
});

test("按行让位时也要写明「对方到底管没管这一行」", () => {
  const ctx = loadCore(`<!doctype html><html><head></head><body>
<ul class="lyric"><li class="line" id="L"><p>コーヒーを飲みながら</p></li></ul>
</body></html>`);
  forceRubyLayout(ctx, true);
  // 让 jp-furigana「真的管着」这一行（它的标记）
  ctx.document.getElementById("L").__fgText = "コーヒーを飲みながら";
  const logs = [];
  const ann = ctx.KTAnnotate.createAnnotator({
    document: ctx.document,
    lookup: (w) => ctx.translator.lookup(w),
    annotateAll: true,
    skipKanjiLines: true,
    coexistWithFurigana: false, // 共存关着 → 对方管着的行让开
    log: (m) => logs.push(String(m)),
  });
  ann.pass();

  const note = logs.find((l) => l.indexOf("未注音") === 0);
  assert.ok(note, "应该有「未注音」这一行：" + JSON.stringify(logs));
  assert.ok(note.indexOf("汉字让位") > 0, "要写明是让位：" + note);
  assert.ok(note.indexOf("peer管=true") > 0, "要写明是对方在管（正常让位）：" + note);
  assert.strictEqual(
    ctx.document.querySelectorAll("ul.lyric ruby.kt-ruby").length,
    0,
    "对方管着的行确实应该让开"
  );
});

test("注音活了半秒才被重建 = 正常重绘，不该进入认输期", async () => {
  // 真机数据把两类现象分得很清楚：
  //   age=223ms / 435ms / 543ms  —— RNP 分几次补齐歌词行，正常重绘
  //   age≈0~几十 ms              —— 对方无条件重建，注什么秒毁什么（真死循环）
  // 前者配合"下一帧前补回来"根本看不见，不该认输（认输会让那一句十几秒没英文，
  // 用户看到的就是"RNP 页的ジオラマ一直没注音"）。
  const { doc, p, ann, logs } = fgLine({ churnBaseMs: 30 });

  for (let i = 0; i < 6; i++) {
    fgApplyWrap(doc, p, SEGMENTS);
    // 把"注音时刻"往前挪 500ms，模拟注音活了半秒才被重建
    const wrap = p.querySelector("span.fg-line");
    ann.pass();
    const host = p.querySelector("ruby.kt-ruby") ? p.querySelector("ruby.kt-ruby").parentNode : null;
    if (host) host.__ktAt = Date.now() - 500;
    else if (wrap) wrap.__ktAt = Date.now() - 500;
    fgRestoreUnpatched(p);
    await sleep(20);
  }

  assert.strictEqual(
    logs.filter((l) => l.indexOf("churn 放弃这一行") === 0).length,
    0,
    "活了半秒的重建不该被当成打架：" + JSON.stringify(logs.filter((l) => l.indexOf("churn") === 0))
  );
});

test("元素没换、只是注音被抹掉时，age 也要算得出来（否则闸门失效）", async () => {
  // 2.0.12 引入了"只有刚插上就被毁才算打架"的闸门，但 prior 那条路
  // （元素还在、注音没了）拿不到记录，只能靠 decidedByHost 里记的注音时刻。
  // 漏了它的话 age 是 undefined → 闸门失效 → 正常重绘也会被当成打架
  // → 那一句隔几秒消失一次（用户原话："ジオラマ偶尔在闪"）。
  const { ctx, doc, p, ann, logs } = fgLine({ churnBaseMs: 30 });

  // 用"元素不换、内容被重写成纯文本"的方式反复模拟正常重绘（每轮相隔足够久）
  // —— 真机上 RNP 就是这么干的：同一个 div，children 换回纯文本。
  for (let i = 0; i < 4; i++) {
    p.textContent = "コーヒーを飲みながら";
    await sleep(220); // 让"注音活了 ~220ms"这个事实成立
    ann.pass();
  }

  assert.strictEqual(
    logs.filter((l) => l.indexOf("churn 放弃这一行") === 0).length,
    0,
    "活了 200ms 以上的重建不该被当成打架：" + JSON.stringify(logs.filter((l) => l.indexOf("churn") === 0))
  );
  assert.ok(doc.querySelectorAll("ruby.kt-ruby").length >= 1, "而且注音应该补回来");
});

test("对方重建但歌词真的换了一句 —— 不能因此认输", () => {
  const { doc, p, ann, logs } = fgLine();

  // 每一句都是新歌词（真机上就是正常播放），且每句都伴随一次推倒重建
  const lines = [
    [{ text: "コーヒーを" }, { text: "飲み", rt: "の" }, { text: "ながら" }],
    [{ text: "ギターと" }, { text: "ピアノ", rt: "ぴあの" }, { text: "のセッション" }],
    [{ text: "スマホを" }, { text: "ポケット", rt: "ぽけっと" }, { text: "に" }],
    [{ text: "コンピューター" }, { text: "の前に" }, { text: "座る", rt: "すわる" }],
    [{ text: "インターネット" }, { text: "の" }, { text: "海", rt: "うみ" }],
  ];
  let changed = 0;
  for (const segs of lines) {
    fgRestoreUnpatched(p);
    fgApplyWrap(doc, p, segs);
    changed += ann.pass().changed;
  }

  assert.ok(changed >= 4, "每句新歌词都该被标上（实际 changed=" + changed + "）");
  assert.strictEqual(
    logs.filter((l) => l.indexOf("churn 放弃这一行") === 0).length,
    0,
    "正常换行不该被当成打架而认输"
  );
});

