/*
 * core/annotate.js —— 注音注入、还原、React 重建后的清理。
 * 用 jsdom 跑真实 DOM 操作。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { loadCore, makeAnnotator, forceRubyLayout } = require("./helpers");

const LYRIC_HTML = `<!doctype html><html><head></head><body>
<div id="app">
  <ul class="lyric">
    <li><p>コーヒーを飲みながら</p></li>
    <li><p>コンピューターの前に座る</p></li>
    <li><p>作詞: テスト太郎</p></li>
  </ul>
</div>
</body></html>`;

function newCtx(html) {
  const ctx = loadCore(html || LYRIC_HTML);
  forceRubyLayout(ctx, true);
  return ctx;
}

function rubyPairs(root) {
  // 收集 (底字, 注音) 对，避开 realm 差异
  const out = [];
  const rubies = root.querySelectorAll("ruby.kt-ruby");
  for (let i = 0; i < rubies.length; i++) {
    const r = rubies[i];
    const rt = r.querySelector("rt.kt-rt, .kt-rt");
    let base = "";
    for (let j = 0; j < r.childNodes.length; j++) {
      const n = r.childNodes[j];
      if (n.nodeType === 3) base += n.nodeValue;
    }
    out.push([base, rt ? rt.textContent : null]);
  }
  return out;
}

/**
 * 「底字」文本：把注音（<rt> / .kt-rt）去掉后的可见原文。
 * 标准 ruby 里 <rt> 的文本本来就算 textContent 的一部分（浏览器也一样），
 * 所以断言底字必须显式剔掉注音，不能直接读 textContent。
 */
function baseText(el) {
  const clone = el.cloneNode(true);
  const anns = clone.querySelectorAll("rt.kt-rt, .kt-rt, rp");
  for (let i = 0; i < anns.length; i++) {
    if (anns[i].parentNode) anns[i].parentNode.removeChild(anns[i]);
  }
  return clone.textContent;
}

test("给歌词里的片假名加上 ruby 注音", () => {
  const ctx = newCtx();
  const ann = makeAnnotator(ctx);
  ann.pass();

  const p1 = ctx.document.querySelector("ul.lyric li p");
  const pairs = rubyPairs(p1);
  assert.deepStrictEqual(pairs, [["コーヒー", "coffee"]]);
  // 底字必须完整保留，注音是叠加不是替换
  assert.strictEqual(baseText(p1), "コーヒーを飲みながら");
});

test("一行里多个外来语都标上", () => {
  const ctx = newCtx();
  const ann = makeAnnotator(ctx);
  ann.pass();
  const lines = ctx.document.querySelectorAll("ul.lyric li p");
  const pairs = rubyPairs(lines[1]);
  assert.deepStrictEqual(pairs, [["コンピューター", "computer"]]);
});

test("制作信息行不注音", () => {
  const ctx = newCtx(
    `<!doctype html><html><body><ul class="lyric">
      <li><p>作詞: コーヒー太郎</p></li>
      <li><p>コーヒー</p></li>
    </ul></body></html>`
  );
  const ann = makeAnnotator(ctx);
  ann.pass();
  const lines = ctx.document.querySelectorAll("ul.lyric li p");
  assert.strictEqual(rubyPairs(lines[0]).length, 0, "作詞 行不应该被注音");
  // 第二行（コーヒー）和第三行的正文里只有一个词可标
  assert.strictEqual(rubyPairs(lines[lines.length - 1]).length, 1);
});

test("还原后 DOM 与原文完全一致（含不残留 class 痕迹）", () => {
  const ctx = newCtx();
  const before = ctx.document.body.innerHTML;
  const ann = makeAnnotator(ctx);
  ann.pass();
  assert.notStrictEqual(ctx.document.body.innerHTML, before, "应该有改动");
  assert.ok(ctx.document.querySelector(".kt-region"), "标注期间应有区域标记");
  ann.restoreAll();
  assert.strictEqual(ctx.document.body.innerHTML, before, "还原后应逐字节一致");
  assert.strictEqual(ctx.document.querySelectorAll(".kt-region").length, 0, "区域标记要摘干净");
});

test("重复 pass 不会重复插入注音", () => {
  const ctx = newCtx();
  const ann = makeAnnotator(ctx);
  ann.pass();
  const first = ctx.document.body.innerHTML;
  ann.pass();
  ann.pass();
  assert.strictEqual(ctx.document.body.innerHTML, first);
  // 两行歌词各一个词，所以是 2 条记录
  assert.strictEqual(ann.injectedCount(), 2);
  assert.strictEqual(ctx.document.querySelectorAll("ruby.kt-ruby").length, 2);
});

