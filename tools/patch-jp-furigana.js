/*
 * 给 jp-furigana 打「与片假名终结者共存」补丁。
 *
 * 背景
 * ----
 * jp-furigana 会把整行内容换成自己的 <span class="fg-line">，并在 isClean() 里用
 *
 *     if (h.childNodes.length !== 1) return false;
 *
 * 判断"这一行有没有被外人动过"。我们在同一行上插 <ruby>，它就判定行脏 →
 * 还原 → 重建整行 → 我们的注音被抹掉 → 我们重注 → 无限来回（实测轨迹里
 * changed=18 restored=18 每秒四次，肉眼就是抽搐）。
 *
 * 为什么只需要放宽这一条
 * ----------------------
 * 我们改写的是它留着的**原文本节点**（只切短、不删除），所以它算出来的
 * "看得见的原文" hostsText() 一个字符都没变 —— 已用它的真实 DOM 结构验证：
 * 注解前后它读到的都是 "取戻したい　ヒーローみたいに"。也就是说：
 * 只要它别因为"多了一个子节点"就把整行推倒重来，两种注音就能安稳共处。
 *
 * 补丁做两件事
 * ------------
 *   1. isClean()：子节点计数忽略我们插的节点（带 kt-ruby / kt-rt 的）；
 *   2. restore()：它拆 wrap 时，把我们挂在它 wrap 里的注音节点先搬到 host 上，
 *      免得跟 wrap 一起被丢掉。（它随后 buildWrap 时会用 include 把 host 的
 *      全部子节点搬进新 wrap，我们的节点也跟着进新 wrap。）
 *
 * 用法
 * ----
 *   node tools/patch-jp-furigana.js            # 打补丁（默认目录）
 *   node tools/patch-jp-furigana.js --dir <目录>
 *   node tools/patch-jp-furigana.js --revert   # 还原
 *   node tools/patch-jp-furigana.js --check    # 只看状态
 *
 * 注意：jp-furigana 更新后补丁会丢失，需要重新执行一次。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const MARK = "/* KT-COEXIST-PATCH */";

// ---------------------------------------------------------------- 补丁内容

const HELPER = `
	// ${MARK}
	// 判断子节点是不是别的插件（片假名终结者）插进来的注音。
	// 这类节点不该让 isClean() 判定"行被外人改过"。
	function __ktIsForeign(node) {
		if (!node || node.nodeType !== 1) return false;
		const cls = typeof node.className === 'string' ? node.className : '';
		if (/(^|\\s)(kt-ruby|kt-rt|kt-ov-label)(\\s|$)/.test(cls)) return true;
		if (node.tagName === 'RT' && node.parentNode) {
			const pc = typeof node.parentNode.className === 'string' ? node.parentNode.className : '';
			if (/(^|\\s)kt-ruby(\\s|$)/.test(pc)) return true;
		}
		return false;
	}

	// 数一下"真正属于 jp-furigana 的"子节点。排除掉别人的节点后，
	// 正常情况下应当恰好有一个 __fgWrap。
	function __ktOwnChildCount(el) {
		let n = 0;
		for (const c of el.childNodes) if (!__ktIsForeign(c)) n++;
		return n;
	}
`;

const PATCHES = [
  {
    name: "isClean: 子节点计数忽略外来的注音",
    from: "\t\t\tif (h.childNodes.length !== 1) return false;",
    to:
      "\t\t\t// " +
      MARK +
      " 子节点计数忽略别的插件插的注音（片假名终结者的 kt-ruby），\n" +
      "\t\t\t// 否则它会一直判定「行被外人改过」并重建整行。\n" +
      "\t\t\tif (__ktOwnChildCount(h) !== 1) return false;",
  },
  {
    name: "restore: 拆 wrap 前把外来注音搬到 host 上，别一起丢掉",
    from: "\t\t\twrap.remove();",
    to:
      "\t\t\t// " +
      MARK +
      " wrap 里可能有别的插件（片假名终结者）插的注音节点。\n" +
      "\t\t\t// 必须**暂存到 host 的 expando**，而不是 append 到 host 上：\n" +
      "\t\t\t// 下面那句 `if (!host.hasChildNodes() && host.__fgOrig)` 靠「host 为空」\n" +
      "\t\t\t// 决定是否放回原文字；一旦提前挂了节点，这个条件永远不成立，\n" +
      "\t\t\t// 整行文字就再也放不回来 —— 实测会把歌词行清空。\n" +
      "\t\t\t// 暂存后由片假名终结者自己接手，挂回我们的原文本节点后面。\n" +
      "\t\t\ttry {\n" +
      "\t\t\t\tconst __ktNodes = [...wrap.querySelectorAll('ruby.kt-ruby, .kt-ov-label')];\n" +
      "\t\t\t\tif (__ktNodes.length) host.__ktForeign = __ktNodes;\n" +
      "\t\t\t} catch (e) { /* ignore */ }\n" +
      "\t\t\twrap.remove();",
  },
];

