# Google Slides 翻訳アドオン 設計ドキュメント

> 英語版: [DESIGN.md](DESIGN.md)

## 1. 概要と目標

### 旧実装の課題

旧実装は `LanguageApp.translate()` を使っており、以下の問題があった：

- **翻訳品質が低い**: Google 翻訳のニュートラルな出力で、ビジネス文書として不自然
- **用語の一貫性がない**: スライドをまたいで同じ原語が異なる訳語に変換される
- **社内・業界固有用語に未対応**: プロダクト名、チーム名、業界用語が誤訳される
- **テキストスタイルが失われる**: `setText()` でフォント・サイズ・色がリセットされる
- **テーブルが未対応**

### 目標

1. Gemini API を活用して翻訳品質を大幅に向上させる
2. 社内用語集（グロッサリー）をコンテキストとして注入し、用語の一貫性を担保する
3. テキストスタイルを可能な限り保持する
4. テーブルセルとテキストシェイプの両方に対応する
5. 翻訳前テキストのバックアップ・ロールバック機能を提供する
6. フリープランのレート制限内で並列リクエストを使って効率的に翻訳する

---

## 2. GAS 設計上の選択肢と判断

### 2.1 Gemini API の呼び出し方法

| 方法 | メリット | デメリット | 判断 |
|---|---|---|---|
| **`UrlFetchApp` + Gemini REST API** | 柔軟、`fetchAll()` で並列化可能、モデル選択自由 | APIキー管理が必要 | **採用** |
| **GAS Advanced Service: Vertex AI** | Google Cloud との親和性が高い、データ非学習保証 | OAuth が複雑、GCP プロジェクト設定が必要 | 将来の拡張候補 |
| **`LanguageApp`（旧実装）** | 設定不要、ゼロコスト | 品質が低い、プロンプト制御不可 | 廃止 |

**判断**: `UrlFetchApp.fetchAll()` + Gemini REST API (`generativelanguage.googleapis.com`) を採用。APIキーは `PropertiesService.getScriptProperties()` に格納する。

同一バッチ内のスライドは `fetchAll()` の1回の呼び出しで並列送信する：

```javascript
function callGeminiFetchAll(items, apiKey, model) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;
  var requests = items.map(function(item) {
    return { url: url, method: 'post', contentType: 'application/json',
             payload: JSON.stringify(item.payload), muteHttpExceptions: true };
  });
  return UrlFetchApp.fetchAll(requests);
}
```

### 2.2 APIキーの管理

- キーはスクリプトプロパティに格納し、ソースコードには一切出現しない
- サイドバーから設定（**Translate > Open → Settings**）
- スクリプトプロパティはスクリプト所有者のみ閲覧可能

### 2.3 グロッサリーの管理

#### 保管場所

| 場所 | メリット | デメリット | 判断 |
|---|---|---|---|
| **Google Drive の JSON ファイル** | 軽量、バージョン管理可能 | ビジュアルエディタなし | **採用** |
| **Google スプレッドシート** | 非エンジニアが編集しやすい | Sheets スコープが必要 | 将来の選択肢 |
| `PropertiesService` | 高速（ネットワーク不要） | 9KB/キー制限、編集 UX が不便 | キャッシュ用途のみ |

**判断**: グロッサリーは **Google Drive 上の JSON ファイル**で管理し、ファイル ID を `PropertiesService` に格納する。パース結果は `CacheService`（TTL: 6時間）でキャッシュする。

#### グロッサリーフォーマット

```json
[
  { "source": "YourCompany", "target": "YourCompany", "dir": "any", "note": "翻訳不要" },
  { "source": "形状最適化", "target": "shape optimization", "dir": "ja→en" }
]
```

`dir` には `"any"` または `"{元言語}→{先言語}"` （例: `"ja→en"`）を指定する。元言語が `"auto"`（自動検出モード）の場合、指定した翻訳先言語に対応する全エントリが対象となる。

### 2.4 レート制限と並列処理

GAS の制約：
- **最大実行時間**: 6分（アドオン）
- **`UrlFetchApp` 呼び出し回数**: 20,000回/日
- Gemini API の **RPM** 制限（例: `gemini-3.1-flash-lite` フリープランは 15 RPM）

