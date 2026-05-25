# Google Slides Translation Add-on — Design Document

> Japanese version: [DESIGN.ja.md](DESIGN.ja.md)

## 1. Overview and Goals

### Problems with the Previous Implementation

The previous implementation used `LanguageApp.translate()` and had the following issues:

- **Poor translation quality**: Generic Google Translate output that feels unnatural in business documents
- **Inconsistent terminology**: The same source term translates differently across slides
- **No support for internal/domain-specific terms**: Product names, team names, and technical vocabulary are mistranslated
- **Text formatting is lost**: `setText()` resets font, size, and color
- **Tables are not supported**

### Goals

1. Use the Gemini API to significantly improve translation quality
2. Inject a company glossary as context to ensure consistent terminology
3. Preserve text formatting as much as possible
4. Support table cells and text shapes equally
5. Provide backup and rollback of pre-translation text
6. Translate efficiently using parallel requests within free-tier rate limits

---

## 2. GAS Design Decisions

### 2.1 How to Call the Gemini API

| Method | Pros | Cons | Decision |
|---|---|---|---|
| **`UrlFetchApp` + Gemini REST API** | Flexible, `fetchAll()` enables parallelism, free model choice | Requires API key management | **Adopted** |
| **GAS Advanced Service: Vertex AI** | Native GCP integration, data non-training guarantee | Complex OAuth, GCP project required | Future upgrade candidate |
| **`LanguageApp` (previous)** | Zero setup, free | Low quality, no prompt control | Deprecated |

**Decision**: Use `UrlFetchApp.fetchAll()` + Gemini REST API (`generativelanguage.googleapis.com`). The API key is stored in `PropertiesService.getScriptProperties()`.

Slides on the same batch are sent in a single `fetchAll()` call for parallel execution:

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

### 2.2 API Key Management

- Keys are stored in Script Properties and never appear in source code
- Configured via the sidebar (**Translate > Open → Settings**)
- Script Properties are only visible to the script owner

### 2.3 Glossary Management

#### Storage Location

| Location | Pros | Cons | Decision |
|---|---|---|---|
| **JSON file on Google Drive** | Lightweight, version-controllable | No visual editor | **Adopted** |
| **Google Spreadsheet** | Easy to edit for non-engineers | Requires Sheets scope | Future option |
| `PropertiesService` | Fast (no network) | 9KB/key limit, poor edit UX | Cache only |

**Decision**: Primary glossary is a **JSON file on Google Drive**, with the file ID saved in `PropertiesService`. Parsed result is cached in `CacheService` (TTL: 6 hours).

#### Glossary Format

```json
[
  { "source": "YourCompany", "target": "YourCompany", "dir": "any", "note": "Do not translate" },
  { "source": "形状最適化", "target": "shape optimization", "dir": "ja→en" }
]
```

`dir` accepts `"any"` or `"{source}→{target}"` (e.g. `"ja→en"`). When source language is `"auto"` (auto-detect mode), all entries targeting the specified language are included.

### 2.4 Rate Limiting and Parallelism

GAS constraints:
- **Max execution time**: 6 minutes (add-on)
- **`UrlFetchApp` calls**: 20,000/day
- Gemini API **RPM** limits (e.g. `gemini-3.1-flash-lite`: 15 RPM free tier)

Strategy:
1. **Parallel batching**: `BATCH_SIZE = 15` slides are sent simultaneously with `UrlFetchApp.fetchAll()` — one API call per slide in parallel
2. **Time-managed pacing**: After each batch, sleep `max(0, 60s − elapsed)` before the next batch to stay within RPM
3. **Reactive retry queue**: Each slide has its own `retries` counter. On 429 or other errors, only that slide is re-enqueued (up to `MAX_RETRIES = 10`); other slides in the batch are unaffected

---

## 3. Translation Approach Design

### 3.1 Translation Granularity

| Granularity | API calls (50 slides × 5 elements) | Decision |
|---|---|---|
| Per-element | 250 | Too expensive, no cross-element consistency |
| **Per-slide batch** | 50 | **Adopted** |
| Whole presentation | 1–few | Risk of exceeding token limits |

**Decision**: **Per-slide batch**. All text elements on one slide (shapes + table cells) are sent as a JSON array; Gemini returns a JSON array of the same length.

### 3.2 Prompt Design

