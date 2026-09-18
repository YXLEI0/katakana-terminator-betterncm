# 更新记录

## 1.0.6

修「含片假名的歌词一直抽搐」。轨迹里是同一批注音在反复重做：

```
[pass] regions=50 changed=20 restored=20   ← 每 ~250ms 一次
```

三个 bug 叠在一起：

- `isStale` 对「片假名开头」的歌词行恒为真：这种形态注入时原文本节点会被移除
  （`kept=false`），而判断里有 `node.parentNode !== host`，永远成立，
  于是每轮都判定失效、还原重注一遍。这就是抽搐的直接原因。
- `orphaned` 把「我们插的注音节点不见了」当成「记录作废」：宿主还在、
  只是 React 摘掉了注音（最常见的情况）却被丢掉记录，那一行再也标不回来
  （restore 完记录已删，同一轮不会再注一次）。
- `pass` 先拍文本节点快照再还原，快照拿到的是切短的半截文本，还原后没人再看它。

稳定性判据换成「可见原文（剔除 `<rt>` 后的底字）有没有变」——
不看 `isConnected`（React 每 250ms 重建歌词行，节点时连时断）。
底字没变就一律不动 DOM。另外 `restore` 恢复 `kept=false` 形态时改为按
注入前记下的子节点下标插回，避免 React 已换行时把旧节点插回去渲染两遍。

验证：5 行歌词 + 播放栏的收敛脚本里 `pass1 changed=4`、
`pass2..6 changed=0 restored=0`，完全收敛。

测试 53 → 56。

## 1.0.5

修「启用后网易云提示应用出错」。根因是**拿整个 `body` 当扫描区域**：
轨迹显示 `regions=1`（就是 BODY），侧边栏、搜索框、歌单名、评论正文
全被改写，一轮就改了 8 处，直接把应用干到错误页。

- `findRegions("safe"|"lyrics")` 改用白名单选择器，**永远不返回 `document.body`**；
  白名单 = 歌词容器 + 播放栏的歌曲名/歌手。宁可漏标，不可越界。
- 连续 5 轮扫描出错就自动停用并还原 DOM（电路熔断）。
- `tools/read-trace.js`：localStorage 的值是 UTF-16LE，之前按 UTF-8 解所以读不到；
  改用 UTF-16LE 的 `["` 字节特征定位，逐文件小窗口解码（一次性解码大文件会让
  进程 `STATUS_HEAP_CORRUPTION` 崩掉）。

测试 52 → 53。

## 1.0.4

1.0.3 的改动（不再替换 React 的文本节点）没能解决「应用出错了」，
而渲染进程的控制台异常读不到（native 日志 `cloudmusic.elog` 不含它），
所以这一版先把**取证**做好，不再靠猜：

- 新增运行轨迹信标：插件把启动信息、每轮扫描结果、注音明细、`pass` 异常、
  以及 `window.onerror` / `unhandledrejection` 抓到的东西写进
  `localStorage['katakana-terminator.trace']`（最多 250 行，写失败绝不影响插件）。
  落盘在网易云的 Local Storage 里，可以用 `node tools/read-trace.js` 读出来。
- 新增 `tools/cdp-capture.js`：带 `--remote-debugging-port=9222` 启动网易云后，
  直接读渲染进程的 console 与未捕获异常。
- 检测 BetterNCM 安全模式（`betterncm.safemode`），安全模式下完全不动 DOM。

## 1.0.3

修「启用插件后网易云提示『应用出错了…重启下试试吧』」。

根因是 DOM 注入方式对 React 不友好：旧实现把整个文本节点替换成新的节点树
（`insertBefore(fragment)` + `removeChild(node)`）。React 更新纯文本时是在
它自己持有的那个文本节点上执行 `setTextContent(node)`，节点一旦被我们换掉，
这个引用就失效了，commit 阶段可能抛错，整页掉进网易云自己的错误页。
默认的「标注全部」会把整页 body 都扫一遍，命中面越大越容易踩到。

改成只「切短」原文本节点、注音作为兄弟节点插在它后面：

- 原文本节点 `nodeValue` 只被改写、不被移除，React 的引用始终有效；
- 注音和文本分段都记进 `inserted`，还原时逐个摘掉，原文从 `rec.plain` 写回，
  所以「还原后与原文逐字节一致」和「不残留重影」都有测试保证；
- 只有文本正好以片假名词开头时（第 0 段本身要带注音）才移除原节点，
  避免底字渲染两遍 —— 这种形态有单独的回归测试。

另外加了两个兜底，避免以后再出现「崩了但没法自救」：

- `MutationObserver` 回调整体 try/catch，回调里出错不再外泄成未捕获异常；
- 紧急开关：控制台执行 `localStorage['katakana-terminator.off'] = '1'`
  （不重启也生效，最多等一轮扫描），插件立刻停手并还原 DOM。
  设置面板在崩溃时是打不开的，所以这个开关不依赖 UI。

## 1.0.2

- 修 CI：`actions/setup-node` 从 Node 20 升到 22.22.2。
  jsdom 30 要求 `^22.22.2 || ^24.15.0 || >=26`，在 Node 20 上它依赖的 undici
  会崩（`TypeError: webidl.util.markAsUncloneable is not a function`），
  导致四个测试文件全部 `testCodeFailure`。
- `package.json` 的 `engines.node` 改为 `>=22.22.2`，并加 `.npmrc`（`engine-strict=true`），
  让版本不满足时在 `npm install` 阶段就失败，而不是等到跑测试才报一堆看不懂的错。
- `tools/check.js` 新增「运行时版本」检查项，提前拦这类问题。
- CI 的测试步骤去掉 `|| npm run test:serial` 兜底 —— 它会把真实失败掩盖成通过。

## 1.0.1

- 填入维护者信息与仓库地址（`manifest.json` 的 `author` / `author_link`，`main.js` 的 `REPO_URL`），
  设置面板里的「源码仓库 / 反馈问题」现在指向真实地址。
- 在线翻译的候选接口从 2 个扩到 4 个：除 `dict-chrome-ex` 的两个 host 外，
  补上 `client=gtx`（`/translate_a/single`）形状的候选，并支持解析该形状的响应。
- 新增 `tools/live-check.js`（联网自测）与 `KT` 控制台调试对象。
- `tools/check.js` 增加元信息一致性检查：`REPO_URL` 必须与仓库一致、不得残留 `OWNER` 占位符。

## 1.0.0

首个版本。

- 把 [Katakana Terminator](https://github.com/Arnie97/katakana-terminator) 的用途搬到网易云音乐：
  片假名外来语上方标注英文原词。
- 三级翻译来源：会话缓存 → 离线词典（335 条）→ 在线翻译（Google `dict-chrome-ex` 接口）。
  原版完全依赖在线接口，这里保证断网也能用。
- 在线部分攒批（约 1.2 秒 / 每批 50 词）、去重、记失败不重试，翻译结果持久化缓存 30 天。
- 默认标注歌词与标题/歌手/专辑，可在设置里改成只标歌词或自定义选择器。
- 实测内核是否支持 ruby 排版，不支持时用绝对定位降级。
- 与 React 协作：注入前快照宿主子节点，还原时整批放回；能识别元素被重建并清理孤儿注音。
