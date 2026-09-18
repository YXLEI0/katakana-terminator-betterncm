/*
 * core/matcher.js —— 片假名识别与半角折算。
 * 这些断言尽量对齐原版 katakana-terminator.user.js 里那条正则的行为，
 * 因为「哪些字符串算一个片假名词」直接决定注音长什么样。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { loadCore } = require("./helpers");

const ctx = loadCore();
const M = ctx.KTMatcher;

// 注意：scan() 在 jsdom 的 realm 里跑，返回的数组原型来自那个 realm，
// assert.deepStrictEqual 会因为它和本文件的 Array.prototype 不是同一个而报
// 「same structure but not reference-equal」。所以这里复制成本 realm 的普通数组。
function texts(s) {
  const out = [];
  const tokens = M.scan(s);
  for (let i = 0; i < tokens.length; i++) out.push(tokens[i].text);
  return out;
}

test("匹配最基本的片假名词", () => {
  assert.deepStrictEqual(texts("コーヒー"), ["コーヒー"]);
  assert.deepStrictEqual(texts("コンピューター"), ["コンピューター"]);
});

test("一个文本节点里可以有多个词", () => {
  assert.deepStrictEqual(texts("コーヒーとコンピューター"), ["コーヒー", "コンピューター"]);
});

test("中黑是分隔符，不进词", () => {
  // 「コーヒー・カップ」是两个词，・ 绝不能进词，否则词典查不到
  assert.deepStrictEqual(texts("コーヒー・カップ"), ["コーヒー", "カップ"]);
  assert.deepStrictEqual(texts("コーヒー･カップ"), ["コーヒー", "カップ"]);
});

test("长音符可以出现在词中间和结尾", () => {
  assert.deepStrictEqual(texts("スーパーマーケット"), ["スーパーマーケット"]);
  assert.deepStrictEqual(texts("サーバー"), ["サーバー"]);
  assert.deepStrictEqual(texts("メーカー"), ["メーカー"]);
});

test("跨文本节点的合成分段都能识别", () => {
  // 这些是常见的合成词
  assert.deepStrictEqual(texts("インターネット"), ["インターネット"]);
  assert.deepStrictEqual(texts("スマートフォン"), ["スマートフォン"]);
  assert.deepStrictEqual(texts("ボーナスステージ"), ["ボーナスステージ"]);
});

test("平假名、汉字、拉丁字母都不算片假名", () => {
  assert.deepStrictEqual(texts("これは漢字とabc"), []);
  assert.deepStrictEqual(texts("ひらがな"), []);
  assert.strictEqual(M.hasKatakana("ひらがな漢字abc"), false);
  assert.strictEqual(M.hasKatakana("カタカナ"), true);
});

test("悬空的长音符不成词", () => {
  // 「ーーー」没有意义，不能当成一个词送去翻译
  assert.deepStrictEqual(texts("ーーー"), []);
  assert.deepStrictEqual(texts("あーーー"), []);
});

test("单词不成词（单字片假名不主动送去翻译）", () => {
  const tokens = M.scan("ア");
  assert.strictEqual(tokens.length, 1);
  assert.strictEqual(M.looksTranslatable(tokens[0]), false);
});

test("半角片假名折算成全角", () => {
  assert.strictEqual(M.normalize("ｺｰﾋｰ"), "コーヒー");
  assert.strictEqual(M.normalize("ﾃﾞｼﾞﾀﾙ"), "デジタル");
  assert.strictEqual(M.normalize("ｲﾝﾀｰﾈｯﾄ"), "インターネット");
  assert.strictEqual(M.normalize("ﾂｰﾙ"), "ツール");
});

test("半角输入的词也能被识别，并给出全角形式", () => {
  const tokens = M.scan("ﾃﾞｼﾞﾀﾙ");
  assert.strictEqual(tokens.length, 1);
  assert.strictEqual(tokens[0].text, "ﾃﾞｼﾞﾀﾙ");
  assert.strictEqual(tokens[0].norm, "デジタル");
});

test("全角输入不做多余的改写", () => {
  const t = M.scan("コーヒー")[0];
  assert.strictEqual(t.norm, "コーヒー");
});

test("start/end 下标能精确切回原文", () => {
  const s = "abcコーヒーdef";
  const t = M.scan(s)[0];
  assert.strictEqual(s.slice(t.start, t.end), "コーヒー");
  assert.strictEqual(t.text, "コーヒー");
});

test("浊点/半浊点组合的片假名", () => {
  assert.deepStrictEqual(texts("ヴォーカル"), ["ヴォーカル"]);
  assert.deepStrictEqual(texts("パーティー"), ["パーティー"]);
  assert.deepStrictEqual(texts("ギター"), ["ギター"]);
});

test("混在日文句子里的外来语", () => {
  assert.deepStrictEqual(texts("これはコンピューターです"), ["コンピューター"]);
  assert.deepStrictEqual(texts("コーヒーを飲む"), ["コーヒー"]);
});
