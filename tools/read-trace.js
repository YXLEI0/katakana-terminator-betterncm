/*
 * 从网易云 Local Storage 的 leveldb 里读插件轨迹。
 *
 * 为什么需要 Snappy 和 SST 遍历
 * ---------------------------
 * 三条路都试过：
 *   1. 直接读 .log  —— 客户端在写，复制时会让进程 STATUS_HEAP_CORRUPTION 崩掉；
 *   2. 只读 .ldb    —— 块是 Snappy 压缩的，只能搜到键、读出来的值是乱码
 *      （这正是之前"轨迹只有 1 行 / 全是乱码"的原因）；
 *   3. 只读 4KB 窗口 —— 值有 100KB+（250 行 × UTF-16），窗口根本不够。
 * 所以这里老老实实按 leveldb 的 SST 格式走：footer → index block → data block，
 * 块按 compression type 解压（0 无压缩 / 1 Snappy），key 里含目标键就收下值。
 *
 * 值本身是 Chrome LocalStorage 的编码：第一个字节是编码标记（0=UTF-16LE），
 * 后面才是正文。所以拿到原始字节后按 UTF-16LE 解码。
 *
 * 用法：
 *   node tools/read-trace.js            # 读 katakana-terminator.trace
 *   node tools/read-trace.js --key xxx  # 读别的键
 *   node tools/read-trace.js --raw      # 直接输出值（不按轨迹数组格式化）
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const KEY = process.argv.includes("--key")
  ? process.argv[process.argv.indexOf("--key") + 1]
  : "katakana-terminator.trace";
const RAW = process.argv.includes("--raw");

const base = path.join(process.env.LOCALAPPDATA, "Netease", "CloudMusic", "webapp91x64", "Local Storage", "leveldb");

// ---------------------------------------------------------------- Snappy

/** Snappy 解压（leveldb 用的就是这个格式，只有 literal / copy 两种元素） */
function snappy(buf) {
  let p = 0;
  const readVarint = () => {
    let shift = 0;
    let out = 0;
    for (;;) {
      const b = buf[p++];
      out |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return out >>> 0;
  };
  const expect = readVarint();
  const out = Buffer.allocUnsafe(expect);
  let o = 0;
  while (p < buf.length && o < expect) {
    const tag = buf[p++];
    const type = tag & 3;
    if (type === 0) {
      // literal
      let len = tag >>> 2;
      if (len >= 60) {
        const extra = len - 59;
        len = 0;
        for (let i = 0; i < extra; i++) len |= buf[p + i] << (8 * i);
        len = len >>> 0;
        p += extra;
      }
      len += 1;
      buf.copy(out, o, p, p + len);
      p += len;
      o += len;
    } else {
      let len;
      let offset;
      if (type === 1) {
        len = 4 + ((tag >>> 2) & 7);
        offset = ((tag >>> 5) << 8) | buf[p];
        p += 1;
      } else if (type === 2) {
        len = 1 + (tag >>> 2);
        offset = buf.readUInt16LE(p);
        p += 2;
      } else {
        len = 1 + (tag >>> 2);
        offset = buf.readUInt32LE(p);
        p += 4;
      }
      // 逐字节拷贝，允许重叠（offset < len 时就是重复填充）
      for (let i = 0; i < len; i++) out[o + i] = out[o - offset + i];
      o += len;
    }
  }
  return out.slice(0, o);
}

// ---------------------------------------------------------------- leveldb

function readVarint(buf, st) {
  let shift = 0;
  let out = 0;
  for (;;) {
    const b = buf[st.p++];
    out += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return out;
}

/** 读一个 block：数据 + 1 字节压缩类型 + 4 字节 crc */
function readBlock(buf, offset, size) {
  const raw = buf.slice(offset, offset + size);
  const type = buf[offset + size];
  if (type === 0) return raw;
  if (type === 1) return snappy(raw);
  throw new Error("不支持的块压缩类型 " + type);
}

/** 遍历一个 block 里的所有 key/value */
function eachEntry(block, fn) {
  const numRestarts = block.readUInt32LE(block.length - 4);
  const limit = block.length - 4 - numRestarts * 4;
  const st = { p: 0 };
  let lastKey = Buffer.alloc(0);
  while (st.p < limit) {
    const shared = readVarint(block, st);
    const nonShared = readVarint(block, st);
    const valueLen = readVarint(block, st);
    const key = Buffer.concat([lastKey.slice(0, shared), block.slice(st.p, st.p + nonShared)]);
    st.p += nonShared;
    const value = block.slice(st.p, st.p + valueLen);
    st.p += valueLen;
    lastKey = key;
    fn(key, value);
  }
}

function readSst(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 48) return [];
  // footer：两个 BlockHandle（varint offset + varint size），最后 8 字节是 magic
  const st = { p: buf.length - 48 };
  const metaOff = readVarint(buf, st);
  const metaSize = readVarint(buf, st);
  const idxOff = readVarint(buf, st);
  const idxSize = readVarint(buf, st);
  void metaOff;
  void metaSize;
  const found = [];
  const index = readBlock(buf, idxOff, idxSize);
  eachEntry(index, (_key, handleRaw) => {
    const hs = { p: 0 };
    const off = readVarint(handleRaw, hs);
    const size = readVarint(handleRaw, hs);
    let data;
    try {
      data = readBlock(buf, off, size);
    } catch (e) {
      return;
    }
    eachEntry(data, (k, v) => found.push({ k, v }));
  });
  return found;
}

// ---------------------------------------------------------------- 取值

function decodeValue(v) {
  // Chrome LocalStorage：首字节 0 = UTF-16LE，1 = Latin-1
  if (v.length && v[0] === 0) return v.slice(1).toString("utf16le");
  return v.toString("latin1");
}

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
            /* 半截 */
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kt-sst-"));
const files = fs
  .readdirSync(base)
  .filter((f) => /\.ldb$/.test(f))
  .map((f) => {
    const st = fs.statSync(path.join(base, f));
    return { f, size: st.size, mt: st.mtimeMs };
  })
  .sort((a, b) => b.mt - a.mt);

/*
 * 每个文件里都可能有一个"当时的完整轨迹"。注意**不能取最长的那个** ——
 * leveldb 会把旧值留在别的 .ldb 里，最长的那份往往是上一轮的。
 * 判据用「最后一行的时间戳」：谁最新用谁。
 */
function lastStamp(text) {
  const m = [...String(text).matchAll(/(\d{2}:\d{2}:\d{2}) \[/g)];
  return m.length ? m[m.length - 1][1] : "";
}

let best = { text: "", where: "", stamp: "" };
for (const x of files) {
  const dst = path.join(tmp, x.f);
  try {
    fs.copyFileSync(path.join(base, x.f), dst);
  } catch (e) {
    continue;
  }
  let entries;
  try {
    entries = readSst(dst);
  } catch (e) {
    console.log(`--- ${x.f}: 解析失败 ${e.message}`);
    continue;
  }
  let local = { text: "", where: x.f, stamp: "" };
  for (const { k, v } of entries) {
    if (k.toString("latin1").indexOf(KEY) === -1) continue;
    const text = decodeValue(v);
    if (text.length > local.text.length) local = { text, where: x.f, stamp: lastStamp(text) };
  }
  if (local.text) {
    console.log(`--- ${x.f} (${x.size}B) 条目 ${entries.length}，轨迹 ${local.text.length} 字符，最后一行 ${local.stamp}`);
    if (local.stamp > best.stamp) best = local;
  } else {
    console.log(`--- ${x.f} (${x.size}B) 条目 ${entries.length}，没有这个键`);
  }
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  /* ignore */
}

if (!best.text) {
  console.log(`\n没找到键 ${KEY}。`);
  process.exit(2);
}

if (RAW) {
  console.log(`\n# 值 ${best.text.length} 字符  来源 ${best.where}\n`);
  console.log(best.text);
  process.exit(0);
}

const { items, closed } = salvage(best.text);
if (!items.length) {
  console.log(`\n# 值是 ${best.text.length} 字符，但不是轨迹数组。前 200 字：\n` + best.text.slice(0, 200));
  process.exit(2);
}
console.log(`\n# 轨迹 ${items.length} 行  来源 ${best.where}  ${closed ? "" : "（数组未闭合）"}\n`);
items.forEach((l, i) => console.log(String(i + 1).padStart(3) + "  " + l));
