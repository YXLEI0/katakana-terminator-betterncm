/*
 * core/translate.js + core/dict.js —— 词典、缓存、在线排队与失败降级。
 * 这里不碰真网络：把 window.fetch 换成假的，直接观察请求内容。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { loadCore } = require("./helpers");

/** 假接口：dict-chrome-ex 返回 ["行1\n行2\n..."] */
function installFakeFetch(ctx, impl) {
  const calls = [];
  ctx.window.fetch = function (url) {
    calls.push(String(url));
    try {
      return Promise.resolve(impl(url, calls.length));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  return calls;
}

/** 从请求 URL 里取出 q 参数（按行拆） */
function wordsOf(url) {
  const q = new URL(url).searchParams.get("q");
  return q.split("\n");
}

function okResponse(words, map) {
  const lines = words.map((w) => (map[w] !== undefined ? map[w] : w));
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve([lines.join("\n")]),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("离线词典能直接命中（同步、不发请求）", () => {
  const ctx = loadCore();
  const calls = installFakeFetch(ctx, (u) => okResponse(wordsOf(u), {}));
  const t = ctx.KTTranslate.createTranslator({ online: true });

  assert.strictEqual(t.lookup("コーヒー"), "coffee");
  assert.strictEqual(t.lookup("コンピューター"), "computer");
  assert.strictEqual(calls.length, 0, "词典命中不应该发请求");
  const s = t.stats();
  assert.ok(s.dictHits >= 2);
  assert.strictEqual(s.dictSize, ctx.KTDict.count);
});

test("词典里没有的词会排队，拿回结果后能查到", async () => {
  const ctx = loadCore();
  const calls = installFakeFetch(ctx, (u) => okResponse(wordsOf(u), { ズンドコ: "zundoko" }));
  let updates = 0;
  const t = ctx.KTTranslate.createTranslator({
    online: true,
    onUpdate: () => {
      updates++;
    },
  });

  assert.strictEqual(t.lookup("ズンドコ"), null, "首次查询应该是 null（异步补上）");
  assert.strictEqual(t.pending(), 1);
  await sleep(1600);
  assert.strictEqual(t.lookup("ズンドコ"), "zundoko");
  assert.strictEqual(updates, 1, "应该通知上层重扫一次");
  assert.ok(calls.length >= 1);
  assert.match(calls[0], /translate\.google\.cn/);
  assert.match(calls[0], /client=dict-chrome-ex/);
  assert.match(calls[0], /sl=ja/);
  assert.match(calls[0], /tl=en/);
});

test("同一批里的重复词只查一次", async () => {
  const ctx = loadCore();
  const calls = installFakeFetch(ctx, (u) => okResponse(wordsOf(u), { アレコレ: "this and that" }));
  const t = ctx.KTTranslate.createTranslator({ online: true });

  t.lookup("アレコレ");
  t.lookup("アレコレ");
  t.lookup("アレコレ");
  await sleep(1600);
  assert.strictEqual(calls.length, 1);
  const words = wordsOf(calls[0]);
  assert.deepStrictEqual(words, ["アレコレ"], "请求里不应该有重复词");
});

test("关掉在线时只用词典，不发请求", async () => {
  const ctx = loadCore();
  const calls = installFakeFetch(ctx, (u) => okResponse(wordsOf(u), {}));
  const t = ctx.KTTranslate.createTranslator({ online: false });

  assert.strictEqual(t.lookup("コーヒー"), "coffee");
  assert.strictEqual(t.lookup("ズンドコ"), null);
  await sleep(1600);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(t.pending(), 0);
});

test("接口失败时不影响词典，也不无限重试", async () => {
  const ctx = loadCore();
  let n = 0;
  const calls = installFakeFetch(ctx, () => {
    n++;
    return { ok: false, status: 500, json: () => Promise.resolve({}) };
  });
  const t = ctx.KTTranslate.createTranslator({ online: true });

  assert.strictEqual(t.lookup("コーヒー"), "coffee", "在线挂了，词典仍要能用");
  t.lookup("ズンドコ");
  // 两个 host 各试一次，然后就该记下失败、不再纠缠
  await sleep(5000);
  const s = t.stats();
  assert.ok(s.failures >= 1, "应该记录了失败");
  assert.ok(s.lastError, "应该记录最后一次错误");
  assert.strictEqual(t.lookup("ズンドコ"), null);
  const afterFailure = calls.length;
  assert.strictEqual(afterFailure, 2, `失败后应该刚好试完两个 host，实际 ${afterFailure} 次`);
  // 关键：反复 lookup 不应该再触发任何请求，否则页面一刷新就是请求风暴
  t.lookup("ズンドコ");
  t.lookup("ズンドコ");
  await sleep(2000);
  assert.strictEqual(calls.length, afterFailure, "失败过的词不应该每次查询都重发请求");
});

test("第一个 host 失败后换第二个 host 重试", async () => {
  const ctx = loadCore();
  const calls = installFakeFetch(ctx, (url) => {
    if (String(url).includes("translate.google.cn")) {
      return { ok: false, status: 429, json: () => Promise.resolve({}) };
    }
    return okResponse(wordsOf(url), { ズンドコ: "zundoko" });
  });
  const t = ctx.KTTranslate.createTranslator({ online: true });
  t.lookup("ズンドコ");
  await sleep(1600);
  assert.strictEqual(t.lookup("ズンドコ"), "zundoko", "换 host 之后应该成功");
  assert.ok(calls.some((u) => u.includes("translate.google.cn")));
  assert.ok(calls.some((u) => u.includes("translate.google.com")));
});

test("响应行数对不上时按失败处理（不会错位贴注音）", async () => {
  const ctx = loadCore();
  installFakeFetch(ctx, () => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(["only-one-line"]),
  }));
  const t = ctx.KTTranslate.createTranslator({ online: true });
  t.lookup("ズンドコ");
  t.lookup("パラダイス");
  await sleep(2500);
  assert.strictEqual(t.lookup("ズンドコ"), null);
  assert.strictEqual(t.lookup("パラダイス"), null);
  assert.ok(t.stats().failures >= 1);
});

test("翻译结果写入本地缓存后，新实例能直接读到", async () => {
  const ctx = loadCore();
  installFakeFetch(ctx, (u) => okResponse(wordsOf(u), { ズンドコ: "zundoko" }));
  const t1 = ctx.KTTranslate.createTranslator({ online: true });
  t1.lookup("ズンドコ");
  await sleep(1600);
  t1.flushCache();
  await sleep(50);

  const raw = ctx.window.localStorage.getItem(ctx.KTTranslate.CACHE_KEY);
  assert.ok(raw, "缓存应该写进了 localStorage");
  assert.match(raw, /zundoko/);

  // 新实例：即使在线关掉，也应该能从缓存里读到
  const t2 = ctx.KTTranslate.createTranslator({ online: false });
  assert.strictEqual(t2.lookup("ズンドコ"), "zundoko");
});

test("清除缓存后本地不再留下词条", async () => {
  const ctx = loadCore();
  installFakeFetch(ctx, (u) => okResponse(wordsOf(u), { ズンドコ: "zundoko" }));
  const t = ctx.KTTranslate.createTranslator({ online: true });
  t.lookup("ズンドコ");
  await sleep(1600);
  t.clearCache();
  assert.strictEqual(ctx.window.localStorage.getItem(ctx.KTTranslate.CACHE_KEY), null);
  assert.strictEqual(t.stats().cached, 0);
});

test("retryMisses 把查不到的词重新排队", async () => {
  const ctx = loadCore();
  let fail = true;
  const calls = installFakeFetch(ctx, (u) => {
    if (fail) return { ok: false, status: 500, json: () => Promise.resolve({}) };
    return okResponse(wordsOf(u), { ズンドコ: "zundoko" });
  });
  const t = ctx.KTTranslate.createTranslator({ online: true });
  t.lookup("ズンドコ");
  await sleep(5000);
  assert.strictEqual(t.lookup("ズンドコ"), null);

  fail = false;
  const n = t.retryMisses();
  assert.strictEqual(n, 1);
  await sleep(1600);
  assert.strictEqual(t.lookup("ズンドコ"), "zundoko");
  assert.ok(calls.length >= 3, `应该又发了请求，实际 ${calls.length} 次`);
});

test("打开在线开关会把之前 miss 的词补上", async () => {
  const ctx = loadCore();
  installFakeFetch(ctx, (u) => okResponse(wordsOf(u), { ズンドコ: "zundoko" }));
  const t = ctx.KTTranslate.createTranslator({ online: false });
  assert.strictEqual(t.lookup("ズンドコ"), null);
  assert.strictEqual(t.pending(), 0, "在线关着的时候不应该排队");
  // miss 已经被记下来了，所以打开开关后能立刻重新排队
  t.setOnline(true);
  await sleep(1600);
  assert.strictEqual(t.lookup("ズンドコ"), "zundoko");
});

test("空词与无意义输入不会进队列", async () => {
  const ctx = loadCore();
  const calls = installFakeFetch(ctx, (u) => okResponse(wordsOf(u), {}));
  const t = ctx.KTTranslate.createTranslator({ online: true });
  assert.strictEqual(t.lookup(""), null);
  assert.strictEqual(t.lookup(null), null);
  assert.strictEqual(t.lookup(undefined), null);
  await sleep(1600);
  assert.strictEqual(calls.length, 0);
});

test("词典数据本身干净：键是片假名、值是非空英文", () => {
  const ctx = loadCore();
  const words = ctx.KTDict.words;
  const keys = Object.keys(words);
  assert.ok(keys.length >= 300, `词典条目偏少：${keys.length}`);
  let bad = 0;
  for (const k of keys) {
    const v = words[k];
    if (!/^[\u30A1-\u30F6\u30FC]+$/.test(k)) bad++;
    if (typeof v !== "string" || !v.trim() || !/[A-Za-z]/.test(v)) bad++;
  }
  assert.strictEqual(bad, 0, "词典里有格式不对的条目");
});
