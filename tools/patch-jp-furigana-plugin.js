/*
 * 直接给 jp-furigana 的 .plugin 包（zip）打共存补丁。
 *
 * 为什么必须改 .plugin 而不是解包目录
 * ----------------------------------
 * BetterNCM 每次启动都会把 plugins/*.plugin 重新解包到 plugins_runtime/<slug>/，
 * 所以改解包目录里的 main.js 会在下次启动时被覆盖掉（实测踩过）。
 * 要持久，只能改包本身。
 *
 * 用法：
 *   node tools/patch-jp-furigana-plugin.js                 # 找 plugins 目录里的 jp-furigana*.plugin 并打补丁
 *   node tools/patch-jp-furigana-plugin.js --file <路径>
 *   node tools/patch-jp-furigana-plugin.js --check
 *   node tools/patch-jp-furigana-plugin.js --revert
 *
 * 会自动备份成 <原名>.kt-bak（只备份一次）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const vm = require("vm");
const { applyPatch, revertPatch, isPatched } = require("./patch-jp-furigana.js");

const PLUGINS_DIR = "C:/betterncm/plugins";

// ---------------------------------------------------------------- zip 读写

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function dosDateTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = e.data;
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const { time, date } = dosDateTime(e.mtime);

    const lh = Buffer.alloc(30 + name.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    name.copy(lh, 30);
    locals.push(lh, comp);

    const ch = Buffer.alloc(46 + name.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    name.copy(ch, 46);
    centrals.push(ch);

    offset += lh.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** 读出 zip 的全部条目（只支持这两类实际用到的压缩方式） */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("不是有效的 zip（找不到 EOCD）");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const nl = buf.readUInt16LE(p + 28);
    const name = buf.toString("utf8", p + 46, p + 46 + nl);
    const method = buf.readUInt16LE(p + 10);
    const cs = buf.readUInt32LE(p + 20);
    const lo = buf.readUInt32LE(p + 42);
    const lnl = buf.readUInt16LE(lo + 26);
    const lel = buf.readUInt16LE(lo + 28);
    const raw = buf.slice(lo + 30 + lnl + lel, lo + 30 + lnl + lel + cs);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    entries.push({ name, data, mtime: new Date() });
    p += 46 + nl + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}

// ---------------------------------------------------------------- 主流程

function findPlugin(explicit) {
  if (explicit) return explicit;
  const names = fs.readdirSync(PLUGINS_DIR).filter((f) => /^jp-furigana.*\.plugin$/.test(f));
  if (!names.length) throw new Error("在 " + PLUGINS_DIR + " 里找不到 jp-furigana*.plugin");
  return path.join(PLUGINS_DIR, names[0]);
}

function main() {
  const args = process.argv.slice(2);
  const fi = args.indexOf("--file");
  const file = findPlugin(fi >= 0 ? args[fi + 1] : null);
  console.log("目标包: " + file);

  const bak = file + ".kt-bak";
  const buf = fs.readFileSync(file);
  const entries = readZip(buf);
  const mainEntry = entries.find((e) => e.name === "main.js");
  if (!mainEntry) throw new Error("包里没有 main.js");

  const src = mainEntry.data.toString("utf8");
  const patchedNow = isPatched(src);

  if (args.includes("--check")) {
    console.log(patchedNow ? "包内已打补丁" : "包内未打补丁");
    console.log("备份存在: " + fs.existsSync(bak));
    return;
  }

  if (args.includes("--revert")) {
    if (fs.existsSync(bak)) {
      // 有备份就直接用备份，逐字节还原，最可靠
      const origEntries = readZip(fs.readFileSync(bak));
      for (const e of entries) {
        const o = origEntries.find((x) => x.name === e.name);
        if (o) e.data = o.data;
      }
      fs.writeFileSync(file, buildZip(entries));
      console.log("已按备份还原（逐字节）：" + file);
    } else if (patchedNow) {
      const r = revertPatch(src);
      mainEntry.data = Buffer.from(r.src, "utf8");
      fs.writeFileSync(file, buildZip(entries));
      console.log("已还原（无备份，按标记回退）：" + file);
    } else {
      console.log("包内没有补丁，无需还原。");
      return;
    }
    console.log("提示：还需删除解包目录（plugins_runtime/jp-furigana）才会重新解包。");
    return;
  }

  if (patchedNow && !args.includes("--force")) {
    console.log("包内已经打过补丁了，无需重复。（要重打请加 --force）");
    return;
  }

  // --force：以备份（原始版）为基准重新打，避免在旧补丁上叠加
  let baseSrc = src;
  if (patchedNow && args.includes("--force")) {
    if (!fs.existsSync(bak)) {
      console.error("包内已打补丁但没有备份，无法安全重打。请先恢复原始 .plugin。");
      process.exit(4);
    }
    baseSrc = readZip(fs.readFileSync(bak))
      .find((e) => e.name === "main.js")
      .data.toString("utf8");
    console.log("已用备份作为基准重新打补丁（长度 " + baseSrc.length + "）");
  }

  const r = applyPatch(baseSrc);
  if (r.error) {
    console.error("锚点没找到，可能 jp-furigana 版本变了：");
    for (const m of r.error) console.error("  - " + m);
    process.exit(2);
  }

  // 语法自检：不能把别人的插件弄坏
  try {
    new vm.Script(r.src, { filename: "jp-furigana/main.js" });
  } catch (e) {
    console.error("补丁后语法检查失败，已中止（未改动文件）：" + e.message);
    process.exit(3);
  }

  if (!fs.existsSync(bak)) {
    fs.copyFileSync(file, bak);
    console.log("已备份原包 -> " + path.basename(bak));
  }

  mainEntry.data = Buffer.from(r.src, "utf8");
  const out = buildZip(entries);
  fs.writeFileSync(file, out);
  for (const n of r.applied) console.log("已应用：" + n);
  console.log("\n补丁完成：" + file + "（" + out.length + " 字节）");
  console.log("请删除解包目录让它重新解包：");
  console.log("  Remove-Item -Recurse -Force C:\\betterncm\\plugins_runtime\\jp-furigana");
  console.log("然后重启网易云。");
}

if (require.main === module) main();
module.exports = { readZip, buildZip };
