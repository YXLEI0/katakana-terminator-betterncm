/*
 * 从网易云 Local Storage 的 leveldb 里读插件轨迹，逐文件处理并且只解码命中区域，
 * 避免一次性把大文件转成字符串（那会把进程搞崩，实测 STATUS_HEAP_CORRUPTION）。
 */
const fs = require("fs");
const path = require("path");

const base = path.join(process.env.LOCALAPPDATA, "Netease", "CloudMusic", "webapp91x64", "Local Storage", "leveldb");
const KEY = Buffer.from("katakana-terminator.trace", "latin1");

const files = fs
  .readdirSync(base)
  .filter((f) => /\.(log|ldb)$/.test(f))
  .map((f) => {
    const full = path.join(base, f);
    const st = fs.statSync(full);
    return { f, full, mt: st.mtimeMs, size: st.size };
  })
  .sort((a, b) => b.mt - a.mt);

let best = [];

for (const x of files) {
  let buf;
  try {
    buf = fs.readFileSync(x.full);
  } catch (e) {
    continue; // 客户端占用，跳过
  }
  let from = 0;
  while (from < buf.length) {
    const at = buf.indexOf(KEY, from);
    if (at === -1) break;
    from = at + KEY.length;
    // value 前缀 \x00 之后是 UTF-16LE 正文；键名匹配结束点可能差 1~4 字节
    for (let off = 0; off <= 4; off++) {
      const s = at + KEY.length + off;
      const e = Math.min(buf.length, s + 80000);
      if (e - s < 16) continue;
      const text = buf.slice(s, e).toString("utf16le");
      const start = text.indexOf("[");
      if (start === -1) continue;
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
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
            try {
              const arr = JSON.parse(text.slice(start, i + 1));
              if (Array.isArray(arr) && arr.length > best.length) best = arr;
            } catch (e) {
              /* ignore */
            }
            break;
          }
        }
      }
    }
  }
}

if (!best.length) {
  console.log("没解出轨迹。文件清单：");
  for (const x of files.slice(0, 8)) console.log(`  ${x.f}  ${x.size}B  ${new Date(x.mt).toLocaleString()}`);
  process.exit(2);
}

console.log(`# 轨迹 ${best.length} 行\n`);
best.forEach((l, i) => console.log(String(i + 1).padStart(3) + "  " + l));
