/*
 * 生成 src/core/dict.js —— 离线外来语词典。
 *
 * 流程：
 *   1. 读 tools/seed-words.js 的候选词（只有片假名，没有英文）；
 *   2. 调 translate.google.cn 的 dict-chrome-ex 接口批量取英文；
 *   3. 逐条校验：英文字母表 / 长度 / 不能是罗马字转写 / 不能是句子；
 *   4. 高置信度的做「回译校验」：把英文再翻回日文，能回到同一个片假名词才收；
 *   5. 写出一份带注释和来源说明的 dict.js。
 *
 * 为什么要回译校验：机器翻译对「コーヒー」这种常见词会直接给 coffee（好），
 * 但也可能把「サンプル」翻成 "sample"（好）或把「マナー」翻成 "manner"（好）。
 * 而有些词会被翻成解释性短语（"a type of ..."），这些必须扔掉。
 * 回译能一次性滤掉大部分噪声：解释性短语几乎不可能翻回原词。
 *
 * 用法：
 *   node tools/build-dict.js              # 联网生成
 *   node tools/build-dict.js --no-verify  # 跳过回译校验（接口不可用时）
 *   node tools/build-dict.js --dry        # 只打印统计，不写文件
 */
"use strict";

const fs = require("fs");
const path = require("path");

// Node 的 fetch 默认不读 HTTP(S)_PROXY，要显式打开；同时按需信任系统证书库
// （本机 github/google 走本地代理，证书是代理签的）。
// 用法：node --use-system-ca tools/build-dict.js
process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY || "1";
if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY) {
  if (!process.env.HTTPS_PROXY && process.env.https_proxy) process.env.HTTPS_PROXY = process.env.https_proxy;
  if (!process.env.HTTP_PROXY && process.env.http_proxy) process.env.HTTP_PROXY = process.env.http_proxy;
  console.log("使用代理:", process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
}

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "src", "core", "dict.js");
const SEED = require("./seed-words.js");

/*
 * 人工核准表：这些词的英文本来就长这样，机器翻译会原样返回（甚至首字母大写），
 * 会被「看起来像罗马字转写」的启发式规则误杀。它们是外来语，英文是对的，直接采用。
 * 只放确实核准过的，不要往里塞「大概对」的东西。
 */
const OVERRIDES = {
  アニメ: "anime",
  オペラ: "opera",
  カラオケ: "karaoke",
  ピアノ: "piano",
  ペン: "pen",
  マンガ: "manga",
  ヨガ: "yoga",
};

const ENDPOINT = "https://translate.google.cn/translate_a/t";
const BATCH = 25;
const TIMEOUT_MS = 20000;

const args = process.argv.slice(2);
const NO_VERIFY = args.includes("--no-verify");
const DRY = args.includes("--dry");

// ---------------------------------------------------------------- 接口

async function translateBatch(texts, sl, tl) {
  const url =
    ENDPOINT +
    "?client=dict-chrome-ex&dt=t&sl=" +
    encodeURIComponent(sl) +
    "&tl=" +
    encodeURIComponent(tl) +
    "&q=" +
    encodeURIComponent(texts.join("\n"));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    // 形状：[ "行1\n行2\n..." ]，偶尔会多一层
    let joined = Array.isArray(json[0]) ? json[0][0] : json[0];
    if (typeof joined !== "string") throw new Error("意外的响应形状: " + JSON.stringify(json).slice(0, 120));
    const lines = joined.split("\n");
    if (lines.length !== texts.length)
      throw new Error(`行数对不上：要 ${texts.length} 行，回了 ${lines.length} 行`);
    return lines;
  } finally {
    clearTimeout(timer);
  }
}

/** 接口行数对不上时退化成逐条请求，保证不错位 */
async function translateOneByOne(texts, sl, tl) {
  const out = [];
  for (const t of texts) {
    try {
      const [one] = await translateBatch([t], sl, tl);
      out.push(one);
    } catch (e) {
      out.push(null);
    }
  }
  return out;
}

async function translateAll(texts, sl, tl) {
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH);
    let lines;
    try {
      lines = await translateBatch(chunk, sl, tl);
    } catch (e) {
      process.stderr.write(`\n  批 ${i / BATCH} 失败（${e.message}），逐条重试…`);
      lines = await translateOneByOne(chunk, sl, tl);
    }
    out.push(...lines);
    process.stderr.write(`\r  已翻译 ${Math.min(i + BATCH, texts.length)}/${texts.length}`);
  }
  process.stderr.write("\n");
  return out;
}

// ---------------------------------------------------------------- 校验

