/*
 * Katakana Terminator for BetterNCM —— 离线外来语词典（自动生成，勿手改）
 *
 * 由 tools/build-dict.js 生成：
 *   词表 tools/seed-words.js
 *      -> translate.google.cn (client=dict-chrome-ex, ja->en) 取英文
 *      -> 格式/长度/罗马字转写过滤
 *      -> 回译校验（en->ja 能回到同一个片假名词）
 *
 * 这份词典是插件断网时的兜底；联网时优先用在线翻译（见 core/translate.js）。
 * 英文释义来自 Google 翻译，仅作参考，不等同于词源。
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KTDict = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 片假名 -> 英文（全角形式；半角输入由 core/matcher.js 折算后再查）
  const WORDS = {
    "アイコン": "icon",
    "アイデア": "idea",
    "アカウント": "account",
    "アクション": "action",
    "アクセサリー": "accessories",
    "アクセス": "access",
    "アップグレード": "upgrade",
    "アップデート": "update",
    "アップル": "apple",  // 回译得「リンゴ」，英文释义来自机器翻译，未经回译确认
    "アップロード": "upload",
    "アナログ": "analog",
    "アニメ": "anime",  // 人工核准（英文与原词同形，机器翻译会原样返回）
    "アプリ": "app",
    "アプリケーション": "application",
    "アルコール": "alcohol",
    "アルゴリズム": "algorithm",
    "アルバイト": "part-time job",
    "アンドロイド": "android",
    "イス": "chair",  // 回译得「椅子」，英文释义来自机器翻译，未经回译确认
    "イベント": "event",
    "イメージ": "image",  // 回译得「画像」，英文释义来自机器翻译，未经回译确认
    "インストール": "installation",
    "インタビュー": "interview",
    "インターネット": "internet",
    "インターフェース": "interface",
    "ウィンドウ": "window",  // 回译得「窓」，英文释义来自机器翻译，未经回译确认
    "ウィンドウズ": "windows",  // 回译得「窓」，英文释义来自机器翻译，未经回译确认
    "ウイスキー": "whiskey",  // 回译得「ウィスキー」，英文释义来自机器翻译，未经回译确认
    "ウイルス": "virus",
    "エネルギ": "energy",
    "エネルギー": "energy",
    "エラー": "error",
    "エンジニア": "engineer",
    "エンジン": "engine",
    "オフィス": "office",
    "オフライン": "offline",
    "オペラ": "opera",  // 人工核准（英文与原词同形，机器翻译会原样返回）
    "オンライン": "online",
    "オーケストラ": "orchestra",
    "オープンソース": "open source",
    "カクテル": "cocktail",
    "カタログ": "catalog",
    "カット": "cut",
    "カバン": "bag",  // 回译得「バッグ」，英文释义来自机器翻译，未经回译确认
    "カフェ": "cafe",
    "カメラ": "camera",
    "カメラマン": "cameraman",
    "カラオケ": "karaoke",  // 人工核准（英文与原词同形，机器翻译会原样返回）
    "カレンダー": "calendar",
    "カレー": "curry",
    "カーテン": "curtain",
    "カード": "card",
    "カーニバル": "carnival",
    "ガス": "gas",
    "ガソリン": "gasoline",
    "キッチン": "kitchen",
    "キャラクター": "character",
    "キャンプ": "camping",
    "キャンペーン": "campaign",
    "キーボード": "keyboard",
    "ギター": "guitar",
    "ギフト": "gift",
    "クライアント": "client",
    "クラウド": "cloud",  // 回译得「雲」，英文释义来自机器翻译，未经回译确认
    "クラシック": "classic",
    "クリック": "click",
    "クレーム": "complaint",  // 回译得「苦情」，英文释义来自机器翻译，未经回译确认
    "グループ": "group",
    "グーグル": "google",
    "ケーキ": "cake",
    "ケース": "case",
    "ケーブル": "cable",
    "ゲーム": "games",
    "コスト": "cost",
    "コストパフォーマンス": "cost performance",
    "コネクタ": "connector",
    "コピー": "copy",
    "コメディ": "comedy",
    "コメント": "comment",
    "コンサート": "concert",
    "コンテンツ": "content",  // 回译得「内容」，英文释义来自机器翻译，未经回译确认
    "コントロール": "control",
    "コンパイル": "compilation",  // 回译得「編集」，英文释义来自机器翻译，未经回译确认
    "コンビニ": "convenience store",
    "コンピュータ": "computer",
    "コンピューター": "computer",
    "コーチ": "coach",
    "コーディング": "coding",
    "コート": "coat",
    "コード": "code",
    "コーヒー": "coffee",
    "コーラ": "cola",
    "ゴルフ": "golf",
    "ゴール": "goal",  // 回译得「目標」，英文释义来自机器翻译，未经回译确认
    "サイクリング": "cycling",
    "サイズ": "size",
    "サイト": "site",
    "サイン": "sign",
    "サッカー": "soccer",
    "サラダ": "salad",
    "サングラス": "sunglasses",
    "サンダル": "sandals",
    "サンドイッチ": "sandwich",
    "サンプル": "sample",
    "サーバ": "server",
    "サーバー": "server",
    "サービス": "service",
    "システム": "system",
    "シネマ": "cinema",  // 回译得「映画」，英文释义来自机器翻译，未经回译确认
    "シミュレーション": "simulation",
    "シャツ": "shirt",
    "シャワー": "shower",
    "ショッピング": "shopping",
    "ショップ": "shop",
    "シーン": "scene",
    "ジム": "gym",
    "ジャズ": "jazz",
    "ジャム": "jam",
    "ジュース": "juice",
    "スイッチ": "switch",
    "スカート": "skirt",
    "スキャナー": "scanner",
    "スキー": "skiing",
    "スクリーン": "screen",  // 回译得「画面」，英文释义来自机器翻译，未经回译确认
    "スケジュール": "schedule",
    "スケート": "skating",
    "スコア": "score",
    "スタイル": "style",
    "スタジオ": "studio",
    "スタッフ": "staff",
    "スタミナ": "stamina",
    "ステージ": "stage",
    "ストリーミング": "streaming",
    "ストレス": "stress",
    "ストレージ": "storage",
    "ストーリー": "story",  // 回译得「物語」，英文释义来自机器翻译，未经回译确认
    "スパゲッティ": "spaghetti",
    "スピーカー": "speaker",
    "スピーチ": "speech",
    "スピード": "speed",  // 回译得「速度」，英文释义来自机器翻译，未经回译确认
    "スポーツ": "sports",
    "スマホ": "smartphone",  // 回译得「スマートフォン」，英文释义来自机器翻译，未经回译确认
    "スマートフォン": "smartphone",
    "スーパー": "super",
    "スーパーマーケット": "supermarket",
    "スープ": "soup",
    "ズボン": "pants",  // 回译得「パンツ」，英文释义来自机器翻译，未经回译确认
    "セキュリティ": "security",
    "センサー": "sensor",
    "センス": "sense",  // 回译得「感覚」，英文释义来自机器翻译，未经回译确认
    "セーター": "sweater",
    "セール": "sale",  // 回译得「販売」，英文释义来自机器翻译，未经回译确认
    "ソファ": "sofa",
    "ソフトウェア": "software",
    "ソロ": "solo",
    "ソース": "source",
    "ソースコード": "source code",
    "タイトル": "title",
    "タイプ": "type",
    "タイミング": "timing",
    "タイヤ": "tires",
    "タクシー": "taxi",
    "タッチ": "touch",  // 回译得「触れる」，英文释义来自机器翻译，未经回译确认
    "タバコ": "cigarette",
    "タブレット": "tablet",
    "ダウンロード": "download",
    "ダンス": "dance",
    "チェック": "check",
    "チケット": "ticket",
    "チップ": "chip",
    "チャット": "chat",
    "チャンス": "chance",
    "チョコレート": "chocolate",
    "チーズ": "cheese",
    "チーム": "team",
    "チームワーク": "teamwork",
    "ツアー": "tour",
    "ツイッター": "twitter",
    "テスト": "test",
    "テニス": "tennis",
    "テレビ": "television",
    "テンポ": "tempo",
    "テーブル": "table",
    "テーマ": "theme",
    "ディスク": "disk",
    "ディスプレイ": "display",
    "ディレクトリ": "directory",
    "デザイナー": "designer",
    "デザイン": "design",
    "デジタル": "digital",
    "デバイス": "device",
    "デバッグ": "debug",
    "デパート": "department store",
    "デュエット": "duet",
    "データ": "data",
    "データベース": "database",
    "トイレ": "toilet",
    "トピック": "topic",
    "トラック": "truck",
    "トラブル": "trouble",
    "トラベル": "travel",  // 回译得「旅行」，英文释义来自机器翻译，未经回译确认
    "トレンド": "trend",
    "トレーニング": "training",
    "ドキュメント": "document",  // 回译得「文書」，英文释义来自机器翻译，未经回译确认
    "ドライバ": "driver",  // 回译得「運転手」，英文释义来自机器翻译，未经回译确认
    "ドライバー": "screwdriver",
    "ドライブ": "drive",
    "ドラマ": "drama",
    "ドラム": "drum",
    "ドレス": "dress",
    "ニュース": "news",
    "ネットワーク": "network",
    "ノート": "notes",  // 回译得「メモ」，英文释义来自机器翻译，未经回译确认
    "ハッキング": "hacking",
    "ハンドバッグ": "handbag",
    "ハンドル": "handle",
    "ハンバーガー": "hamburger",
    "ハードウェア": "hardware",
    "バイオリン": "violin",  // 回译得「ヴァイオリン」，英文释义来自机器翻译，未经回译确认
    "バイク": "bike",  // 回译得「自転車」，英文释义来自机器翻译，未经回译确认
    "バグ": "bug",
    "バス": "bus",
    "バスケットボール": "basketball",
    "バター": "butter",
    "バッグ": "bag",
    "バッテリー": "battery",
    "バランス": "balance",
    "バレーボール": "volleyball",
    "バーゲン": "bargain",
    "バージョン": "version",
    "バーベキュー": "barbecue",
    "パスタ": "pasta",
    "パスポート": "passport",
    "パスワード": "password",
    "パソコン": "computer",  // 回译得「コンピュータ」，英文释义来自机器翻译，未经回译确认
    "パターン": "pattern",
    "パワー": "power",  // 回译得「力」，英文释义来自机器翻译，未经回译确认
    "パン": "bread",
    "パンフレット": "brochure",
    "パーティー": "party",
    "パートタイム": "part time",
    "パートナー": "partner",
    "ヒロイン": "heroine",
    "ヒーロー": "hero",  // 回译得「英雄」，英文释义来自机器翻译，未经回译确认
    "ビジネス": "business",
    "ビスケット": "biscuit",
    "ビデオ": "video",
    "ビール": "beer",
    "ピアノ": "piano",  // 人工核准（英文与原词同形，机器翻译会原样返回）
    "ピクニック": "picnic",
    "ピザ": "pizza",
    "ファイル": "file",
    "ファックス": "fax",
    "ファンタジー": "fantasy",
    "フィーバー": "fever",  // 回译得「発熱」，英文释义来自机器翻译，未经回译确认
    "フェイスブック": "facebook",
    "フェスティバル": "festival",  // 回译得「祭り」，英文释义来自机器翻译，未经回译确认
    "フォルダ": "folder",
    "フォルダー": "folder",
    "フレームワーク": "framework",
    "ブラウザ": "browser",
    "ブラウザー": "browser",
    "ブランド": "brand",
    "ブログ": "blog",
    "ブーム": "boom",
    "プラグイン": "plugin",
    "プラン": "plan",  // 回译得「計画」，英文释义来自机器翻译，未经回译确认
    "プリンター": "printer",
    "プレゼン": "presentation",
    "プレゼンテーション": "presentation",
    "プレゼント": "present",  // 回译得「現在」，英文释义来自机器翻译，未经回译确认
    "プログラマー": "programmer",
    "プログラミング": "programming",
    "プログラム": "program",
    "プロジェクト": "project",
    "プール": "pool",
    "ベッド": "bed",
    "ベルト": "belt",
    "ペン": "pen",  // 人工核准（英文与原词同形，机器翻译会原样返回）
    "ホテル": "hotel",
    "ホラー": "horror",
    "ホームページ": "home page",
    "ボタン": "button",
    "ボランティア": "volunteer",
    "ボール": "ball",
    "ポイント": "points",
    "ポケット": "pocket",
    "ポスター": "poster",
    "ポップス": "pops",
    "マイク": "microphone",
    "マイクロソフト": "microsoft",
    "マイブーム": "my boom",
    "マウス": "mouse",
    "マナー": "manners",
    "マラソン": "marathon",
    "マルチメディア": "multimedia",
    "マンガ": "manga",  // 人工核准（英文与原词同形，机器翻译会原样返回）
    "マーケット": "market",  // 回译得「市場」，英文释义来自机器翻译，未经回译确认
    "マーケティング": "marketing",
    "ミステリー": "mystery",  // 回译得「謎」，英文释义来自机器翻译，未经回译确认
    "ミルク": "milk",  // 回译得「牛乳」，英文释义来自机器翻译，未经回译确认
    "ミーティング": "meeting",  // 回译得「会議」，英文释义来自机器翻译，未经回译确认
    "メッセージ": "message",
    "メディア": "media",
    "メニュー": "menu",
    "メモリ": "memory",  // 回译得「記憶」，英文释义来自机器翻译，未经回译确认
    "メロディー": "melody",
    "メンバー": "member",
    "メール": "email",
    "モジュール": "module",
    "モチベーション": "motivation",
    "モニター": "monitor",
    "ユーチューブ": "youtube",
    "ヨガ": "yoga",  // 人工核准（英文与原词同形，机器翻译会原样返回）
    "ライブ": "live",  // 回译得「生きる」，英文释义来自机器翻译，未经回译确认
    "ライブラリ": "library",  // 回译得「図書館」，英文释义来自机器翻译，未经回译确认
    "ラジオ": "radio",
    "ラベル": "label",
    "ランキング": "ranking",
    "リスク": "risk",
    "リズム": "rhythm",
    "リボン": "ribbon",
    "リーダー": "leader",
    "ルール": "rules",
    "レジ": "cash register",
    "レストラン": "restaurant",
    "レベル": "level",
    "レポート": "report",  // 回译得「報告書」，英文释义来自机器翻译，未经回译确认
    "レーザー": "laser",
    "レーダー": "radar",
    "ログ": "log",
    "ロック": "lock",
    "ロボット": "robot",
    "ロマンス": "romance",
    "ワイン": "wine",
  };

  return {
    words: WORDS,
    generatedAt: "2026-09-18T15:26:28.056Z",
    count: 335,
  };
});
