# 更新记录

## 2.0.0

**删掉浮层方案，只保留「按行分工 + 共存补丁」这一条路。**

1.2.x 里为了让本插件和 jp-furigana 互不干扰，同时存在两套渲染方式：
直接写进歌词行（`lyricRender: "inline"`）和把英文画在独立浮层上（`overlay`）。
共存补丁做完之后，浮层已经没有存在意义了 —— 它的全部优点（不碰歌词 DOM）
都被「按行分工」覆盖，代价（不参与排版、换行/缩放时位置偏）却是独有的。

- 删除 `src/core/overlay.js`（261 行）及其 9 个测试；
- 删除设置项 `lyricRender`（`configVersion` → 4，旧配置里的这个键会被忽略）；
- 含汉字的歌词行保持「让给 jp-furigana」的默认行为；
打开「与振假名插件共用同一行」（+ 打补丁）后同一行两种注音并存；
- 新增 `tests/coexist.test.js`（6 个用例），把共存行为固化成契约；
- 顺带修掉设置面板里「标注范围」标错默认值的问题（`all` 才是默认）。

不兼容变更：升级后含汉字的歌词行不会再出现英文注音，除非打开共存开关。
如果你之前一直在用浮层，这个版本会改变你看到的效果 —— 这是有意的。

## 1.2.3

继续修闪烁。这次找到了**真正的来源**：不是判定逻辑，而是**变更通知**。

jp-furigana 的 MutationObserver 回调里对任何 `childList`/`characterData` 变更
都会把最近的歌词行标脏：

```js
for (const r of records) {
  if (r.type !== 'characterData' && r.type !== 'childList') continue;
  for (let el = r.target; el; el = el.parentElement)
    if (el.__fgText != null) { el.__fgDirty = true; ... }   // ← 无条件标脏
```

我们插 `<ruby>` 恰好就是一次 `childList` 变更 → 该行被判脏 → `processLine` →
`restoreLine` 先把 wrap 摘掉（我们的注音随之消失）→ 重建 → 我们再插……

前两处补丁只影响「判定是否干净」，管不到「什么时候被标脏」，所以照样每轮重建。

补丁新增第三条（关键）：在 observer 回调最前面跳过我们引起的变更
（`__ktRecordIsOurs`）。配套地，插件会给**自己造出来的节点**打上 `__ktOwned`
标记（新建的文本分段 + 改写过的原文本节点），供它识别。

判断逻辑用 9 个用例验证过：

| 变更 | 视为我们的 |
| --- | --- |
| 插入/删除我们的 ruby | ✅ |
| 插入我们标记过的文本节点 | ✅ |
| 改写我们改过的原文本节点 | ✅ |
| 插入普通文本节点 | ❌ |
| 插入别人的 ruby | ❌ |
| 混合插入（我们的 + 普通的） | ❌ |

另外插件侧消费 `host.__ktForeign`：取走并**清空**它还原时摘下的注音节点，
立刻挂回原位（缩短可见空窗），同时避免节点越积越多。

## 1.2.2

修「歌词行消失」——**这是我 1.2.0 补丁里的 bug，我造成的。**

`restore()` 原本靠「host 为空」来决定是否放回原文字：

```js
if (!host.hasChildNodes() && host.__fgOrig && host.__fgOrig.length)
    host.append(...host.__fgOrig);
```

而我的补丁先把外来注音 `appendChild` 到 host 上，host 就有子节点了，
于是上面这个条件**永远不成立**，整行文字再也放不回来 —— 实测复现：

```
处理前:    取戻したい　ヒーローみたいに
restore 后: 只剩 [我们的 ruby]，其余文字全没了
原文本节点还在 p 里吗: false
```

**修法**：不再往 host 上挂节点，改成暂存到 host 的 expando（`host.__ktForeign`）：

```js
const __ktNodes = [...wrap.querySelectorAll('ruby.kt-ruby, .kt-ov-label')];
if (__ktNodes.length) host.__ktForeign = __ktNodes;
wrap.remove();        // 之后原有的 `if (!host.hasChildNodes() ...)` 依然成立
```

暂存后由片假名终结者自己接手，把节点挂回我们的原文本节点后面；
也不会在宿主上残留任何 expando。

修复前后对比（用真实函数实测）：

| | `restore()` 后可见文字 |
| --- | --- |
| 旧补丁 | `"ヒーロー"`（其余全丢） |
| 新补丁 | `"取戻したい　ヒーローみたいに"` ✅ |

顺带加固工具链：

- `revertPatch()` 改成按 `HELPER` 常量**精确移除**注入块（之前按行号找，留残渣），
  并支持传入原始文本做逐字节校验；