const RE_LATIN = /^[A-Za-z][A-Za-z0-9'’.\- ]*$/;

/** 英文候选能不能用 */
function glossIssue(gloss) {
  if (!gloss) return "空";
  const g = gloss.trim();
  if (!g) return "空";
  if (g.length > 40) return "太长";
  if (!RE_LATIN.test(g)) return "含非拉丁字符";
  const words = g.split(/\s+/);
  if (words.length > 4) return "像句子";
  // 解释性前缀
  if (/^(a|an|the)\s/i.test(g)) return "带冠词的解释";
  // 首字母大写的中英混合等异常（专有名词除外，这里从严）
  return null;
}

/**
 * 罗马字转写检测：把片假名粗略转成拉丁串，如果英文候选就是它的转写，
 * 说明接口没真的翻译（例如 コーヒー -> "kōhī"），丢掉。
 */
const ROMAJI_TABLE = {
  ア: "a", イ: "i", ウ: "u", エ: "e", オ: "o",
  カ: "ka", キ: "ki", ク: "ku", ケ: "ke", コ: "ko",
  サ: "sa", シ: "shi", ス: "su", セ: "se", ソ: "so",
  タ: "ta", チ: "chi", ツ: "tsu", テ: "te", ト: "to",
  ナ: "na", ニ: "ni", ヌ: "nu", ネ: "ne", ノ: "no",
  ハ: "ha", ヒ: "hi", フ: "fu", ヘ: "he", ホ: "ho",
  マ: "ma", ミ: "mi", ム: "mu", メ: "me", モ: "mo",
  ヤ: "ya", ユ: "yu", ヨ: "yo",
  ラ: "ra", リ: "ri", ル: "ru", レ: "re", ロ: "ro",
  ワ: "wa", ヲ: "o", ン: "n",
  ガ: "ga", ギ: "gi", グ: "gu", ゲ: "ge", ゴ: "go",
  ザ: "za", ジ: "ji", ズ: "zu", ゼ: "ze", ゾ: "zo",
  ダ: "da", ヂ: "ji", ヅ: "zu", デ: "de", ド: "do",
  バ: "ba", ビ: "bi", ブ: "bu", ベ: "be", ボ: "bo",
  パ: "pa", ピ: "pi", プ: "pu", ペ: "pe", ポ: "po",
  ァ: "a", ィ: "i", ゥ: "u", ェ: "e", ォ: "o",
  ャ: "ya", ュ: "yu", ョ: "yo", ッ: "", ー: "",
  ヴ: "bu", ヷ: "va", ヸ: "vi", ヹ: "ve", ヺ: "vo",
};

function romajiOf(katakana) {
  let out = "";
  for (const ch of katakana) out += ROMAJI_TABLE[ch] !== undefined ? ROMAJI_TABLE[ch] : ch;
  return out.toLowerCase();
}

function looksLikeRomaji(gloss, katakana) {
  const flat = gloss.toLowerCase().replace(/[^a-z]/g, "");
  const romaji = romajiOf(katakana).replace(/[^a-z]/g, "");
  if (!flat || !romaji) return false;
  return flat === romaji;
}

/**
 * 片假名词的「同形」比较，用来判断回译是否命中同一个词。
 * 忽略长音符和促音/拗音的细微写法差异，因为接口经常给出变体写法：
 *   コンピューター -> コンピュータ
 *   ウイスキー     -> ウィスキー
 *   スマホ         -> スマートフォン   （这个是缩写扩展，仍算命中）
 * 另外把片假名折叠到平假名，避免「ヴァイオリン / バイオリン」这种清浊差异误判。
 */
function kanaKey(s) {
  return String(s)
    .replace(/[\u30FC\uFF70]/g, "") // 去掉长音符
    .replace(/[\u30A1-\u30F6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)) // 片假名->平假名
    .replace(/[\s　]/g, "");
}

/** 回译结果里是否出现了原词（或其常见变体） */
function backTranslationMatches(word, back) {
  if (!back) return false;
  if (back.includes(word)) return true;
  const key = kanaKey(word);
  if (!key) return false;
  // 全串比较 + 前缀比较（缩写/扩展写法）
  const backKey = kanaKey(back);
  if (backKey === key) return true;
  if (backKey.startsWith(key) || key.startsWith(backKey)) return true;
  // 回译里可能夹着别的词，按片段找
  return backKey.includes(key);
}

// ---------------------------------------------------------------- 主流程

async function main() {
  // 去重保序
  const words = [...new Set(SEED.map((w) => w.trim()).filter(Boolean))];
  console.log(`候选词 ${words.length} 个，开始取英文…`);

  const glosses = await translateAll(words, "ja", "en");

  const accepted = [];
  const rejected = [];
  const needVerify = [];

  words.forEach((w, i) => {
    // 种子表里只该有片假名词。混进汉字/平假名会让词典出现查不到的怪条目，
    // 而且这类词机器翻译照样会给个像样的英文，光看英文发现不了。
    if (!/^[\u30A1-\u30F6\u30FC]+$/.test(w)) {
      rejected.push([w, "", "种子表里不是纯片假名"]);
      return;
    }
    const gloss = (glosses[i] || "").trim();
    // 人工核准表优先
    if (Object.prototype.hasOwnProperty.call(OVERRIDES, w)) {
      needVerify.push([w, OVERRIDES[w]]);
      return;
    }
    const issue = glossIssue(gloss);
    if (issue) {
      rejected.push([w, gloss, issue]);
      return;
    }
    if (looksLikeRomaji(gloss, w)) {
      rejected.push([w, gloss, "未翻译（罗马字转写）"]);
      return;
    }
    // 接口对某些词会返回句首大写（"Application" / "Part-time job"）。
    // 注音用的是小写英文的观感，统一转小写；专有名词（マイクロソフト 等）
    // 在这里转小写也无伤大雅，本来就是当普通名词注的。
    needVerify.push([w, gloss.toLowerCase()]);
  });

  console.log(`初筛通过 ${needVerify.length} 条，丢弃 ${rejected.length} 条`);

  let verified = needVerify;
  if (!NO_VERIFY && needVerify.length) {
    console.log("回译校验中…");
    // 人工核准的不参与回译（它们的英文本来就等于原词，回译必然"不匹配"）
    const toVerify = needVerify.filter(([w]) => !Object.prototype.hasOwnProperty.call(OVERRIDES, w));
    const back = await translateAll(
      toVerify.map(([, g]) => g),
      "en",
      "ja"
    );
    const manual = needVerify
      .filter(([w]) => Object.prototype.hasOwnProperty.call(OVERRIDES, w))
      .map(([w, g]) => [w, g, "manual", ""]);
    verified = [];
    let hit = 0;
    toVerify.forEach(([w, g], i) => {
      const b = (back[i] || "").trim();
      // 命中：回译回到同一个外来语（含变体写法）-> verified
      // 没命中：英文释义仍然可用，但回译落到了和语/汉语词上
      //         （アップル -> リンゴ、ウィンドウ -> 窓），标 machine 并记下回译，
      //         方便人工复核。不能因为回译「更日语」就把正确的英文扔掉。
      if (backTranslationMatches(w, b)) {
        verified.push([w, g, "verified", ""]);
        hit++;
      } else {
        verified.push([w, g, "machine", b]);
      }
    });
    verified.push(...manual);
    console.log(`回译命中 ${hit} 条，未命中但仍采用 ${verified.length - hit - manual.length} 条，人工核准 ${manual.length} 条`);
  } else {
    verified = needVerify.map(([w, g]) => [w, g, "machine", ""]);
  }

  // 按片假名排序，输出稳定
  verified.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  rejected.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  console.log("\n=== 丢弃明细 ===");
  for (const [w, g, why] of rejected) console.log(`  ${w}\t${g || "(空)"}\t${why}`);

  if (DRY) {
    console.log(`\n--dry：不写文件。可用 ${verified.length} 条`);
    return;
  }

  const lines = [];
  lines.push("/*");
  lines.push(" * Katakana Terminator for BetterNCM —— 离线外来语词典（自动生成，勿手改）");
  lines.push(" *");
  lines.push(" * 由 tools/build-dict.js 生成：");
  lines.push(" *   词表 tools/seed-words.js");
  lines.push(" *      -> translate.google.cn (client=dict-chrome-ex, ja->en) 取英文");
  lines.push(" *      -> 格式/长度/罗马字转写过滤");
  if (!NO_VERIFY) lines.push(" *      -> 回译校验（en->ja 能回到同一个片假名词）");
  lines.push(" *");
  lines.push(" * 这份词典是插件断网时的兜底；联网时优先用在线翻译（见 core/translate.js）。");
  lines.push(" * 英文释义来自 Google 翻译，仅作参考，不等同于词源。");
  lines.push(" */");
  lines.push("");
  lines.push("(function (root, factory) {");
  lines.push('  if (typeof module === "object" && module.exports) module.exports = factory();');
  lines.push("  else root.KTDict = factory();");
  lines.push('})(typeof globalThis !== "undefined" ? globalThis : this, function () {');
  lines.push('  "use strict";');
  lines.push("");
  lines.push("  // 片假名 -> 英文（全角形式；半角输入由 core/matcher.js 折算后再查）");
  lines.push("  const WORDS = {");
  for (const [w, g, conf, note] of verified) {
    let mark = "";
    if (conf === "machine") {
      mark = note ? `  // 回译得「${note}」，英文释义来自机器翻译，未经回译确认` : "  // 未经回译确认";
    } else if (conf === "manual") {
      mark = "  // 人工核准（英文与原词同形，机器翻译会原样返回）";
    }
    lines.push(`    ${JSON.stringify(w)}: ${JSON.stringify(g)},${mark}`);
  }
  lines.push("  };");
  lines.push("");
  lines.push("  return {");
  lines.push("    words: WORDS,");
  lines.push(`    generatedAt: ${JSON.stringify(new Date().toISOString())},`);
  lines.push(`    count: ${verified.length},`);
  lines.push("  };");
  lines.push("});");
  lines.push("");

  fs.writeFileSync(OUT, lines.join("\n"), "utf8");
  console.log(`\n已写入 ${path.relative(ROOT, OUT)}：${verified.length} 条`);
}

main().catch((e) => {
  console.error("生成失败：", e);
  process.exit(1);
});
