/*
 * 集成测试：像 BetterNCM 那样把 5 个文件注入到一个页面里，
 * 提供 plugin / betterncm 全局桩，然后观察插件是否真的开始工作。
 *
 * 这是最接近真机的一层：manifest 的 injects 顺序、main.js 里的生命周期注册、
 * 扫描调度、设置面板构建，都会在这里跑到。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { loadCore, loadScripts } = require("./helpers");

const FILES = [
  "core/matcher.js",
  "core/dict.js",
  "core/translate.js",
  "core/annotate.js",
  "main.js",
];

// 贴近网易云 3.x 的歌词结构
const NCM_HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-playbar">
    <div class="words">
      <span class="name"><a href="#">コーヒーとコンピューター</a></span>
      <span class="by"><a href="#">ギター太郎</a></span>
    </div>
  </div>
  <div class="m-lyric">
    <ul id="mod_pc_lyric_record" class="lyric">
      <li class="line"><p>コーヒーを飲みながら</p></li>
      <li class="line"><p>ギターとピアノのセッション</p></li>
      <li class="line"><p>コンピューターの前に座る</p></li>
      <li class="line"><p>作詞: テスト太郎</p></li>
    </ul>
  </div>
</div>
</body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个假的 BetterNCM 环境并注入插件 */
function bootPlugin(html, options) {
  options = options || {};
  const ctx = loadCore(html, { translator: false, url: "https://music.163.com/" });
  const dom = ctx.dom;
  const window = ctx.window;

  // 网络：默认全部失败，保证测试不碰真接口
  window.fetch = function () {
    return Promise.reject(new Error("offline (test)"));
  };

  const opened = [];
  const listeners = { load: [], config: [] };
  const betterncm = {
    app: {
      getBetterNCMVersion: function () {
        return Promise.resolve("1.3.4-test");
      },
    },
    ncm: {
      openUrl: function (u) {
        opened.push(u);
      },
    },
    fs: {
      exists: function () {
        return Promise.resolve(false);
      },
      readFile: function () {
        return Promise.reject(new Error("no fs in test"));
      },
    },
    utils: {
      waitForElement: function () {
        return Promise.resolve(null);
      },
      delay: function (ms) {
        return new Promise(function (r) {
          setTimeout(r, ms);
        });
      },
    },
  };
  const plugin = {
    devMode: !!options.dev,
    pluginPath: "C:/betterncm/plugins/katakana-terminator",
    onLoad: function (fn) {
      listeners.load.push(fn);
    },
    onConfig: function (fn) {
      listeners.config.push(fn);
    },
  };

  // BetterNCM 是把 plugin / betterncm 作为全局注入的，挂到 window 上即可
  window.betterncm = betterncm;
  window.plugin = plugin;

  loadScripts(dom, FILES);

  const env = {
    ctx,
    dom,
    window,
    document: window.document,
    plugin,
    betterncm,
    opened,
    listeners,
    runLoad: async function () {
      for (const fn of listeners.load) await fn();
    },
  };
  // window.KatakanaTerminator 要到 onLoad 之后才存在（BetterNCM 就是这个顺序），
  // 所以这里用 getter 延迟取值，别在 boot 阶段就抄一份 undefined。
  Object.defineProperty(env, "api", {
    get: function () {
      return window.KatakanaTerminator;
    },
  });
  return env;
}

function rubyCount(root) {
  return root.querySelectorAll("ruby.kt-ruby").length;
}

/** 底字文本（剔掉注音）——标准 ruby 里 <rt> 的文本也算 textContent，必须显式去掉 */
function baseText(el) {
  const clone = el.cloneNode(true);
  const anns = clone.querySelectorAll("rt.kt-rt, .kt-rt, rp");
  for (let i = 0; i < anns.length; i++) {
    if (anns[i].parentNode) anns[i].parentNode.removeChild(anns[i]);
  }
  return clone.textContent;
}

test("注入 5 个文件后，插件注册了 onLoad / onConfig", async () => {
  const env = bootPlugin(NCM_HTML);
  assert.strictEqual(env.listeners.load.length, 1, "应该注册了 onLoad");
  assert.strictEqual(env.listeners.config.length, 1, "应该注册了 onConfig");
  // window.KatakanaTerminator 是 onLoad 里导出的（BetterNCM 也是加载完才调 onLoad）
  await env.runLoad();
  assert.strictEqual(typeof env.window.KatakanaTerminator, "object", "onLoad 后应该导出 API");
  assert.strictEqual(env.api, env.window.KatakanaTerminator);
});

