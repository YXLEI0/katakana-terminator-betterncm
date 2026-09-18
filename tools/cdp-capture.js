/*
 * 读取网易云音乐渲染进程的控制台报错（Chrome DevTools Protocol）。
 *
 * 为什么需要它：NCM 的 native 日志（cloudmusic.elog）不包含网页控制台的异常，
 * 插件崩页面的原因只能从渲染进程的 console / 未捕获异常里看。
 *
 * 用法：
 *   1. 完全退出网易云音乐；
 *   2. 在快捷方式目标后面加参数（注意前面有个空格）：
 *        "...\cloudmusic.exe" --remote-debugging-port=9222
 *      或者用命令行启动：
 *        & "C:\Program Files\Netease\CloudMusic\cloudmusic.exe" --remote-debugging-port=9222
 *   3. 等客户端起来后运行本脚本：
 *        node tools/cdp-capture.js
 *   4. 复现问题（启用插件 / 切到会崩的页面），脚本会把报错打出来，Ctrl+C 结束。
 *
 * 只看不写：脚本不会修改页面，只用 Runtime.evaluate 读取状态。
 */
"use strict";

const PORT = process.env.CDP_PORT || "9222";
const HOST = "127.0.0.1";

// 需要关注的来源：我们的插件 + 未捕获异常
const INTERESTING = /katakana|kt-|KT|annotate|translate/i;

async function getTargets() {
  const res = await fetch(`http://${HOST}:${PORT}/json/list`);
  return res.json();
}

function shortStack(stackTrace) {
  if (!stackTrace || !stackTrace.callFrames) return "";
  return stackTrace.callFrames
    .slice(0, 6)
    .map((f) => `      at ${f.functionName || "(anonymous)"} ${f.url || "(eval)"}:${f.lineNumber + 1}:${f.columnNumber + 1}`)
    .join("\n");
}

function fmtArg(a) {
  if (a === null || a === undefined) return String(a);
  if (a.type === "string") return a.value;
  if ("value" in a) return JSON.stringify(a.value);
  if (a.description) return a.description;
  return a.type;
}

async function main() {
  let targets;
  try {
    targets = await getTargets();
  } catch (e) {
    console.error(`连不上 http://${HOST}:${PORT}/json/list —— 网易云是不是没带 --remote-debugging-port=${PORT} 启动？`);
    console.error("原始错误：" + e.message);
    process.exit(1);
  }

  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!pages.length) {
    console.error("没找到可调试的页面。目标列表：");
    console.error(JSON.stringify(targets, null, 2).slice(0, 2000));
    process.exit(1);
  }

  console.log(`找到 ${pages.length} 个页面，逐个接入：`);
  for (const p of pages) console.log(`  - ${p.title || "(无标题)"}  ${p.url}`);
  console.log("\n开始监听。复现问题即可，Ctrl+C 结束。\n");

  for (const page of pages) {
    attach(page);
  }
}

function attach(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const send = (method, params) => ws.send(JSON.stringify({ id: ++id, method, params: params || {} }));

  ws.addEventListener("open", () => {
    send("Runtime.enable");
    send("Log.enable");
    send("Console.enable");
    // 顺便把当前状态读出来，方便判断插件到底加载到哪一步
    send("Runtime.evaluate", {
      expression: `JSON.stringify({
        hasKT: typeof window.KatakanaTerminator,
        globals: ['KTMatcher','KTDict','KTTranslate','KTAnnotate'].map(function(k){ return k + '=' + typeof window[k]; }),
        off: (function(){ try { return localStorage.getItem('katakana-terminator.off'); } catch(e) { return 'n/a'; } })(),
        config: (function(){ try { return localStorage.getItem('katakana-terminator.config'); } catch(e) { return 'n/a'; } })(),
        rubies: document.querySelectorAll('ruby.kt-ruby').length,
        regions: document.querySelectorAll('.kt-region').length
      })`,
      returnByValue: true,
    });
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }

    if (msg.id && msg.result && msg.result.result && typeof msg.result.result.value === "string") {
      console.log(`[${page.title || "page"}] 当前状态: ${msg.result.result.value}\n`);
      return;
    }

    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      const text = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      console.log("=".repeat(70));
      console.log(`!! 未捕获异常 [${page.title || "page"}]`);
      console.log(text);
      const st = shortStack(d.stackTrace);
      if (st) console.log(st);
      console.log("=".repeat(70) + "\n");
      return;
    }

    if (msg.method === "Runtime.consoleAPICalled") {
      const args = (msg.params.args || []).map(fmtArg).join(" ");
      const isErr = msg.params.type === "error" || msg.params.type === "warning";
      // 只打错误/警告，以及和我们插件相关的日志，避免刷屏
      if (!isErr && !INTERESTING.test(args)) return;
      const st = shortStack(msg.params.stackTrace);
      console.log(`[console.${msg.params.type}] ${args}`);
      if (st) console.log(st);
      return;
    }

    if (msg.method === "Log.entryAdded") {
      const e = msg.params.entry;
      if (e.level === "error" || INTERESTING.test(e.text || "")) {
        console.log(`[log.${e.level}] ${e.text}  ${e.url || ""}`);
      }
    }
  });

  ws.addEventListener("error", (e) => {
    console.error(`WebSocket 出错（${page.title}）：${e.message || e.type}`);
  });
  ws.addEventListener("close", () => {
    console.log(`连接关闭（${page.title}）`);
  });
}

main();
