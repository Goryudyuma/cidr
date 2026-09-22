# 検証記録

2026年9月22日、macOS arm64で実行しました。

- Go 1.27.1
- Node.js 24.7.0 / npm 11.5.1
- Playwright 1.58.2 / Chromium 145.0.7632.6

## 結果

| 確認 | 結果 |
| --- | --- |
| `go test -race ./...` | 成功。コア、API、サーバー設定を検証 |
| `go vet ./...` | 成功 |
| `npm run typecheck` | 成功 |
| `npm run build` | 成功。Go Wasm、対応するwasm_exec.js、Viteの静的ファイルを生成 |
| `npm run build:api` | 成功。`bin/cidr-api`を生成 |
| `npm test` | 成功。Goのraceテストから本番ビルド、ブラウザテストまで一括実行 |
| Playwright | 11テスト成功 |
| 共通データ比較 | 37ケースでネイティブGo・実HTTP API・実Worker内のWasmが一致 |
| ランダム参照テスト | 300ケース成功。IPv4・IPv6各256アドレスの参照集合と比較 |
| コアのfuzzテスト | 3秒、約159,000回の実行を完了。発見した空フィールド名のエラーを修正し、回帰データを保存 |
| `npm audit` | 修正版に固定した依存で脆弱性0件 |
| 表示確認 | デスクトップ1440px、モバイル390pxのスクリーンショットを確認 |

ブラウザの比較には`web/dist/assets/worker-*.js`と`web/dist/wasm/core.wasm`を使用しています。WasmラッパーやWorkerを置き換えていません。Workerのコンストラクター自体が例外を投げるケースだけは、初期化失敗の表示を確認するために例外を注入しています。

ブラウザをオフラインにしてから、サンプルの読み込み、追加、除外、範囲選択、コピー、リセットが成功し、追加のネットワークリクエストがないことを確認しました。IPv6 `/0`の正確なアドレス数、下位ビットの異なるIPへのズーム、同じ画素に重なる範囲の選択、古い計算・ズーム応答の破棄も確認しています。

Wasmでは5,000件の入力を処理し、出力一覧が40件ずつに分かれることを確認しました。ネイティブのコアでは12,000件の初期入力・操作、1MiBを超えるJSON、16,384件を超える出力CIDRを固定上限なしで処理しています。APIでは設定した小さな境界値、既定値を超える件数・32MiB超のボディ、キャンセル、時間超過、同時実行枠の満杯と解放を検証しています。

## この環境での再実行

実行環境の書き込み制限に合わせ、Goキャッシュとブラウザを一時ディレクトリに配置しました。

```sh
PLAYWRIGHT_BROWSERS_PATH=/tmp/cidr-playwright-browsers npx playwright install chromium
GOCACHE=/tmp/cidr-go-cache \
PLAYWRIGHT_BROWSERS_PATH=/tmp/cidr-playwright-browsers npm test
```

通常の開発環境では、READMEのコマンドで実行できます。

## Cloudflare公開後の確認

2026年9月22日、Workersプロジェクト`cidr`へ静的フロントエンドをデプロイしました。

- 公開URL: https://cidr.goryudyuma.workers.dev/
- バージョンID: `78fe8bfd-2608-46ff-be98-255a2ab919da`
- 公開されたWasmとwasm_exec.jsが、ローカルのビルド成果物とバイト単位で一致
- 公開URLの実Chromium上で共通37ケースが一致
- 読み込み後にオフラインへ切り替え、サンプル計算と追加操作が成功
- ブラウザ実行時エラー0件、計算用APIへのリクエスト0件
- Wasmは`application/wasm`、Workerは`text/javascript`で配信
- ハッシュ付きJavaScriptは長期キャッシュ、固定名Wasmは毎回再検証

確認には`node scripts/smoke-deployment.mjs https://cidr.goryudyuma.workers.dev/`を使用しました。Go APIはこの静的配信とは別に起動する構成です。ライセンスファイルが読み取り専用になって再ビルドできない問題も修正し、続けて2回のビルドが成功しました。

## 未実施の確認

Safari・Firefox、Windowsでの実行、長時間の負荷試験は行っていません。APIの最大出力100万CIDRを同時4リクエストで生成するような最大負荷の計測も行っていません。環境ごとのメモリと処理能力に合わせて、APIの上限と同時実行数を調整してください。

## CI・Dependabot・キャッシュの追加確認

2026年9月22日、次を実行しました。

- `go test -race ./...`、`go vet ./...`、APIビルド、Wasm・フロントエンドのビルドが成功
- 実Chromiumの11テストが成功。37件の共通データでネイティブGo・HTTP・Wasmの一致を再確認
- GitHub Actionsワークフローをactionlint 1.7.12で検査し、エラーなし。ワークフローとDependabot設定のYAML解析も成功
- [GitHub ActionsのUbuntu 24.04上のテスト](https://github.com/Goryudyuma/cidr/actions/runs/35684628148/job/106608715718)も成功。依存のインストールからGoのraceテスト・vet・APIビルド・Wasmとフロントエンドのビルド・実Chromiumテスト・成果物の保存まで完了
- Dependabot初回実行で、npmの`engine-strict`とDependabot自身のNode/npmバージョンが衝突する問題を確認。インストール時の厳密一致を外し、Nodeのバージョン検査をビルド時へ移動。CIのNode/npm固定は維持
- HTMLに`no-transform`付き再検証ヘッダーを追加し、既存のCloudflare `cidr`へ反映。バージョンIDは`d1335c79-592b-4d6b-95fc-27c3709eb5b9`
- 公開URLでHTML、JavaScript、CSS、Worker、Wasm、Goランタイムの6リソースを検査。一致するETagでは304と空本文、不一致のETagでは200と現在の本文を確認
- ローカルの実Wrangler配信でも同じキャッシュ検査が成功。HTMLファイルを変更した後、変更前のETagでリクエストすると新しいETagと本文を200で取得
- 更新後の公開URLで、実Chromiumの共通37ケースとオフライン編集が成功。実行時エラー、計算APIへの通信はともに0件

```sh
npm run test:cache -- https://cidr.goryudyuma.workers.dev/
PLAYWRIGHT_BROWSERS_PATH=/tmp/cidr-playwright-browsers \
  node scripts/smoke-deployment.mjs https://cidr.goryudyuma.workers.dev/
```

CIはPRとmainへのpushで同じ検証を行います。mainで合格した成果物だけをデプロイし、公開後にキャッシュ検査を実行します。自動デプロイの利用には、READMEに記載したActions secretの登録が必要です。
