# SF6 Battlelog Sync

ストリートファイター6 の [Buckler's Boot Camp](https://www.streetfighter.com/6/buckler/) からランクマッチの戦績を取得して、Google スプレッドシートに追記するツール。
ブラウザで戦績ページを開いて拡張のボタンを押すと、直近100試合ぶんを取得してシートに追記する。すでに記録済みの試合は自動でスキップされるので、何度押しても行が重複しない。

## 仕組み

```
[人間]  Buckler にログインして戦績ページを開く
   ↓
[Chrome拡張]  ページのセッションのまま全ページぶんの JSON を取得 → POST
   ↓
[Apps Script]  replay_id で重複を除いてシートに追記
```

## セットアップ

### 1. Apps Script（受け皿）

1. 記録先のスプレッドシートを開き、「拡張機能」→「Apps Script」
2. [`apps_script/Code.gs`](apps_script/Code.gs) の中身を貼り付ける
3. `TOKEN` を自分だけが知っている文字列に変更する（`openssl rand -hex 16` などで生成）あとでブラウザの拡張機能に設定します。
4. 「デプロイ」→「新しいデプロイ」→ 種類は **ウェブアプリ**
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
5. 初回は承認を求められる。「このアプリは確認されていません」→「詳細」→「（プロジェクト名）に移動」
6. 発行された `/exec` で終わる URL をコピーしておく

### 2. Chrome 拡張

1. `chrome://extensions` を開く
2. 右上の「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」→ [`extension/`](extension) フォルダを選択

### 3. 拡張の設定

ツールバーの拡張アイコン →「設定」を開き、手順1でコピーした `/exec` URL と `TOKEN` を入力して保存する。

## 使い方

1. Buckler にログインする
2. 自分のバトルログのページを開く
   `https://www.streetfighter.com/6/buckler/ja-jp/profile/{あなたのSID}/battlelog/rank`
3. 拡張のアイコンをクリック →「バトルログを同期」

`✅ N件を追記（既存 M件はスキップ）` と出れば成功。

## シートの列

| 列 | 内容 |
| --- | --- |
| `replay_id` | 試合の一意ID。重複排除のキー |
| `played_at` | 対戦日時 |
| `battle_type` | RANKED MATCH など |
| `result` | WIN / LOSE |
| `rounds` | 取得ラウンド数（`2-1` など） |
| `my_character` | 自分の使用キャラ |
| `my_input` | クラシック / モダン |
| `my_league_rank` | ランク番号 |
| `lp_before` | **その試合を始める前**の LP |
| `lp_delta` | LP 増減（後述） |
| `my_master_rating` | MR（マスター未到達なら 0） |
| `my_round_results` | ラウンドごとの生の値（`1,0,7` など） |
| `opponent` | 相手のファイターID |
| `opponent_sid` | 相手の SID |
| `opponent_character` | 相手の使用キャラ |
| `opponent_input` | 相手の入力方式 |
| `opponent_league_rank` | 相手のランク番号 |
| `opponent_lp` | 相手の LP |
| `opponent_master_rating` | 相手の MR |
| `opponent_round_results` | 相手のラウンド生値 |
| `opponent_platform` | 相手のプラットフォーム |

### `lp_before` と `lp_delta`

Buckler が返す `league_point` は **その試合の開始前**の LP。つまり増減は1試合の情報だけからは求まらない。

そのため `lp_delta` は「次の試合の `lp_before` との差」として後追いで埋めている。最新の1行は次の試合がまだ無いので空欄になり、**次回の同期で自動的に埋まる**。

LP はキャラクターごとに独立しているので、直後の試合が別キャラだった場合は空欄のままにしている。

### `round_results` の値

`0` はそのラウンドを落としたことを表し、`0` 以外は取ったことを表す。勝敗判定にはこれを使っている。

`1` / `5` / `7` と値が分かれるのは決着の種類（KO・パーフェクト・時間切れなど）と思われるが、**対応関係は未解明**。後から解析できるよう生の値のまま保存している。

## 制限

- **直近100試合しか取得できない。** Buckler 側が保持している範囲がそれだけなので、前回の同期から101試合以上プレイすると、古いものは取り返せない。こまめに同期するのが安全
  - この場合、境目の `lp_delta` は複数試合ぶんの差になり、実際の増減と一致しなくなる
- ランクマッチのページ（`/battlelog/rank`）で動作を確認している。他のモードのページでも同じ仕組みで動くはずだが未検証
- 拡張はストアに公開していないため、デベロッパーモードでの読み込みが必要

## trouble shooting

### 列を追加したとき

`apps_script/Code.gs` の `HEADERS` と `extension/popup.js` の変換部分の両方を更新する。行の組み立ては `HEADERS` から導出しているので、順序のズレは起きない。

既存シートは列構成が古いままなので、**シートごと削除してから**同期し直す。消し忘れた場合はエラーで安全に停止する。

### Apps Script を更新するとき

「デプロイ」→「**デプロイを管理**」→ 鉛筆アイコン → バージョンを「新バージョン」→ デプロイ。

「新しいデプロイ」を選ぶと **URL が変わってしまい**、拡張側の設定が 404 になる。

### 構成

```
apps_script/Code.gs   受け皿。重複排除・追記・lp_delta の後追い更新
extension/            Chrome 拡張（Manifest V3）
  manifest.json
  popup.html / popup.css
  popup.js            取得ロジックと送信処理
docs/design/          設計メモ
```

## ライセンス

個人利用のためのツール。ストリートファイター6 および Buckler's Boot Camp は株式会社カプコンの著作物です。