- `patch-jp-furigana-plugin.js` 新增 `--force`：以备份为基准重新打补丁，
  避免在旧补丁上叠加；
- `--revert` 优先用备份逐字节还原。

## 1.2.1

修「补丁打了但没用」。

原因很关键：**BetterNCM 每次启动都会把 `plugins/*.plugin` 重新解包到
`plugins_runtime/<slug>/`**，所以我上一版改解包目录里的 `main.js` 在下次启动时
被原封不动覆盖回去了（实测：改完是 53098 字节，重启后变回 63869 字节、
时间戳回到原日期，补丁消失）。补丁必须打在**包本身**上才能持久。

新增 `tools/patch-jp-furigana-plugin.js`：

- 直接修改 `plugins/jp-furigana-*.plugin`（读取 zip → 替换 `main.js` → 重新打包）；
- 支持 `--check` / `--revert` / `--file <路径>`；
- 打补丁前做语法自检，语法不过就中止且不改文件；
- 自动备份成 `<原名>.kt-bak`，只备份一次；
- 自带 zip 读写往返自检（20 个条目、内容逐字节一致），
  避免重新打包把词典文件弄坏。

`tools/patch-jp-furigana.js`（改解包目录的那个）保留，适合临时试验；
要持久请用新脚本。

**操作步骤**（改包之后必须让解包目录重新生成）：

```powershell
node tools/patch-jp-furigana-plugin.js
Remove-Item -Recurse -Force C:\betterncm\plugins_runtime\jp-furigana
# 然后重启网易云
```

## 1.2.0

**支持「同一行歌词里，汉字有振假名 + 片假名有英文」。** 需要给 jp-furigana 打补丁。

先把机制说清楚（用它的真实代码 + 真实 DOM 结构实测出来的）：

我原本以为冲突来自 `isClean()` 里的 `h.childNodes.length !== 1`。**实测发现不是**——
在"jp-furigana 已注音、我们插了 ruby"的场景下：

| | `isClean()` | `restore()` 后我们的注音 |
| --- | --- | --- |
| 未打补丁 | `true` | **0 个（被丢掉）** |
| 已打补丁 | `true` | **1 个（保住）** |

抹掉我们注音的真正原因是 `restore()`：

```js
const wrap = host.__fgWrap;
if (wrap && wrap.parentNode === host) wrap.remove();   // ← 我们的节点挂在 wrap 里，一起被扔了
```

它每次处理该行都会先 `restoreLine()`，所以我们的注音每轮都被丢掉一次。

另外实测到一件好事：我们改写的是它留着的原文本节点（只切短、不删除），
所以它算出来的「看得见的原文」`hostsText()` 一个字符都没变 ——
注解前后它读到的都是 `取戻したい　ヒーローみたいに`。

补丁做两件事（`tools/patch-jp-furigana.js`）：

1. `restore()`：拆 wrap 前，把我们挂在它 wrap 里的注音节点先搬到 host 上，
   免得跟着一起被丢掉（它随后重建 wrap 时会用 `include` 把 host 的全部子节点
   搬进新 wrap，我们的节点也跟着进新 wrap）；
2. `isClean()`：子节点计数忽略我们插的节点，作为纵深防御。

用法：

```bash
node tools/patch-jp-furigana.js           # 打补丁（自动备份 main.js.kt-bak）
node tools/patch-jp-furigana.js --check   # 看状态
node tools/patch-jp-furigana.js --revert  # 还原
```

补丁前会做语法自检，语法不过就中止且不改文件。锚点找不到会明确报出来，
不会打一半。

插件侧新增设置项 `coexistWithFurigana`（默认关）。打开它并且该行确认被
jp-furigana 接管时，含汉字的行也会注音；没打补丁时遇到它管的行仍然让开。

**注意**：jp-furigana 更新后补丁会丢失，重新跑一次脚本即可。

测试 71 个全过。

## 1.1.1

按「各管各的元素」重做与 jp-furigana 的共存（不再依赖浮层）。

关键发现：jp-furigana 的 `processLine()` 里有一条
`if (!FuriganaCore.hasKanji(text)) { line.__fgHosts = []; return; }`
—— **纯假名行它压根不管**。所以按「含不含汉字」分工就行：

- **含汉字的歌词行**：整个让给它，我们一个字节都不碰；
- **纯假名行**：归我们；
- **播放栏的歌曲名/歌手**：它从来不碰，我们照标（含汉字也标）。

于是 `lyricRender` 默认回到 `inline`（排版正确，不再是浮层），
靠这条分工规则避免冲突。浮层作为可选项保留（`lyricRender: "overlay"`），
适合"我全都要"的场景。

实现要点：

