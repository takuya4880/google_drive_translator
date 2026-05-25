# Google Slides Translator

A Google Apps Script add-on that translates Google Slides presentations using the Gemini API, with support for a custom glossary to ensure consistent terminology.

## Features

- Translates all text shapes and table cells in a presentation
- Parallel batch translation using `UrlFetchApp.fetchAll()` — all slides in a batch are sent simultaneously (default model: `gemini-3.1-flash-lite`, 15 RPM free tier)
- Source language is auto-detected by Gemini; specify only the target language
- Supported target languages: English, Japanese, Korean, Chinese (Traditional), Chinese (Simplified), French
- Translation range selector: current slide only or entire presentation
- Injects a company glossary (JSON file on Google Drive) to enforce consistent terminology
- Backs up original text to speaker notes before overwriting
- Preserves text formatting: font, size, color, alignment, and inline styles (bold, italic, underline)
- Sidebar control panel with live translation log

## Project Structure

```
src/
├── main.gs         Entry point, sidebar server functions, translation orchestrator
├── sidebar.html    Sidebar UI (translate button, language selector, settings, log)
├── translator.gs   Gemini API calls, prompt building, response parsing
├── extractor.gs    Text extraction from shapes and table cells, style snapshot, write-back
├── glossary.gs     Load glossary from Drive, CacheService
└── utils.gs        Style helpers, alert wrappers

appsscript.json     GAS manifest (OAuth scopes)
glossary/
└── glossary.json   Sample glossary — upload this to Google Drive
DESIGN.md           English design document
DESIGN.ja.md        Japanese design document
```

## Setup

### 1. Prerequisites

- [Node.js](https://nodejs.org) (v18+)
- [clasp](https://github.com/google/clasp) v3: `npm install -g @google/clasp`
- A Google account with [Apps Script API enabled](https://script.google.com/home/usersettings)
- A [Gemini API key](https://aistudio.google.com/app/apikey)

### 2. Clone and push

```bash
git clone <this-repo>
cd google_drive_translator

clasp login

# Copy the template and fill in your own IDs
cp .clasp.json.template .clasp.json
```

Then edit `.clasp.json`:
- **`scriptId`**: Open a Google Slides file → Extensions > Apps Script → Project Settings → Script ID
- **`projectId`**: GCP project number (optional, only needed for `clasp tail-logs`)

```bash
clasp push --force
```

Reload the Google Slides file — a **Translate** menu should appear.

### 3. Get a Gemini API key

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Sign in with your Google account
3. Click **Create API key**
4. Select an existing GCP project or create a new one when prompted
5. Copy the generated API key

> The free tier (`gemini-3.1-flash-lite`) allows 15 requests/minute and 500 requests/day — sufficient for typical presentation translation.

### 4. Configure API key

In Google Slides: **Translate > Open**, then expand **Settings** and enter your Gemini API key.

### 5. (Optional) Set up a glossary

1. Edit `glossary/glossary.json` with your company terms
2. Upload the file to Google Drive
3. Copy the file ID from the Drive URL (`/d/<FILE_ID>/`)
4. In Google Slides: **Translate > Open** → **Settings** → paste the file ID and save

#### Glossary format

```json
[
  { "source": "YourCompany", "target": "YourCompany", "dir": "any", "note": "Company name — do not translate" },
  { "source": "your term", "target": "your translation", "dir": "ja→en" },
  { "source": "your translation", "target": "your term", "dir": "en→ja" }
]
```

`dir` values: `"any"`, `"ja→en"`, `"en→ja"`, `"ko→en"`, `"en→ko"`, `"zh-TW→en"`, etc.

## Internal Distribution (Workspace Marketplace)

Publishing as a private Workspace Marketplace add-on lets any user in the organization install it once and use it across all their Slides files — no `clasp push` required per file.

### Prerequisites

- Google Workspace organization (paid plan)
- Workspace Admin access (for domain-wide approval)
- A standalone GAS project (not container-bound)
- A GCP project linked to the GAS script

### 1. Push to the standalone GAS project

Ensure `.clasp.json` points to the standalone script ID and push:

```bash
clasp push --force
```

### 2. Create a versioned deployment in GAS

1. Open the project at [script.google.com](https://script.google.com)
2. **Deploy → New deployment** → type: **Editor Add-on**
3. Add a description (e.g. `v1`) and click **Deploy**
4. Note the version number (e.g. `1`)

### 3. Configure GCP

1. Open [Google Cloud Console](https://console.cloud.google.com) and select the linked project
2. **APIs & Services → Library** → enable **Google Workspace Marketplace SDK**
3. Go to **Google Workspace Marketplace SDK → App Configuration**:
   - Check **Slides add-on**
   - **Slides add-on Project Script ID**: paste the standalone script ID
   - **Slides add-on script version**: enter the version number from Step 2
   - Save

### 4. Publish to Marketplace

1. Go to the **Store Listing** tab in the Marketplace SDK
2. Fill in app name, description, and upload a 120×120 px icon
3. Set **Distribution** to **Private — only users in your domain**
4. Click **Publish** — no review required for private apps, goes live immediately

### 5. Admin: approve and install (Admin Console)

1. Sign in to [admin.google.com](https://admin.google.com)
2. **Apps → Google Workspace Marketplace apps → App list**
3. Search for **Google Slides Translator** and approve it
4. Choose **Install for all users** or a specific organizational unit

### Updating the add-on

After pushing code changes, create a new versioned deployment in GAS, then update the script version number in **GCP → Marketplace SDK → App Configuration** and save.

---

## Usage

1. Open any Google Slides file
2. Click **Extensions** in the menu bar → **Google Slides Translator** → **Open**
3. Select the translation range: **Current slide** (default) or **Entire presentation**
4. Click **Translate to English** for the most common case, or select another target language and click **Translate**
5. Watch the **Log** panel for live progress — original text is saved to speaker notes as backup
6. A completion dialog appears when all slides are done

> If you close the sidebar mid-translation, the translation continues in the background. Reopen the sidebar to resume progress display.

## Development

```bash
# Push local changes to GAS
clasp push --force

# Open GAS editor in browser
clasp open-script

# View execution logs
clasp tail-logs
```

## Limitations

- Inline bold, italic, and underline are preserved across translation; other mixed styles within a single text box (e.g. mixed font sizes) fall back to the first run's style
- Presentations over ~80 slides may hit the GAS 6-minute execution timeout (planned: resumable execution)

## Design

See [DESIGN.md](DESIGN.md) for architecture decisions, tradeoffs, and the phased roadmap.
