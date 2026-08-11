# Android用API契約案 v1

既存の公開URL＋UIトークン＋JSONPはブラウザ版専用です。Android版では、端末ごとの認証情報を使ったJSON APIへ変更します。秘密鍵をソースやAPKへ固定しません。

## 必須API

```text
POST /android/v1/devices/register
GET  /android/v1/bootstrap
POST /android/v1/members/verify
GET  /android/v1/products?updatedAfter=...
GET  /android/v1/febbraio/active-usage?memberCode=...
POST /android/v1/transactions
POST /android/v1/transactions/{id}/products
POST /android/v1/transactions/{id}/payment
GET  /android/v1/transactions/{id}
POST /android/v1/transactions/{id}/cancel
POST /android/v1/transactions/{id}/complete-register-reset
```

## 取引開始

```json
{
  "transactionId": "端末で生成したUUID",
  "memberCode": "会員証コード",
  "service": "SHOP",
  "startedAt": "ISO-8601"
}
```

## 商品確定

```json
{
  "items": [
    {
      "productCode": "商品コード",
      "quantity": 1,
      "customizations": {
        "rice": "少なめ",
        "negi": "なし"
      }
    }
  ]
}
```

スマレジへ送るのは商品コードと数量です。カスタマイズはキッチン注文へ保存し、スマレジ操作には混ぜません。

## 決済開始

```json
{
  "paymentType": "CREDIT",
  "expectedTotalIncludingTax": 1000
}
```

レスポンスは、商品登録ジョブとの依存関係をサーバー側で解決した後に決済ジョブを作成します。同じ取引ID・同じ操作の再送は二重実行しません。

## 売上確認結果

```json
{
  "transactionId": "UUID",
  "status": "SALE_CONFIRMED",
  "smaregiTransactionId": "売上ID",
  "totalIncludingTax": 1000,
  "confirmedAt": "ISO-8601"
}
```

照合には店舗、レジ端末、会員、決済開始時刻、合計金額、商品明細を使用します。API反映遅延は決済失敗と判定しません。

