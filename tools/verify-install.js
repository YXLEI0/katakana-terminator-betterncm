/*
 * 装机核对：`C:\betterncm\plugins` 里那个 `.plugin`，是不是就是当前 src/ 打出来的？
 *
 * 为什么需要它：`.plugin` 是**复制**过去的，改完源码忘了重新打包/复制，
 * 现象是"改了代码但真机没变化"，而插件本身不会报错 —— 很容易怀疑到别处去。
 * 这里把包解开，逐个文件和仓库 src/ 做**逐字节**比对，顺带核对版本号与
 * 几个共存相关的关键串是否真的在包里。
 *
 * 用法：
 *   node tools/verify-install.js                 # 默认 C:\betterncm\plugins
 *   node tools/verify-install.js --dir <目录>    # 换插件目录
 *   node tools/verify-install.js --pkg <文件>    # 直接指定包
 *
 * 这是**开发机专用**脚本（只在 Windows + BetterNCM 环境下有意义），不跑在 CI 里。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { readZip } = require("./patch-jp-furigana-plugin");

const ROOT = path.join(__dirname, "..");
const manifest = require(path.join(ROOT, "src", "manifest.json"));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const pluginsDir = arg("--dir", "C:\\betterncm\\plugins");
const pkgPath = arg("--pkg", path.join(pluginsDir, manifest.slug + ".plugin"));

let bad = 0;
function check(ok, msg) {
  console.log((ok ? "  ok   " : "  FAIL ") + msg);
  if (!ok) bad++;
}

function main() {
  if (!fs.existsSync(pkgPath)) {
    console.error("找不到包：" + pkgPath);
    console.error("先 npm run build && npm run install:plugin");
    process.exit(2);
  }
  const entries = readZip(fs.readFileSync(pkgPath));
  console.log("=== " + path.basename(pkgPath) + "（" + fs.statSync(pkgPath).size + " 字节）===");

  const manEntry = entries.find((e) => e.name === "manifest.json");
  const packed = manEntry ? JSON.parse(manEntry.data.toString("utf8")) : {};
  check(packed.version === manifest.version, "版本号 " + packed.version + "（期望 " + manifest.version + "）");
  check(packed.slug === manifest.slug, "slug = " + packed.slug);

  // 包内每个条目都要和 src/ 下同名文件逐字节一致
  for (const e of entries) {
    const onDisk = path.join(ROOT, "src", e.name);
    if (!fs.existsSync(onDisk)) {
      check(false, "src/" + e.name + " 在仓库里不存在");
      continue;
    }
    const disk = fs.readFileSync(onDisk);
    const same = Buffer.compare(e.data, disk) === 0;
    check(same, "src/" + e.name + (same ? " 一致" : " **不一致**（库里 " + disk.length + " 字节 / 包里 " + e.data.length + " 字节）"));
  }
  // 反过来：src/ 下的文件不能漏打进包（manifest 里 injects 声明的必须都在）
  for (const item of (manifest.injects && manifest.injects.Main) || []) {
    check(
      entries.some((e) => e.name === item.file),
      "注入清单里的 " + item.file + " 在包里"
    );
  }

  // 共存相关的关键串：只做"有没有"，细节由单测保证
  const ann = entries.find((e) => e.name === "core/annotate.js");
  if (ann) {
    const src = ann.data.toString("utf8");
    check(
      /kt-ruby/.test(src) && /lt-rt/.test(src) && /fg-rt/.test(src),
      "annotate.js 认三家注音节点（kt-* / lt-* / fg-*）"
    );
  }
  const main = entries.find((e) => e.name === "main.js");
  if (main) {
    check(/prevHook/.test(main.data.toString("utf8")), "main.js 的修复钩子是链式（不顶掉别人）");
  }

  console.log(bad ? "\n有 " + bad + " 项不通过 —— 包和源码对不上，重新 build + install:plugin" : "\n装机的包与当前源码一致。");
  process.exit(bad ? 1 : 0);
}

main();