test("React 重建元素后，旧注音被清掉、新文本被重新标注", () => {
  const ctx = newCtx();
  const ann = makeAnnotator(ctx);
  ann.pass();

  // 模拟 React 用全新元素替换整个 li（原来的文本节点连着我们插的 ruby 一起被丢弃）
  const li = ctx.document.querySelector("ul.lyric li");
  const fresh = ctx.document.createElement("li");
  fresh.innerHTML = "<p>ギターを弾く</p>";
  li.parentNode.replaceChild(fresh, li);

  ann.pass();

  // 被替换掉的那棵子树里不能还挂着我们注入的节点（否则会一直漏内存、
  // 而且 React 若把它重新挂回来就会看到过期注音）。
  assert.strictEqual(li.querySelectorAll("ruby.kt-ruby").length, 0, "孤儿注音要清掉");
  // 页面上还剩第二行（コンピューター）的注音，加上新换进来的第一行，共 2 条
  assert.strictEqual(ctx.document.querySelectorAll("ul.lyric ruby.kt-ruby").length, 2);
  const pairs = rubyPairs(ctx.document.querySelector("ul.lyric li p"));
  assert.deepStrictEqual(pairs, [["ギター", "guitar"]]);
  assert.strictEqual(baseText(ctx.document.querySelector("ul.lyric li p")), "ギターを弾く");
});

test("内核不支持 ruby 排版时降级成绝对定位的 span", () => {
  const ctx = loadCore(LYRIC_HTML);
  forceRubyLayout(ctx, false);
  const ann = makeAnnotator(ctx);
  ann.pass();

  const ruby = ctx.document.querySelector("ruby.kt-ruby");
  assert.ok(ruby, "仍然用 ruby 元素做容器");
  assert.strictEqual(ruby.querySelectorAll("rt").length, 0, "不应该有 rt");
  const span = ruby.querySelector("span.kt-rt");
  assert.ok(span, "注音应该放在 span.kt-rt 里");
  assert.strictEqual(span.textContent, "coffee");
  // 宿主元素要带上降级标记，CSS 才生效
  assert.ok(ruby.parentNode.classList.contains("kt-fallback"));
});

test("样式表可以注入并按设置更新", () => {
  const ctx = newCtx();
  ctx.KTAnnotate.applyStyles(ctx.document, { rtSize: 70, rtOpacity: 50 });
  const style = ctx.document.getElementById("katakana-terminator-style");
  assert.ok(style, "应该插入了 style 元素");
  assert.match(style.textContent, /font-size: 70%/);
  assert.match(style.textContent, /opacity: 0\.5/);

  ctx.KTAnnotate.applyStyles(ctx.document, { rtSize: 40, rtOpacity: 100 });
  assert.match(ctx.document.getElementById("katakana-terminator-style").textContent, /font-size: 40%/);
  // 只应有一个 style 元素
  assert.strictEqual(ctx.document.querySelectorAll("#katakana-terminator-style").length, 1);
});

test("annotateAll=false 只标歌词，true 走白名单（不含整页）", () => {
  const html = `<!doctype html><html><body>
    <div class="title">コーヒー</div>
    <div class="m-playbar"><div class="words"><span class="name">ギター</span></div></div>
    <ul class="lyric"><li><p>ピアノ</p></li></ul>
  </body></html>`;

  // 只标歌词：标题、播放栏都不动
  const ctx1 = loadCore(html);
  forceRubyLayout(ctx1, true);
  const lyricsOnly = ctx1.KTAnnotate.createAnnotator({
    document: ctx1.document,
    lookup: ctx1.translator.lookup,
    annotateAll: false,
  });
  lyricsOnly.pass(lyricsOnly.findRegions("lyrics"));
  assert.strictEqual(ctx1.document.querySelectorAll(".title ruby").length, 0, "标题不该被标注");
  assert.strictEqual(ctx1.document.querySelectorAll(".m-playbar ruby").length, 0, "播放栏不该被标注");
  assert.strictEqual(ctx1.document.querySelectorAll("ul.lyric ruby").length, 1);

  // 标注全部：歌词 + 播放栏标题，但白名单外的 .title 仍然不碰
  const ctx2 = loadCore(html);
  forceRubyLayout(ctx2, true);
  const everything = ctx2.KTAnnotate.createAnnotator({
    document: ctx2.document,
    lookup: ctx2.translator.lookup,
    annotateAll: true,
  });
  everything.pass();
  assert.strictEqual(ctx2.document.querySelectorAll(".m-playbar ruby").length, 1, "播放栏标题应该被标注");
  assert.strictEqual(ctx2.document.querySelectorAll("ul.lyric ruby").length, 1);
  assert.strictEqual(ctx2.document.querySelectorAll(".title ruby").length, 0, "白名单外的元素不该被标注");
});