test("没有振假名插件时，含汉字的歌词行也要标（不能因为「有汉字」就整行让开）", async () => {
  // 真机事故：用户关掉 jp-furigana 之后，默认播放页整页没有注音，
  // RNP 页只有唯一不含汉字的那一行有注音。原因是让位条件写成了
  // `hasKanji && !(coexist && managed)` —— 共存开关默认关着，
  // 于是"有汉字"就等于"整行让开"，哪怕对方根本没管这一行。
  const env = bootPlugin(NCM_HTML); // 这个 DOM 里没有任何 jp-furigana 标记
  await env.runLoad();
  await sleep(600);

  // 播放栏用 DOM 注音
  assert.ok(env.document.querySelectorAll(".m-playbar ruby.kt-ruby").length > 0, "播放栏应该被标注");

  const lines = env.document.querySelectorAll("ul.lyric li p");
  // 含汉字的行：对方没管，就该我们标
  assert.ok(lines[0].querySelectorAll("ruby.kt-ruby").length >= 1, "对方没管的含汉字行应该被注音");
  assert.strictEqual(baseText(lines[0]), "コーヒーを飲みながら", "底字必须保持原样");
  // 纯假名行：也归我们
  assert.ok(lines[1].querySelectorAll("ruby.kt-ruby").length >= 1, "纯假名行应该被注音");

  assert.strictEqual(env.api.config.scope, "all");
});

test("振假名插件接管了这一行时，含汉字的行整个让给它", async () => {
  const env = bootPlugin(NCM_HTML);
  await env.runLoad();
  await sleep(300);
  // 模拟 jp-furigana 已经处理过这一行（它会给行挂 __fgText）
  env.document.querySelectorAll("ul.lyric li")[0].__fgText = "コーヒーを飲みながら";
  env.api.set("scope", "lyrics");
  await sleep(500);

  const kanjiLine = env.document.querySelectorAll("ul.lyric li p")[0];
  assert.strictEqual(kanjiLine.querySelectorAll("ruby.kt-ruby").length, 0, "对方管的行必须整个让出去");
  assert.strictEqual(baseText(kanjiLine), "コーヒーを飲みながら", "而且一个字节都不能改");
});

test("把范围切成「只标歌词」后，纯假名歌词会被 DOM 注音", async () => {
  const env = bootPlugin(NCM_HTML);
  await env.runLoad();
  await sleep(300);
  env.api.set("scope", "lyrics");
  await sleep(500);

  const p = env.document.querySelectorAll("ul.lyric li p")[1];
  assert.ok(p.querySelectorAll("ruby.kt-ruby").length >= 1, "纯片假名行应该被注音");
  const pairs = [...p.querySelectorAll("ruby.kt-ruby")].map((r) => [
    r.childNodes[0].nodeValue,
    r.querySelector(".kt-rt").textContent,
  ]);
  assert.ok(
    pairs.some((x) => x[0] === "ギター" && x[1] === "guitar"),
    "应该有 ギター -> guitar：" + JSON.stringify(pairs)
  );
  assert.strictEqual(baseText(p), "ギターとピアノのセッション", "底字必须保持原文");
});

test("标题栏（播放栏）里的片假名也被标注", async () => {
  const env = bootPlugin(NCM_HTML);
  await env.runLoad();
  await sleep(500);
  // 歌名「コーヒーとコンピューター」里两个词，歌手「ギター太郎」一个词
  const pairs = [];
  const rubies = env.document.querySelectorAll(".m-playbar ruby.kt-ruby");
  for (let i = 0; i < rubies.length; i++) pairs.push(rubies[i].querySelector(".kt-rt").textContent);
  assert.deepStrictEqual(pairs.sort(), ["coffee", "computer", "guitar"].sort());
  // 底字必须完好
  assert.strictEqual(baseText(env.document.querySelector(".m-playbar .name")), "コーヒーとコンピューター");
  assert.strictEqual(baseText(env.document.querySelector(".m-playbar .by")), "ギター太郎");
});

test("关掉「标注播放栏」后播放栏不再被标注", async () => {
  const env = bootPlugin(NCM_HTML);
  await env.runLoad();
  await sleep(400);
  assert.ok(rubyCount(env.document.querySelector(".m-playbar")) > 0, "先确认播放栏已被标注");
  env.api.set("scope", "lyrics"); // 只标歌词 -> 播放栏不再走 DOM 注音
  await sleep(600);

  assert.strictEqual(rubyCount(env.document.querySelector(".m-playbar")), 0, "切到只标歌词后，播放栏不该被标注");
});

