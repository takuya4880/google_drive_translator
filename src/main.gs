function onOpen(e) {
  SlidesApp.getUi()
    .createAddonMenu()
    .addItem('Translate this slide to English', 'menuTranslateCurrentSlide')
    .addItem('Translate entire file to English', 'menuTranslateAll')
    .addSeparator()
    .addItem('Open sidebar', 'showSidebar')
    .addToUi();
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

function menuTranslateCurrentSlide() { showSidebarWithAction('current'); }
function menuTranslateAll()          { showSidebarWithAction('all'); }

function showSidebarWithAction(action) {
  var tmpl = HtmlService.createTemplateFromFile('sidebar');
  tmpl.autoStart = action;
  SlidesApp.getUi().showSidebar(tmpl.evaluate().setTitle('Translator'));
}

function showSidebar() {
  var tmpl = HtmlService.createTemplateFromFile('sidebar');
  tmpl.autoStart = '';
  SlidesApp.getUi().showSidebar(tmpl.evaluate().setTitle('Translator'));
}

var PROGRESS_CACHE_KEY = 'translation_progress';

function getProgress() {
  var data = CacheService.getScriptCache().get(PROGRESS_CACHE_KEY);
  return data ? JSON.parse(data) : null;
}

function getSettings() {
  var apiKey = getScriptProp('GEMINI_API_KEY');
  return {
    apiKeySet:  !!apiKey,
    glossaryId: getScriptProp('GLOSSARY_FILE_ID') || '',
    model:      getScriptProp('GEMINI_MODEL') || DEFAULT_MODEL
  };
}

function saveSettings(apiKey, glossaryId, model) {
  if (apiKey) setScriptProp('GEMINI_API_KEY', apiKey);
  var oldId = getScriptProp('GLOSSARY_FILE_ID');
  if (oldId) CacheService.getScriptCache().remove('glossary_cache_' + oldId);
  setScriptProp('GLOSSARY_FILE_ID', glossaryId);
  setScriptProp('GEMINI_MODEL', model);
  return 'Settings saved.';
}

// ── Main orchestrator ────────────────────────────────────────────────────────

function getSlidesToTranslate(range) {
  var presentation = SlidesApp.getActivePresentation();
  var allSlides = presentation.getSlides();
  if (range !== 'current') return allSlides;

  try {
    var currentPage = presentation.getSelection().getCurrentPage();
    var currentId = currentPage.getObjectId();
    for (var i = 0; i < allSlides.length; i++) {
      if (allSlides[i].getObjectId() === currentId) return [allSlides[i]];
    }
  } catch (e) {
    Logger.log('Could not determine current slide, falling back to full presentation: ' + e.message);
  }
  return allSlides;
}

function translatePresentation(sourceLang, targetLang, range) {
  var apiKey = getScriptProp('GEMINI_API_KEY');
  if (!apiKey) {
    showAlert('Configuration Error', 'Gemini API key is not set.\nGo to Translate > Open to configure it.');
    return;
  }

  var model = getScriptProp('GEMINI_MODEL') || DEFAULT_MODEL;
  var slides = getSlidesToTranslate(range || 'all');
  var total = slides.length;
  var glossaryEntries = loadGlossary(sourceLang, targetLang);
  var logMessages = [];
  var done = 0;

  function writeProgress(running, message) {
    Logger.log(message);
    logMessages.push(message);
    if (logMessages.length > 100) logMessages.splice(0, logMessages.length - 100);
    CacheService.getScriptCache().put(PROGRESS_CACHE_KEY, JSON.stringify({
      running: running,
      total:   total,
      done:    done,
      messages: logMessages
    }), 600);
  }

  writeProgress(true, 'Translation started: ' + total + ' slides, model=' + model);

  // Phase 1: extract elements from all slides and back up originals to speaker notes
  var allElements = [];
  for (var i = 0; i < slides.length; i++) {
    var elements = extractShapeElements(slides[i]);
    allElements.push(elements);
    if (elements.length > 0) backupToSpeakerNotes(slides[i], elements);
  }

  // Phase 2: build initial queue — one item per slide that has translatable text
  var queue = [];
  for (var i = 0; i < slides.length; i++) {
    if (allElements[i].length === 0) continue;
    var texts     = allElements[i].map(function(el) { return el.text; });
    var richTexts = allElements[i].map(function(el) { return el.richText; });
    var relevant = filterRelevantEntries(glossaryEntries, texts);
    var systemPrompt = buildSystemPrompt(sourceLang, targetLang, buildGlossaryPrompt(relevant));
    queue.push({
      slideIndex: i,
      texts: texts,
      payload: buildGeminiPayload(richTexts, systemPrompt),
      retries: 0
    });
  }

  // Phase 3: process queue in parallel batches; write each slide back as soon as its batch completes
  var errorSlides = [];

  while (queue.length > 0) {
    var batch = queue.splice(0, Math.min(BATCH_SIZE, queue.length));
    var t0 = Date.now();

    writeProgress(true, 'Sending batch: ' + batch.length + ' slides (' + queue.length + ' remaining)');
    var responses = callGeminiFetchAll(batch, apiKey, model);

    var had429 = false;
    for (var j = 0; j < batch.length; j++) {
      var item = batch[j];
      var resp = responses[j];
      if (resp.ok) {
        done++;
        writeBackTranslations(allElements[item.slideIndex], resp.result);
        writeProgress(true, 'Slide ' + (item.slideIndex + 1) + ': done (' + done + '/' + total + ')');
      } else if (item.retries < MAX_RETRIES) {
        if (resp.status === 429) had429 = true;
        item.retries++;
        queue.push(item);
        writeProgress(true, 'Slide ' + (item.slideIndex + 1) + ': ' + resp.error + ' → retry ' + item.retries + '/' + MAX_RETRIES);
      } else {
        errorSlides.push('Slide ' + (item.slideIndex + 1) + ': ' + resp.error);
        writeProgress(true, 'Slide ' + (item.slideIndex + 1) + ': failed — ' + resp.error);
      }
    }

    // Only pace when a 429 was received — parse failures and other errors
    // don't indicate rate limit pressure, so retry immediately.
    if (queue.length > 0 && had429) {
      var sleepMs = Math.max(0, 60000 - (Date.now() - t0));
      if (sleepMs > 0) {
        writeProgress(true, 'Rate limit hit — waiting ' + (sleepMs / 1000).toFixed(1) + 's before next batch…');
        Utilities.sleep(sleepMs);
      }
    }
  }

  var finalMsg = errorSlides.length > 0
    ? 'Done with ' + errorSlides.length + ' error(s): ' + errorSlides.join(', ')
    : 'All ' + total + ' slides translated successfully.';
  writeProgress(false, finalMsg);

  if (errorSlides.length > 0) {
    showAlert('Translation Complete (with errors)', errorSlides.join('\n'));
  }
}

