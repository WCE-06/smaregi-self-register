# スマレジ・セルフレジ操作改善システム

顧客用GAS Web UIからWindows店舗PCへ命令を送り、Raspberry Pi Pico Wを経由してスマレジiPadをBLE HID操作するシステムです。

```text
GAS Web UI
→ GAS命令キュー
→ Windows Pythonブリッジ
→ USBシリアル
→ Raspberry Pi Pico W
→ Bluetooth HID
→ スマレジiPad
```

## このリポジトリの役割

このリポジトリをGAS側ソースの正本として使用します。実行環境はGoogle Apps Scriptです。GitHub Pagesへそのまま公開する構成ではありません。

- `Index.html`：顧客用セルフレジ画面
- `Admin.html`：商品同期管理画面
- `ClientBridge.html`：画面とGASサーバーの接続層
- `Code.gs`：会員照会、商品同期、命令キュー、接続状態管理
- `appsscript.json`：GASマニフェスト
- `WINDOWS_HEARTBEAT_CONTRACT.md`：Windowsとの状態連携仕様

## 現在の設計

- スマレジ顧客マスタで会員コードの存在を確認
- スマレジ商品マスタを15分ごとに同期
- 商品登録完了を待たず、支払い方法選択画面を先行表示
- 1台の専用レジとして命令を直列キューへ登録
- 支払い選択後は「決済端末を起動しています」と表示し、裏側の命令順序を維持
- Windows heartbeat protocol v2対応
- POINT後の滞留待機はWindows、画面遷移待機はGASが担当

## 秘密情報

次の値はGitHubへ保存せず、GASのスクリプトプロパティで管理します。

- `BRIDGE_SECRET`
- `UI_ACCESS_TOKEN`
- `ADMIN_ACCESS_TOKEN`
- `SMAREGI_CONTRACT_ID`
- `SMAREGI_CLIENT_ID`
- `SMAREGI_CLIENT_SECRET`
- 操作権限付き公開URL

## スマレジ商品タグ

- タグなし：おもひで商店
- `SELFREG_KITCHEN`：Aozora kitchen
- `SELFREG_ATELIER`：FEBBRAIO・アートリエ
- `SELFREG_NOBARCODE`：バーコードなし商品
- `SELFREG_HIDDEN`：セルフレジへ表示しない
- `SELFREG_TAX8`：軽減税率8%を明示

## 安全条件

- 決済・取消命令を自動再送しない
- 生座標や任意シリアル命令をGASから送らない
- 座標はWindowsの許可リストと`coordinates.json`で管理する
- iPadの向き、表示倍率、AssistiveTouch設定を固定する
- 本番変更後は安全なテスト取引で確認する

## 更新手順

1. GitHub上のソースを変更する。
2. ローカルでHTML内JavaScriptの構文を確認する。
3. GASプロジェクトへ対象ファイルを反映する。
4. 新しいGASバージョンをデプロイする。
5. 接続状態、会員認証、商品登録、取消を安全画面で確認する。

