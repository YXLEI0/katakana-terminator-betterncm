/*
 * core/overlay.js —— 浮层注音。
 *
 * 这个模块是为了和 jp-furigana 共存而写的：它把英文注音画在独立浮层上，
 * **完全不碰歌词 DOM**。所以测试的重点有两个：
 *   1. 歌词 DOM 必须一个字节都不变（这是共存的前提）；
 *   2. 该画出来的标签要画出来、该清的能清掉。
 *
 * 注意：jsdom 没有布局引擎，getBoundingClientRect 全返回 0，
 * 所以这里会打桩量测函数；真实定位效果需要真机确认。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { loadCore, loadScripts } = require("./helpers");

const LYRIC_HTML = `<!doctype html><html><head></head><body>
<div class="m-playbar"><div class="words"><span class="name">コーヒー</span></div></div>
<div class="rnp-lyrics-container">
  <div class="rnp-lyrics-line rnp-lyrics-line-original">コーヒーを飲みながら</div>
  <div class="rnp-lyrics-line rnp-lyrics-line-original">ギターを弾く</div>
</div>
</body></html>`;

/** 装好 overlay 模块 + 桩掉量测 */
function setup(html) {
  const ctx = loadCore(html || LYRIC_HTML);
  loadScripts(ctx.dom, ["core/overlay.js"]);
  const win = ctx.window;
  // 打桩：让每个 Range 量出一个稳定的矩形（模拟有布局的环境）
  win.Range.prototype.getBoundingClientRect = function () {
    return { left: 100, top: 200, right: 160, bottom: 220, width: 60, height: 20 };
  };
  return ctx;
}

function makeOverlay(ctx, opts) {
  return ctx.window.KTOverlay.createOverlay(
    Object.assign(
      {
        document: ctx.document,
        lookup: (w) => ctx.translator.lookup(w),
      },
      opts || {}
    )
  );
}

const lyricRegions = (ctx) => [...ctx.document.querySelectorAll(".rnp-lyrics-line")];

test("浮层会为片假名词画出英文标签", () => {
  const ctx = setup();
  const ov = makeOverlay(ctx);
  const r = ov.render(lyricRegions(ctx));

  assert.ok(r.placed >= 2, `应该画至少 2 个标签，实际 ${r.placed}`);
  const labels = [...ctx.document.querySelectorAll("#katakana-terminator-overlay .kt-ov-label")].map((e) => e.textContent);
  assert.ok(labels.includes("coffee"), "应该有 coffee：" + labels.join(","));
  assert.ok(labels.includes("guitar"), "应该有 guitar：" + labels.join(","));
  ov.destroy();
});

test("浮层绝不修改歌词 DOM（与 jp-furigana 共存的前提）", () => {
  const ctx = setup();
  const before = ctx.document.querySelector(".rnp-lyrics-container").innerHTML;
  const ov = makeOverlay(ctx);
  ov.render(lyricRegions(ctx));

  assert.strictEqual(
    ctx.document.querySelector(".rnp-lyrics-container").innerHTML,
    before,
    "歌词容器必须一字不变"
  );
  // 也不该出现我们那套 ruby 注音节点
  assert.strictEqual(ctx.document.querySelectorAll("ruby.kt-ruby").length, 0, "不该插 ruby");
  assert.strictEqual(ctx.document.querySelectorAll("[data-kt-region]").length, 0, "不该打区域标记");
  ov.destroy();
});

test("浮层挂在 body 下、且不拦截鼠标事件", () => {
  const ctx = setup();
  const ov = makeOverlay(ctx);
  ov.render(lyricRegions(ctx));

  const layer = ctx.document.getElementById("katakana-terminator-overlay");
  assert.ok(layer, "浮层容器应该存在");
  assert.strictEqual(layer.parentNode, ctx.document.body, "应该挂在 body 下");
  assert.match(layer.style.cssText, /pointer-events:\s*none/, "不能吃事件");
  assert.match(layer.style.cssText, /position:\s*fixed/, "应该是 fixed 定位");
  ov.destroy();
});

