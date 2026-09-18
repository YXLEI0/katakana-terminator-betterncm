/*
 * 生成 src/preview.png —— 插件预览图（BetterNCM 商店要求 manifest 里的 preview 存在）。
 *
 * 不依赖任何图形库：自己写 PNG 编码器（zlib 用 Node 内置的）。
 * 图案是手画的点阵，画的是「コーヒー / coffee」这个典型例子。
 *
 * 用法：node tools/make-preview.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "src", "preview.png");

// ---------------------------------------------------------------- 画布

const W = 480;
const H = 240;
const canvas = new Uint8Array(W * H * 4);

const BG = [26, 27, 38, 255];
const CARD = [36, 40, 59, 255];
const FG = [220, 223, 244, 255]; // 底字
const ACCENT = [122, 162, 247, 255]; // 注音
const MUTED = [86, 95, 137, 255];

function px(x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  canvas[i] = c[0];
  canvas[i + 1] = c[1];
  canvas[i + 2] = c[2];
  canvas[i + 3] = c[3];
}

function fillRect(x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(x, y, c);
}

function roundRect(x0, y0, w, h, r, c) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const dx = Math.min(x - x0, x0 + w - 1 - x);
      const dy = Math.min(y - y0, y0 + h - 1 - y);
      if (dx < r && dy < r) {
        const ox = r - dx;
        const oy = r - dy;
        if (ox * ox + oy * oy > r * r) continue;
      }
      px(x, y, c);
    }
  }
}

// ---------------------------------------------------------------- 5x7 点阵字体

const FONT = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "11110", "10001", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "11110", "10000", "10000", "10000", "11111"],
  F: ["11111", "10000", "11110", "10000", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "11111", "10001", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  K: ["10001", "10010", "11100", "10010", "10001", "10001", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10001", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "01110", "00001", "00001", "10001", "01110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

function drawText(text, x, y, scale, color) {
  let cx = x;
  for (const raw of text.toUpperCase()) {
    const glyph = FONT[raw] || FONT[" "];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] === "1") fillRect(cx + col * scale, y + row * scale, scale, scale, color);
      }
    }
    cx += 6 * scale;
  }
  return cx;
}

function textWidth(text, scale) {
  return text.length * 6 * scale;
}

// ---------------------------------------------------------------- 自绘形状

/** 画一个圆角「词条」：底字色块 + 上方注音色块，模拟 ruby 排版 */
function drawRubyWord(x, y, baseW, glossW, baseH, glossH) {
  // 注音（上方，细小）
  roundRect(x + Math.round((baseW - glossW) / 2), y, glossW, glossH, 2, ACCENT);
  // 底字（下方，粗大）
  roundRect(x, y + glossH + 4, baseW, baseH, 3, FG);
}

// ---------------------------------------------------------------- 编码

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng() {
  // 每行前面加一个 filter 字节（0 = None）
  const raw = Buffer.alloc(H * (W * 4 + 1));
  let p = 0;
  for (let y = 0; y < H; y++) {
    raw[p++] = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      raw[p++] = canvas[i];
      raw[p++] = canvas[i + 1];
      raw[p++] = canvas[i + 2];
      raw[p++] = canvas[i + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 主流程

function main() {
  fillRect(0, 0, W, H, BG);

  // 顶部标题：KATAKANA TERMINATOR
  const title = "KATAKANA TERMINATOR";
  const ts = 2;
  drawText(title, Math.round((W - textWidth(title, ts)) / 2), 18, ts, MUTED);

  // 分隔线
  fillRect(24, 46, W - 48, 1, MUTED);

  // 主体：三个「片假名词 + 英文注音」，模拟页面上的效果
  const rowY = 78;
  const baseH = 34;
  const glossH = 9;
  const words = [
    { base: 74, gloss: 40 },
    { base: 110, gloss: 34 },
    { base: 84, gloss: 46 },
  ];
  let x = 34;
  for (const w of words) {
    drawRubyWord(x, rowY, w.base, w.gloss, baseH, glossH);
    x += w.base + 22;
  }

  // 下方一行小字：COFFEE / COMPUTER / ...
  drawText("COFFEE  COMPUTER  INTERNET", 34, rowY + glossH + baseH + 22, 2, FG);

  // 底部一行说明
  drawText("KATAKANA -> ENGLISH", 34, H - 30, 2, MUTED);

  fs.writeFileSync(OUT, encodePng());
  console.log(`已写入 ${path.relative(ROOT, OUT)}（${W}x${H}）`);
}

main();
