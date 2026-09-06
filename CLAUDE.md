# CLAUDE.md

> [!IMPORTANT]
> **このリポジトリは公開されている**（`katsumata-ryo/street_fighter_6`）。
> コミットする内容・README や docs に書く例・エラーメッセージの貼り付けは、
> すべて世界中から読まれる前提で扱うこと。詳しくは末尾の「公開リポジトリでの注意」。

SF6 の個人用ツール置き場。2つのものが同居している。

1. **バトルログ同期** — Buckler's Boot Camp の戦績を Google スプレッドシートに追記する（Chrome 拡張 + Apps Script）。セットアップと仕様は [README.md](README.md) に全部書いてある
2. **フレームデータ** — 公式サイトから全キャラのフレームデータを取得して JSON にしたもの

## 構成

```
apps_script/Code.gs        同期の受け皿。重複排除・追記・lp_delta の後追い更新
extension/                 Chrome 拡張（Manifest V3）。popup.js が取得と送信
scripts/fetch_frame_data.rb  フレームデータの取得スクリプト
data/                      取得データ（gitignore 済み）
docs/design/               設計メモ
```

## フレームデータ

`data/frames/` に全31キャラ・2,442技ぶん。**`data/` は gitignore されている**ので、
clone 直後やファイルが無いときは取得し直す：

```bash
ruby scripts/fetch_frame_data.rb
```

依存は Ruby 標準ライブラリのみ。1回あたり31リクエスト・30秒ほど。
スキーマの詳細は [data/frames/README.md](data/frames/README.md) を見ること。

### 読むときの注意

- **1ファイル 30〜80KB あるので丸ごと Read しない。** `jq` で必要な技だけ絞る
- **数値はすべて文字列。** `全体 47` `21+着地後12` `※1100` `D`（ダウン）のような
  非数値が普通に混ざる。比較するときは `tonumber? // 0` で保護する
- **空欄は `null`。** 発生の無い技（前ステップ等）は `startup` が `null` で、
  代わりに `recovery` に `全体 47` と入っていたりする
- キャラは slug で引く。日本語名 → slug は `data/frames/index.json`
  （`gouki_akuma` = 豪鬼、`vega_mbison` = ベガ、`cviper` = C.ヴァイパー あたりは注意）

### よく使う引き方

```bash
# 技をひとつ引く
jq -r '.moves[] | select(.name=="しゃがみ中K")' data/frames/chunli.json

# ガードされて -7F 以上不利な技（確反を探す側）
jq -r '.moves[] | select((.onBlock|tonumber? // 0) <= -7) | "\(.name) \(.onBlock)"' data/frames/ryu.json

# 発生の速い技（確反を返す側）
jq -r '.moves[] | select((.startup|tonumber? // 99) <= 5) | "\(.name) \(.startup)F"' data/frames/cammy.json

# 無敵技を探す
jq -r '.moves[] | select(.notes[]? | test("無敵")) | "\(.name): \(.notes|join(" / "))"' data/frames/ken.json
```

`category` は `通常技` / `特殊技` / `必殺技` / `スーパーアーツ` / `通常投げ` / `共通システム`。
ドライブインパクトやパリィなどの共通動作も `共通システム` として各キャラのファイルに入っている
（キャラごとに数値が違うので、共通だからと他キャラの値を流用しないこと）。

## 触るときの注意

- **同期の列を増やすときは2箇所** — `apps_script/Code.gs` の `HEADERS` と
  `extension/popup.js` の変換部分。既存シートは削除してから同期し直す
- **Apps Script の再デプロイは「デプロイを管理」→ 新バージョン。**
  「新しいデプロイ」だと URL が変わって拡張側が 404 になる

## 公開リポジトリでの注意

このリポジトリは GitHub 上で公開されている。以下はコミットしないこと。
迷ったら「これは公開して困らないか」を先に確認する。

### 秘匿情報

`.gitignore` で `.auth/` と `data/` は除外済みだが、**除外は最後の防波堤**であって、
そもそも書かない・出力しないのが前提。

| 対象 | 中身 |
| --- | --- |
| Apps Script の `TOKEN` | 知られると誰でもシートに書き込める |
| Apps Script の `/exec` URL | 上と組み合わせて悪用できる |
| Buckler のログイン cookie | **パスワード相当**。今は拡張がブラウザのセッションをそのまま使うので、リポジトリ側には持たない |

**値を会話やログ、コミットメッセージ、コードコメントに書き出さない。**
デバッグ時も `TOKEN` や cookie を丸ごと出力せず、長さや先頭数文字の確認に留める。

`.gitignore` の `.auth/` は、ログインを自動化する案（cookie やブラウザプロファイルを
手元に置く方式）を試したときの名残。その案は却下済みだが、また同じことを試すときの
保険として残してある。
README や docs にサンプルを載せるときは、必ずダミー値（`https://.../exec`、`YOUR_TOKEN`）にする。

### 個人情報

- **自分の SID・Capcom ID を実例として書かない。** URL 例は `{あなたのSID}` のようなプレースホルダで
- **バトルログには対戦相手の情報が入っている**（`opponent_sid` / ファイターID / ランク / MR）。
  これは第三者のデータなので、実データの断片をサンプルとして貼らない。
  スプレッドシートの共有設定にも注意する

### 著作権

フレームデータと戦績データは**カプコンの著作物**。`data/` を gitignore しているのは
サイズだけの理由ではなく、**取得したデータを再配布しないため**。ここは外さないこと。

- `data/` 以下をコミット対象に含めない（`.gitignore` の `data/` を消さない）
- 公式サイトの画像・テキストをリポジトリに取り込まない。
  スクリプトは「各自が自分の手元で取得する」形を保つ
- 公式サイトへのアクセスは個人利用の範囲で。連打せず、
  `fetch_frame_data.rb` の `sleep 0.5` は残しておく