- `matcher.hasKanji()`：和 jp-furigana 同口径的汉字判断；
- `annotate.js` 新增 `skipKanjiLines` 选项（默认 `false`，不改变模块自身语义；
  由 `main.js` 在 inline 模式下传函数，每次扫描实时求值）；
- 新增 `isLyricRegion()`：只对**歌词行**做分工 —— 播放栏名称含汉字也要照标；
- 新增 `lineHasKanji()`：判断"看得见的原文"里有没有汉字。
  不能直接用 `textContent` —— 振假名插件插的 `<rt>` 文字也算 textContent，
  会把纯假名行误判成含汉字，导致该我们管的行反而被让出去。

修掉两个自己引入的 bug：`isLyricRegion` 最初把播放栏也判成歌词行（
`player-bar` 命中 `lyric`? 不，是判据过宽），以及循环里 `region` 变量
在使用之后才赋值。

测试 71 个全过。

## 1.1.0

**新增浮层渲染，可以和 jp-furigana（振假名插件）在同一行歌词上共存。**

先说清为什么必须换渲染方式。jp-furigana 的做法是：把整行内容换成自己的
`<span class="fg-line">`，然后靠 `h.childNodes.length !== 1` 判断「这行有没有被
外人动过」。我往它管的行里插 `<ruby>`，它就判定行脏 → 还原 → 重建整行 →
我的注音被抹掉 → 我再注……两边来回就是抽搐（轨迹实测 `changed=18 restored=18`
每秒四次）。**只要改歌词 DOM，就不可能共存。**

所以新增 `core/overlay.js`：把英文注音画在一个独立的浮层上。

- 完全不碰歌词 DOM（有测试断言歌词容器一字不变）；
- 用 `Range.getBoundingClientRect()` 量出每个片假名词的位置，绝对定位画上去；
- 浮层 `position:fixed` + `pointer-events:none`，不吃鼠标事件、不影响点击滚动；
- 滚动（捕获阶段，兼容内部滚动容器）、resize、DOM 变化、以及 250ms 兜底
  都会重新测量（逐字动画/transform 滚动不一定触发事件）；
- 只画视口附近的行，远处的不建标签。

设置里新增「歌词渲染方式」：

| 选项 | 说明 |
| --- | --- |
| `overlay`（默认） | 浮层，不碰 DOM，可与振假名插件共存 |
| `inline` | 直接写进歌词行，排版更准，但会和 jp-furigana 互相打架 |

默认范围回到 `all`（歌词用浮层 + 播放栏用 DOM 注音），配置迁移同步更新。

**如实说明代价**：浮层不参与排版，所以换行/缩放时位置可能略有偏差；
复制歌词不会带上英文注音；**定位效果我在开发环境里无法验证**
（jsdom 没有布局引擎），需要真机目视确认。

测试 61 → 71（新增 9 个浮层测试 + 1 个「歌词 DOM 逐字节不变」）。

## 1.0.11

针对「问题依旧」做了两件事：**默认不再碰歌词**，以及修掉一个导致开关失效的真 bug。

**1. 歌词标注改为默认关闭。**

真机上歌词行的 DOM 由网易云和 RefinedNowPlaying 高频重建，文字还带逐字动画，
注音进去会被反复丢掉。追着重注就是抽搐——这一点几轮都没能根治，
而它已经影响到正常使用，所以默认改成只标**播放栏的歌曲名/歌手**（DOM 稳定）。
需要歌词的人可以在设置里把「标注范围」改成"只标歌词"或"歌词 + 播放栏"。

**2. 修「关掉后仍在注音」的 bug（`core/annotate.js`）。**

```js
var list = regions && regions.length ? regions : findRegions("safe");
```

空数组是 truthy 但长度为 0，于是"没传区域"和"区域为空"被混为一谈：
传空数组反而会退回默认区域。结果就是把播放栏标注关掉后它还在注音。
改成 `regions ? regions : findRegions("safe")`。

**3. 新增「一直在变就不碰」的放弃机制。**

按 host 记录可见文本变化次数，连续变化超过 3 次就判定为"在动"并放弃，
不再追着重注（`unstable` 计数会出现在轨迹里）。稳定性优先于覆盖率。

**4. 没有区域时撤掉已有注音。**

关掉某个范围（区域列表变空）时，会把之前注的音还原，而不是留着不管。

验证（模拟真机：每轮扫描前把每行内部换新、文字不变）：

```
默认（只标播放栏）：pass1 changed=1 → pass2..5 changed=0        完全静止
打开歌词 + 每轮重建：pass1 changed=3 → pass2..6 changed=0       不再追击
```

测试 60 → 61。

**说明**：1.0.10 的改动我依赖的是构造的 DOM 模拟，而真机行为不同，
所以那次没能解决。这一版把默认行为改成不碰歌词，从源头上避免这个问题。

