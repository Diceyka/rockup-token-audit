// ============================================================
// RockUP Token Audit — Google Apps Script Web App
// Code.gs
//
// Deploy as Web App:
//   Execute as: Me
//   Who has access: Anyone (или Anyone with Google Account)
// ============================================================

// Brand colours (используем для форматирования таблиц)
var BRAND = {
  INK:       '#141413',
  PAPER:     '#faf9f5',
  BRAND:     '#d97757',
  BLUE:      '#6a9bcc',
  GREEN:     '#788c5d',
  MUTED:     '#e2e0d9',
  PASS_BG:   '#e8f5e2',
  FAIL_BG:   '#fdecea',
  DIFF_BG:   '#fff8f0',
};

// ── Entry point ──────────────────────────────────────────────
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var data          = payload.data;
    var spreadsheetId = payload.spreadsheetId || null;

    var ss;
    if (spreadsheetId) {
      ss = SpreadsheetApp.openById(spreadsheetId);
    } else {
      // Check script properties for a stored sheet
      var storedId = PropertiesService.getScriptProperties().getProperty('ROCKUP_SHEET_ID');
      if (storedId) {
        try { ss = SpreadsheetApp.openById(storedId); } catch (ex) { ss = null; }
      }
      if (!ss) {
        var now = new Date();
        var title = 'RockUP Token Audit — ' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'MMM yyyy');
        ss = SpreadsheetApp.create(title);
        PropertiesService.getScriptProperties().setProperty('ROCKUP_SHEET_ID', ss.getId());
      }
    }

    // Write all sheets
    writeSheetSummary(ss,          data.summary);
    writeSheetMatrix(ss,           data.matrix);
    writeSheetOverlaps(ss,         data.tokenOverlaps);
    writeSheetDetails(ss,          data.componentDetails);
    writeSheetLightDark(ss,        data.lightDark);
    writeSheetWcag(ss,             data.wcag);
    writeSheetAliasDuplicates(ss,  data.aliasDuplicates);
    if (data.refColors && data.refColors.length > 0) {
      writeSheetRefColors(ss, data.refColors);
    }

    // Remove default Sheet1 if still present
    cleanupDefaultSheet(ss);

    ss.setActiveSheet(ss.getSheets()[0]);

    return jsonOk({ spreadsheetId: ss.getId(), url: ss.getUrl() });

  } catch (err) {
    return jsonError(err.toString());
  }
}

// ── GET (health check) ───────────────────────────────────────
function doGet(e) {
  return jsonOk({ status: 'RockUP Token Audit Web App is running' });
}

// ── Manual import from Google Drive ──────────────────────────
// Use when CORS blocks direct send from Figma Web (browser).
// 1. Save the downloaded rockup-audit-*.json file to Google Drive
// 2. Open this Apps Script project → Run → importFromFile()
function importFromFile() {
  // Find the most recent rockup-audit-*.json in Drive
  var files = DriveApp.searchFiles(
    'title contains "rockup-audit" and mimeType = "application/json" and trashed = false'
  );

  if (!files.hasNext()) {
    throw new Error(
      'Файл rockup-audit-*.json не найден в Google Drive. ' +
      'Загрузи скачанный из плагина JSON-файл на Google Drive и запусти снова.'
    );
  }

  // Pick the most recently modified file
  var latestFile = null;
  var latestDate = new Date(0);
  while (files.hasNext()) {
    var f = files.next();
    if (f.getLastUpdated() > latestDate) {
      latestDate = f.getLastUpdated();
      latestFile = f;
    }
  }

  Logger.log('Импортирую из файла: ' + latestFile.getName());

  var content = latestFile.getBlob().getDataAsString();
  var data    = JSON.parse(content);

  // Re-use the same sheet logic as doPost
  var storedId = PropertiesService.getScriptProperties().getProperty('ROCKUP_SHEET_ID');
  var ss;
  if (storedId) {
    try { ss = SpreadsheetApp.openById(storedId); } catch (ex) { ss = null; }
  }
  if (!ss) {
    var now = new Date();
    var title = 'RockUP Token Audit — ' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'MMM yyyy');
    ss = SpreadsheetApp.create(title);
    PropertiesService.getScriptProperties().setProperty('ROCKUP_SHEET_ID', ss.getId());
  }

  writeSheetSummary(ss,         data.summary);
  writeSheetMatrix(ss,          data.matrix);
  writeSheetOverlaps(ss,        data.tokenOverlaps);
  writeSheetDetails(ss,         data.componentDetails);
  writeSheetLightDark(ss,       data.lightDark);
  writeSheetWcag(ss,            data.wcag);
  writeSheetAliasDuplicates(ss, data.aliasDuplicates);
  if (data.refColors && data.refColors.length > 0) {
    writeSheetRefColors(ss, data.refColors);
  }
  cleanupDefaultSheet(ss);
  ss.setActiveSheet(ss.getSheets()[0]);

  Logger.log('Готово! Таблица: ' + ss.getUrl());
  SpreadsheetApp.getUi().alert('RockUP Token Audit импортирован!\n\n' + ss.getUrl());
}