```
System prompt (fixed):
  You are a professional business translator. Detect the source language
  and translate the contents of a Google Slides presentation to {targetLang}.
  Follow these rules strictly:
  1. Texts are passed as a JSON array. Return a JSON string array of exactly the same length.
  2. If a text is empty, numeric-only, or symbol-only, return it unchanged.
  3. Use the following glossary for proper nouns and product names:
     {glossary}
  4. Use natural, concise business language.
  5. Do not add Markdown syntax, code blocks, or explanatory text.
  6. Return only the JSON array — nothing else.

User message:
  Translate the following texts:
  {json_array_of_texts}
```

Source language is **auto-detected** by Gemini. `buildSystemPrompt()` accepts `sourceLang = 'auto'` and omits the source language specification from the prompt. An explicit source language can still be passed (e.g. `'ja'`) for backward compatibility.

### 3.3 Gemini Model Selection

| Model | RPM (free) | RPD (free) | Quality | Decision |
|---|---|---|---|---|
| **`gemini-3.1-flash-lite`** | 15 | 500 | Good | **Default** |
| `gemini-2.5-flash` | 5 | 20 | Higher | Optional (switchable via Settings) |
| `gemini-2.5-pro` | 5 | 20 | Best | Optional for critical documents |

`gemini-3.1-flash-lite` is the default because its 15 RPM / 500 RPD free-tier limit comfortably supports the `BATCH_SIZE = 15` design without rate limiting under typical usage.

### 3.4 Parsing Gemini's Response

Response parsing uses a three-stage fallback in `parseGeminiResponse()`:

1. **Direct `JSON.parse`** — succeeds for well-formed responses
2. **Sanitize then parse** — `sanitizeJsonNewlines()` escapes literal `\n`/`\r` inside JSON string values (Gemini sometimes returns unescaped newlines, producing invalid JSON)
3. **Regex extract then sanitize then parse** — extracts `[...]` with a regex to handle trailing backticks or whitespace Gemini occasionally appends

Array length mismatch throws an error, triggering a retry via the queue.

### 3.5 Preserving Text Style

`getText().setText(result)` destroys formatting. `captureStyle()` snapshots the text style before translation; `restoreStyle()` re-applies it after `setText()`.

- **Single style**: snapshot is restored exactly
- **Mixed styles**: first-run style is applied as a fallback (known limitation)

---

## 4. Architecture

```
src/
├── main.gs         onOpen, showSidebar, getSettings, saveSettings,
│                   getProgress, translatePresentation
├── sidebar.html    Sidebar UI: translate buttons, language selector,
│                   live log (CacheService polling), collapsible settings
├── translator.gs   buildGeminiPayload, callGeminiFetchAll, parseGeminiResponse,
│                   sanitizeJsonNewlines, buildSystemPrompt
├── extractor.gs    extractShapeElements (shapes + table cells),
│                   writeBackTranslations, backupToSpeakerNotes
├── glossary.gs     loadGlossary, filterByDirection, filterRelevantEntries,
│                   buildGlossaryPrompt
└── utils.gs        captureStyle, restoreStyle, showAlert, getScriptProp, setScriptProp

appsscript.json     Manifest (OAuth scopes)
glossary/
└── glossary.json   Sample glossary
```

### Execution Flow

```
onOpen()
└── showSidebar()          ← user opens sidebar

sidebar: "Translate to English"
└── google.script.run.translatePresentation('auto', 'en')

translatePresentation(sourceLang, targetLang)
├── loadGlossary(sourceLang, targetLang)       [CacheService → Drive JSON]
├── Phase 1: extractShapeElements() × all slides + backupToSpeakerNotes()
├── Phase 2: build queue [{slideIndex, texts, payload, retries}]
└── Phase 3: queue loop
    ├── batch = queue.splice(0, BATCH_SIZE)
    ├── callGeminiFetchAll(batch, apiKey, model) → responses[]
    │   └── UrlFetchApp.fetchAll(requests)      ← parallel HTTP
    ├── for each response:
    │   ├── ok     → writeBackTranslations() + writeProgress() to CacheService
    │   ├── retry  → item.retries++, queue.push(item)
    │   └── failed → errorSlides.push()
    └── sleep max(0, 60s − elapsed) if more batches remain

sidebar: setInterval 2s
└── google.script.run.getProgress()            ← reads CacheService
    └── handleProgress(data) → update log display
```

---

## 5. Feature Scope by Phase