test("绝不把整个 body 当区域（这是把网易云干崩的原因）", () => {
  const html = `<!doctype html><html><body>
    <nav class="m-sidebar">ミク</nav>
    <input placeholder="カラオケ" value="">
    <div class="m-playbar"><div class="words"><span class="name">コーヒー</span></div></div>
    <ul class="lyric"><li><p>ギター</p></li></ul>
  </body></html>`;
  const ctx = loadCore(html);
  forceRubyLayout(ctx, true);
  const ann = ctx.KTAnnotate.createAnnotator({
    document: ctx.document,
    lookup: ctx.translator.lookup,
    annotateAll: true,
  });

  for (const mode of ["lyrics", "safe"]) {
    const regions = ann.findRegions(mode);
    assert.ok(regions.length > 0, `${mode} 应该有区域`);
    for (const r of regions) assert.notStrictEqual(r, ctx.document.body, `${mode} 不允许返回 body`);
  }

  // 侧边栏里的片假名必须原样不动
  ann.pass();
  assert.strictEqual(ctx.document.querySelectorAll(".m-sidebar ruby").length, 0, "侧边栏不该被标注");
  assert.strictEqual(ctx.document.querySelector(".m-sidebar").textContent, "ミク");
  assert.strictEqual(ctx.document.querySelectorAll(".m-playbar ruby").length, 1);
  assert.strictEqual(ctx.document.querySelectorAll("ul.lyric ruby").length, 1);
});

test("词典里没有的词不会被注音（并进入待翻译状态）", () => {
  const html = `<!doctype html><html><body><ul class="lyric"><li><p>ズンドコパラダイス</p></li></ul></body></html>`;
  const ctx = loadCore(html);
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx);
  ann.pass();
  assert.strictEqual(ctx.document.querySelectorAll("ruby.kt-ruby").length, 0);
});

test("半角片假名在页面里也能查到词典", () => {
  const html = `<!doctype html><html><body><ul class="lyric"><li><p>ｺｰﾋｰ</p></li></ul></body></html>`;
  const ctx = loadCore(html);
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx);
  ann.pass();
  const pairs = rubyPairs(ctx.document.querySelector("ul.lyric li p"));
  assert.deepStrictEqual(pairs, [["ｺｰﾋｰ", "coffee"]]);
  // 底字保持半角原文，只在查词典时折算
  assert.strictEqual(baseText(ctx.document.querySelector("ul.lyric li p")), "ｺｰﾋｰ");
});

test("注入不会替换 React 持有的文本节点（这是不把 React 搞崩的关键）", () => {
  // 文本不以片假名开头：原文本节点必须原样保留，只被「切短」
  const ctx = newCtx(
    `<!doctype html><html><body><ul class="lyric"><li><p>今日はコーヒーです</p></li></ul></body></html>`
  );
  forceRubyLayout(ctx, true);
  const p = ctx.document.querySelector("ul.lyric li p");
  const reactNode = p.firstChild; // 假装这是 React 内部持有的那个引用
  assert.strictEqual(reactNode.nodeType, 3);

  makeAnnotator(ctx).pass();

  assert.strictEqual(p.firstChild, reactNode, "原文本节点必须还在，且还在第一个位置");
  assert.strictEqual(reactNode.parentNode, p, "原文本节点不能脱离父节点");
  // React 之后会在这个节点上执行 setTextContent，必须仍然有效
  assert.doesNotThrow(() => {
    reactNode.nodeValue = "明日はカフェです";
  }, "React 更新这个节点不应该抛错");
});

test("文本以片假名开头时也不会留下重影", () => {
  // 这种情况原节点没法保留（第 0 段本身要带注音），
  // 但渲染出来的底字必须只出现一次
  const ctx = newCtx(
    `<!doctype html><html><body><ul class="lyric"><li><p>コーヒーを飲む</p></li></ul></body></html>`
  );
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx);
  ann.pass();
  const p = ctx.document.querySelector("ul.lyric li p");
  assert.deepStrictEqual(rubyPairs(p), [["コーヒー", "coffee"]]);
  assert.strictEqual(baseText(p), "コーヒーを飲む", "底字不能重复");
  // 还原后同样不能有重影
  ann.restoreAll();
  assert.strictEqual(baseText(p), "コーヒーを飲む");
  assert.strictEqual(ctx.document.body.innerHTML.includes("コーヒーコーヒー"), false);
});

test("文本节点里既有词又有普通文本时，拼接顺序不乱", () => {
  const html = `<!doctype html><html><body><ul class="lyric"><li><p>これはコーヒーです</p></li></ul></body></html>`;
  const ctx = loadCore(html);
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx);
  ann.pass();
  const p = ctx.document.querySelector("ul.lyric li p");
  assert.strictEqual(baseText(p), "これはコーヒーです");
  assert.deepStrictEqual(rubyPairs(p), [["コーヒー", "coffee"]]);
});
