// ── Theme color resolution ──────────────────────────────────────────────────

// Module-level cache; reset each GAS execution.
var _themeColorCache = null;

// Fetch the presentation's theme palette from the Slides REST API.
// Returns { ACCENT1: 'rrggbb', DARK1: 'rrggbb', ... } or {} on failure.
function getThemeColorMap() {
  if (_themeColorCache !== null) return _themeColorCache;
  try {
    var id    = SlidesApp.getActivePresentation().getId();
    var token = ScriptApp.getOAuthToken();
    var resp  = UrlFetchApp.fetch(
      'https://slides.googleapis.com/v1/presentations/' + id +
        '?fields=masters.pageProperties.colorScheme.colors',
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
    );
    if (resp.getResponseCode() !== 200) { _themeColorCache = {}; return {}; }
    var body    = JSON.parse(resp.getContentText());
    var map     = {};
    var masters = body.masters || [];
    if (masters.length > 0) {
      var scheme = ((masters[0].pageProperties || {}).colorScheme || {});
      (scheme.colors || []).forEach(function(entry) {
        if (entry.type && entry.color && entry.color.rgbColor) {
          var r = Math.round((entry.color.rgbColor.red   || 0) * 255);
          var g = Math.round((entry.color.rgbColor.green || 0) * 255);
          var b = Math.round((entry.color.rgbColor.blue  || 0) * 255);
          map[entry.type] = ('00' + r.toString(16)).slice(-2) +
                             ('00' + g.toString(16)).slice(-2) +
                             ('00' + b.toString(16)).slice(-2);
        }
      });
    }
    _themeColorCache = map;
    return map;
  } catch (e) {
    Logger.log('getThemeColorMap: ' + e.message);
    _themeColorCache = {};
    return {};
  }
}

// Resolve a GAS Slides Color object to a lowercase 6-char hex string (no '#'),
// or null if the color is absent or cannot be resolved.
// Handles both explicit RGB colors and theme colors.
function resolveColorHex(fc) {
  try {
    if (!fc) return null;
    var colorType = fc.getColorType();
    if (colorType === SlidesApp.ColorType.RGB) {
      return fc.asRgbColor().asHexString().toLowerCase().replace('#', '');
    }
    if (colorType === SlidesApp.ColorType.THEME) {
      var themeType = fc.asThemeColor().getThemeColorType().toString();
      return getThemeColorMap()[themeType] || null;
    }
  } catch (e) {}
  return null;
}

// ── PropertiesService wrappers ──────────────────────────────────────────────

