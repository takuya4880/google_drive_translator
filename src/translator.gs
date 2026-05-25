var DEFAULT_MODEL = 'gemini-3.1-flash-lite';
var MAX_RETRIES = 10;
var BATCH_SIZE = 15;

var LANG_NAMES = {
  'en':    'English',
  'ja':    'Japanese',
  'ko':    'Korean',
  'zh-TW': 'Traditional Chinese',
  'zh-CN': 'Simplified Chinese',
  'fr':    'French'
};

function buildSystemPrompt(sourceLang, targetLang, glossaryPrompt) {
  var tgt = LANG_NAMES[targetLang] || targetLang;
  var intro = sourceLang === 'auto'
    ? 'You are a professional business translator. Detect the source language and translate the contents of a Google Slides presentation to ' + tgt + '.'
    : 'You are a professional business translator. Translate the contents of a Google Slides presentation from ' + (LANG_NAMES[sourceLang] || sourceLang) + ' to ' + tgt + '.';

  return [
    intro,
    'Follow these rules strictly:',
    '1. Texts are passed as a JSON array. Return a JSON string array of exactly the same length.',
    '2. If a text is empty, numeric-only, or symbol-only, return it unchanged.',
    '3. Use the following glossary for proper nouns and product names:',
    glossaryPrompt,
    '4. Use natural, concise business language.',
    '5. Texts may contain inline formatting tags <b>, <i>, <u>, and <c:RRGGBB> (text color, where RRGGBB is a hex color code). Preserve all these tags around the semantically corresponding words in the translation. Do not add or remove tags.',
    '6. Do not add Markdown syntax, code blocks, or explanatory text.',
    '7. Return only the JSON array — nothing else.'
  ].join('\n');
}

// Build the Gemini API request payload for a batch of texts.
function buildGeminiPayload(texts, systemPrompt) {
  return {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: 'Translate the following texts:\n' + JSON.stringify(texts) }] }],
    generationConfig: { response_mime_type: 'application/json' }
  };
}

// Fire multiple Gemini requests in parallel using UrlFetchApp.fetchAll.
// Each item must have { payload, texts }. Returns an array of { ok, result } or
// { ok: false, status, error } in the same order as items.
function callGeminiFetchAll(items, apiKey, model) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;

  var requests = items.map(function(item) {
    return {
      url: url,
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(item.payload),
      muteHttpExceptions: true
    };
  });

  var responses = UrlFetchApp.fetchAll(requests);

  return responses.map(function(response, i) {
    var status = response.getResponseCode();
    if (status === 429) {
      return { ok: false, status: 429, error: 'RATE_LIMIT' };
    }
    if (status !== 200) {
      return { ok: false, status: status, error: 'HTTP ' + status + ': ' + response.getContentText().substring(0, 200) };
    }
    try {
      var body = JSON.parse(response.getContentText());
      if (!body.candidates || body.candidates.length === 0) {
        throw new Error('Empty candidates: ' + JSON.stringify(body).substring(0, 200));
      }
      if (!body.candidates[0].content || !body.candidates[0].content.parts) {
        throw new Error('Malformed response content');
      }
      return {
        ok: true,
        result: parseGeminiResponse(body.candidates[0].content.parts[0].text, items[i].texts.length)
      };
    } catch (e) {
      return { ok: false, status: status, error: e.message };
    }
  });
}

// Escape literal newlines/carriage returns inside JSON string values.
// Gemini sometimes returns unescaped newlines within strings, producing invalid JSON.
function sanitizeJsonNewlines(text) {
  var result = '';
  var inString = false;
  var escaped = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (escaped) {
      result += ch;
      escaped = false;
    } else if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
    } else if (ch === '"') {
      result += ch;
      inString = !inString;
    } else if (inString && (ch === '\n' || ch === '\r')) {
      result += (ch === '\n') ? '\\n' : '\\r';
    } else {
      result += ch;
    }
  }
  return result;
}

function parseGeminiResponse(rawText, expectedLength) {
  var parsed;
  // Attempt 1: direct parse
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    // Attempt 2: sanitize literal newlines inside string values, then parse
    try {
      parsed = JSON.parse(sanitizeJsonNewlines(rawText));
    } catch (e2) {
      // Attempt 3: extract JSON array with regex, sanitize, then parse
      var match = rawText.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          parsed = JSON.parse(sanitizeJsonNewlines(match[0]));
        } catch (e3) {
          throw new Error('JSON parse failed: ' + rawText.substring(0, 200));
        }
      } else {
        throw new Error('JSON parse failed: ' + rawText.substring(0, 200));
      }
    }
  }

  if (!Array.isArray(parsed)) {
    // Some models return an object with indexed keys; try converting.
    if (typeof parsed === 'object') {
      parsed = Object.values(parsed);
    } else {
      throw new Error('Response is not an array: ' + typeof parsed);
    }
  }

  if (parsed.length !== expectedLength) {
    throw new Error('Array length mismatch: expected=' + expectedLength + ', got=' + parsed.length);
  }

  return parsed.map(function(item) { return String(item); });
}
