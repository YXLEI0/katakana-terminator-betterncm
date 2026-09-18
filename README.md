# 片假名终结者 · Katakana Terminator for BetterNCM

在网易云音乐里，给**片假名外来语**上方标注**英文原词**。

这是 [Arnie97/katakana-terminator](https://github.com/Arnie97/katakana-terminator)（浏览器扩展 / 油猴脚本）的
网易云移植版，按 [BetterNCM](https://github.com/BetterNCM) 插件规范重写。

```
コーヒー      컴퓨터       インターネット
 coffee     computer      internet
```

## 效果

```
コンピューターの前に座って、コーヒーを飲む
  computer              coffee
```

## 环境

- 网易云音乐 **2.10.x / 3.x**（在 3.1.39 上实测）
- [BetterNCM](https://github.com/BetterNCM) **1.3.0+**

## 安装

### 从插件市场

插件市场里搜「片假名终结者」或 slug `katakana-terminator`。

### 手动安装

1. 从 [Releases](../../releases) 下载 `katakana-terminator.plugin`；
2. 放进 BetterNCM 的插件目录（通常是 `C:\betterncm\plugins`）；
3. 重启网易云音乐。

想自己打包：

```bash
npm install
npm run build                       # 产出 builds/katakana-terminator.plugin
npm run install:plugin              # 顺便复制到 C:\betterncm\plugins
```

## 设置

设置页在 BetterNCM 的插件设置里，改动即时生效。

| 选项 | 说明 |
| --- | --- |
| 启用片假名注音 | 总开关 |
| 词典没有的词联网翻译 | 关掉则完全离线，只用内置词典 |
| 除歌词外也标注标题 / 歌手 / 专辑 | 关掉就只处理歌词区域 |
| 注音字号 | 注音相对底字的百分比，默认 60% |
| 注音不透明度 | 默认 80% |
| 标注范围 | 自动 / 只标歌词 / 自定义选择器 |
| 重新扫描 | 立刻重扫一遍当前页面 |
| 重试未翻译的词 | 清掉「查不到」的记录重新排队（接口恢复后用） |
| 清除翻译缓存 | 清空本地翻译缓存 |

## 翻译从哪来

三级来源，按顺序命中：

1. **会话缓存**（内存）—— 命中就同步返回；
2. **离线词典**（[`src/core/dict.js`](src/core/dict.js)，335 条常用外来语）—— 断网也能标；
3. **在线翻译**（Google 翻译的前端接口）—— 前两层没有的词才发请求。

原版扩展**完全依赖在线接口**，接口一挂插件就废了（同类插件 jp-furigana 就因为这个停更过）。
这里把词典放在在线之前，保证「离线可用、在线更准」。

在线部分是非阻塞的：查不到的词先进队列，攒一小会儿（约 1.2 秒）批量请求，一次最多 50 个词。
同一批里的重复词只发一次；失败过的词会记成「查不到」不再自动重试，避免接口故障时把请求打爆。
结果缓存在 `localStorage`，30 天过期，最多 4000 条。

在线接口有**四个候选**，按顺序尝试，前一个失败就换下一个（同一个厂商、两种响应形状）：

| 顺序 | 接口 | 形状 |
| --- | --- | --- |
| 1 | `translate.google.cn/translate_a/t` | `client=dict-chrome-ex` |
| 2 | `translate.google.com/translate_a/t` | `client=dict-chrome-ex` |
| 3 | `translate.googleapis.com/translate_a/single` | `client=gtx` |
| 4 | `translate.google.cn/translate_a/single` | `client=gtx` |

多候选是有实际意义的：某些网络环境会把这些域名写进 `hosts` 指向 `127.0.0.1`，
或者对单个接口限流；换域名/换接口往往就能绕过。四个都失败才判定为离线。

> 如果你的网络需要代理才能访问这些接口，请让网易云走系统代理（或在代理软件里开 TUN/透明代理）。
> 插件自身不读代理设置，走的是客户端进程的网络栈。

## 排障

控制台（BetterNCM 的开发者工具）里有一个 `KT` 对象：

```js
KT.stats()            // 命中统计、在线请求次数、失败原因、缓存条数
KT.lookup('コーヒー')  // 单独查一个词，看当前拿到什么译文
KT.rubyLayout()       // 当前内核认不认 ruby 排版（false 表示走了降级）
KT.scan('コーヒーとカフェ')   // 看分词结果
KT.pass()             // 立刻重扫一次
KT.clearCache()       // 清掉翻译缓存
KT.set('online', false)  // 临时改成纯离线
```

`[katakana-terminator]` 开头的日志里，`在线翻译失败：...` 会带上最后一个接口的错误原因。
接口全部失败时插件会退回离线词典，页面不会出错——只是没词典覆盖的词不标。

想单独验证联网这条路：

```bash
set HTTPS_PROXY=http://127.0.0.1:7897   # 按你的代理端口改
node --use-system-ca tools/live-check.js
```

## 实现要点

- **只改文本节点，不改整行。** 片假名注音不需要重新分词，所以逐个文本节点替换即可，
  React 重建时要还原的东西也少。
- **还原靠快照。** 注入前记下宿主的子节点，还原时整批放回，保证逐字节回到原样
  （不残留 `class=""` 之类的痕迹）。
- **能识别 React 重建。** 元素被整体替换后，我们插的节点会留在被丢弃的子树里，
  这时要主动清掉，否则 React 复用节点时会看到过期注音。
- **实测内核的 ruby 支持。** 网易云的 CEF 在某些版本里会把 `<rt>` 画成 block、撑坏行高。
  代码用真实布局探针判断（不能用 `CSS.supports('display','ruby')`，对新内核恒为 false），
  不支持时改用绝对定位的 `<span>` 降级。
- **不和自己较劲。** 扫描结束后清空 `MutationObserver` 的记录队列，
  否则自己造成的 DOM 变更会自激成死循环。

## 目录结构

```
src/
  manifest.json       插件描述（injects 顺序即依赖顺序）
  main.js             入口：生命周期、观察循环、设置面板
  core/matcher.js     片假名识别 + 半角折算（从原版正则移植）
  core/dict.js        离线词典（自动生成，勿手改）
  core/translate.js   缓存 / 词典 / 在线请求的调度
  core/annotate.js    DOM 注音注入与还原
tests/                jsdom 单元测试
tools/
  build.js            打包成 .plugin（zip）
  build-dict.js       生成离线词典
  make-preview.js     生成预览图
  check.js            静态自检（语法/manifest/词典/密钥）
  live-check.js       联网自测在线翻译接口
```

## 开发

```bash
npm install
npm test              # 跑单元测试
npm run test:serial   # 某些沙箱里 node --test 起不了子进程时用这个
npm run check         # 静态自检
node --use-system-ca tools/live-check.js   # 联网自测在线翻译（需要能访问 Google）
```

### 重新生成离线词典

词典是**生成**的，不要手改 `src/core/dict.js`：

```bash
# 需要能访问 translate.google.cn
npm run build:dict
```

流程：读 `tools/seed-words.js` 的词表 → 调 `translate.google.cn` 的
`dict-chrome-ex` 接口取英文 → 过滤（长度/字符集/罗马字转写）→ 回译校验打标 → 写出 `dict.js`。
词表里只放纯片假名词，混进汉字会被 `build.js` 和 `check.js` 拦下来。

想加词就编辑 `tools/seed-words.js`，再跑一次生成。

## 已知限制

- **桌面歌词不生效。** 那是原生窗口，不是网页，插件技术上够不到。
- 单片假名词不注（「ア」这种），除非它正好在词典里。
- 只处理假名，汉字振假名是另一个插件（jp-furigana）的活。
- 在线翻译依赖 Google 的**非公开**接口，可能失效或被限流；失效时自动退回离线词典。

## 许可

插件自身代码采用 **MIT**，见 [LICENSE](LICENSE)。

词典数据的来源与注意事项见 [NOTICE.md](NOTICE.md)。

## 致谢

- [Arnie97/katakana-terminator](https://github.com/Arnie97/katakana-terminator) —— 原版扩展，
  片假名匹配正则与「用 ruby 标注」的思路都来自它（MIT）。
- [Leleawa/jp-furigana](https://github.com/Leleawa/jp-furigana) —— 同生态的振假名插件，
  本插件参考了它的 BetterNCM 生命周期写法、设置面板结构与 ruby 支持探针。
- [BetterNCM](https://github.com/BetterNCM) —— 插件框架。