## 1.0.10

终于根治「歌词一直抽搐」。轨迹给出了确凿证据：

```
[pass] regions=121 changed=18 restored=18     ← 每 250ms，持续几分钟不停
```

18 行歌词在**无限地撤销 + 重注**。机制是：网易云/RefinedNowPlaying
会把歌词行的**内部子节点整批换新**，文字却一字不变。此时记录里的文本节点
已经作废，新文本节点没有记录，于是被当成"新的一行"重新注音 ——
React 一重建我们就注一次，来回触发，永不收敛。

改动（`core/annotate.js`）：

- 新增按 **host 元素**索引的记忆 `decidedByHost`：记住"这个 host 的这段
  可见内容已经处理过"，同时记下**两种可见形态**（注音在位时的底字、
  以及 React 丢掉我们节点后的底字）—— 这两种都说明内容已处理过。
- 判断顺序提到**还原之前**：否则即使最终决定不重注，中途也已经做了一次
  还原（一串 DOM 变更 = 可见的一闪）。
- React 已经把我们的节点丢掉时**不再"还原"**，直接丢记录重注 ——
  还原本身就会闪（`annotationsIntact()`）。
- 同一段内容最多补注一次（`reAnnotated`）：补了还被丢掉，说明补注音这个
  动作本身会触发对方重建，就不再补。宁可这一行暂时没有注音，也不动 DOM ——
  稳定性优先于覆盖率。
- `restoreAll()` 同时清掉这份记忆，否则用户手动禁用再启用（或改设置触发
  rescan）后会"怎么都不再注音"。

顺带修：轨迹里的 `[pass]` 日志改成只在真的做了事时才写。之前每 250ms
一条会把 250 行缓冲冲干净，导致我加的诊断日志（明明写了）在轨迹里根本
看不到 —— 白折腾一轮。

验证（模拟真机模式：每轮扫描前 React 把每行内部换新、文字不变）：

```
round1:    changed=2 restored=0
round2..8: changed=0 restored=0 skipped=2      ← 完全静止
```

改之前是 `changed=18 restored=18` 永不收敛。测试 58 → 60。

## 1.0.8

针对「还是抽搐」和「上一首的歌词出现在正在播放的歌词里」两个现象继续修。

后一个现象是最有价值的新线索：**页面上同时存在多个歌词容器** ——
正在播放的那个，加上上一首还没卸载的、以及 RefinedNowPlaying 的淡出副本。
之前的行为是「只要选择器命中就注音」，于是：

- 隐藏副本也被注音，换歌过程中两种歌词同时可见（就是"上一首的歌词串进来"）；
- 同一份歌词在多个容器里各注一遍，React 重建哪个我们就重注哪个，
  来回触发就是持续抽搐。

改动：

- `findRegions` / `collectBySelectors` 增加**可见性过滤**：明确隐藏
  （行内 `display:none` / `visibility:hidden`、`hidden` 属性，或
  `getComputedStyle` 能确认隐藏）的容器直接跳过。判定从严，拿不到样式时
  一律当可见，避免漏标正常内容。
- `pass()` 里原来有一个**全局的"失效记录还原"循环**：它每轮把**所有**
  历史记录无条件还原一遍（包括已经隐藏、根本不用管的行），然后才去处理区域。
  这才是抽搐一直没根除的原因。现在只在该记录对应的文本节点真的被处理到、
  且确认失效时才还原。
- 循环内节点所属区域也做同样的可见性判断。

顺带修测试里 `querySelector(...).length` 的写法（在本项目的 jsdom realm 下
不可靠），统一成 `querySelectorAll`。

新增测试：隐藏的歌词副本不标注、且多轮扫描稳定。

测试 57 → 58。

## 1.0.7

修「装了振假名插件（jp-furigana）时，同时有振假名和英文注音的歌词行仍会抽搐」。

根因是**跨插件的 class 冲突**：我用 `class="kt-region"` / `class="kt-fallback"`
标记已注音的区域，而这些区域元素（`ul.lyric > li`、RNP 的歌词行等）是和别的
歌词插件共用的。改它们的 `className` 会让对方的渲染检查判定"这行变了"并
重建整行，把我们的注音一起丢掉，下一轮我们再标一次 —— 两边互相触发，
表现就是只有"两种注音都有"的行才一直抽搐。

改法：标记一律改用 `data-kt-region` / `data-kt-fallback` 属性，
**不再写任何共用元素的 `className`**（只给自己创建的 `ruby` / `rt` / `span` 设 class）。
CSS 选择器同步改成 `[data-kt-region]` / `[data-kt-fallback]`。

新增回归测试：扫描前后，所有既有元素的 class 必须一字不变。

测试 56 → 57。

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