// ── Sheet helpers ────────────────────────────────────────────

function getOrCreateSheet(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  } else {
    sheet.clearContents();
    sheet.clearFormats();
  }
  return sheet;
}

function cleanupDefaultSheet(ss) {
  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('Лист1') || ss.getSheetByName('Ark1');
  if (def && ss.getSheets().length > 1) {
    ss.deleteSheet(def);
  }
}

function headerRange(sheet, numCols) {
  return sheet.getRange(1, 1, 1, numCols);
}

function applyHeaderStyle(range, bgColor) {
  bgColor = bgColor || BRAND.INK;
  range.setBackground(bgColor)
       .setFontColor(bgColor === BRAND.INK ? BRAND.PAPER : BRAND.INK)
       .setFontWeight('bold')
       .setFontSize(10);
}

function autoResizeCols(sheet, numCols) {
  for (var i = 1; i <= numCols; i++) {
    sheet.autoResizeColumn(i);
  }
}

function freezeRow(sheet) {
  sheet.setFrozenRows(1);
}

function addFilter(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return;
  // Find header row (frozen row 1, or rows 3–4 for sheets with title block)
  var headerRow = sheet.getFrozenRows() || 1;
  var range = sheet.getRange(headerRow, 1, lastRow - headerRow + 1, lastCol);
  try { range.createFilter(); } catch (e) { /* filter already exists */ }
}

function setTabColor(sheet, color) {
  sheet.setTabColor(color);
}

/** Pad every row to numCols columns — fixes setValues() mismatch */
function padRows(rows, numCols) {
  return rows.map(function(row) {
    var r = (row || []).slice();
    while (r.length < numCols) r.push('');
    return r.slice(0, numCols);
  });
}

/** Write rows safely: pads all rows to numCols before setValues */
function writeRows(sheet, rows, numCols, startRow) {
  if (!rows || rows.length === 0) return;
  startRow = startRow || 1;
  var padded = padRows(rows, numCols);
  sheet.getRange(startRow, 1, padded.length, numCols).setValues(padded);
}

// ── Sheet writers ────────────────────────────────────────────

// 1. Summary
function writeSheetSummary(ss, summary) {
  var sheet = getOrCreateSheet(ss, 'Summary');
  setTabColor(sheet, BRAND.INK);

  var rows = [];

  // Title
  rows.push([summary.title]);
  rows.push([summary.subtitle]);
  rows.push([]);
  rows.push(['Метрика', 'Значение', '', 'Топ shared токенов', 'Кол-во компонентов', 'Вхождений', 'Компоненты', '']);
  rows.push(['Сгенерировано', summary.generatedAt, '', '', '', '', '', '']);

  // Metrics + top shared side-by-side
  var metrics = summary.metrics;
  var top     = summary.topShared;
  var maxRows = Math.max(metrics.length, top.length);

  for (var i = 0; i < maxRows; i++) {
    var m = metrics[i] || { label: '', value: '' };
    var t = top[i]     || { token: '', numComponents: '', occurrences: '', components: '' };
    rows.push([m.label, m.value, '', t.token, t.numComponents, t.occurrences, t.components, '']);
  }

  writeRows(sheet, rows, 8);

  // Title styling
  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(12);
  sheet.getRange(2, 1).setFontColor(BRAND.INK).setFontSize(9).setFontStyle('italic');

  // Header row (row 4)
  applyHeaderStyle(sheet.getRange(4, 1, 1, 8));

  // Metrics bold labels
  if (metrics.length > 0) {
    sheet.getRange(6, 1, metrics.length, 1).setFontWeight('bold');
  }

  // Wrap text for components column
  sheet.getRange(6, 7, top.length, 1).setWrap(true);

  sheet.setColumnWidth(1, 280);
  sheet.setColumnWidth(4, 300);
  sheet.setColumnWidth(7, 400);
  sheet.setFrozenRows(4);
  addFilter(sheet);
}