### Phase 1 (Released)
- [x] Text shapes and slide titles
- [x] Table cell text
- [x] Parallel batch translation (`UrlFetchApp.fetchAll`, `BATCH_SIZE=15`)
- [x] Per-slide retry queue (`MAX_RETRIES=10`)
- [x] Source language auto-detection
- [x] Target languages: English, Japanese, Korean, zh-TW, zh-CN, French
- [x] Gemini API translation (default: `gemini-3.1-flash-lite`)
- [x] Glossary injection (JSON file on Drive, CacheService)
- [x] Backup pre-translation text to speaker notes
- [x] Single-style preservation
- [x] JSON newline sanitization fallback
- [x] Sidebar UI with live progress log

### Phase 2
- [ ] Resumable execution for decks > ~80 slides (GAS 6-minute timeout)
- [ ] Translate selected slides only (range input)
- [ ] Improved style preservation (per-run level for mixed styles)
- [ ] Speaker notes translation

### Phase 3
- [ ] Translation cache (skip unchanged strings on re-run)
- [ ] Rollback UI (restore from speaker notes)
- [ ] Vertex AI migration (enterprise data-privacy requirements)

---

## 6. Error Handling Strategy

| Error type | Handling |
|---|---|
| Gemini 429 (rate limit) | Re-enqueue slide; next batch starts after 60s pacing |
| Gemini 5xx / network error | Re-enqueue slide; retried in next batch |
| JSON parse failure | `sanitizeJsonNewlines()` fallback → regex extract → re-enqueue if all fail |
| Array length mismatch | Error thrown → slide re-enqueued |
| Exceeded `MAX_RETRIES` (10) | Slide added to error list; reported in completion alert |
| GAS 6-minute timeout | Phase 2: save progress to PropertiesService for resume |
| Glossary load failure | Alert shown; translation continues without glossary |

---

## 7. Key Design Tradeoffs

| Issue | Adopted | Rejected | Reason |
|---|---|---|---|
| Translation engine | Gemini REST API (`UrlFetchApp`) | `LanguageApp`, DeepL | Quality, prompt control, `fetchAll` parallelism |
| Parallelism | `UrlFetchApp.fetchAll()` per batch | Sequential per-slide | 15× speedup within a batch; only GAS mechanism for concurrent HTTP |
| Rate limit strategy | Time-managed batching + per-slide reactive retry | Fixed sleep between slides | No wasted wait when API is slow; resilient to shared quota consumption |
| Source language | Auto-detect (`'auto'`) | Explicit language pair | Simpler UX; Gemini detection is reliable for business text |
| API key storage | `PropertiesService` | Hardcoded | Security |
| Glossary storage | JSON on Drive + CacheService | PropertiesService directly | No size limit; non-engineer editable; 6h cache reduces latency |
| Translation granularity | Per-slide batch (JSON array) | Per-element / full deck | Balance of API efficiency and consistency |
| JSON output | `response_mime_type: application/json` + sanitize fallback | Text parsing | Minimise parse failure; handle Gemini's occasional unescaped newlines |
| Style preservation | Single-style snapshot; warn on mixed | Full per-run level | Phase 1 complexity kept low |
| Default model | `gemini-3.1-flash-lite` | `gemini-2.5-flash` | 15 RPM / 500 RPD vs 5 RPM / 20 RPD; fits `BATCH_SIZE=15` cleanly |
| UI | Sidebar with live log | Modal dialogs | Persistent panel; progress visible; settings always accessible |

---

## 8. Open Issues and Risks

1. **GAS 6-minute timeout**: Decks exceeding ~80 slides may not complete in one run. Saving the slide index to `PropertiesService` for "resume from slide N" is planned for Phase 2.

2. **Gemini JSON output stability**: `response_mime_type` JSON mode and `sanitizeJsonNewlines()` cover known failure modes, but further edge cases may exist.

3. **Glossary token cost**: A large glossary bloats the system prompt. `filterRelevantEntries()` pre-filters to only include terms that appear in the current slide's text.

4. **Data privacy**: Slide content is sent to the Gemini API. Verify compliance with your organization's data policy. Migrating to Vertex AI (which guarantees no data training) is an option if required.

5. **Concurrent translations**: If the sidebar is closed and reopened, the resume-detection mechanism prevents accidental double-execution. Two users running translations simultaneously on the same `PROGRESS_CACHE_KEY` would interfere — acceptable given the current single-user deployment model.

---

## Appendix: `appsscript.json` OAuth Scopes

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

- `presentations`: read/write slide content
- `drive.readonly`: read glossary JSON from Drive
- `script.external_request`: `UrlFetchApp.fetchAll()` to Gemini API
- `script.container.ui`: `SlidesApp.getUi().showSidebar()`
