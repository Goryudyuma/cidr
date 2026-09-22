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

## 参照CIから追加した検査

2026年9月22日、`dev-hato/hato-atama`のワークフローを参考に品質・セキュリティ・キャッシュ保守の検査を追加しました。

- ESLint、Prettier、gofmt、actionlint 1.7.12の検査が成功
- キャッシュ削除スクリプトを実行する7件のNodeテストが成功。main・通常ブランチ・開いているPRの保持、閉じたPRの選別、削除競合、APIエラーを検証
- OSV Scanner 2.5.1でGoとnpmの全ロック依存を検査し、既知の脆弱性0件
- Gitleaks 8.30.1でGitの全履歴を検査し、秘密情報の検出0件
- Goのraceテスト・vet、APIビルド、Wasmとフロントエンドのビルドが成功
- 実Chromiumの11テストが成功。37ケースでネイティブGo・HTTP・Wasmの一致を再確認

キャッシュ削除APIのテストではGitHub APIを置き換え、実際のリモートキャッシュは削除していません。定期実行・PR閉鎖時のキャッシュ整理は、ワークフローをmainへマージした後に動作します。

## 英語ページの追加確認

2026年9月22日、日本語`/`と英語`/en/`を生成する本番ビルドで確認しました。

- ESLint、TypeScript型チェック、Prettier、本番ビルドが成功
- 実Chromiumの18テストが成功。既存11件に日英表示・切替・配信の7件を追加
- 英語への直接アクセス・再読み込み、入力エラー・Wasm初期化失敗、コピー・追加・除外・リセットを確認
- オフラインの言語切替とブラウザの戻る・進むで、入力途中の内容、操作履歴、集計、選択、ズーム、一覧のページ位置を保持。切替時の通信は0件
- サブディレクトリ`/nested/`へ実ビルドを配信し、英語の`index.html`から日英切替・再読み込み後も共有Worker・Wasmが動作
- 英語のPC表示、390px・320pxのIPv6 `/0`表示をスクリーンショットで確認
- ローカルWranglerで日英HTMLと共有ファイルの計7リソースを検査し、一致するETagで304・空本文、不一致のETagで200・現在の本文を確認
- 更新した公開確認スクリプトをローカルWranglerへ実行し、共通37ケース、英語直リンク、オフラインの切替・編集が成功。Wasmとランタイムはビルド成果物と一致し、実行時エラーは0件

```sh
node scripts/check-cache.mjs http://127.0.0.1:8789/en/
PLAYWRIGHT_BROWSERS_PATH=/tmp/cidr-playwright-browsers \
  node scripts/smoke-deployment.mjs http://127.0.0.1:8789/en/
```

## Dependabot: Playwrightの更新

2026年9月22日、Playwrightを1.62.1へ更新し、対応するChromium 151.0.7922.34で18テストが成功しました。日英UI・オフライン編集・サブディレクトリ配信と、共通37ケースのネイティブGo・HTTP・Wasmの一致を確認しています。Wasmと静的ファイルのビルド、ESLint、Prettierも成功しました。

## Dependabot: Viteの更新

2026年9月22日、Viteを8.2.2へ更新し、ビルド設定を`rolldownOptions`へ移行しました。

- Node.js 24.7.0で依存の再インストール、ESLint、Prettier、型チェック、Wasm・フロントエンドのビルドが成功
- 実Chromiumの18テストが成功。英語320px表示もスクリーンショットで確認
- ローカルWranglerの配信で日英HTML、JavaScript、CSS、Worker、Wasm、Goランタイムの7リソースを検査し、一致するETagで304・空本文、不一致のETagで200・現在の本文を確認
- 公開確認スクリプトをローカルWranglerへ実行し、共通37ケース、英語直リンク、オフラインの言語切替・編集が成功。ビルドと配信のWasm・ランタイムが一致し、ブラウザ実行時エラーは0件

Vite 8がWorkerのURLをテンプレートリテラルで生成するため、キャッシュ検査も対応しました。WorkerのURLを検出できない場合は検査を失敗させ、Workerを確認せずに成功することを防ぎます。

## Dependabot: TypeScriptとNode.js型定義の互換性

2026年9月22日、typescript-eslint 8.70.1のTypeScript対応範囲（`>=4.8.4 <6.1.0`）に合わせてTypeScript 6.0.3を採用しました。`@types/node`は実行環境のNode.js 24系に合わせ、24.13.3へ更新しています。どちらも公開から30日以上経ったバージョンです。

Node.js 24.7.0で`npm ci`、ESLint、Prettier、TypeScript型チェック、Wasm・フロントエンドのビルド、実Chromiumの18テストが成功しました。共通37ケースによるネイティブGo・HTTP・Wasmの一致も確認しています。TypeScript 7とNode.js 26用の型定義は取り込まず、通常のmajor更新PRを保留する設定にしました。セキュリティ更新は引き続き対象です。

## デプロイ中のキャッシュ検査