// ---------------------------------------------------------------- 纯函数

function isPatched(src) {
  return src.includes(MARK);
}

/** 返回 { src, applied[], error } —— 不改任何文件，方便测试与 --check */
function applyPatch(src) {
  if (isPatched(src)) return { src, applied: [], already: true };

  const missing = PATCHES.filter((p) => !src.includes(p.from));
  if (missing.length) {
    return { src, applied: [], error: missing.map((m) => m.name) };
  }

  const iife = src.indexOf("(() => {");
  if (iife < 0) return { src, applied: [], error: ["找不到 IIFE 起点"] };

  let out = src;
  const insertAt = out.indexOf("\n", iife) + 1;
  out = out.slice(0, insertAt) + HELPER + out.slice(insertAt);

  const applied = [];
  for (const p of PATCHES) {
    const before = out;
    out = out.replace(p.from, p.to);
    if (out !== before) applied.push(p.name);
  }
  return { src: out, applied };
}

/**
 * 还原补丁，返回 { src, reverted[], exact? }。
 *
 * 还原要**逐字节回到原始**，不能只把两处替换退回去 —— 我注入的 helper 块
 * 是一大段代码，靠"找标记删一段"很容易留下残渣（实测踩过：还原后仍含标记，
 * 于是再次 --check 还是"已打补丁"）。
 *
 * 做法：把 helper 块从 HELPER 常量本身精确切掉（HELPER 是我自己写的，
 * 内容完全确定），再退回两处替换，最后按可选的 origSrc 断言一致性。
 */
function revertPatch(src, origSrc) {
  if (!isPatched(src)) return { src, reverted: [], notPatched: true };

  let out = src;
  const reverted = [];

  // 1. 两处替换，从后往前退（避免影响前面的匹配）
  for (const p of [...PATCHES].reverse()) {
    if (out.includes(p.to)) {
      out = out.replace(p.to, p.from);
      reverted.push(p.name);
    }
  }

  // 2. 精确移除 helper 块（按 HELPER 常量的原文匹配）
  if (out.includes(HELPER)) {
    out = out.split(HELPER).join("");
    reverted.push("helper 块");
  }

  // 3. 如果给了原始文本，就用它兜底/校验
  if (origSrc != null) {
    if (out === origSrc) return { src: out, reverted, exact: true };
    // 有备份就直接用备份，最可靠
    return { src: origSrc, reverted, exact: true, usedBackup: true };
  }
  return { src: out, reverted, exact: false };
}

// ---------------------------------------------------------------- 命令行

function main() {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf("--dir");
  const dir = dirIdx >= 0 && args[dirIdx + 1] ? args[dirIdx + 1] : "C:/betterncm/plugins_runtime/jp-furigana";
  const file = path.join(dir, "main.js");

  if (!fs.existsSync(file)) {
    console.error("找不到 jp-furigana： " + file);
    console.error("用 --dir 指定它的解包目录（一般是 C:\\betterncm\\plugins_runtime\\jp-furigana）");
    process.exit(1);
  }

  const src = fs.readFileSync(file, "utf8");

  if (args.includes("--check")) {
    console.log(isPatched(src) ? "已打补丁" : "未打补丁");
    console.log("文件: " + file);
    return;
  }

  if (args.includes("--revert")) {
    const r = revertPatch(src);
    if (r.notPatched) {
      console.log("没有打补丁，无需还原。");
      return;
    }
    fs.writeFileSync(file, r.src, "utf8");
    console.log("已还原：" + file);
    return;
  }

  const r = applyPatch(src);
  if (r.already) {
    console.log("已经打过补丁了，无需重复。");
    console.log("文件: " + file);
    return;
  }
  if (r.error) {
    console.error("锚点没找到，可能 jp-furigana 版本变了：");
    for (const m of r.error) console.error("  - " + m);
    console.error("请把上面这些反馈给插件作者，不要手动乱改。");
    process.exit(2);
  }

  const bak = file + ".kt-bak";
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, src, "utf8");
  console.log("已备份原文件 -> " + path.basename(bak));

  // 写之前先确认打出来的代码语法没坏，不能把别人的插件弄崩
  try {
    new (require("vm").Script)(r.src, { filename: file });
  } catch (e) {
    console.error("补丁后的代码语法检查失败，已中止（原文件未改动）：" + e.message);
    process.exit(3);
  }

  fs.writeFileSync(file, r.src, "utf8");
  for (const name of r.applied) console.log("已应用：" + name);
  console.log("\n补丁完成：" + file);
  console.log("重启网易云生效；然后在片假名终结者的设置里打开「与振假名插件共用同一行」。");
  console.log("提示：jp-furigana 更新后补丁会丢失，重新跑一次本脚本即可。");
}

if (require.main === module) main();

module.exports = { applyPatch, revertPatch, isPatched, MARK };