test("禁用后 DOM 完全还原，重新启用后又能标注", async () => {
  const env = bootPlugin(NCM_HTML);
  await env.runLoad();
  await sleep(500);
  const annotated = env.document.body.innerHTML;
  assert.ok(rubyCount(env.document.body) > 0);

  env.api.set("enabled", false);
  await sleep(200);
  assert.strictEqual(rubyCount(env.document.body), 0, "禁用后不该有注音");
  assert.strictEqual(env.document.querySelectorAll(".kt-region").length, 0);
  assert.ok(!env.document.body.innerHTML.includes("kt-ruby"), "禁用后 DOM 里不该有痕迹");
  // 我们注入的 <style> 也要收走：禁用之后页面里不该留下任何我们的东西
  assert.strictEqual(
    env.document.getElementById("katakana-terminator-style"),
    null,
    "禁用后应该把注入的样式表摘掉"
  );

  env.api.set("enabled", true);
  await sleep(500);
  assert.strictEqual(env.document.body.innerHTML, annotated, "重新启用后应该回到同样的结果");
  assert.ok(env.document.getElementById("katakana-terminator-style"), "重新启用后样式要补回来");
});

test("断网时依然能用离线词典标注", async () => {
  const env = bootPlugin(NCM_HTML);
  await env.runLoad();
  await sleep(400);
  env.api.set("scope", "lyrics"); // 这里验证的是歌词的 DOM 注音
  await sleep(600);
  // fetch 全程失败，但词典命中的词照样标上（用纯片假名行，含汉字的行归振假名插件）
  const rt = env.document.querySelectorAll("ul.lyric li p")[1].querySelector("ruby.kt-ruby .kt-rt");
  assert.ok(rt, "应该有用离线词典标出来的注音");
  assert.strictEqual(rt.textContent, "guitar");
  const stats = env.api.stats();
  assert.ok(stats.dictHits > 0, "应该走了离线词典");
});

test("对方把注音抹掉后，必须在下一帧之前补回来（不能等 250ms 才补）", async () => {
  // 真机轨迹里的现场：RNP 歌词行出现后会分几次补齐（罗马音层陆续到达），
  // 每次都让 jp-furigana 重建该行，我们的注音 age≈500ms 就被毁一次。
  // 而重扫以前要等 250ms（≈15 帧）—— 那一闪就是这么被看见的。
  const env = bootPlugin(NCM_HTML);
  await env.runLoad();
  await sleep(600);

  const line = env.document.querySelectorAll("ul.lyric li p")[1];
  assert.ok(line.querySelectorAll("ruby.kt-ruby").length >= 1, "前提：先注上音");

  // 模拟对方重建这一段：把这一行的内容换成纯文本（我们的注音随之消失）
  line.textContent = "ギターとピアノのセッション";

  // 只等一帧多一点的时间：如果重扫还是 250ms 的防抖，这里必然还没补上
  await sleep(60);
  assert.ok(
    line.querySelectorAll("ruby.kt-ruby").length >= 1,
    "应该在本帧内就补回来（等了 60ms 仍没有，说明还在走 250ms 防抖）"
  );
  assert.strictEqual(baseText(line), "ギターとピアノのセッション", "底字必须保持原文");
});

test("对方重建完一行直接叫我们时，注音要在同一次调用里补好（不能等下一帧）", async () => {
  // 真机轨迹：对方每 ~200ms 重建一次当前行，我们靠 MutationObserver 被叫醒，
  // 补的动作要等下一帧才落地 —— 中间那一帧就是"没有注音"，肉眼就是一直在闪。
  // 共存补丁让 jp-furigana 重建完直接调 window.__ktRepairLine(line)，
  // 于是补注音和重建发生在同一个任务里，绘制时永远有注音。
  const env = bootPlugin(NCM_HTML);
  await env.runLoad();
  await sleep(600);

  assert.strictEqual(typeof env.window.__ktRepairLine, "function", "应该注册了同步补注音的钩子");

  const li = env.document.querySelectorAll("ul.lyric li")[1];
  const p = li.querySelector("p");
  assert.ok(p.querySelectorAll("ruby.kt-ruby").length >= 1, "前提：先注上音");

  // 模拟对方重建这一行：整行内容换新（我们的注音随之消失）
  const fresh = env.document.createTextNode("ギターとピアノのセッション");
  while (p.firstChild) p.removeChild(p.firstChild);
  p.appendChild(fresh);
  assert.strictEqual(p.querySelectorAll("ruby.kt-ruby").length, 0, "重建后注音应已消失");

  // 对方重建完直接叫我们 —— 调用返回时注音就必须已经补好
  const ok = env.window.__ktRepairLine(li);
  assert.strictEqual(ok, true, "钩子应该返回 true（真的补了）");
  assert.ok(
    p.querySelectorAll("ruby.kt-ruby").length >= 1,
    "钩子返回时注音必须已经就位（否则那一帧就是没有注音的样子）"
  );
  assert.strictEqual(baseText(p), "ギターとピアノのセッション", "底字必须保持原文");
});

