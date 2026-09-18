# 更新记录

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
