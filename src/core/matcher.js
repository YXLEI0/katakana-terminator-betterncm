/*
 * Katakana Terminator for BetterNCM —— 片假名匹配
 *
 * 从 Katakana Terminator（Arnie97, MIT）的 katakana-terminator.user.js 移植的
 * 片假名识别逻辑，改写成了不分配多余对象的分段扫描器：
 * 原版每处理一个文本节点都跑一次正则 + splitText，这里改成一次 linear scan，
 * 同时把半角片假名（ﾂｰﾙ / ｺｰﾋｰ / ﾃﾞｼﾞﾀﾙ）折算成全角，好查词典。
 *
 * 挂到 globalThis.KT。既能在浏览器里按 <script> 加载，也能在 Node 里直接
 * require（UMD 那套壳，见文件末尾）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KTMatcher = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 片假名区段。注意：
  //  - 刻意不含 ・(U+30FB，中黑) 和 ･(U+FF65，半角中黑)：
  //    它们是词与词的分隔符（「コーヒー・カップ」），算进词里会污染词典查找。
  //  - ヷヸヹヺ(U+30F7-30FA) 和 ヿ(U+30FF) 原版正则也排除，保持一致。
  const RE_KATAKANA = /[\u30A1-\u30F6\u30FD\u30FE]/; // ァ-ヶ ヽヾ
  const RE_HALFWIDTH = /[\uFF66-\uFF9D]/; // ｦ-ﾝ

  // 「续接字符」：本身不是片假名，但可以出现在片假名词中间/末尾。
  // 長音符 ー 单独成词时没有意义（「ーーー」这种），只有跟在片假名后面才算词的一部分。
  const RE_CONTINUE = /[\u30A0\u30FC\u3099\u309A\uFF70\uFF9E\uFF9F]/; // ゠ ー ゛ ゜ ｰ ﾞ ﾟ

  function isKatakana(ch) {
    return RE_KATAKANA.test(ch) || RE_HALFWIDTH.test(ch);
  }

  function isContinue(ch) {
    return RE_CONTINUE.test(ch);
  }

  // ---------------------------------------------------------------- 半角折叠

  // 半角片假名 -> 全角（未加浊点的那一档）。濁点/半濁点交给 normalize 处理。
  const HALFWIDTH_MAP = {
    "\uFF66": "\u30F2", // ｦ ヲ
    "\uFF67": "\u30A1", // ｧ ァ
    "\uFF68": "\u30A3", // ｨ ィ
    "\uFF69": "\u30A5", // ｩ ゥ
    "\uFF6A": "\u30A7", // ｪ ェ
    "\uFF6B": "\u30A9", // ｫ ォ
    "\uFF6C": "\u30E3", // ｬ ャ
    "\uFF6D": "\u30E5", // ｭ ュ
    "\uFF6E": "\u30E7", // ｮ ョ
    "\uFF6F": "\u30C3", // ｯ ッ
    "\uFF70": "\u30FC", // ｰ ー
    "\uFF71": "\u30A2", // ｱ ア
    "\uFF72": "\u30A4", // ｲ イ
    "\uFF73": "\u30A6", // ｳ ウ
    "\uFF74": "\u30A8", // ｴ エ
    "\uFF75": "\u30AA", // ｵ オ
    "\uFF76": "\u30AB", // ｶ カ
    "\uFF77": "\u30AD", // ｷ キ
    "\uFF78": "\u30AF", // ｸ ク
    "\uFF79": "\u30B1", // ｹ ケ
    "\uFF7A": "\u30B3", // ｺ コ
    "\uFF7B": "\u30B5", // ｻ サ
    "\uFF7C": "\u30B7", // ｼ シ
    "\uFF7D": "\u30B9", // ｽ ス
    "\uFF7E": "\u30BB", // ｾ セ
    "\uFF7F": "\u30BD", // ｿ ソ
    "\uFF80": "\u30BF", // ﾀ タ
    "\uFF81": "\u30C1", // ﾁ チ
    "\uFF82": "\u30C4", // ﾂ ツ
    "\uFF83": "\u30C6", // ﾃ テ
    "\uFF84": "\u30C8", // ﾄ ト
    "\uFF85": "\u30CA", // ﾅ ナ
    "\uFF86": "\u30CB", // ﾆ ニ
    "\uFF87": "\u30CC", // ﾇ ヌ
    "\uFF88": "\u30CD", // ﾈ ネ
    "\uFF89": "\u30CE", // ﾉ ノ
    "\uFF8A": "\u30CF", // ﾊ ハ
    "\uFF8B": "\u30D2", // ﾋ ヒ
    "\uFF8C": "\u30D5", // ﾌ フ
    "\uFF8D": "\u30D8", // ﾍ ヘ
    "\uFF8E": "\u30DB", // ﾎ ホ
    "\uFF8F": "\u30DE", // ﾏ マ
    "\uFF90": "\u30DF", // ﾐ ミ
    "\uFF91": "\u30E0", // ﾑ ム
    "\uFF92": "\u30E1", // ﾒ メ
    "\uFF93": "\u30E2", // ﾓ モ
    "\uFF94": "\u30E4", // ﾔ ヤ
    "\uFF95": "\u30E6", // ﾕ ユ
    "\uFF96": "\u30E8", // ﾖ ヨ
    "\uFF97": "\u30E9", // ﾗ ラ
    "\uFF98": "\u30EA", // ﾘ リ
    "\uFF99": "\u30EB", // ﾙ ル
    "\uFF9A": "\u30EC", // ﾚ レ
    "\uFF9B": "\u30ED", // ﾛ ロ
    "\uFF9C": "\u30EF", // ﾜ ワ
    "\uFF9D": "\u30F3", // ﾝ ン
  };

  /**
   * 把半角片假名折成全角，顺便把「カ＋濁点」合成「ガ」。
   * 全角输入原样返回（不做 NFKC，避免动到别的字符）。
   *
   *   ﾃﾞｼﾞﾀﾙ -> デジタル
   *   ｺｰﾋｰ   -> コーヒー
   */
  function normalize(text) {
    if (typeof text !== "string" || !text) return "";
    let out = "";
    let touched = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const full = HALFWIDTH_MAP[ch];
      if (full) {
        // 看下一个字符是不是浊点/半浊点，是就一起吞掉
        const next = text[i + 1];
        if (next === "\uFF9E" || next === "\uFF9F") {
          // NFC 会把「カ＋゛」合成「ガ」
          out += (full + (next === "\uFF9E" ? "\u3099" : "\u309A")).normalize("NFC");
          i++;
        } else {
          out += full;
        }
        touched = true;
        continue;
      }
      // 已经是全角片假名 + 组合浊点的情况，也顺手合成一下
      if (RE_KATAKANA.test(ch)) {
        const next = text[i + 1];
        if (next === "\u3099" || next === "\u309A") {
          out += (ch + next).normalize("NFC");
          i++;
          touched = true;
          continue;
        }
      }
      out += ch;
    }
    return touched ? out : text;
  }

  /**
   * 扫描文本里的片假名词。
   *
   * 每个词返回：
   *   { start, end, text, norm }
   * start/end 是原文里的下标（end 不含），text 是原文切片，
   * norm 是折成全角、可直接拿去查词典的形式。
   *
   * 行为对齐原版正则：
   *   - 词从一个真片假名开始（不接受开头的 ー / ゛）；
   *   - 中间和结尾可以带 ー / ゛ / ゜（「コーヒー」「ヴォーカル」）；
   *   - 结尾必须是真片假名或长音符（「サーバー」里的 ー 结尾OK，
   *     但「ス・」这种以 ・ 结尾的分隔符不会被吞）；
   *   - ・ / ･ 一律当分隔符，不进入词。
   */
  function scan(text) {
    const out = [];
    if (typeof text !== "string" || !text) return out;

    const n = text.length;
    let i = 0;
    while (i < n) {
      if (!isKatakana(text[i])) {
        i++;
        continue;
      }
      const start = i;
      let end = i + 1;
      while (end < n) {
        const ch = text[end];
        if (isKatakana(ch)) {
          end++;
          continue;
        }
        if (isContinue(ch)) {
          // 长音符/浊点只能挂在后面，且后面还得再有片假名才继续吃；
          // 末尾悬空的 ー 也要收（サーバー），所以往后看一位。
          const nxt = text[end + 1];
          if (nxt !== undefined && (isKatakana(nxt) || isContinue(nxt))) {
            end++;
            continue;
          }
          // 悬空长音符结尾：收进来（コーヒー 的 ー），但 ゛ 悬空就不要
          if (ch === "\u30FC" || ch === "\uFF70") {
            end++;
          }
          break;
        }
        break;
      }
      const raw = text.slice(start, end);
      out.push({ start: start, end: end, text: raw, norm: normalize(raw) });
      i = end;
    }
    return out;
  }

  /** 文本里有没有片假名（歌词/标题筛选用的快速预判） */
  function hasKatakana(text) {
    if (!text) return false;
    for (let i = 0; i < text.length; i++) {
      if (isKatakana(text[i])) return true;
    }
    return false;
  }

  // 汉字（含扩展 A 与兼容表意文字）。和 jp-furigana 的 FuriganaCore.hasKanji 同口径：
  // 用来判断"这行是不是该让给振假名插件"。
  const RE_KANJI = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

  /** 文本里有没有汉字 */
  function hasKanji(text) {
    return typeof text === "string" && RE_KANJI.test(text);
  }

  /**
   * 扫出来的词够不够格拿去翻译。
   * 单字的片假名（「ア」「ン」）绝大多数是助词性的，标英文没意义；
   * 除非它在词典里，所以这里只做长度预筛，词典命中与否由调用方决定。
   */
  function looksTranslatable(token) {
    if (!token || !token.text) return false;
    // 去掉长音符后至少 2 个字符
    const core = token.text.replace(/[\u30FC\uFF70]/g, "");
    return core.length >= 2;
  }

  return {
    scan: scan,
    hasKatakana: hasKatakana,
    hasKanji: hasKanji,
    normalize: normalize,
    looksTranslatable: looksTranslatable,
    isKatakana: isKatakana,
    RE_KATAKANA: RE_KATAKANA,
    RE_HALFWIDTH: RE_HALFWIDTH,
    RE_CONTINUE: RE_CONTINUE,
    RE_KANJI: RE_KANJI,
    HALFWIDTH_MAP: HALFWIDTH_MAP,
  };
});
