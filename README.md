# CIDR Studio

IPv4・IPv6の集合を編集するWebツールと、同じGoコアを使うHTTP APIです。追加と除外を順番に適用し、集合を正確に表す最少本数のCIDR、連続範囲、アドレス数を返します。

ブラウザの計算はWeb Worker内のGo WebAssemblyで行います。静的ファイルの読み込み後は、通信を切っても編集・計算・ズームを使えます。入力をHTTP APIに送信しません。編集内容はメモリ内だけに保持し、再読み込みすると初期状態に戻ります。

日本語版は`/`、英語版は`/en/`です。画面上部の「日本語 / English」で切り替えます。言語を切り替えても、入力途中の内容・集合・操作履歴・ズーム・選択範囲・一覧のページ位置を保持します。切り替えに通信やページの再読み込みは必要ありません。URLで表示言語が決まるため、英語版へのリンクを共有したり、直接開いたりできます。

## 必要な環境

| ツール | 固定バージョン |
| --- | --- |
| Go | 1.27.1（`.go-version`、`go.mod`） |
| Node.js | 24.7.0（`.nvmrc`、`package.json`） |
| npm | 11.5.1 |
| Vite | 7.3.6 |
| TypeScript | 5.9.3 |
| Playwright | 1.62.1 |
| Wrangler | 4.136.1 |
| ESLint / typescript-eslint | 10.11.0 / 8.70.1 |
| Prettier | 3.9.8 |
| actionlint | 1.7.12 |
| OSV Scanner / Gitleaks | 2.5.1 / 8.30.1 |
| go4.org/netipx | v0.0.0-20231129151722-fdeea329fbba |

Go依存は`go.sum`、npm依存は`package-lock.json`で固定しています。ブラウザにはWebAssembly、module Worker、BigIntの対応が必要です。コピー機能にはHTTPSまたはlocalhostが必要です。

Dependabotは独自のNode/npmでロックファイルを更新するため、`npm install`時の`engine-strict`は無効にしています。ビルドスクリプトでは`.nvmrc`のNode.jsと`.go-version`のGoを検査し、CIも表のバージョンで更新後の依存を検証します。

## 起動とビルド

リポジトリのルートで実行します。

```sh
# nvmを使用している場合
nvm install
nvm use

go mod download
npm ci

# Wasmを生成して開発用フロントエンドを起動
npm run dev
# http://127.0.0.1:5173
```

```sh
# 静的フロントエンド: web/dist/ に生成
npm run build

# ビルド済みフロントエンドをローカルで確認
npm run preview
# http://127.0.0.1:4173

# Go APIを別プロセスで起動
go run ./cmd/api -addr 127.0.0.1:8080

# APIの配布用バイナリ
npm run build:api
./bin/cidr-api -addr 127.0.0.1:8080

# Wasmだけを再生成
npm run wasm
```

`scripts/build-wasm.mjs`はGoのバージョンを確認し、`GOOS=js GOARCH=wasm`で`cmd/wasm`をビルドします。そのGoの`GOROOT/lib/wasm/wasm_exec.js`、Goとnetipxのライセンス、バージョン情報も`web/public/wasm/`へ配置します。Viteはこれらを`web/dist/wasm/`へコピーします。生成物はGit管理対象外です。Goを更新するときは`.go-version`と`go.mod`も変更し、Wasmとランタイムを一緒に再生成してください。

## 別々に配信する

フロントエンドは`web/dist/`の全ファイルを静的ホスティングへ配置します。相対パスでビルドするため、ドメイン直下とサブディレクトリの両方で使えます。サブディレクトリのURLには末尾の`/`を付けてください。JavaScriptを適切なMIMEタイプで配信してください。Wasmは`application/wasm`を推奨しますが、`application/octet-stream`でも読み込めます。

ビルドでは日本語の`index.html`と英語の`en/index.html`を生成します。両ページで同じJavaScript・CSS・Worker・Wasmを共有します。ホスティング先は`/en/`を`en/index.html`として配信してください。サブディレクトリに置く場合は、例えば`/tools/cidr/`と`/tools/cidr/en/`で利用できます。

APIはGoバイナリだけを別ホスト・別ポートで実行できます。Node.js、Wasm、静的ファイルは不要です。公開する場合は、必要に応じてHTTPSを終端するリバースプロキシの後ろに置いてください。APIの公開先をUIに設定する必要はありません。

