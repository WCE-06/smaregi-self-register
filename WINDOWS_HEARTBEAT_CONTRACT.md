# WindowsからGASへの状態通知仕様 v2

WindowsブリッジはGAS Webアプリの`/exec` URLへ、定期的にPOSTする。

## リクエスト

```json
{
  "op": "heartbeat",
  "secret": "Windows設定ファイル内のBRIDGE_SECRET",
  "status": {
    "protocolVersion": 2,
    "pointWaitHandled": true,
    "bridge": "ONLINE",
    "pico": "CONNECTED",
    "bluetooth": "CONNECTED",
    "state": "ACTIVE",
    "coordinates": {
      "ready": true,
      "missing": []
    },
    "busy": false
  }
}
```

`secret`はログへ出力しない。`updatedAt`はWindowsから受け取らず、GASが受信時刻を記録する。

## 送信間隔

- 推奨: 10秒ごと
- GASは最終受信から30秒を超えた状態をオフラインとして扱う。
- ジョブ実行中も`busy:true`で送信を継続する。

## 各項目

- `protocolVersion`: この契約では`2`
- `pointWaitHandled`: POINT実行時に`coordinates.json.wait_ms`をWindowsが適用する場合だけ`true`
- `bridge`: 正常時`ONLINE`
- `pico`: COMポートとSTATUS応答が正常なら`CONNECTED`
- `bluetooth`: PicoのSTATUSが`BLE=CONNECTED`なら`CONNECTED`
- `state`: Picoが実行可能なら`ACTIVE`
- `coordinates.ready`: 現在選択可能なシナリオの必須座標が揃っているか
- `coordinates.missing`: 未登録の標準操作名
- `busy`: ジョブ実行中なら`true`

## 移行時の注意

WindowsがPOINT後の`wait_ms`をまだ処理しない間は、必ず`pointWaitHandled:false`を送る。

GASは次のように待機値を自動選択する。

- `false`または状態通知なし: 従来の合計待機値（10500ms／11500ms）
- `true`: 画面遷移待機だけ（2000ms／3000ms）

片側だけ先に待機時間を短縮しない。