// 2. Matrix
function writeSheetMatrix(ss, matrixData) {
  var sheet       = getOrCreateSheet(ss, 'Matrix');
  var compNames   = matrixData.componentNames;
  var rows        = matrixData.rows;
  setTabColor(sheet, BRAND.BLUE);

  var headerRow = ['Token', 'Category', '# components', '# occurrences', 'Light alias', 'Dark alias'].concat(compNames);
  var dataRows  = rows.map(function(r) {
    var base = [r.token, r.category, r.numComponents, r.numOccurrences, r.lightAlias, r.darkAlias];
    var dots = compNames.map(function(c) { return r[c] || ''; });
    return base.concat(dots);
  });

  var allData = [headerRow].concat(dataRows);
  if (allData.length > 0) {
    sheet.getRange(1, 1, allData.length, headerRow.length).setValues(allData);
  }

  // Header style
  applyHeaderStyle(sheet.getRange(1, 1, 1, headerRow.length));

  // Component header cells: coloured (start at col 7 now)
  if (compNames.length > 0) {
    var compHeaderRange = sheet.getRange(1, 7, 1, compNames.length);
    compHeaderRange.setBackground(BRAND.BLUE).setFontColor(BRAND.PAPER);
  }

  // Dot cells: center-align (start at col 7)
  if (compNames.length > 0 && dataRows.length > 0) {
    sheet.getRange(2, 7, dataRows.length, compNames.length)
         .setHorizontalAlignment('center')
         .setFontColor(BRAND.BRAND);
  }

  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
  sheet.setColumnWidth(1, 280);
  sheet.setColumnWidth(5, 200);
  sheet.setColumnWidth(6, 200);
  addFilter(sheet);
}

// 3. Token Overlaps
function writeSheetOverlaps(ss, overlaps) {
  var sheet = getOrCreateSheet(ss, 'Token overlaps');
  setTabColor(sheet, BRAND.BRAND);

  var header = ['Token', 'Category', '# components', '# occurrences', 'Components', 'Light alias', 'Dark alias'];
  var data   = overlaps.map(function(r) {
    return [r.token, r.category, r.numComponents, r.numOccurrences, r.components, r.lightAlias, r.darkAlias];
  });

  var rows = [['Токены, разделённые двумя и более компонентами'], [], header].concat(data);
  writeRows(sheet, rows, header.length);

  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(11);
  applyHeaderStyle(sheet.getRange(3, 1, 1, header.length));

  if (data.length > 0) {
    sheet.getRange(4, 5, data.length, 1).setWrap(true);
  }

  sheet.setFrozenRows(3);
  sheet.setColumnWidth(1, 280);
  sheet.setColumnWidth(5, 380);
  sheet.setColumnWidth(6, 200);
  sheet.setColumnWidth(7, 200);
  addFilter(sheet);
}

// 4. Component Details
function writeSheetDetails(ss, details) {
  var sheet = getOrCreateSheet(ss, 'Component details');
  setTabColor(sheet, BRAND.GREEN);

  var header = ['Component', 'Section', 'Component token', 'Property / role', 'Used token',
                'Audit token', 'Token class', 'Light alias', 'Dark alias', 'Note'];
  var data = details.map(function(r) {
    return [r.component, r.section, r.componentToken, r.property, r.usedToken,
            r.auditToken, r.tokenClass, r.lightAlias, r.darkAlias, r.note || ''];
  });

  var titleRow = ['Определения токенов компонентов — Figma Plugin API'];
  var rows = [titleRow, [], header].concat(data);
  writeRows(sheet, rows, header.length);

  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(11);
  applyHeaderStyle(sheet.getRange(3, 1, 1, header.length));

  if (data.length > 0) {
    // Alternating row colour by component
    var components = [];
    data.forEach(function(r, i) {
      var c = r[0];
      if (components.indexOf(c) === -1) components.push(c);
    });

    data.forEach(function(r, i) {
      var idx = components.indexOf(r[0]);
      if (idx % 2 === 1) {
        sheet.getRange(i + 4, 1, 1, header.length).setBackground('#f5f3ed');
      }
    });
  }

  sheet.setFrozenRows(3);
  sheet.setFrozenColumns(1);
  sheet.setColumnWidth(1,  120);
  sheet.setColumnWidth(3,  280);
  sheet.setColumnWidth(5,  260);
  sheet.setColumnWidth(8,  220);
  sheet.setColumnWidth(9,  220);
  addFilter(sheet);
}

