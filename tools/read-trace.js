/*
 * 从网易云 Local Storage 的 leveldb 里读插件轨迹。
 *
 * 两个坑（都实测踩过）：
 *   1. 直接读客户端正在写的文件会让进程 STATUS_HEAP_CORRUPTION 崩掉 —— 先复制再读；
 *   2. 值是 UTF-16LE 的 JSON 数组，可能跨 leveldb log record 被截断，直接 JSON.parse
 *      会失败。所以改成「先扫出完整的字符串字面量」，能捞多少捞多少，
 *      并明确报告数组是否是完整的。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const base = path.join(process.env.LOCALAPPDATA, "Netease", "CloudMusic", "webapp91x64", "Local Storage", "leveldb");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kt-trace-"));
const KEY = Buffer.from("katakana-terminator.trace", "latin1");
const ARRAY_START = Buffer.from([0x5b, 0x00, 0x22, 0x00]); // UTF-16LE 的 ["

/** 从 JSON 数组文本里捞出所有完整的字符串元素，并报告数组是否闭合 */
function salvage(text) {
  const items = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;
  let closed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') {
        inStr = false;
        if (depth === 1 && start >= 0) {
          try {
            items.push(JSON.parse(text.slice(start, i + 1)));
          } catch (e) {
            /* 半截字符串，丢掉 */
          }
          start = -1;
        }
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      start = i;
    } else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        closed = true;
        break;
      }
    }
  }
  return { items, closed };
}

const files = fs
  .readdirSync(base)
  .filter((f) => /\.(log|ldb)$/.test(f))
  .map((f) => {
    const full = path.join(base, f);
    return { f, full, size: fs.statSync(full).size, mt: fs.statSync(full).mtimeMs };
  })
  .sort((a, b) => b.mt - a.mt);

let best = { items: [], closed: false, where: "" };

for (const x of files) {
  const dst = path.join(tmp, x.f);
  try {
    fs.copyFileSync(x.full, dst);
  } catch (e) {
    continue;
  }
  const buf = fs.readFileSync(dst);
  let from = 0;
  for (;;) {
    const at = buf.indexOf(KEY, from);
    if (at === -1) break;
    from = at + 1;
    const win = buf.slice(at + KEY.length, Math.min(buf.length, at + KEY.length + 4096));
    const rel = win.indexOf(ARRAY_START);
    if (rel === -1) continue;
    const arrAt = at + KEY.length + rel;
    const text = buf.slice(arrAt, buf.length).toString("utf16le");
    const got = salvage(text);
    // 优先取「完整的」，都不完整时取捞到最多的
    if (got.items.length > best.items.length || (got.closed && !best.closed && got.items.length > best.items.length / 2)) {
      best = { items: got.items, closed: got.closed, where: `${x.f}@${arrAt} (${x.size}B)` };
    }
  }
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  /* ignore */
}

if (!best.items.length) {
  console.log("没解出轨迹。文件：");
  for (const x of files.slice(0, 8)) console.log(`  ${x.f}  ${x.size}B  ${new Date(x.mt).toLocaleString()}`);
  process.exit(2);
}

console.log(`# 轨迹 ${best.items.length} 行  来源 ${best.where}  ${best.closed ? "" : "（数组未闭合，末尾可能缺几行）"}\n`);
best.items.forEach((l, i) => console.log(String(i + 1).padStart(3) + "  " + l));