対策：
1. **並列バッチ化**: `BATCH_SIZE = 15` スライドを `UrlFetchApp.fetchAll()` で同時送信 — 1スライドにつき1リクエストを並列実行
2. **時間管理ペーシング**: 各バッチ後に `max(0, 60秒 − 経過時間)` スリープし RPM 制限を守る
3. **リアクティブリトライキュー**: 各スライドは独自の `retries` カウンターを持つ。429 などのエラー時はそのスライドのみ再エンキュー（最大 `MAX_RETRIES = 10`）、他のスライドは影響を受けない

---

## 3. 翻訳手法の設計

### 3.1 翻訳の粒度

| 粒度 | API呼び出し数（50スライド × 5要素想定） | 判断 |
|---|---|---|
| 要素単位 | 250回 | コスト大、要素間の一貫性なし |
| **スライド一括** | 50回 | **採用** |
| 全体一括 | 1〜数回 | トークン上限超過のリスク |

**判断**: **スライド一括**を基本とする。1スライドのすべてのテキスト要素（シェイプ + テーブルセル）を JSON 配列として Gemini に渡し、同じ長さの JSON 配列で返させる。

### 3.2 プロンプト設計

```
システムプロンプト（固定）:
  あなたはビジネス翻訳の専門家です。Google Slides の内容を検出して
  {targetLang} に翻訳します。以下のルールを厳守してください：
  1. テキストは JSON 配列で渡されます。同じ長さの JSON 文字列配列で返してください。
  2. 空のテキスト、数字のみ、記号のみのテキストはそのまま返してください。
  3. 固有名詞・プロダクト名は以下のグロッサリーに従ってください：
     {glossary}
  4. ビジネス文書として自然で簡潔な表現を使ってください。
  5. マークダウン記法、コードブロック、説明文は加えないでください。
  6. JSON 配列のみを返し、それ以外は何も返さないでください。

ユーザーメッセージ:
  以下のテキストを翻訳してください：
  {json_array_of_texts}
```

元言語は **Gemini が自動検出**する。`buildSystemPrompt()` は `sourceLang = 'auto'` を受け付け、元言語の指定をプロンプトから省略する。後方互換性のため `'ja'` などの明示的な元言語も引き続き指定可能。

### 3.3 Gemini モデルの選択

| モデル | RPM（フリー） | RPD（フリー） | 品質 | 判断 |
|---|---|---|---|---|
| **`gemini-3.1-flash-lite`** | 15 | 500 | 良好 | **デフォルト** |
| `gemini-2.5-flash` | 5 | 20 | 高い | オプション（Settings で切替可） |
| `gemini-2.5-pro` | 5 | 20 | 最高 | 重要文書向けオプション |

`gemini-3.1-flash-lite` をデフォルトとする理由: フリープランの 15 RPM / 500 RPD 制限が `BATCH_SIZE = 15` の設計と合致し、通常使用でレート制限に引っかかりにくいため。

### 3.4 Gemini レスポンスのパース

`parseGeminiResponse()` では3段階のフォールバックを使用する：

1. **直接 `JSON.parse`** — 正常なレスポンスはここで成功
2. **サニタイズ後パース** — `sanitizeJsonNewlines()` で JSON 文字列値内のリテラル `\n`/`\r` をエスケープ（Gemini が稀にエスケープなし改行を返すため）
3. **正規表現抽出 → サニタイズ → パース** — Gemini が末尾にバッククォートや空白を付けることがあるため `[...]` を正規表現で抽出

配列長不一致の場合はエラーを throw し、キューへの再エンキューをトリガーする。

### 3.5 テキストスタイルの保持

`getText().setText(result)` はフォーマットを破壊する。`captureStyle()` で翻訳前のスタイルをスナップショットし、`setText()` 後に `restoreStyle()` で再適用する。

- **単一スタイル**: スナップショットをそのまま復元
- **混在スタイル**: 先頭ランのスタイルをフォールバック適用（既知の制限）

---

## 4. アーキテクチャ

