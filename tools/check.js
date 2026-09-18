/*
 * 静态自检：不联网、不依赖浏览器，CI 里跑这个就能挡住大部分低级错误。
 *
 *   node tools/check.js
 *
 * 检查项：
 *   1. 所有 .js 能通过语法解析（vm.Script 只编译不执行）；
 *   2. manifest.json 合法，slug/version 格式正确，注入顺序符合依赖；
 *   3. 注入清单里的文件都存在，且不含别的东西；
 *   4. 词典条目数与格式；
 *   5. 源码里不残留 TODO/OWNER 之类的占位符（提示性，不算失败）；
 *   6. 不出现明显的秘密信息（token 之类）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");

let failures = 0;
let warnings = 0;

function ok(msg) {
  console.log("  ok    " + msg);
}
function fail(msg) {
  failures++;
  console.log("  FAIL  " + msg);
}
function warn(msg) {
  warnings++;
  console.log("  warn  " + msg);
}

function walk(dir, out) {
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------- 1. 语法

console.log("[1/6] 语法检查");
const jsFiles = walk(SRC)
  .concat(walk(path.join(ROOT, "tools")), walk(path.join(ROOT, "tests")))
  .filter((f) => f.endsWith(".js"));
for (const f of jsFiles) {
  const rel = path.relative(ROOT, f);
  try {
    // 只编译，不执行；能挡住语法错误和明显的非法 token
    new vm.Script(fs.readFileSync(f, "utf8"), { filename: rel });
  } catch (e) {
    fail(`${rel}: ${e.message}`);
  }
}
if (failures === 0) ok(`${jsFiles.length} 个 JS 文件语法正常`);

// ---------------------------------------------------------------- 2. manifest

console.log("[2/6] manifest.json");
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
} catch (e) {
  fail("manifest.json 解析失败：" + e.message);
}
if (manifest) {
  if (manifest.manifest_version !== 1) fail("manifest_version 必须是 1");
  else ok("manifest_version = 1");
  for (const k of ["name", "slug", "version", "author"]) {
    if (!manifest[k]) fail(`缺字段 ${k}`);
  }
  if (manifest.slug && !/^[a-zA-Z0-9_-]+$/.test(manifest.slug)) fail("slug 含非法字符：" + manifest.slug);
  else if (manifest.slug) ok("slug = " + manifest.slug);
  if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) warn("version 不像语义化版本：" + manifest.version);
  if (manifest.preview && !fs.existsSync(path.join(SRC, manifest.preview))) fail(`preview 指向的文件不存在：${manifest.preview}`);
  else if (manifest.preview) ok("preview 存在：" + manifest.preview);
  if (manifest.type === "extension") ok('type = "extension"');
  else warn('type 建议为 "extension"，当前：' + manifest.type);
  if (manifest["ncm3-compatible"]) ok("声明兼容网易云 3.x");
  if (manifest.author === "OWNER") warn("manifest.author 还是占位符 OWNER，发布前记得改");
}

// ---------------------------------------------------------------- 3. 注入清单

console.log("[3/6] 注入清单");
const WANT_ORDER = ["core/matcher.js", "core/dict.js", "core/translate.js", "core/annotate.js", "main.js"];
if (manifest && manifest.injects && manifest.injects.Main) {
  const files = manifest.injects.Main.map((i) => i.file);
  for (const f of files) {
    if (!fs.existsSync(path.join(SRC, f))) fail("注入的文件不存在：" + f);
    if (!/\.m?js$/.test(f)) fail("注入文件必须以 .js 结尾：" + f);
  }
  if (files.join(",") !== WANT_ORDER.join(",")) fail(`注入顺序不对：${files.join(" -> ")}`);
  else ok("注入顺序正确：" + files.join(" -> "));
  // main.js 依赖前四个模块，顺序错了会直接报「核心模块未注入」
  const mainIdx = files.indexOf("main.js");
  if (mainIdx !== files.length - 1) fail("main.js 必须最后注入");
} else {
  fail("manifest 里没有 injects.Main");
}

// ---------------------------------------------------------------- 4. 词典

console.log("[4/6] 离线词典");
let dict = null;
try {
  dict = require(path.join(SRC, "core", "dict.js"));
} catch (e) {
  fail("dict.js 加载失败：" + e.message);
}
if (dict) {
  const keys = Object.keys(dict.words);
  if (keys.length < 300) fail(`词典条目太少：${keys.length}`);
  else ok(`词典 ${keys.length} 条`);
  let badKey = 0;
  let badVal = 0;
  for (const k of keys) {
    if (!/^[\u30A1-\u30F6\u30FC]+$/.test(k)) badKey++;
    const v = dict.words[k];
    if (typeof v !== "string" || !v.trim() || !/[A-Za-z]/.test(v)) badVal++;
  }
  if (badKey) fail(`有 ${badKey} 个键不是纯片假名（种子表里混进了非片假名词）`);
  if (badVal) fail(`有 ${badVal} 个释义不是非空英文`);
  if (!badKey && !badVal) ok("词典键值格式正常");
  if (dict.count !== keys.length) fail(`dict.count(${dict.count}) 与实际条目数(${keys.length}) 不一致`);
}

// ---------------------------------------------------------------- 5. 元信息一致性

console.log("[5/6] 元信息与仓库地址");
const MANIFEST = manifest || {};
const EXPECTED_OWNER = "YXLEI0";
const EXPECTED_REPO = "katakana-terminator-betterncm";
if (MANIFEST.author && MANIFEST.author !== EXPECTED_OWNER) {
  warn(`manifest.author 是「${MANIFEST.author}」，与预期维护者（${EXPECTED_OWNER}）不一致`);
}
if (!MANIFEST.author_link) warn("manifest.author_link 为空，商店里不会显示作者主页");
const mainSrc = fs.readFileSync(path.join(SRC, "main.js"), "utf8");
const repoUrl = /var REPO_URL = "([^"]+)"/.exec(mainSrc);
if (!repoUrl) {
  fail("main.js 里找不到 REPO_URL");
} else {
  const url = repoUrl[1];
  const want = `https://github.com/${EXPECTED_OWNER}/${EXPECTED_REPO}`;
  if (url !== want) fail(`main.js 的 REPO_URL 不对：\n         实际 ${url}\n         应为 ${want}`);
  else ok("main.js 的 REPO_URL 与仓库一致");
  if (/OWNER/.test(url)) fail("REPO_URL 里还有 OWNER 占位符");
}
let placeholders = 0;
for (const f of walk(SRC)) {
  if (!f.endsWith(".js") && !f.endsWith(".json")) continue;
  const n = (fs.readFileSync(f, "utf8").match(/OWNER/g) || []).length;
  if (n) {
    fail(`${path.relative(ROOT, f)} 里还有 ${n} 处 OWNER 占位符`);
    placeholders += n;
  }
}
if (!placeholders) ok("没有残留的 OWNER 占位符");

// ---------------------------------------------------------------- 6. 秘密信息

console.log("[6/6] 秘密信息检查");
const SECRET_PATTERNS = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/github_pat_[A-Za-z0-9_]{20,}/, "GitHub fine-grained token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "私钥"],
  [/sk-[A-Za-z0-9]{32,}/, "OpenAI 风格密钥"],
];
let found = 0;
for (const f of walk(ROOT)) {
  const rel = path.relative(ROOT, f);
  if (rel.startsWith("node_modules") || rel.startsWith(".git" + path.sep)) continue;
  if (f.endsWith(".png") || f.endsWith(".gz") || f.endsWith(".plugin")) continue;
  let text;
  try {
    text = fs.readFileSync(f, "utf8");
  } catch (e) {
    continue;
  }
  for (const [re, name] of SECRET_PATTERNS) {
    if (re.test(text)) {
      fail(`${rel} 里疑似有${name}`);
      found++;
    }
  }
}
if (!found) ok("没有发现疑似密钥");

// ---------------------------------------------------------------- 结果

console.log("");
if (failures) {
  console.log(`检查未通过：${failures} 个错误，${warnings} 个警告`);
  process.exit(1);
}
console.log(`检查通过（${warnings} 个警告）`);
