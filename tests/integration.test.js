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

test("默认：含汉字的歌词行让给振假名插件，纯假名行归我们", async () => {
  const env = bootPlugin(NCM_HTML);
  await env.runLoad();
  await sleep(600);

  // 播放栏用 DOM 注音
  assert.ok(env.document.querySelectorAll(".m-playbar ruby.kt-ruby").length > 0, "播放栏应该被标注");

  const lines = env.document.querySelectorAll("ul.lyric li p");
  // 含汉字的行：整个让出去，我们一个字节都不碰
  assert.strictEqual(lines[0].querySelectorAll("ruby.kt-ruby").length, 0, "含汉字的行不该被我们改");
  assert.strictEqual(baseText(lines[0]), "コーヒーを飲みながら", "含汉字的行保持原样");
  // 纯假名行：归我们
  assert.ok(lines[1].querySelectorAll("ruby.kt-ruby").length >= 1, "纯假名行应该被注音");

  assert.strictEqual(env.api.config.scope, "all");
});

test("把范围切成「只标歌词」后，纯假名歌词会被 DOM 注音", async () => {
  const env = bootPlugin(NCM_HTML);
  await env.runLoad();
  await sleep(300);
  // 含汉字的行整体让给振假名插件，所以断言用的是纯片假名行
  // （这正是按行分工后归我们管的部分）。
  env.api.set("scope", "lyrics");
  await sleep(500);

  // 纯片假名的那一行（分工后归我们管）
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

  // 含汉字的那一行让给振假名插件，我们不该碰
  const kanjiLine = env.document.querySelectorAll("ul.lyric li p")[0];
  assert.strictEqual(kanjiLine.querySelectorAll("ruby.kt-ruby").length, 0, "含汉字的行必须整个让出去");
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

  env.api.set("enabled", true);
  await sleep(500);
  assert.strictEqual(env.document.body.innerHTML, annotated, "重新启用后应该回到同样的结果");
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