```
src/
├── main.gs         onOpen, showSidebar, getSettings, saveSettings,
│                   getProgress, translatePresentation
├── sidebar.html    サイドバー UI：翻訳ボタン、言語選択、
│                   ライブログ（CacheService ポーリング）、折りたたみ設定
├── translator.gs   buildGeminiPayload, callGeminiFetchAll, parseGeminiResponse,
│                   sanitizeJsonNewlines, buildSystemPrompt
├── extractor.gs    extractShapeElements（シェイプ + テーブルセル）、
│                   writeBackTranslations、backupToSpeakerNotes
├── glossary.gs     loadGlossary, filterByDirection, filterRelevantEntries,
│                   buildGlossaryPrompt
└── utils.gs        captureStyle, restoreStyle, showAlert, getScriptProp, setScriptProp

appsscript.json     マニフェスト（OAuth スコープ）
glossary/
└── glossary.json   サンプルグロッサリー
```

### 実行フロー

```
onOpen()
└── showSidebar()          ← ユーザーがサイドバーを開く

サイドバー: "Translate to English"
└── google.script.run.translatePresentation('auto', 'en')

translatePresentation(sourceLang, targetLang)
├── loadGlossary(sourceLang, targetLang)       [CacheService → Drive JSON]
├── Phase 1: extractShapeElements() × 全スライド + backupToSpeakerNotes()
├── Phase 2: キュー構築 [{slideIndex, texts, payload, retries}]
└── Phase 3: キューループ
    ├── batch = queue.splice(0, BATCH_SIZE)
    ├── callGeminiFetchAll(batch, apiKey, model) → responses[]
    │   └── UrlFetchApp.fetchAll(requests)      ← 並列 HTTP
    ├── 各レスポンスに対して:
    │   ├── 成功   → writeBackTranslations() + writeProgress() to CacheService
    │   ├── リトライ → item.retries++, queue.push(item)
    │   └── 失敗   → errorSlides.push()
    └── バッチが残っていれば max(0, 60秒 − 経過時間) スリープ

サイドバー: setInterval 2秒
└── google.script.run.getProgress()            ← CacheService を読む
    └── handleProgress(data) → ログ表示を更新
```

---

## 5. 対応する要素の範囲（フェーズ別）

### Phase 1（リリース済み）
- [x] テキストシェイプとスライドタイトル
- [x] テーブルセルのテキスト
- [x] 並列バッチ翻訳（`UrlFetchApp.fetchAll`、`BATCH_SIZE=15`）
- [x] スライド単位のリトライキュー（`MAX_RETRIES=10`）
- [x] 元言語の自動検出
- [x] 翻訳先言語：英語、日本語、韓国語、中国語（繁体）、中国語（簡体）、フランス語
- [x] Gemini API 翻訳（デフォルト: `gemini-3.1-flash-lite`）
- [x] グロッサリー注入（Drive 上の JSON ファイル + CacheService）
- [x] 翻訳前テキストを話者ノートにバックアップ
- [x] 単一スタイルの保持
- [x] JSON 改行サニタイズフォールバック
- [x] ライブ進捗ログ付きサイドバー UI

### Phase 2
- [ ] 80スライド超の場合の再開可能実行（GAS 6分タイムアウト対策）
- [ ] 特定スライドのみ翻訳（範囲指定）
- [ ] スタイル保持の精度向上（ランレベル対応）
- [ ] 話者ノートの翻訳

### Phase 3
- [ ] 翻訳キャッシュ（同一テキストの再翻訳スキップ）
- [ ] ロールバック UI（話者ノートから元テキストを復元）
- [ ] Vertex AI 移行（企業データプライバシー要件への対応）

---

## 6. エラーハンドリング戦略

| エラー種別 | 対処 |
|---|---|
| Gemini 429（レート制限） | スライドを再エンキュー；次バッチは 60 秒ペーシング後に開始 |
| Gemini 5xx / ネットワークエラー | スライドを再エンキュー；次バッチで再試行 |
| JSON パース失敗 | `sanitizeJsonNewlines()` フォールバック → 正規表現抽出 → すべて失敗なら再エンキュー |
| 配列長不一致 | エラー throw → スライド再エンキュー |
| `MAX_RETRIES`（10回）超過 | エラーリストに追加；完了アラートで報告 |
| GAS 6分タイムアウト | Phase 2：進捗を PropertiesService に保存して再開 |
| グロッサリー読み込み失敗 | アラート表示；グロッサリーなしで翻訳続行 |

