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
  ann.pass();
  return { ctx, ann, doc: ctx.document };
}

test("含汉字的歌词行整个让给振假名插件", () => {
  const { doc } = setup();
  const kanjiLine = doc.querySelectorAll("ul.lyric li p")[0];
  assert.strictEqual(kanjiLine.querySelectorAll("ruby.kt-ruby").length, 0, "含汉字的行不该被我们改");
  assert.strictEqual(kanjiLine.textContent, "取とり戻もどしたい　ヒーローみたいに", "必须保持原样");
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

