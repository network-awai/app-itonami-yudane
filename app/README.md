# Yudane — Tauri v3 app（AWAI-3502）

委ね — 暮らしの予定から生まれる電力の柔軟性を、同意と匿名性の条件で確かめます。申し出ごとに、能力（capability）・期限・互恵性・k-匿名性（5 人以上）を判定し、集計だけを示します。個人のデータは扱わず、外部へは何も送信しません。

この `app/` は、repo の `.cljk` ドメインコードを ClojureScript でそのまま端末内で動かす Tauri v3 アプリです。

## 仕組み

- `scripts/build.mjs` が、repo の `.cljk`（`package.json` の `itonami.cljsSources`）を `.cljc` として写し、`src/cljs/itonami/app/entry.cljs`（この app の操作の定義）と固定した `kotoba.lang.text` と一緒に ClojureScript（1.12.145、advanced）で `dist/domain.js` にまとめます。コンパイラの警告が 1 つでもあれば build は失敗します。
- 画面（`src/ui/`）は操作ごとに EDN の入力欄と例を出し、結果を EDN で表示します。実行の記録は端末の localStorage にだけ残ります。
- 外部への通信はありません。descriptor の `operations` は空、CSP は `connect-src ipc: http://ipc.localhost` だけ、Tauri の権限は読み取り専用の `awai_host_info` だけです。Android の manifest に `INTERNET` 権限はありません。
- 入れていないもの（daemon・送受信・遠隔推論・公開など）は `entry.cljs` の冒頭に書いています。

## 使い方

```sh
cd app
npm ci
npm test            # build + 6 checks (descriptor, no network API, CSP, capabilities, release pins, every example runs)
npm run build:android   # Android debug APK, package network.itonami.yudane
```

`npm run build` には Clojure CLI（JVM）が要ります。Android には SDK・NDK 27・JDK 21・Rust の `aarch64-linux-android` が要ります。

Store への掲載は network-awai/awai-os の `android/local-apps.json` と `build.py --local-apps-dir` で行います。実機・署名済みの配布は未確認です。
