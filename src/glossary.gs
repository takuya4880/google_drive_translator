var GLOSSARY_CACHE_KEY = 'glossary_cache';
var GLOSSARY_CACHE_TTL = 6 * 60 * 60; // 6 hours in seconds

// Load glossary entries filtered by translation direction.
// Checks CacheService first; fetches from Drive JSON on cache miss.
function loadGlossary(sourceLang, targetLang) {
  var fileId = getScriptProp('GLOSSARY_FILE_ID');
  if (!fileId) return [];

  var cacheKey = GLOSSARY_CACHE_KEY + '_' + fileId;
  var cache = CacheService.getScriptCache();
  var cached = cache.get(cacheKey);

  var allEntries;
  if (cached) {
    allEntries = JSON.parse(cached);
  } else {
    try {
      allEntries = fetchGlossaryFromDrive(fileId);
      cache.put(cacheKey, JSON.stringify(allEntries), GLOSSARY_CACHE_TTL);
    } catch (e) {
      Logger.log('Failed to load glossary: ' + e.message);
      return [];
    }
  }

  return filterByDirection(allEntries, sourceLang, targetLang);
}

// Fetch and parse a glossary JSON file from Google Drive.
// Expected format: array of { source, target, dir, note? }
function fetchGlossaryFromDrive(fileId) {
  var file = DriveApp.getFileById(fileId);
  var content = file.getBlob().getDataAsString('UTF-8');
  var parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error('Glossary JSON must be a top-level array.');
  }
  return parsed;
}

// Keep only entries that match the given language direction.
// dir values: "any", "ja→en", "en→ja", "ko→en", "en→ko", etc.
// sourceLang may be 'auto' to include all entries targeting targetLang.
function filterByDirection(entries, sourceLang, targetLang) {
  return entries.filter(function(entry) {
    if (entry.dir === 'any') return true;
    var parts = entry.dir.split('→');
    if (parts.length !== 2) return false;
    if (parts[1] !== targetLang) return false;
    return sourceLang === 'auto' || parts[0] === sourceLang;
  });
}

// Format glossary entries into a string suitable for injection into the system prompt.
function buildGlossaryPrompt(entries) {
  if (!entries || entries.length === 0) return '(no glossary)';
  return entries.map(function(entry) {
    var note = entry.note ? ' (' + entry.note + ')' : '';
    return '- ' + entry.source + ' → ' + entry.target + note;
  }).join('\n');
}

// For large glossaries: filter down to entries whose source term
// appears in the given text array, to avoid bloating the prompt.
function filterRelevantEntries(entries, texts) {
  if (!entries || entries.length === 0) return [];
  var combined = texts.join(' ');
  return entries.filter(function(entry) {
    return combined.indexOf(entry.source) !== -1;
  });
}