// 5. Light Dark
function writeSheetLightDark(ss, rows) {
  var sheet = getOrCreateSheet(ss, 'Light Dark');
  setTabColor(sheet, '#8b6fc0');

  var header = ['Audit token', 'Category', 'Light alias', 'Dark alias',
                'Components count', 'Occurrences', 'Components'];
  var data = rows.map(function(r) {
    return [r.auditToken, r.category, r.lightAlias, r.darkAlias,
            r.componentsCount, r.occurrences, r.components];
  });

  var titleRow = ['Маппинг Light/Dark alias для используемых токенов'];
  var allRows = [titleRow, [], header].concat(data);
  writeRows(sheet, allRows, header.length);

  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(11);
  applyHeaderStyle(sheet.getRange(3, 1, 1, header.length), '#8b6fc0');

  if (data.length > 0) {
    sheet.getRange(4, 7, data.length, 1).setWrap(true);
  }

  sheet.setFrozenRows(3);
  sheet.setColumnWidth(1, 280);
  sheet.setColumnWidth(3, 220);
  sheet.setColumnWidth(4, 220);
  sheet.setColumnWidth(7, 350);
  addFilter(sheet);
}

// 6. WCAG 2.1 AA
function writeSheetWcag(ss, rows) {
  var sheet = getOrCreateSheet(ss, 'WCAG 2.1 AA');
  setTabColor(sheet, BRAND.GREEN);

  var disclaimer1 = '⚠ Hex-значения из Figma ref-токенов (NEW Ref / Color). Верифицируй в Figma.';
  var disclaimer2 = 'Критерии: нормальный текст ≥4.5:1 (AA) / ≥7:1 (AAA); крупный текст и UI-элементы ≥3:1 (AA).';
  var header = ['Контекст', 'Компонент', 'FG токен', 'BG токен',
                'Light FG hex', 'Light BG hex', 'Light ratio', 'Light AA (4.5)', 'Light AA (3.0)',
                'Dark FG hex',  'Dark BG hex',  'Dark ratio',  'Dark AA (4.5)',  'Dark AA (3.0)', 'Роль / Заметка'];

  var data = rows.map(function(r) {
    return [r.context, r.component, r.fgToken, r.bgToken,
            r.lightFgHex, r.lightBgHex, r.lightRatio, r.lightAA45, r.lightAA30,
            r.darkFgHex,  r.darkBgHex,  r.darkRatio,  r.darkAA45,  r.darkAA30,  r.note || ''];
  });

  var allRows = [[disclaimer1], [disclaimer2], [], header].concat(data);
  writeRows(sheet, allRows, header.length);

  sheet.getRange(1, 1).setFontColor('#c05010').setFontWeight('bold');
  sheet.getRange(2, 1).setFontStyle('italic').setFontSize(9);
  applyHeaderStyle(sheet.getRange(4, 1, 1, header.length), BRAND.GREEN);

  if (data.length > 0) {
    var dataStart = 5;
    // Colour Pass/Fail cells
    var passCols = [8, 9, 13, 14]; // Light AA 4.5, 3.0, Dark AA 4.5, 3.0
    passCols.forEach(function(col) {
      var range = sheet.getRange(dataStart, col, data.length, 1);
      var bgColors = data.map(function(r) {
        var val = r[col - 1];
        return [val === '✓ Pass' ? BRAND.PASS_BG : val === '✗ Fail' ? BRAND.FAIL_BG : ''];
      });
      range.setBackgrounds(bgColors);
    });
  }

  sheet.setFrozenRows(4);
  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(3, 180);
  sheet.setColumnWidth(4, 180);
  addFilter(sheet);
}

