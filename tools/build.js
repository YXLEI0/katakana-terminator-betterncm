/*
 * 打包：把 src/ 打成 builds/katakana-terminator.plugin（.plugin 就是个 zip，文件在 zip 根目录）。
 *
 *   node tools/build.js
 *   node tools/build.js --install              复制到 C:\betterncm\plugins
 *   node tools/build.js --install --dir <路径>
 *
 * 自己写 zip 而不是调 Compress-Archive：PowerShell 的 ZipFile::CreateFromDirectory
 * 会把条目名写成反斜杠（不符合 ZIP 规范，解压端可能不建子目录），而且 PS 5.1
 * 读没有 BOM 的 .ps1 会按 ANSI 解，中文注释一乱语法就崩。Node 两个坑都没有，
 * CI 里也不必用 Windows runner。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const OUT_DIR = path.join(ROOT, "builds");

// 打进包的文件（相对 src/），顺序就是 manifest 的 injects 依赖顺序
const SRC_FILES = [
  "manifest.json",
  "core/matcher.js",
  "core/dict.js",
  "core/translate.js",
  "core/annotate.js",
  "core/overlay.js",
  "main.js",
  "preview.png",
];

// src/ 下允许存在的全部内容（多出来说明有临时文件误提交）
const ALLOWED_TOP = new Set(["manifest.json", "main.js", "preview.png", "core"]);
const ALLOWED_CORE = new Set(["matcher.js", "dict.js", "translate.js", "annotate.js", "overlay.js"]);

// ---------------------------------------------------------------- zip

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = zlib.deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    const { time, date } = dosDateTime(entry.mtime);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 通用标志位：文件名为 UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); // 同样标 UTF-8
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

// ---------------------------------------------------------------- 收集与自检

function collect() {
  const entries = [];
  const add = (fullPath, name) => {
    if (!fs.existsSync(fullPath)) throw new Error(`缺少 src/${name}（先跑 npm run build:dict / build:preview 生成）`);
    entries.push({ name, data: fs.readFileSync(fullPath), mtime: fs.statSync(fullPath).mtime });
  };
  for (const f of SRC_FILES) add(path.join(SRC, f), f);
  return entries;
}

function selfCheck(entries) {
  // 1. 条目名必须用正斜杠，且 manifest.json 必须在最外层
  for (const e of entries) {
    if (e.name.includes("\\")) throw new Error(`条目名里有反斜杠：${e.name}`);
  }
  if (!entries.some((e) => e.name === "manifest.json"))
    throw new Error("manifest.json 不在 zip 根层，BetterNCM 会认不出来");

  // 2. src/ 里不能有打包清单之外的文件（商店按 subpath 打包整个目录）
  const top = fs.readdirSync(SRC).filter((f) => f !== ".gitkeep");
  const extraTop = top.filter((f) => !ALLOWED_TOP.has(f));
  if (extraTop.length) throw new Error(`src/ 里有不该分发的文件：${extraTop.join(", ")}`);
  const missingTop = [...ALLOWED_TOP].filter((f) => !top.includes(f));
  if (missingTop.length) throw new Error(`src/ 缺少：${missingTop.join(", ")}`);

  const core = fs.readdirSync(path.join(SRC, "core")).filter((f) => f !== ".gitkeep");
  const extraCore = core.filter((f) => !ALLOWED_CORE.has(f));
  if (extraCore.length) throw new Error(`src/core/ 里有不该分发的文件：${extraCore.join(", ")}`);
  const missingCore = [...ALLOWED_CORE].filter((f) => !core.includes(f));
  if (missingCore.length) throw new Error(`src/core/ 缺少：${missingCore.join(", ")}`);

  // 3. manifest 的结构与 injects 顺序
  const mf = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
  if (mf.manifest_version !== 1) throw new Error("manifest_version 必须是 1");
  for (const field of ["name", "slug", "version", "author"]) {
    if (!mf[field]) throw new Error(`manifest.json 缺 ${field}`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(mf.slug)) throw new Error("slug 只能包含英文、数字、横杠、下划线");
  if (!mf.preview) throw new Error("manifest.json 缺 preview，商店要求预览图");
  if (!entries.some((e) => e.name === mf.preview)) throw new Error(`manifest 声明的预览图 ${mf.preview} 不在包里`);

  const injected = (mf.injects && mf.injects.Main) || [];
  if (!injected.length) throw new Error("manifest.json 没有 Main 注入项");
  const injectedFiles = injected.map((i) => i.file);
  for (const f of injectedFiles) {
    if (!/\.m?js$/.test(f)) throw new Error(`注入文件必须以 .js 结尾：${f}`);
    if (!entries.some((e) => e.name === f)) throw new Error(`manifest 注入的 ${f} 不在包里`);
  }
  // core 必须按依赖顺序注入：matcher -> dict -> translate -> annotate -> main
  const wantOrder = ["core/matcher.js", "core/dict.js", "core/translate.js", "core/annotate.js", "main.js"];
  const order = injectedFiles.filter((f) => wantOrder.includes(f));
  if (order.join(",") !== wantOrder.join(","))
    throw new Error(`injects 顺序不对，应为 ${wantOrder.join(" -> ")}，实际 ${injectedFiles.join(" -> ")}`);

  // 4. 词典非空、且不含明显坏值
  const dictJs = fs.readFileSync(path.join(SRC, "core", "dict.js"), "utf8");
  const m = /count:\s*(\d+)/.exec(dictJs);
  const count = m ? Number(m[1]) : 0;
  if (count < 100) throw new Error(`离线词典只有 ${count} 条，太小了（先跑 npm run build:dict）`);
  // 只在 WORDS 字面量里查坏值：注释里出现 "NaN" 这种词是正常的
  const body = /const WORDS = \{([\s\S]*?)\n  \};/.exec(dictJs);
  if (!body) throw new Error("dict.js 里找不到 WORDS 字面量，检查生成脚本");
  if (/undefined|NaN/.test(body[1])) throw new Error("词典里出现了 undefined/NaN，检查生成脚本");
  const actual = (body[1].match(/":/g) || []).length;
  if (actual !== count) throw new Error(`dict.count(${count}) 与实际条目数(${actual}) 不一致`);

  return { manifest: mf, dictCount: count, injectedFiles };
}

// ---------------------------------------------------------------- 主流程

function main() {
  const args = process.argv.slice(2);
  const entries = collect();
  const info = selfCheck(entries);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${info.manifest.slug}.plugin`);
  fs.writeFileSync(out, buildZip(entries));

  const mb = (fs.statSync(out).size / 1048576).toFixed(2);
  console.log(`已打包 ${info.manifest.name} v${info.manifest.version}`);
  console.log(`  ${entries.length} 个条目，离线词典 ${info.dictCount} 条，${mb} MB`);
  console.log(`  -> ${path.relative(ROOT, out)}`);
  console.log(`  注入顺序：${info.injectedFiles.join(" -> ")}`);

  if (args.includes("--install")) {
    const i = args.indexOf("--dir");
    const dir = i >= 0 && args[i + 1] ? args[i + 1] : "C:\\betterncm\\plugins";
    if (!fs.existsSync(dir)) throw new Error(`找不到插件目录 ${dir}`);
    const dest = path.join(dir, path.basename(out));
    fs.copyFileSync(out, dest);
    console.log(`已复制到 ${dest}，重启网易云生效`);
  }
}

main();
