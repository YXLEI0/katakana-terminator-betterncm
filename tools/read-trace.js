/*
 * 从网易云的 Local Storage 里把插件的运行轨迹读出来。
 *
 * 背景：插件把每次扫描、注音明细和异常都写进 localStorage['katakana-terminator.trace']。
 * 出问题时渲染进程的 console 不一定方便看，但这份轨迹会落盘在
 * %LOCALAPPDATA%\Netease\CloudMusic\webapp91x64\Local Storage\leveldb 里，
 * 这个脚本直接把它解出来。
 *
 *   node tools/read-trace.js
 *
 * 只读，不修改任何东西。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const KEY = "katakana-terminator.trace";
const base = path.join(
  process.env.LOCALAPPDATA || "",
  "Netease",
  "CloudMusic",
  "webapp91x64",
  "Local Storage",
  "leveldb"
);

if (!fs.existsSync(base)) {
  console.error("找不到 Local Storage 目录：\n  " + base);
  process.exit(1);
}

// localStorage 在 leveldb 里是 "_<origin>\x00\x01<key>" -> value，
// 值是 UTF-16LE 还是 UTF-8 取决于写入端（Chromium 用 UTF-16LE 存 value）。
// 这里两种都试，找那种能解析出合法 JSON 数组的。
function decodeCandidates(buf) {
  const out = [];
  // UTF-16LE
  try {
    const s = buf.toString("utf16le");
    out.push(s);
  } catch (e) {
    /* ignore */
  }
  // UTF-8 / latin1
  out.push(buf.toString("utf8"));
  out.push(buf.toString("latin1"));
  return out;
}

const files = fs
  .readdirSync(base)
  .filter((f) => f.endsWith(".log") || f.endsWith(".ldb"))
  .map((f) => path.join(base, f))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

let best = null;
let bestLen = 0;

for (const file of files) {
  const buf = fs.readFileSync(file);
  for (const text of decodeCandidates(buf)) {
    let idx = text.indexOf(KEY);
    while (idx !== -1) {
      // 键后面就是值，抓一段足够长的窗口，找最外层的 JSON 数组
      const window = text.slice(idx + KEY.length, idx + KEY.length + 200000);
      const start = window.indexOf("[");
      if (start !== -1) {
        // 括号配平，截出完整数组
        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let i = start; i < window.length; i++) {
          const ch = window[i];
          if (inStr) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === '"') inStr = false;
            continue;
          }
          if (ch === '"') inStr = true;
          else if (ch === "[") depth++;
          else if (ch === "]") {
            depth--;
            if (depth === 0) {
              const raw = window.slice(start, i + 1);
              try {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr) && arr.length > bestLen) {
                  best = arr;
                  bestLen = arr.length;
                }
              } catch (e) {
                /* 这段不是完整 JSON，继续找 */
              }
              break;
            }
          }
        }
      }
      idx = text.indexOf(KEY, idx + 1);
    }
  }
}

if (!best) {
  console.log("没找到插件轨迹。可能原因：");
  console.log("  1) 插件从未成功启动过（检查是否被紧急开关关掉了）");
  console.log("  2) 客户端还没重新启动过，轨迹尚未落盘");
  console.log("  3) leveldb 还在内存里没 flush —— 完全退出网易云后再试一次");
  process.exit(2);
}

console.log(`读到 ${best.length} 行轨迹（按时间顺序）：\n`);
for (const line of best) console.log("  " + line);