---

## 7. 主要な設計上のトレードオフ

| 課題 | 採用案 | 却下した代替案 | 理由 |
|---|---|---|---|
| 翻訳エンジン | Gemini REST API（`UrlFetchApp`） | `LanguageApp`、DeepL | 品質・プロンプト制御・`fetchAll` 並列化 |
| 並列処理 | `UrlFetchApp.fetchAll()` per バッチ | スライド単位の逐次処理 | バッチ内で最大15倍高速化；GAS で並列 HTTP を実現する唯一の手段 |
| レート制限戦略 | 時間管理バッチ化 + スライド単位リアクティブリトライ | スライド間の固定スリープ | API が遅いときも無駄な待機なし；共有クォータ消費に対して耐性あり |
| 元言語 | 自動検出（`'auto'`） | 明示的な言語ペア | シンプルな UX；ビジネステキストでは Gemini の検出精度が高い |
| APIキー管理 | `PropertiesService` | ハードコード | セキュリティ |
| グロッサリー保管 | Drive 上の JSON + CacheService | PropertiesService 直接 | サイズ制限なし；非エンジニアが編集可能；6時間キャッシュでレイテンシ削減 |
| 翻訳粒度 | スライド一括（JSON 配列） | 要素単位 / 全体一括 | API 効率と一貫性のバランス |
| JSON 出力 | `response_mime_type: application/json` + サニタイズフォールバック | テキストパース | パース失敗を最小化；Gemini が稀に返すエスケープなし改行に対応 |
| スタイル保持 | 単一スタイルのスナップショット；混在は警告 | 完全なランレベル対応 | Phase 1 の実装複雑度を抑える |
| デフォルトモデル | `gemini-3.1-flash-lite` | `gemini-2.5-flash` | 15 RPM / 500 RPD vs 5 RPM / 20 RPD；`BATCH_SIZE=15` に適合 |
| UI | ライブログ付きサイドバー | モーダルダイアログ | 常時表示パネル；翻訳中も進捗が見える；設定に常時アクセス可能 |

---

## 8. 未解決の課題・リスク

1. **GAS の 6 分タイムアウト**: 80スライド超の場合、1回の実行で完了しない可能性がある。スライドインデックスを `PropertiesService` に保存して「スライド N から再開」する仕組みを Phase 2 で計画している。

2. **Gemini の JSON 出力の安定性**: `response_mime_type` の JSON モードと `sanitizeJsonNewlines()` で既知の失敗パターンはカバーしているが、さらなるエッジケースが存在する可能性がある。

3. **グロッサリーのトークンコスト**: 大きなグロッサリーはシステムプロンプトを肥大化させる。`filterRelevantEntries()` で現在のスライドのテキストに含まれる用語のみに事前フィルタリングしている。

4. **データプライバシー**: スライドの内容が Gemini API に送信される。自組織のデータポリシーへの準拠を確認すること。必要な場合は Vertex AI（データ非学習保証あり）への移行も選択肢として検討する。

5. **同時翻訳の競合**: サイドバーを閉じて再度開いた場合、再開検出機構により誤った二重実行を防ぐ。同一の `PROGRESS_CACHE_KEY` に対して複数ユーザーが同時翻訳を実行すると干渉が起きるが、現在の単一ユーザー運用モデルでは許容範囲内。

---

## 付録：`appsscript.json` OAuth スコープ

```json
{
  "timeZone": "Asia/Tokyo",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/script.container.ui"
  ]
}
```

- `presentations`: スライドコンテンツの読み書き
- `drive.readonly`: Drive 上のグロッサリー JSON の読み込み
- `script.external_request`: Gemini API への `UrlFetchApp.fetchAll()` 呼び出し
- `script.container.ui`: `SlidesApp.getUi().showSidebar()` の実行