test("钩子要链上去：不能把已经挂着的（拉丁字母片假名注音）顶掉", async () => {
  // window.__ktRepairLine 是全局的。谁先加载不该决定谁的功能还在：
  // 如果后加载的那个直接赋值，先加载的那家就再也收不到同步通知，
  // 于是它开始闪 —— 而且是"只有它一家闪"，非常难查。两个方向都必须能链。
  const env = bootPlugin(NCM_HTML);
  const called = [];
  env.window.__ktRepairLine = function () {
    called.push("prev");
  };
  await env.runLoad();
  await sleep(600);

  const li = env.document.querySelectorAll("ul.lyric li")[1];
  const p = li.querySelector("p");
  assert.ok(p.querySelectorAll("ruby.kt-ruby").length >= 1, "前提：先注上音");

  // 模拟对方重建这一行
  while (p.firstChild) p.removeChild(p.firstChild);
  p.appendChild(env.document.createTextNode("ギターとピアノのセッション"));

  const ok = env.window.__ktRepairLine(li);
  assert.strictEqual(ok, true, "自己该补的还是要补");
  assert.ok(p.querySelectorAll("ruby.kt-ruby").length >= 1, "注音要就位");
  assert.ok(called.indexOf("prev") >= 0, "前一个钩子也必须被调到（否则那一家会闪）");
});

test("设置面板能构建出来，控件反映当前配置，链接交给系统浏览器", () => {
  const env = bootPlugin(NCM_HTML);
  const root = env.listeners.config[0]();
  assert.ok(root, "onConfig 应该返回一个元素");
  assert.strictEqual(root.id, "katakana-terminator-config");

  const enabled = root.querySelector('[data-k="enabled"]');
  assert.ok(enabled, "应该有启用开关");
  assert.strictEqual(enabled.type, "checkbox");
  assert.strictEqual(enabled.checked, true);

  const rtSize = root.querySelector('[data-k="rtSize"]');
  assert.ok(rtSize, "应该有注音字号滑块");
  assert.strictEqual(rtSize.value, "60");
  assert.ok(root.querySelector('[data-v="rtSize"]'), "应该有数值回显");

  // 外链走 betterncm.ncm.openUrl，而不是直接导航
  const link = root.querySelector("[data-open]");
  assert.ok(link);
  let navigated = false;
  const ev = new env.window.MouseEvent("click", { bubbles: true, cancelable: true });
  link.addEventListener("click", () => {
    if (ev.defaultPrevented) navigated = true;
  });
  link.dispatchEvent(ev);
  assert.ok(env.opened.length >= 1, "应该调用了 openUrl");
  assert.ok(navigated, "应该 preventDefault");

  // 打开这一行的行内 <style> 之外不应污染页面
  assert.strictEqual(env.document.body.contains(root), false, "面板在插入 DOM 前是游离的（符合 BetterNCM 流程）");
});

test("设置面板改动会落盘到 localStorage", async () => {
  const env = bootPlugin(NCM_HTML, { dev: true });
  await env.runLoad();
  const root = env.listeners.config[0]();
  const rtSize = root.querySelector('[data-k="rtSize"]');
  rtSize.value = "80";
  rtSize.dispatchEvent(new env.window.Event("change"));

  const raw = env.window.localStorage.getItem("katakana-terminator.config");
  assert.ok(raw, "配置应该写进 localStorage");
  assert.strictEqual(JSON.parse(raw).rtSize, 80);
  assert.strictEqual(env.api.config.rtSize, 80);
});

test("缺少核心模块时优雅退出，不抛异常", () => {
  // 只注入 core 里的匹配器之前的状态：这里故意一个核心模块都不注入
  const ctx = loadCore(NCM_HTML, { translator: false });
  const window = ctx.window;
  window.fetch = () => Promise.reject(new Error("offline"));
  const listeners = [];
  window.plugin = {
    devMode: false,
    pluginPath: "",
    onLoad: (fn) => listeners.push(fn),
    onConfig: () => {},
  };
  window.betterncm = { app: {}, ncm: {}, fs: {} };
  // loadCore 已经把核心模块注进去了，这里清掉，模拟 injects 顺序被改坏
  for (const k of ["KTMatcher", "KTDict", "KTTranslate", "KTAnnotate"]) delete window[k];

  assert.doesNotThrow(() => {
    loadScripts(ctx.dom, ["main.js"]);
    for (const fn of listeners) fn();
  }, "缺依赖时不应抛异常");
  assert.strictEqual(window.KatakanaTerminator, undefined, "初始化失败就不该导出 API");
});

test("配置损坏时回退到默认值", () => {
  const env = bootPlugin(NCM_HTML);
  env.window.localStorage.setItem("katakana-terminator.config", "{ 这不是 JSON");
  const root = env.listeners.config[0]();
  const enabled = root.querySelector('[data-k="enabled"]');
  assert.strictEqual(enabled.checked, true, "坏配置应该回退到默认（启用）");
});
