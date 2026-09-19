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

test("会消费 host.__ktForeign 并把注音挂回原位", () => {
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

  // 我们再跑一轮：应当把它挂回去并清空暂存
  ann.restoreAll();
  ann.pass();
  assert.strictEqual(host.__ktForeign, null, "暂存要被清空，避免越积越多");
  assert.ok(p.querySelectorAll("ruby.kt-ruby").length >= 1, "注音要补回原位");
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
