/*
 * 真机联网自测：用真实的 core/translate.js + core/dict.js 打真接口，
 * 确认「在线翻译」这条路在当前网络下能走通。
 *
 *   set HTTPS_PROXY=http://127.0.0.1:7897
 *   node --use-system-ca tools/live-check.js
 */
"use strict";

process.env.NODE_USE_ENV_PROXY = "1";
if (!process.env.HTTPS_PROXY && process.env.https_proxy) process.env.HTTPS_PROXY = process.env.https_proxy;

const KTTranslate = require("../src/core/translate.js");
const KTDict = require("../src/core/dict.js");

const words = process.argv.slice(2);
const probes = words.length ? words : ["ズンドコパラダイス", "ソーシャルディスタンス", "メタバース"];

console.log("代理:", process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "(未设置)");
console.log("词典条目:", KTDict.count);
console.log("候选接口:", KTTranslate.ENDPOINTS.map((e) => e.label + " (" + e.kind + ")").join(", "));
console.log("");

const t = KTTranslate.createTranslator({
  online: true,
  log: (...a) => console.log("  log:", ...a),
  onStatus: (m) => console.log("  status:", m),
  onUpdate: () => console.log("  onUpdate: 有新译文"),
});

console.log("先看词典命中的词（应为同步返回）:");
for (const w of ["コーヒー", "コンピューター"]) {
  console.log("  " + w + " -> " + JSON.stringify(t.lookup(w)));
}

console.log("\n词典没有的词，进队列等在线结果:");
for (const w of probes) {
  console.log("  " + w + " -> " + JSON.stringify(t.lookup(w)) + " (pending=" + t.pending() + ")");
}

const deadline = Date.now() + 30000;
const timer = setInterval(() => {
  const done = probes.every((w) => t.lookup(w) !== null);
  if (done || Date.now() > deadline) {
    clearInterval(timer);
    console.log("\n最终结果:");
    for (const w of probes) console.log("  " + w + " -> " + JSON.stringify(t.lookup(w)));
    console.log("\n统计:", JSON.stringify(t.stats(), null, 2));
    const okCount = probes.filter((w) => t.lookup(w) !== null).length;
    console.log(`\n在线翻译成功 ${okCount}/${probes.length}`);
    process.exit(okCount > 0 ? 0 : 1);
  }
}, 500);
