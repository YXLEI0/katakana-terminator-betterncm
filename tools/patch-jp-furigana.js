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
	// 判断子节点是不是别的插件插进来的注音。
	// 这类节点不该让 isClean() 判定"行被外人改过"。
	//
	// 目前要认两家（都是同一个作者、可能同时开着）：
	//   kt-ruby / kt-rt —— 片假名终结者（片假名 -> 英文）
	//   lt-ruby / lt-rt —— 拉丁字母片假名注音（拉丁词 -> 片假名读音）
	// 少认一家的后果是实打实的：那家的注音会让这一行被判脏并重建，
	// 于是那一家开始闪 —— 而且是"只有它一家闪"，非常难查。
	function __ktIsForeign(node) {
		if (!node || node.nodeType !== 1) return false;
		const cls = typeof node.className === 'string' ? node.className : '';
		if (/(^|\\s)(kt-ruby|kt-rt|kt-ov-label|lt-ruby|lt-rt|lt-ov-label)(\\s|$)/.test(cls)) return true;
		if (node.tagName === 'RT' && node.parentNode) {
			const pc = typeof node.parentNode.className === 'string' ? node.parentNode.className : '';
			if (/(^|\\s)(kt-ruby|lt-ruby)(\\s|$)/.test(pc)) return true;
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

	// 这个文本节点是不是注音插件改写/新建的？（两家各用自己的标记位）
	function __ktTextIsOurs(n) {
		return !!(n && n.nodeType === 3 && (n.__ktOwned || n.__ltOwned));
	}

	// 这条 MutationRecord 是不是"某个注音插件插注音"引起的？
	// 是的话就不该因此把歌词行标脏 —— 否则每次它插节点我们都会重建整行，
	// 两边来回就是闪烁。
	function __ktRecordIsOurs(r) {
		try {
			// 插入/删除的节点里有我们的注音
			if (r.addedNodes && r.addedNodes.length) {
				let allOurs = true;
				for (const n of r.addedNodes) {
					if (!__ktIsForeign(n) && !__ktTextIsOurs(n)) { allOurs = false; break; }
				}
				if (allOurs) return true;
			}
			if (r.removedNodes && r.removedNodes.length) {
				let allOurs = true;
				for (const n of r.removedNodes) {
					if (!__ktIsForeign(n) && !__ktTextIsOurs(n)) { allOurs = false; break; }
				}
				if (allOurs) return true;
			}
			// characterData：改的是我们留下的那段文本节点
			if (r.type === 'characterData' && __ktTextIsOurs(r.target)) return true;
			// 变更目标本身就在我们的注音节点内部
			if (r.target && r.target.nodeType === 1 && __ktIsForeign(r.target)) return true;
		} catch (e) { /* ignore */ }
		return false;
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
  {
    /*
     * 第三条，也是最关键的：observer 层面忽略我们的变更。
     *
     * 它的回调对任何 childList/characterData 变更都会把最近的歌词行标脏：
     *     for (; el; el = el.parentElement)
     *         if (el.__fgText != null) { el.__fgDirty = true; ... }
     * 我们插 <ruby> 恰好就是一次 childList 变更 → 该行被判脏 → processLine →
     * restoreLine 先把 wrap 摘掉（我们的注音随之消失）→ 重建 → 我们再插……
     * 这才是"闪烁"的真正来源：不是判定逻辑，而是**变更通知**把行标脏了。
     */
    name: "observer: 忽略片假名终结者引起的变更（闪烁的真正来源）",
    from:
      "\t\t\tfor (const r of records) {\n" +
      "\t\t\t\t// 只关心文字和结构变化\n" +
      "\t\t\t\tif (r.type !== 'characterData' && r.type !== 'childList') continue;\n" +
      "\t\t\t\trelevant = true;",
    to:
      "\t\t\tfor (const r of records) {\n" +
      "\t\t\t\t// 只关心文字和结构变化\n" +
      "\t\t\t\tif (r.type !== 'characterData' && r.type !== 'childList') continue;\n" +
      "\t\t\t\t// " +
      MARK +
      " 片假名终结者插的注音引起的变更不算「行被外人改过」，\n" +
      "\t\t\t\t// 否则它每插一个 <ruby> 我们就把整行标脏、重建一次 → 来回闪。\n" +
      "\t\t\t\tif (__ktRecordIsOurs(r)) continue;\n" +
      "\t\t\t\trelevant = true;",
  },
  {
    /*
     * 第四条：hostsText() 的口径。
     *
     * 它判断"这一行还能用吗"靠 hostsText(line) === line.__fgText，但两边算法不一致：
     *   __fgText  = plainText(line)                 —— 排除 <rt>/<rp>/.fg-rt
     *   hostsText = Σ host.__fgOrig[].textContent    —— 什么都算
     *
     * 只要我们的 <ruby> 在它 applyWrap 之前就已经是宿主的子节点，它就会把我们的
     * ruby 一起存进 __fgOrig，于是 hostsText 里多出 rt 里的英文（"ステージstage"），
     * 两边**永远**对不上 → isClean() 永远 false → 它每一轮 pass 都重建这一行 →
     * 我们的注音每轮被抹掉 → 一直闪。
     *
     * 真机证据：只有联网翻译出来的那几个词（ジオラマ、ライト 不在离线词典里）
     * 会闪 —— 它们的注音是在"它的 wrap 已经不在了"的那一瞬间补上去的，
     * 正好构成"我们比它先动手"，于是 ruby 被它存进 __fgOrig。
     * 用工具里的 repro 可以稳定复现：重建次数 [1,1,1,1,1,1]；打上本条后变成
     * [1,0,0,0,0,0]（wrap 一次之后 isClean 恒为真）。
     *
     * 为什么不能简单换成 plainText(n)：plainText 用 TreeWalker，而 nextNode()
     * 不访问根节点 —— 传文本节点进去返回空字符串，会把正文整段丢掉。
     * 所以分三种情况：文本节点取值、外来注音只取底字、其余元素走 plainText。
     */
    name: "hostsText: 只数「看得见的底字」，别把外来注音的 rt 算进原文",
    from: "\t\t\tfor (const n of h.__fgOrig || []) out += n.textContent;",
    to:
      "\t\t\t// " +
      MARK +
      " 只数看得见的底字，别把外来注音 rt 里的英文算成原文：\n" +
      "\t\t\t// 否则 hostsText(line) !== line.__fgText 永远成立，这一行会被无限重建。\n" +
      "\t\t\tfor (const n of h.__fgOrig || []) {\n" +
      "\t\t\t\tif (n.nodeType === 3) { out += n.nodeValue; continue; }\n" +
      "\t\t\t\tif (__ktIsForeign(n)) {\n" +
      "\t\t\t\t\tfor (const c of n.childNodes) if (c.nodeType === 3) out += c.nodeValue;\n" +
      "\t\t\t\t\tcontinue;\n" +
      "\t\t\t\t}\n" +
      "\t\t\t\tout += plainText(n);\n" +
      "\t\t\t}",
  },
  {
    /*
     * 第五条：重建完这一行之后，叫片假名终结者一声。
     *
     * 为什么需要：真机轨迹里 `changed=1 restored=1` 每秒重复五次、永不停止 ——
     * 对方每 ~200ms 重建一次这一行（新 wrap），我们就补一次注音。
     * 而我们是被 MutationObserver 叫醒的，补的动作要等到**下一帧**才落地，
     * 中间那一帧画出来就是没有注音的样子 —— 肉眼就是"一直在闪"。
     *
     * 同步补就没有这个空窗：我们被它直接调用，在**同一个任务**里把注音插回新 wrap，
     * 之后才轮到绘制。而且它自己的 observer 已经会忽略我们的变更（第三条），
     * 所以插完不会反过来再触发它重建，不会自激。
     *
     * 钩子由片假名终结者注册（window.__ktRepairLine）；它不在的话这一句就是空转，
     * 对没装/没开我们的用户没有任何影响。
     */
    name: "processLine: 重建完这一行后通知片假名终结者同步补注音",
    from:
      "\t\tline.__fgText = text;\n" +
      "\t\tline.__fgHosts = hosts;\n" +
      "\t\tline.__fgMirrors = mirrors;\n" +
      "\t\treturn true;",
    to:
      "\t\tline.__fgText = text;\n" +
      "\t\tline.__fgHosts = hosts;\n" +
      "\t\tline.__fgMirrors = mirrors;\n" +
      "\t\t// " +
      MARK +
      " 我们刚刚把这一行整个换新了，别人的注音跟着没了。\n" +
      "\t\t// 这时候直接叫它同步补回来，别等下一帧 —— 等一帧就是肉眼可见的一闪。\n" +
      "\t\t// 它自己的 observer 会忽略我们这边的变更，所以不会自激。\n" +
      "\t\ttry {\n" +
      "\t\t\tif (typeof window !== 'undefined' && typeof window.__ktRepairLine === 'function')\n" +
      "\t\t\t\twindow.__ktRepairLine(line);\n" +
      "\t\t} catch (e) { /* ignore */ }\n" +
      "\t\treturn true;",
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
