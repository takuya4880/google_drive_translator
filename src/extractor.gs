// Extract all non-empty text shapes and table cells from a slide.
// Returns an array of element descriptors used by writeBackTranslations().
function extractShapeElements(slide) {
  var elements = [];

  var SKIP_TYPES = [
    SlidesApp.PlaceholderType.SLIDE_NUMBER,
    SlidesApp.PlaceholderType.DATE_AND_TIME,
    SlidesApp.PlaceholderType.FOOTER,
    SlidesApp.PlaceholderType.HEADER
  ];

  var shapes = slide.getShapes();
  for (var i = 0; i < shapes.length; i++) {
    var shape = shapes[i];
    if (SKIP_TYPES.indexOf(shape.getPlaceholderType()) !== -1) continue;
    var textRange = shape.getText();
    var text = textRange.asString().trim();
    if (!text) continue;
    elements.push({
      type:          'shape',
      shape:         shape,
      text:          text,
      richText:      encodeRichText(textRange),
      styleSnapshot: captureStyle(textRange),
      hasMultiStyle: !isSingleStyle(textRange)
    });
  }

  var tables = slide.getTables();
  for (var t = 0; t < tables.length; t++) {
    var table = tables[t];
    var numRows = table.getNumRows();
    var numCols = table.getNumColumns();
    for (var r = 0; r < numRows; r++) {
      for (var c = 0; c < numCols; c++) {
        var cell = table.getCell(r, c);
        var cellRange = cell.getText();
        var cellText = cellRange.asString().trim();
        if (!cellText) continue;
        elements.push({
          type:          'cell',
          cell:          cell,
          text:          cellText,
          richText:      encodeRichText(cellRange),
          styleSnapshot: captureStyle(cellRange),
          hasMultiStyle: !isSingleStyle(cellRange)
        });
      }
    }
  }

  return elements;
}

// Write translated strings back into shapes and table cells, restoring formatting after setText().
function writeBackTranslations(elements, translations) {
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    var translated = translations[i];
    if (translated == null || translated === '') continue;

    var textRange = el.type === 'cell' ? el.cell.getText() : el.shape.getText();
    applyRichText(textRange, translated, el.styleSnapshot);
  }
}

// Save original text to speaker notes as a backup before translation.
function backupToSpeakerNotes(slide, elements) {
  try {
    var notesPage = slide.getNotesPage();
    var notesShape = notesPage.getSpeakerNotesShape();
    var textRange = notesShape.getText();
    var existing = textRange.asString().trim();

    var backup = elements.map(function(el, i) {
      return '[' + (i + 1) + '] ' + el.text;
    }).join('\n');

    var header = '--- Pre-translation backup ---\n';
    var separator = existing ? '\n\n' : '';
    textRange.setText(existing + separator + header + backup);
  } catch (e) {
    Logger.log('Speaker notes backup failed: ' + e.message);
  }
}