// 7. Ref Colors — palette with live swatches
function writeSheetRefColors(ss, refColors) {
  var sheet = getOrCreateSheet(ss, 'Ref Colors');
  setTabColor(sheet, BRAND.BRAND);

  // Build numbered data: counter resets (to 10) for each group, steps by 10
  var header = ['#', 'Token', 'Group', 'Subgroup', 'Hex', 'Swatch'];
  var lastGroup = null;
  var counter = 0;
  var data = refColors.map(function(r) {
    var g = r.group || '';
    if (g !== lastGroup) { counter = 10; lastGroup = g; }
    else { counter += 10; }
    return [counter, r.name, g, r.subgroup || '', r.hex, ''];
  });

  var allRows = [header].concat(data);
  writeRows(sheet, allRows, header.length);

  // Header style
  applyHeaderStyle(sheet.getRange(1, 1, 1, header.length));

  // Paint swatch cells and style hex
  if (data.length > 0) {
    var swatchBgs   = [];
    var swatchFonts = [];

    data.forEach(function(r, i) {
      var hex = r[4]; // col index 4 = Hex (0-based)
      var isValid = hex && hex.charAt(0) === '#' && hex.length === 7;
      swatchBgs.push([isValid ? hex : '']);

      // font colour on swatch: white on dark, black on light
      var fontColor = '#ffffff';
      if (isValid) {
        var rr = parseInt(hex.slice(1, 3), 16);
        var gg = parseInt(hex.slice(3, 5), 16);
        var bb = parseInt(hex.slice(5, 7), 16);
        var lum = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
        fontColor = lum > 140 ? '#141413' : '#faf9f5';
      }
      swatchFonts.push([fontColor]);
    });

    // Swatch = col 6 (1-based)
    var swatchRange = sheet.getRange(2, 6, data.length, 1);
    swatchRange.setBackgrounds(swatchBgs);
    swatchRange.setFontColors(swatchFonts);
    swatchRange.setHorizontalAlignment('center');
    swatchRange.setFontWeight('bold');
    swatchRange.setFontSize(9);

    // Hex = col 5 (1-based) — monospace
    var hexRange = sheet.getRange(2, 5, data.length, 1);
    hexRange.setFontFamily('Courier New').setFontSize(10);

    // # column = col 1 — right-align, muted color
    sheet.getRange(2, 1, data.length, 1)
         .setHorizontalAlignment('right')
         .setFontColor(BRAND.MUTED)
         .setFontSize(10);
  }

  // Bold first row of each group in Token column (col 2)
  var seenGroup = null;
  data.forEach(function(r, i) {
    if (r[2] !== seenGroup) {
      sheet.getRange(i + 2, 2).setFontWeight('bold');
      seenGroup = r[2];
    }
  });

  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);
  sheet.setColumnWidth(1,  50);
  sheet.setColumnWidth(2, 340);
  sheet.setColumnWidth(3, 100);
  sheet.setColumnWidth(4, 120);
  sheet.setColumnWidth(5, 100);
  sheet.setColumnWidth(6,  60);
  sheet.setRowHeight(1, 22);

  // Make swatch rows a bit taller for visibility
  if (data.length > 0) {
    for (var ri = 2; ri <= data.length + 1; ri++) {
      sheet.setRowHeight(ri, 20);
    }
  }

  addFilter(sheet);
}

// 8. Alias Duplicates
function writeSheetAliasdup(ss, rows) {
  var sheet = getOrCreateSheet(ss, 'Alias duplicates');
  setTabColor(sheet, BRAND.BRAND);

  var header = ['Group type', 'Light alias', 'Dark alias', 'Token count', 'Tokens', 'Components', 'Risk / Комментарий'];
  var data = rows.map(function(r) {
    return [r.groupType, r.lightAlias, r.darkAlias, r.tokenCount, r.tokens, r.components, r.risk];
  });

  var titleRow = ['Одинаковые ref-alias (same Light alias, different/same Dark alias)'];
  var allRows  = [titleRow, [], header].concat(data);
  writeRows(sheet, allRows, header.length);

  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(11);
  applyHeaderStyle(sheet.getRange(3, 1, 1, header.length));

  if (data.length > 0) {
    data.forEach(function(r, i) {
      var bg = r[0] === 'same Light, different Dark' ? '#fff3e0' : '#fce8ff';
      sheet.getRange(i + 4, 1, 1, header.length).setBackground(bg);
    });

    sheet.getRange(4, 5, data.length, 1).setWrap(true);
    sheet.getRange(4, 6, data.length, 1).setWrap(true);
  }

  sheet.setFrozenRows(3);
  sheet.setColumnWidth(2, 220);
  sheet.setColumnWidth(3, 220);
  sheet.setColumnWidth(5, 250);
  sheet.setColumnWidth(6, 300);
  sheet.setColumnWidth(7, 320);
  addFilter(sheet);
}

// Alias sheet writer is named differently above — fix:
function writeSheetAliasDuplicates(ss, rows) {
  writeSheetAliasdup(ss, rows);
}

// ── Response helpers ─────────────────────────────────────────
function jsonOk(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonError(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ success: false, error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}