CORSは既定で無効です。別のWebアプリからAPIを呼ぶ場合だけ、許可するオリジンを列挙します。

```sh
./bin/cidr-api \
  -addr 127.0.0.1:8080 \
  -cors-origins 'https://client.example.com,http://localhost:3000'
```

ワイルドカードは受け付けません。オリジンにはパスを含めず、スキーム・ホスト・必要ならポートを指定します。CORSは認証やアクセス制御の代わりにはなりません。

## Cloudflare Workersへのデプロイ

公開先: [日本語](https://cidr.goryudyuma.workers.dev/) / [English](https://cidr.goryudyuma.workers.dev/en/)

既存のWorkersプロジェクト`cidr`には、`wrangler.jsonc`で指定した`web/dist/`をStatic Assetsとして配信します。Cloudflare側でWasmを実行せず、ブラウザに読み込んで実行します。この配信にはネイティブGo APIを含めません。

```sh
# 初回のみ。Cloudflareにログイン済みなら不要
npx wrangler login

# ビルドして既存のcidrへデプロイ
npm run deploy

# アップロード前に設定と成果物を確認する場合
npm run build
npx wrangler deploy --dry-run

# 公開後、実ブラウザで共通ケースとオフライン編集を確認
node scripts/smoke-deployment.mjs https://cidr.goryudyuma.workers.dev/

# 本番のETag、304、更新時の200とキャッシュ方針を確認
npm run test:cache -- https://cidr.goryudyuma.workers.dev/
```

アカウントIDとプロジェクト名は`wrangler.jsonc`に固定しています。トークンはリポジトリへ保存せず、Wranglerのログイン状態、または`CLOUDFLARE_API_TOKEN`環境変数を使います。

### GitHub Actions

実行環境は`ubuntu-latest`を使い、GitHubが提供するUbuntuランナーの更新に追従します。

`.github/workflows/ci.yml`は次のタイミングで動きます。

| トリガー | 処理 |
| --- | --- |
| `main`向けのPull Request | lint・整形・ワークフロー検査、依存関係・秘密情報の検査、Goのraceテスト・vet・APIビルド、TypeScript検査、Wasmとフロントエンドのビルド、実Chromiumテスト |
| `merge_group` | 同じ検証を実行。将来マージキューを有効にした場合にも対応 |
| `main`へのpush（PRのマージを含む） | 上記がすべて成功した後、そのビルド成果物を既存の`cidr`へデプロイし、本番のキャッシュを検証 |
| Actions画面の`Run workflow` | テストを実行。`main`を選んだ場合だけデプロイ |

デプロイ時に再ビルドはしません。テスト済みの`web/dist/`をActionsのartifactで引き継ぎます。同時デプロイを直列化し、古い実行を再試行しても、最新の`main`でなければデプロイをスキップします。PRではCloudflareの認証情報を使用しません。PRの更新時には古いCIをキャンセルします。

ブランチルールの必須チェック名は`Go, Wasm and browser tests`のままです。このジョブが品質検査・セキュリティ検査・実行テストの結果をまとめ、すべて成功した場合だけ合格します。いずれかが失敗・キャンセル・スキップされた場合は合格せず、デプロイも進みません。

[dev-hato/hato-atamaのCI](https://github.com/dev-hato/hato-atama/tree/master/.github/workflows)を参考に、次の検査と保守処理を加えています。

| 処理 | 内容 |
| --- | --- |
| lint・整形 | ESLintでTypeScriptとJavaScript、PrettierでJSON・JSONC・YAML、gofmtでGo、actionlintでActionsの構文と式を検査 |
| Dependency Review | PRとマージキューで依存の差分を検査。開発用も含め、既知の脆弱性があれば失敗 |
| OSV Scanner | Goの標準ライブラリ・モジュールとnpmロックファイルを全件検査。既存依存に新しく報告された脆弱性も検出 |
| Gitleaks | Gitの全履歴を検査。検出した秘密情報はログ上で伏せる |
| 定期セキュリティ検査 | `.github/workflows/security-scan.yml`で毎週土曜10:15 JSTと手動実行 |
| キャッシュ整理 | `.github/workflows/cache-cleanup.yml`でPR閉鎖時、毎日06:00 JST、手動実行。閉じたPRのキャッシュだけ削除し、main・通常ブランチ・開いているPRのキャッシュを保持 |

GitHub Actionsは完全なコミットSHA、OSVとGitleaksの配布バイナリはバージョンとSHA256を固定しています。スキャナーを更新するときは`security.yml`のバージョンと公式リリースのSHA256を一緒に更新してください。整形エラーはローカルで修正してコミットします。CIがソースを書き換えることはありません。キャッシュ整理はPRのコードをチェックアウトせず、GitHub APIで閉鎖状態を確認してから削除します。定期実行とPR閉鎖時の処理は、ワークフローをmainへマージした後に有効になります。

Dependabot自身がPRを閉じたときは[トークンの権限制限](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-on-actions)があるため、その場のキャッシュ削除をスキップし、日次実行で回収します。

初回だけ、Cloudflareの[Account API Tokens](https://dash.cloudflare.com/?to=/:account/api-tokens)でデプロイ用トークンを作成し、[このリポジトリのActions secrets](https://github.com/Goryudyuma/cidr/settings/secrets/actions)へ`CLOUDFLARE_API_TOKEN`という名前で登録してください。既存Workerの更新には、対象を`Specified Workers: cidr`、ロールを`Editor`に絞れます。アカウントIDは`wrangler.jsonc`から読み込むため、別のsecretは不要です。ローカルのWrangler OAuthトークンをCIへコピーする必要はありません。詳細は[CloudflareのCI認証](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)と[Workerごとの権限](https://developers.cloudflare.com/workers/authorization/workers/)を参照してください。

### Dependabot

`.github/dependabot.yml`でnpm、Go modules、GitHub Actionsを対象にしています。毎週月曜09:00（日本時間）に確認し、`cooldown.default-days: 30`で公開から30日経ったバージョンを更新候補にします。minor・patchはエコシステムごとにまとめ、majorは個別のPRにします。自動マージは設定していません。[セキュリティ更新にはcooldownが適用されません](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#cooldown)。Go・Node.js・npm本体の固定バージョンは手動で更新し、関連ファイルの値も揃えてください。

### ブラウザのキャッシュ

`web/public/_headers`で次の方針を設定しています。

| ファイル | キャッシュと更新 |
| --- | --- |
| 日本語・英語のHTML | `max-age=0, must-revalidate, no-transform`。アクセス時にETagで確認し、同じ内容なら本文なしの304、変わっていれば200で取得 |
| 固定名の`/wasm/*` | `max-age=0, must-revalidate`。Wasmと対応するGoランタイムを再検証 |
| ハッシュ付きの`/assets/*` | `max-age=31536000, immutable`。有効なキャッシュがあれば通信せず使用。内容が変わるとURLも変わるため、新しいHTMLから新しいファイルを取得 |

304はキャッシュ済みのETagを付けた条件付きリクエストへの応答です。初回やキャッシュ削除後は200になり、新しいデプロイでも内容が同じファイルは再ダウンロードしません。開いたままの画面を自動で再読み込みすることはなく、次回アクセス・再読み込みで更新を確認します。`no-transform`はCloudflareによるHTML変換でETagが除去されるのを防ぎます。

`scripts/check-cache.mjs`は日本語・英語のHTML、JavaScript、CSS、Worker、Wasm、Goランタイムについて、実際のHTTP応答を確認します。一致するETagで304と空本文、不一致のETagで200と現在の本文になることを検証します。Vite previewにはCloudflareの`_headers`が適用されないため、公開URLを対象に実行してください。

## 画面の使い方

1. 初期集合にIPまたはCIDRを1行ずつ入力し、「初期集合を適用」を押します。空行と行の前後の空白はUIが取り除きます。適用すると操作履歴を初期化します。
2. 「集合を編集」で対象を指定し、「追加」「除外」を押します。操作履歴の上から順に集合演算を行います。初期集合に未適用の変更がある間は、追加・除外を無効にします。
3. IPv4とIPv6の帯で範囲を確認します。「集合に合わせる」「全体 /0」、IP・CIDR指定のズームを使えます。
4. 帯へのホバー・クリック・キーボード操作で開始IP、終了IP、関連CIDRを表示します。描画幅より小さな範囲はマーカーで示します。同じ位置に重なる範囲は、マーカーを選び左右矢印キーで切り替えます。連続範囲一覧から個別の範囲を選ぶこともできます。
5. 「コピー」で全CIDRを改行区切りでコピーします。「すべてリセット」で初期集合と操作履歴を空にします。

CIDR・連続範囲一覧は40件ずつ、操作履歴は10件ずつ表示します。ページ送りは表示だけに作用し、計算結果やコピー対象を切り詰めません。不正な操作では直前の集合を保持してエラーを表示します。

## 計算仕様

- IP単体はIPv4なら`/32`、IPv6なら`/128`です。CIDRのホストビットはマスクします。
- IPv4とIPv6は別の空間として混在できます。IPv4-mapped IPv6とzone付きIPv6は入力エラーです。
- `add`は和集合、`remove`は差集合です。重複追加と存在しない対象の除外は成功します。順序が変われば結果も変わります。
- ネットワークアドレスとブロードキャストアドレスを含みます。アドレスを1件ずつ列挙しません。IPv6の`/0`も範囲単位で計算します。
- 最小CIDR一覧は対象外のアドレスを含みません。連続範囲の`start`と`end`は両端を含みます。
- 出力はIPv4、IPv6の順で、ファミリー内はアドレス昇順です。空集合の一覧は`[]`です。
- アドレス数は`math/big.Int`で数え、10進文字列で返します。IPv6全体は`340282366920938463463374607431768211456`件です。
- `initial`と`operations`の省略は空配列です。明示的な`null`、未知フィールド、重複キー、誤ったJSON型、複数のJSON値はエラーです。APIは値の空白を自動除去しません。
- 1件でも入力エラーがあれば、部分的な結果を返しません。

集合演算は`netipx.IPSetBuilder`、出力は`IPSet.Prefixes`と`IPSet.Ranges`を使います。TypeScriptには集合演算を実装していません。ズーム入力もGoで検証します。描画では正規化済みアドレスをBigIntに変換し、表示区間からの相対座標を求めてから、小さな数値をNumberに変換します。

## API

`POST /api/evaluate`にJSONを送ります。

```sh
curl --fail-with-body http://127.0.0.1:8080/api/evaluate \
  -H 'Content-Type: application/json' \
  --data '{
    "initial": ["192.0.2.0/30", "192.0.2.4/30"],
    "operations": [
      {"op": "remove", "value": "192.0.2.3"},
      {"op": "remove", "value": "192.0.2.4/31"}
    ]
  }'
```

```json
{
  "cidrs": ["192.0.2.0/31", "192.0.2.2/32", "192.0.2.6/31"],
  "ranges": [
    {"family": "ipv4", "start": "192.0.2.0", "end": "192.0.2.2"},
    {"family": "ipv4", "start": "192.0.2.6", "end": "192.0.2.7"}
  ],
  "addressCount": {"ipv4": "5", "ipv6": "0"}
}
```

成功は200、JSON・IP・操作・件数上限などの入力エラーは400です。エラーは以下の形です。

```json
{
  "error": {
    "code": "invalid_ip",
    "message": "Expected a valid IPv4 or IPv6 address or CIDR.",
    "field": "operations[1].value"
  }
}
```

主なコードは`invalid_json`、`unknown_field`、`duplicate_field`、`invalid_operation`、`invalid_ip`、`unsupported_address`、`input_limit`、`output_limit`、`body_too_large`です。混雑や計算時間超過は503で、構造化されたエラーを返します。存在しないパスは404、POST以外は405、CORSを有効にしている場合の許可外オリジンは403です。

## 入力制限と負荷制御

Wasmと通常の`core.Evaluate`には、入力件数・操作件数・出力件数・JSONボディサイズの固定上限を設けていません。実際に扱える量はブラウザやプロセスのメモリに依存します。どちらもIP・CIDR文字列1件は128バイトまでです。有効なIP・CIDR表記はこの長さに収まります。

APIには次の大きめの既定値を設定しています。引数で変更でき、すべて正の値が必要です。

| 制限 | 既定値 | 起動引数 |
| --- | ---: | --- |
| JSONボディ | 32 MiB（33,554,432バイト） | `-max-body-bytes` |
| 初期入力 | 100,000件 | `-max-initial` |
| 操作 | 100,000件 | `-max-operations` |
| 出力CIDR | 1,000,000件 | `-max-cidrs` |
| 出力連続範囲 | 200,000件 | `-max-ranges` |
| 1リクエストの計算時間 | 15秒 | `-evaluation-timeout` |
| 同時実行リクエスト | 4件 | `-max-concurrent` |

```sh
./bin/cidr-api \
  -max-body-bytes 67108864 \
  -max-initial 500000 \
  -max-operations 500000 \
  -max-cidrs 2000000 \
  -max-ranges 1000000 \
  -evaluation-timeout 30s \
  -max-concurrent 2
```

同時実行枠はボディ読み込みから応答書き込みまで保持し、満杯なら待機キューを作らず503を返します。計算時間と切断はcontextで確認します。ライブラリ内の個々の集合演算を途中で強制停止する方式ではなく、各処理の前後で中断します。HTTPヘッダー読み込みは5秒、リクエスト読み込みは15秒、応答書き込みは最低30秒、アイドル接続は60秒でタイムアウトします。計算時間を延長すると書き込み時間も延長します。

入力の形式・集合演算・結果の規則はWasmとAPIで共通です。APIだけが配信上の制限を追加します。したがってAPIの制限内で完了する同じ入力は同じ結果を返し、APIの上限を超える入力でもWasmでは計算できます。

## 構成

```text
core/                 計算・型・JSON検証・ランダム参照テスト
cmd/wasm/             syscall/jsとコアの橋渡し
cmd/api/              ネイティブHTTPサーバー
internal/httpapi/     エンドポイント・制限・CORS・テスト
web/src/              TypeScript UI・SVG・Worker・通信
web/en/index.html     英語ページの静的エントリーポイント
scripts/build-wasm.mjs  Wasmと対応ランタイムの生成
testdata/evaluate.json  実行環境をまたいで使う共通ケース
tests/native/         比較用のネイティブGo実行器
tests/browser/        実ブラウザのWasm・HTTP・UIテスト
tests/ci/             キャッシュ削除対象の検証
```

共通関数は`Evaluate(req Request) (Result, error)`です。JSONの入口は`EvaluateJSON(data []byte)`です。API用には`EvaluateWithLimits(ctx, req, limits)`と`EvaluateJSONWithLimits(ctx, data, limits)`を使います。コアはHTTP、JavaScript、DOMに依存しません。

WorkerはWasmの関数登録完了を確認してから`ready`を返します。計算要求と応答にはIDを付け、UIも編集世代を確認することで古い応答の反映を防ぎます。初期化失敗・計算エラーは画面に表示します。

## テスト

```sh
npm run lint
npm run format:check
# JSON・JSONC・YAMLの整形を修正する場合
npm run format

node --test tests/ci/*.test.mjs
go test -race ./...
go vet ./...
npm run typecheck
npm run build

# 初回だけ実ブラウザをインストール
npx playwright install chromium

# 静的フロントエンドとAPIを起動し、終了後に停止する
npm run test:browser

# Goとブラウザのテストをまとめて実行
npm test

# CIと同じActions検査
go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12
"$(go env GOPATH)/bin/actionlint"
```

共通のJSONケースについて、ネイティブGoを実行した結果、実HTTPサーバーの結果、本番ビルドのWorker内で動くWasmの結果を比較します。WorkerとWasmはモックしません。Goのランダムテストでは各ファミリー256アドレスの小空間に限って単純な参照集合を列挙し、結果集合、重複の不在、最小化を確認します。IPを列挙するのはこのテスト内だけです。

ブラウザではオフライン編集、追加・除外・リセット・コピー、エラー時の状態保持、IPv6の下位ビットを保つズーム、細い範囲のマーカー、古い応答の破棄、旧上限を超える入力、モバイル表示も確認します。実行結果は[TESTING.md](TESTING.md)に記録しています。

英語ページでは直接アクセス・再読み込み、英語の操作・エラー・読み上げ用ラベル、オフラインの言語切替とブラウザ履歴、320px・390px幅でのIPv6表示を検証します。表示文言はTypeScriptの辞書で管理し、GoコアやAPIの計算・検証ルールは両言語で共通です。

## 参照

- [Go WebAssembly](https://go.dev/wiki/WebAssembly)
- [syscall/js](https://pkg.go.dev/syscall/js)
- [go4.org/netipx](https://pkg.go.dev/go4.org/netipx)