test("重新 render 会先清掉旧标签，不会累积", () => {
  const ctx = setup();
  const ov = makeOverlay(ctx);
  ov.render(lyricRegions(ctx));
  const first = ctx.document.querySelectorAll("#katakana-terminator-overlay .kt-ov-label").length;
  assert.ok(first > 0);

  for (let i = 0; i < 5; i++) ov.render(lyricRegions(ctx));
  assert.strictEqual(
    ctx.document.querySelectorAll("#katakana-terminator-overlay .kt-ov-label").length,
    first,
    "重复渲染不该让标签变多"
  );
  ov.destroy();
});

test("stop 会清掉标签，destroy 连容器和样式一起收走", () => {
  const ctx = setup();
  const ov = makeOverlay(ctx);
  ov.render(lyricRegions(ctx));
  assert.ok(ov.labelCount() > 0);

  ov.stop();
  assert.strictEqual(ov.labelCount(), 0, "stop 后不该还有标签");
  assert.strictEqual(
    ctx.document.querySelectorAll("#katakana-terminator-overlay .kt-ov-label").length,
    0,
    "DOM 里也不该有标签"
  );
  assert.strictEqual(ctx.document.getElementById("katakana-terminator-overlay-style").id, "katakana-terminator-overlay-style");

  ov.destroy();
  assert.strictEqual(ctx.document.getElementById("katakana-terminator-overlay"), null, "容器应该被移除");
  assert.strictEqual(ctx.document.getElementById("katakana-terminator-overlay-style"), null, "样式应该被移除");
});

test("视口外的行不画标签（省性能）", () => {
  const ctx = setup();
  const win = ctx.window;
  win.Range.prototype.getBoundingClientRect = function () {
    // 远离视口：top 5000，视口高度按 jsdom 默认 768
    return { left: 10, top: 5000, right: 60, bottom: 5020, width: 50, height: 20 };
  };
  const ov = makeOverlay(ctx);
  const r = ov.render(lyricRegions(ctx));
  assert.strictEqual(r.placed, 0, "视口外不该画");
  assert.ok(r.skipped > 0, "应该记为跳过");
  ov.destroy();
});

test("词典查不到的词不画标签", () => {
  const ctx = setup(
    `<!doctype html><html><body><div class="rnp-lyrics-line">ズンドコパラダイス</div></body></html>`
  );
  const ov = makeOverlay(ctx);
  const r = ov.render([ctx.document.querySelector(".rnp-lyrics-line")]);
  assert.strictEqual(r.placed, 0, "查不到就不该画");
  ov.destroy();
});

test("不会重复标注 jp-furigana 的注音文本（fg-rt）", () => {
  const ctx = setup(`<!doctype html><html><body>
    <div class="rnp-lyrics-line">
      <span class="fg-line"><span class="fg-ruby"><ruby>漢<rt class="fg-rt">かん</rt></ruby></span>コーヒー</span>
    </div>
  </body></html>`);
  const ov = makeOverlay(ctx);
  ov.render([ctx.document.querySelector(".rnp-lyrics-line")]);
  const labels = [...ctx.document.querySelectorAll("#katakana-terminator-overlay .kt-ov-label")].map((e) => e.textContent);
  assert.deepStrictEqual(labels, ["coffee"], "只该标片假名，不该把振假名当词：" + labels.join(","));
  ov.destroy();
});

test("start 会挂上监听并在 destroy 时全部摘掉", async () => {
  const ctx = setup();
  const ov = makeOverlay(ctx);
  ov.start(() => lyricRegions(ctx));
  assert.strictEqual(ov.isRunning(), true);
  // start 里第一次渲染是排进 rAF 的，等它跑完
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(ov.labelCount() > 0, "start 之后应该已经画了标签");

  ov.destroy();
  assert.strictEqual(ov.isRunning(), false);
  assert.strictEqual(ov.labelCount(), 0);
});
