# 第三方组件与数据来源

本插件由 **YXLEI0** 移植维护：https://github.com/YXLEI0/katakana-terminator-betterncm

本插件**没有**打包任何第三方运行时库（不需要 kuromoji、不需要分词词典）。
分发的文件只有本仓库 `src/` 下的代码、一份生成的词典和一张预览图。

## 1. 原版 Katakana Terminator

- 项目：https://github.com/Arnie97/katakana-terminator
- 作者：Arnie97 及贡献者
- 许可：MIT

`src/core/matcher.js` 的片假名识别规则是从原版油猴脚本的
`katakana-terminator.user.js` 移植并改写的（原版用一条正则配合 `splitText`，
这里改成线性扫描并支持半角折算）。插件的用途、外观与交互有意与原版保持一致。

MIT 许可允许修改与再分发，但要求保留版权声明。原许可全文见
[LICENSE](LICENSE) 末尾，或上述仓库的 `LICENSE` 文件。

## 2. 离线词典 `src/core/dict.js`

- 生成脚本：`tools/build-dict.js`
- 词表：`tools/seed-words.js`（本仓库手写的常用外来语表）
- 英文释义来源：**Google 翻译**（`translate.google.cn`，`client=dict-chrome-ex`，ja→en）

需要说明的是：

- 英文释义是**机器翻译结果**，用于在页面上做提示性注音，**不等于词源考据**。
  词典里对回译未命中的条目都加了注释（例如 `アップル -> apple`，回译是「リンゴ」），
  生成脚本也把所有条目都过了格式与罗马字转写过滤。
- 生成时使用的是一个**未公开文档的接口**。插件运行时的在线翻译也走同一个类型接口。
  它可能在任何时候失效、限流或改变行为；失效时插件自动退回这份离线词典。
  使用者需要自行判断在所在地与自身用途下这样做是否合适。
- 重新生成词典需要联网执行 `npm run build:dict`，该步骤**不属于**插件的运行流程。

如果你希望以更严格的方式获取释义，可以自己替换 `tools/build-dict.js` 里的取词实现
（例如改用 JMdict 或其他词典数据源），只要产出的 `src/core/dict.js` 结构不变即可。

## 3. 开发期依赖

`jsdom`（MIT）仅用于单元测试（`devDependencies`），**不会**被打进 `.plugin` 包。

## 4. 参考实现

- [Leleawa/jp-furigana](https://github.com/Leleawa/jp-furigana)：同生态的「日语歌词振假名」插件。
  本插件参考了它的 BetterNCM 生命周期写法、设置面板的 `data-k` 绑定结构、
  `MutationObserver` 记录清理方式，以及判断内核是否支持 ruby 排版的实测探针。
  未复制其代码，但思路来自该项目的公开实现。
- [BetterNCM](https://github.com/BetterNCM)：插件框架与 manifest 规范。
