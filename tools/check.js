/*
 * 静态自检：不联网、不依赖浏览器，CI 里跑这个就能挡住大部分低级错误。
 *
 *   node tools/check.js
 *
 * 检查项：
 *   0. Node 版本满足 jsdom 的引擎要求；
 *   1. 所有 .js 能通过语法解析（vm.Script 只编译不执行）；
 *   2. manifest.json 合法，slug/version 格式正确，注入顺序符合依赖；
 *   3. 注入清单里的文件都存在，且不含别的东西；
 *   4. 词典条目数与格式；
 *   5. 元信息一致（REPO_URL 与仓库一致、无 OWNER 占位符）；
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

// ---------------------------------------------------------------- 0. 运行时版本

console.log("[0/7] 运行时版本");
{
  // jsdom 30 要求 Node ^22.22.2 || ^24.15.0 || >=26。跑低了不会给出清楚的报错，
  // 而是它依赖的 undici 直接崩：
  //   TypeError: webidl.util.markAsUncloneable is not a function
  // CI 里曾经就因为在 Node 20 上跑，四个测试文件全挂，所以这里提前拦一道。
  const [maj, min, patch] = process.versions.node.split(".").map(Number);
  const v = [maj, min, patch];
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const okNode =
    (maj === 22 && cmp(v, [22, 22, 2]) >= 0) ||
    (maj === 24 && cmp(v, [24, 15, 0]) >= 0) ||
    maj >= 26;
  if (okNode) ok(`Node ${process.versions.node}（满足 jsdom 30 的引擎要求）`);
  else fail(`Node ${process.versions.node} 不满足 jsdom 30 要求：^22.22.2 || ^24.15.0 || >=26`);

  let jsdomPkg = null;
  try {
    jsdomPkg = require("jsdom/package.json");
  } catch (e) {
    warn("没装 jsdom，跳过依赖检查（先跑 npm install）");
  }
  if (jsdomPkg) ok(`jsdom ${jsdomPkg.version}`);
  try {
    ok(`undici ${require("undici/package.json").version}`);
  } catch (e) {
    warn("没找到 undici（jsdom 的依赖）");
  }

  // 测试文件清单：npm test 里显式列了这几个文件。
  // 不要退回 `node --test tests/`（Node 22 会把目录当模块名，
  // 报 Cannot find module .../tests），也不要用 glob（不同 Node 版本
  // 对 --test 的 glob 支持不一致）。加了新测试文件却忘了写进 package.json
  // 的话，这里会提醒。
  const TEST_FILES = [
    "tests/matcher.test.js",
    "tests/annotate.test.js",
    "tests/coexist.test.js",
    "tests/patch.test.js",
    "tests/translate.test.js",
    "tests/integration.test.js",
  ];
  const missing = TEST_FILES.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) fail("测试文件不存在：" + missing.join(", "));
  const onDisk = fs
    .readdirSync(path.join(ROOT, "tests"))
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => "tests/" + f);
  const notListed = onDisk.filter((f) => !TEST_FILES.includes(f));
  if (notListed.length) warn("tests/ 下有没被 npm test 覆盖的测试文件：" + notListed.join(", "));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const f of TEST_FILES) {
    if (!pkg.scripts.test.includes(f)) fail(`npm test 里没有包含 ${f}`);
  }
  if (!missing.length && !notListed.length) ok(`npm test 覆盖全部 ${TEST_FILES.length} 个测试文件`);
}

// ---------------------------------------------------------------- 1. 语法

console.log("[1/7] 语法检查");
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

console.log("[2/7] manifest.json");
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

console.log("[3/7] 注入清单");
const WANT_ORDER = [
  "core/matcher.js",
  "core/dict.js",
  "core/translate.js",
  "core/annotate.js",
  "main.js",
];
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

console.log("[4/7] 离线词典");
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

console.log("[5/7] 元信息与仓库地址");
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

console.log("[6/7] 秘密信息检查");
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