2026年9月22日の依存更新後、デプロイ直後のキャッシュ検査が失敗しました。[CIログ](https://github.com/Goryudyuma/cidr/actions/runs/35689966853)では、Wasmを取得する3回のHTTP要求の途中でGo build IDとVCS情報が切り替わっていました。配信後の再検査では7リソースの304・200応答、CI成果物とのWasm・ランタイムの一致、実Chromiumの共通37ケースと日英オフライン編集が成功しています。

固定URLのETagと本文の両方が変わった場合だけ、そのファイルの検査を最大4回やり直す処理を追加しました。ローカルHTTPサーバーから応答を返して実際の検査スクリプトを起動し、安定した7リソースの検査、HTML・Wasmの版切替からの復帰、同じ版の不正な200応答、ETagか本文だけの変更、ハッシュ付きファイルの変更を検証します。公開URLの再検査も成功しました。

## 本番ドメイン cidr.063.jp

2026年9月22日、Cloudflareの有効な`063.jp`ゾーンへCustom Domainを登録し、既存のWorker `cidr`に紐付けました。API応答で`enabled: true`・`previews_enabled: false`を確認しています。

- DNSのA・AAAA応答と、証明書検証を有効にしたHTTPSの200応答を確認
- `https://cidr.063.jp/`の7リソースで、一致するETagの304・空本文、不一致のETagの200・現在の本文を確認
- 公開Wasm・GoランタイムがCI成果物と一致
- 実Chromiumで共通37ケース、英語直リンク、日英のオフライン切替・編集が成功。ブラウザ実行時エラー0件

今後のmainデプロイ後は、CIで`cidr.063.jp`と既存の`workers.dev`の両方を検査します。

## 共有リンク

2026年9月22日、Node.js 24.7.0、Go 1.27.1、Playwright 1.62.1 / Chromium 151.0.7922.34で確認しました。

- 実Chromiumの26テストが成功。既存18件に共有リンクの8件を追加
- 89 CIDR、順序付き操作11件、IPv6の最下位ビット付近のズーム、選択、日英表示、未適用入力、タブ・各一覧のページを別ページへ復元
- 空集合と日英の再読み込み、オフラインでの共有リンク作成、フラグメントがHTTP要求・Refererに含まれないことを確認
- 不正なbase64、未知の形式・キー、範囲外の座標・安全でない数値、32,768文字超のフラグメント、1MiB超へ展開するgzip、GoのIP検証エラーで部分適用がないことを確認
- 結果を超えるページ番号の補正、共有上限を超える未適用入力が通常計算を妨げないこと、Wasm初期化中の入力とhashchange直後のリセットが古い復元を破棄することを確認
- クリップボード拒否時のリンク欄から、実際に復元できることを確認
- Goのraceテスト・vet・APIビルド、TypeScript型チェック、ESLint、Prettier、Wasm・フロントエンドのビルドが成功。CIスクリプトの15テストも成功
- 共通37ケースでネイティブGo・実HTTP・実Worker内Wasmの一致を再確認
- 更新した公開確認スクリプトをローカルの静的配信へ実行。共通37ケース、オフライン編集・共有、別ブラウザコンテキストでの復元が成功し、ブラウザ実行時エラー0件
- 日本語PC表示と英語320px表示のスクリーンショットを確認

共有のテストで置き換えるのは、拒否時の動作を確認するクリップボードだけです。計算処理・Worker・Wasmは実物を使用しています。Safari・Firefoxでの共有動作は未確認です。

## 共有形式2・完全復元を保つ圧縮

2026年9月22日、同じ固定バージョンのGo・Node.js・Chromiumで確認しました。

- 実Chromiumの全29テストが成功。共有11件で初期集合の順序・重複・ホストビット付き表記・IPv6の大文字表記、追加／除外の順序、入力原文の空白・空行・末尾改行・Unicodeと未適用の編集を保持
- 6,000件の合成IPv4入力で、旧形式のgzipリンク35,121文字に対し、新形式はBrotliで4,879文字。上限内で作成でき、実Wasmで元の入力を復元
- 1MiBを超える圧縮可能な入力途中の文字列を、内容を変えずに共有・復元
- gzip／Brotli両方の固定リンクを`tests/fixtures/share-v2.json`へ保存。未公開だった旧形式1は未対応として検出し、新形式の未知バージョン・codec、不正差分・tupleなど20項目で部分適用がないことを確認
- 共有形式のNodeテスト6件が成功。固定seedの2,500件でUTF-16文字列を完全に往復し、サロゲートの途中を差分境界にした場合も復元。復元後JSONが16MiBちょうどの場合と1バイト超の場合を検証
- Goで両codecの往復、gzip／Brotliの選択、一方の圧縮結果がURL上限を超えた場合の継続、8MiBの展開境界、切り詰め・破損データ・過大なBrotli windowの拒否を検証
- 新しいGo復号処理のfuzzを約6秒実行し、147,049件を完了。panic・上限逸脱・失敗時の部分結果なし
- Goのraceテスト・vet・APIビルド、型チェック・ESLint・Prettier・actionlint、Wasmと静的ファイルのビルドが成功。既存CIスクリプトの15テストも成功
- 共通37ケースのネイティブGo・実HTTP・実Worker内Wasmの一致を再確認
- ローカル静的配信に公開確認スクリプトを実行し、別ブラウザコンテキストでの原文・履歴・draft・表示状態の復元、復元後の追加操作、オフライン共有が成功。ブラウザ実行時エラー0件

圧縮・復元はWeb Worker内で実行し、ブラウザのネイティブBrotli機能は使いません。Safari・Firefoxでの実機確認は未実施です。

Brotli実装を含むWasmは、このローカルビルドで約5.19MBから8.39MBになりました。Nodeのgzipで比較したサイズは約1.42MBから2.45MBです。これはファイルの比較値で、実際の配信時の圧縮方式・転送量とは区別しています。