function getScriptProp(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function setScriptProp(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}

// ── UI helpers ──────────────────────────────────────────────────────────────

// Google Slides has no native toast API; progress is logged instead.
// Use showAlert() for messages the user must see.
function showToast(message) {
  Logger.log('[Progress] ' + message);
}

function showAlert(title, message) {
  SlidesApp.getUi().alert(title, message, SlidesApp.getUi().ButtonSet.OK);
}

// ── Style capture / restore ─────────────────────────────────────────────────

// Snapshot the text style of a TextRange before calling setText(),
// which would otherwise reset all formatting.
function captureStyle(textRange) {
  var style = textRange.getTextStyle();
  var paraStyle = textRange.getParagraphStyle();

  var resolved = resolveColorHex(style.getForegroundColor());
  var hexColor = resolved ? '#' + resolved : null;

  return {
    fontFamily: style.getFontFamily(),
    fontSize:   style.getFontSize(),
    bold:       style.isBold(),
    italic:     style.isItalic(),
    underline:  style.isUnderline(),
    hexColor:   hexColor,
    alignment:  paraStyle.getParagraphAlignment()
  };
}

// Re-apply a captured style snapshot after setText().
function restoreStyle(textRange, snapshot) {
  var style = textRange.getTextStyle();
  var paraStyle = textRange.getParagraphStyle();

  try { if (snapshot.fontFamily)      style.setFontFamily(snapshot.fontFamily); } catch (e) {}
  try { if (snapshot.fontSize)        style.setFontSize(snapshot.fontSize); } catch (e) {}
  try { if (snapshot.bold    !== null) style.setBold(snapshot.bold); } catch (e) {}
  try { if (snapshot.italic  !== null) style.setItalic(snapshot.italic); } catch (e) {}
  try { if (snapshot.underline !== null) style.setUnderline(snapshot.underline); } catch (e) {}
  try { if (snapshot.hexColor)        style.setForegroundColor(snapshot.hexColor); } catch (e) {}
  try { if (snapshot.alignment)       paraStyle.setParagraphAlignment(snapshot.alignment); } catch (e) {}
}

// Returns true when all runs in a TextRange share the same font family and size.
function isSingleStyle(textRange) {
  var runs = textRange.getRuns();
  if (!runs || runs.length <= 1) return true;
  var refFamily = runs[0].getTextStyle().getFontFamily();
  var refSize   = runs[0].getTextStyle().getFontSize();
  return runs.every(function(run) {
    var s = run.getTextStyle();
    return s.getFontFamily() === refFamily && s.getFontSize() === refSize;
  });
}

// ── Rich-text encoding / decoding ───────────────────────────────────────────

// Encode a TextRange's content as HTML-like markup (<b>, <i>, <u>, <c:RRGGBB>).
// The result is sent to Gemini so it can preserve inline formatting across translation.
function encodeRichText(textRange) {
  var runs = textRange.getRuns();
  if (!runs || runs.length === 0) return textRange.asString();

  var result = '';
  for (var i = 0; i < runs.length; i++) {
    var run = runs[i];
    var text = run.asString();
    if (!text) continue;

    var style     = run.getTextStyle();
    var bold      = style.isBold()      === true;
    var italic    = style.isItalic()    === true;
    var underline = style.isUnderline() === true;

    var resolvedHex = resolveColorHex(style.getForegroundColor());
    var hexColor = (resolvedHex && resolvedHex !== '000000') ? resolvedHex : null;

    var open  = (bold ? '<b>' : '') + (italic ? '<i>' : '') + (underline ? '<u>' : '') +
                (hexColor ? '<c:' + hexColor + '>' : '');
    var close = (hexColor ? '</c>' : '') + (underline ? '</u>' : '') +
                (italic ? '</i>' : '') + (bold ? '</b>' : '');

    result += open + text + close;
  }
  return result;
}

// Parse HTML-like markup (<b>, <i>, <u>, <c:RRGGBB>) into a flat list of styled segments.
// Unknown or mismatched tags are treated as literal text, so malformed input never throws.
function parseMarkup(markup) {
  var segments = [];
  var stack = [{ bold: false, italic: false, underline: false, color: null }];
  var buf = '';
  var i = 0;

  function flush() {
    if (buf) {
      var top = stack[stack.length - 1];
      segments.push({ text: buf, bold: top.bold, italic: top.italic, underline: top.underline, color: top.color });
      buf = '';
    }
  }

  while (i < markup.length) {
    if (markup[i] !== '<') { buf += markup[i++]; continue; }

    var end = markup.indexOf('>', i);
    if (end === -1) { buf += markup[i++]; continue; }  // unmatched '<' → literal

    var tag = markup.substring(i + 1, end).toLowerCase().trim();
    flush();

    var top = stack[stack.length - 1];
    if      (tag === 'b')  { stack.push({ bold: true,     italic: top.italic, underline: top.underline, color: top.color }); }
    else if (tag === '/b') { if (stack.length > 1) stack.pop(); }
    else if (tag === 'i')  { stack.push({ bold: top.bold, italic: true,       underline: top.underline, color: top.color }); }
    else if (tag === '/i') { if (stack.length > 1) stack.pop(); }
    else if (tag === 'u')  { stack.push({ bold: top.bold, italic: top.italic, underline: true,          color: top.color }); }
    else if (tag === '/u') { if (stack.length > 1) stack.pop(); }
    else if (tag.length === 8 && tag.indexOf('c:') === 0 && /^[0-9a-f]{6}$/.test(tag.substring(2))) {
      stack.push({ bold: top.bold, italic: top.italic, underline: top.underline, color: tag.substring(2) });
    }
    else if (tag === '/c') { if (stack.length > 1) stack.pop(); }
    else                   { buf += markup.substring(i, end + 1); }  // unknown tag → literal text

    i = end + 1;
  }

  flush();
  return segments;
}

// Re-apply font, size, color, and alignment to the full range — but not bold/italic/underline,
// which are handled per-segment by applyRichText.
function restoreBaseStyle(textRange, snapshot) {
  var style     = textRange.getTextStyle();
  var paraStyle = textRange.getParagraphStyle();
  try { if (snapshot.fontFamily) style.setFontFamily(snapshot.fontFamily); } catch (e) {}
  try { if (snapshot.fontSize)   style.setFontSize(snapshot.fontSize);     } catch (e) {}
  try { if (snapshot.hexColor)   style.setForegroundColor(snapshot.hexColor); } catch (e) {}
  try { if (snapshot.alignment)  paraStyle.setParagraphAlignment(snapshot.alignment); } catch (e) {}
}

// Set a translated markup string into a TextRange and re-apply per-segment styles.
// Falls back to plain-text + full snapshot restore if the markup is malformed.
function applyRichText(textRange, markedUpText, snapshot) {
  var segments, plainText;
  var fallback = false;

  try {
    segments  = parseMarkup(markedUpText);
    plainText = segments.map(function(s) { return s.text; }).join('');
    if (plainText.indexOf('<') !== -1) fallback = true;  // residual tags mean parse went wrong
  } catch (e) {
    fallback = true;
  }

  if (fallback) {
    // Strip all markup tags and apply the global snapshot as before
    textRange.setText(markedUpText.replace(/<[^>]*>/g, ''));
    restoreStyle(textRange, snapshot);
    return;
  }

  textRange.setText(plainText);
  restoreBaseStyle(textRange, snapshot);

  var pos = 0;
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    var len = seg.text.length;
    if (len > 0) {
      try {
        var range = textRange.getRange(pos, pos + len);
        var s = range.getTextStyle();
        s.setBold(seg.bold);
        s.setItalic(seg.italic);
        s.setUnderline(seg.underline);
        if (seg.color !== null) s.setForegroundColor('#' + seg.color);
      } catch (e) {}
    }
    pos += len;
  }
}
