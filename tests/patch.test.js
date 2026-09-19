/*
 * 共存补丁工具的自检。
 *
 * 补丁是打在**别人的插件**上的，锚点错了会直接中止（不写文件），
 * 但更容易出的问题是「jp-furigana 升级后锚点对不上，我们却不知道」——
 * 所以这里用一段**照抄真实源码**的样本固定住四处锚点，
 * 任何一处被改动都会在这里失败。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const { applyPatch, revertPatch, isPatched, MARK } = require("../tools/patch-jp-furigana.js");

/*
 * 样本：四处锚点原文必须逐字节一致。
 * 前三处来自 jp-furigana 1.1.0 / 1.0.2 的 main.js，第四处是 hostsText。
 */
const FIXTURE = [
  "(() => {",
  "\tfunction restore(host) {",
  "\t\tconst wrap = host.__fgWrap;",
  "\t\tif (wrap && wrap.parentNode === host) {",
  "\t\t\twrap.remove();",
  "\t\t\t// 只有当 React 没有自己重建过内容时，才把原来的节点放回去",
  "\t\t\tif (!host.hasChildNodes() && host.__fgOrig && host.__fgOrig.length)",
  "\t\t\t\thost.append(...host.__fgOrig);",
  "\t\t}",
  "\t\thost.__fgWrap = null;",
  "\t}",
  "\tfunction hostsText(line) {",
  "\t\tlet out = '';",
  "\t\tfor (const h of line.__fgHosts || [])",
  "\t\t\tfor (const n of h.__fgOrig || []) out += n.textContent;",
  "\t\treturn out;",
  "\t}",
  "\tfunction isClean(line) {",
  "\t\tconst hosts = line.__fgHosts;",
  "\t\tfor (const h of hosts) {",
  "\t\t\tif (!h.isConnected) return false;",
  "\t\t\tif (h.childNodes.length !== 1) return false;",
  "\t\t}",
  "\t\treturn hostsText(line) === line.__fgText;",
  "\t}",
  "\tconst observer = new MutationObserver((records) => {",
  "\t\tlet relevant = false;",
  "\t\t\tfor (const r of records) {",
  "\t\t\t\t// 只关心文字和结构变化",
  "\t\t\t\tif (r.type !== 'characterData' && r.type !== 'childList') continue;",
  "\t\t\t\trelevant = true;",
  "\t\t\t}",
  "\t});",
  "\tfunction processLine(line) {",
  "\t\tline.__fgText = text;",
  "\t\tline.__fgHosts = hosts;",
  "\t\tline.__fgMirrors = mirrors;",
  "\t\treturn true;",
  "\t}",
  "})();",
  "",
].join("\n");

/** 五处锚点 —— 少一处就说明补丁会打不全 */
const ANCHORS = [
  "if (h.childNodes.length !== 1) return false;",
  "wrap.remove();",
  "if (r.type !== 'characterData' && r.type !== 'childList') continue;",
  "for (const n of h.__fgOrig || []) out += n.textContent;",
  "line.__fgMirrors = mirrors;",
];

test("五处锚点在样本里都能找到", () => {
  for (const a of ANCHORS) {
    assert.ok(FIXTURE.indexOf(a) >= 0, "样本缺少锚点（补丁会打不上）：" + a);
  }
});

test("五处补丁全部应用，且结果语法正确、锚点不再残留", () => {
  const r = applyPatch(FIXTURE);
  assert.strictEqual(r.error, undefined, "不该有锚点缺失：" + JSON.stringify(r.error));
  assert.strictEqual(r.applied.length, 5, "应该应用 5 处：" + JSON.stringify(r.applied));
  assert.ok(isPatched(r.src));
  // 打完补丁的代码必须是合法 JS —— 打坏别人的插件是最坏的结果
  assert.doesNotThrow(() => new vm.Script(r.src), "补丁后的代码语法必须正确");
  // 被整段替换掉的两处原文不该再出现
  // （另三处是"原地加一句"，原文本来就要留着，见下面的断言）
  for (const gone of [
    "if (h.childNodes.length !== 1) return false;",
    "for (const n of h.__fgOrig || []) out += n.textContent;",
  ]) {
    assert.strictEqual(r.src.indexOf(gone), -1, "打完补丁后不该还留着原文：" + gone);
  }
  // 原地插入：原文要留着，同时多出我们的那几行
  assert.ok(r.src.indexOf("if (__ktRecordIsOurs(r)) continue;") > 0, "observer 该忽略我们的变更");
  assert.ok(r.src.indexOf("host.__ktForeign = __ktNodes;") > 0, "restore 该暂存外来注音");
  assert.ok(r.src.indexOf("window.__ktRepairLine(line);") > 0, "重建完该同步叫我们补注音");
  // 我们的实现细节要在里面
  assert.ok(r.src.indexOf("__ktIsForeign") > 0, "应该注入 helper");
  assert.ok(r.src.indexOf("__ktRecordIsOurs") > 0, "应该注入 helper");
  assert.ok(r.src.indexOf("__ktOwnChildCount(h) !== 1") > 0, "isClean 应该换成忽略外来节点的计数");
  assert.ok(r.src.indexOf("out += plainText(n);") > 0, "hostsText 应该走 plainText 分支");
});

test("重复打补丁是幂等的（不会打两遍）", () => {
  const once = applyPatch(FIXTURE).src;
  const twice = applyPatch(once);
  assert.strictEqual(twice.already, true, "第二次应该识别出已打补丁");
  assert.strictEqual(twice.src, once, "已打补丁的内容不该被改动");
});

test("revertPatch 能逐字节还原（含 helper 块）", () => {
  const applied = applyPatch(FIXTURE).src;
  const back = revertPatch(applied, FIXTURE);
  assert.strictEqual(back.exact, true, "给了原文就应该逐字节还原");
  assert.strictEqual(back.src, FIXTURE, "还原结果必须与原文完全一致");
  assert.strictEqual(isPatched(back.src), false, "还原后不该还有补丁标记");
  assert.strictEqual(back.src.indexOf("__ktIsForeign"), -1, "helper 必须被完整摘掉");
});

test("锚点缺失时中止，不改内容也不抛异常", () => {
  const broken = FIXTURE.replace("for (const n of h.__fgOrig || []) out += n.textContent;", "for (const n of h.__fgOrig || []) out += n.innerText;");
  const r = applyPatch(broken);
  assert.ok(Array.isArray(r.error) && r.error.length === 1, "应该只报缺的那一处：" + JSON.stringify(r.error));
  assert.strictEqual(r.src, broken, "有锚点缺失时不能改动源码");
});
