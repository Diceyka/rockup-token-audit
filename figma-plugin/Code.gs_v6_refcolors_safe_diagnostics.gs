// ============================================================
// RockUP Token Audit — Google Apps Script Backend
// Code.gs v6-refcolors-safe-diagnostics — исправления: change tracking, Dashboard без #ERROR,
// Ref Colors sample/subgroup, дата dd.MM.yyyy, поддержка previousToken из плагина,
// сохранение Ref Colors при пустом payload
// ============================================================

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({
      status: 'ok',
      service: 'RockUP Token Audit',
      timestamp: new Date().toISOString(),
      codeVersion: 'v6-refcolors-safe-diagnostics'
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var payload       = JSON.parse(e.postData.contents || '{}');
    var data          = payload.data || {};
    var spreadsheetId = payload.spreadsheetId;

    var ss;
    if (spreadsheetId) {
      try {
        ss = SpreadsheetApp.openById(spreadsheetId);
      } catch (_) {
        ss = SpreadsheetApp.create('RockUP Token Audit');
        spreadsheetId = ss.getId();
      }
    } else {
      ss = SpreadsheetApp.create('RockUP Token Audit');
      spreadsheetId = ss.getId();
    }

    var errors = [];
    var written = {};
    var runChanges = [];

    function safe(name, fn) {
      try {
        written[name] = fn() || 0;
      } catch (err) {
        errors.push(name + ': ' + err.message);
      }
    }

    safe('Matrix', function() {
      writeMatrix(ss, data.matrix || {});
      return data.matrix && data.matrix.rows ? data.matrix.rows.length : 0;
    });

    safe('Light Dark', function() {
      writeLightDark(ss, data.lightDark || [], runChanges);
      return data.lightDark ? data.lightDark.length : 0;
    });

    safe('Component details', function() {
      writeComponentDetails(ss, data.componentDetails || [], runChanges);
      return data.componentDetails ? data.componentDetails.length : 0;
    });

    safe('WCAG', function() {
      writeWCAG(ss, data.wcag || []);
      return data.wcag ? data.wcag.length : 0;
    });

    safe('Token overlaps', function() {
      writeTokenOverlaps(ss, data.tokenOverlaps || []);
      return data.tokenOverlaps ? data.tokenOverlaps.length : 0;
    });

    // Ref Colors не трогается аудитом — обновляется вручную из xlsx
    // safe('Ref Colors', function() {
    //   return writeRefColors(ss, data.refColors);
    // });

    safe('Action items', function() { updateActionItems(ss, data); });
    safe('Methodology', function() { deleteMethodologySheet(ss); });
    safe('Журнал изменений', function() { writeChangeLog(ss, runChanges); });
    safe('Dashboard', function() { writeDashboard(ss, data.summary || {}); });
    safe('Reorder', function() { reorderSheets(ss); });

    SpreadsheetApp.flush();

    var url = 'https://docs.google.com/spreadsheets/d/' + spreadsheetId + '/edit';
    return ContentService
      .createTextOutput(JSON.stringify({
        ok: errors.length === 0,
        url: url,
        spreadsheetId: spreadsheetId,
        codeVersion: 'v6-refcolors-safe-diagnostics',
        errors: errors,
        written: written,
        changes: runChanges.length
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message, codeVersion: 'v6-refcolors-safe-diagnostics' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

function getOrCreate(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function clearSheet(ws) {
  ws.clearContents();
  ws.clearFormats();
  ws.clearConditionalFormatRules();
  // Важно: clearFormats() не всегда убирает выпадающие списки/валидации.
  // На Ref Colors из-за этого могут оставаться стрелки в колонках B/D.
  try { ws.getDataRange().clearDataValidations(); } catch (_) {}
  // После clearFormats() тема таблицы может задавать белый шрифт по умолчанию.
  // Явно сбрасываем цвет текста в рабочей зоне до тёмного.
  ws.getRange(1, 1, 500, 30).setFontColor('#212121');
}

function styleHeader(ws, row, numCols) {
  ws.getRange(row, 1, 1, numCols)
    .setBackground('#1a1a2e')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(10);
}

function batchWrite(ws, startRow, rows) {
  if (!rows || rows.length === 0) return;
  var rng = ws.getRange(startRow, 1, rows.length, rows[0].length);
  rng.setValues(rows);
  rng.setFontColor('#212121');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeToken(value) {
  var s = text(value);
  if (!s || s === '—' || s === '-') return '';
  return s;
}

function sameToken(a, b) {
  return normalizeToken(a) === normalizeToken(b);
}

function pad2(n) {
  return ('0' + n).slice(-2);
}

function formatAuditDate(value) {
  var d;
  if (value instanceof Date) {
    d = value;
  } else if (typeof value === 'string') {
    var s = value.trim();
    var m = s.match(/^(\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{2,4})$/);
    if (m) {
      var year = Number(m[3]);
      if (year < 100) year += 2000;
      d = new Date(year, Number(m[2]) - 1, Number(m[1]));
    } else {
      d = new Date(s);
    }
  } else if (value) {
    d = new Date(value);
  } else {
    d = new Date();
  }
  if (!d || isNaN(d.getTime())) d = new Date();
  return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear();
}

function pushChange(runChanges, source, objectName, changeType, oldValue, newValue, dateValue) {
  if (!runChanges) return;
  runChanges.push({
    date: formatAuditDate(dateValue || new Date()),
    source: source || '—',
    object: objectName || '—',
    type: changeType || 'Изменение',
    oldValue: oldValue || '—',
    newValue: newValue || '—'
  });
}

var SHEET_ORDER = [
  'Журнал изменений', 'Dashboard', 'Matrix', 'Light Dark', 'Component details',
  'WCAG', 'Token overlaps', 'Ref Colors', 'Action items'
];

function reorderSheets(ss) {
  var default1 = ss.getSheetByName('Sheet1');
  if (default1 && default1.getLastRow() === 0) ss.deleteSheet(default1);
  SHEET_ORDER.forEach(function(name, idx) {
    var ws = ss.getSheetByName(name);
    if (!ws) return;
    ss.setActiveSheet(ws);
    ss.moveActiveSheet(idx + 1);
  });
}

// ══════════════════════════════════════════════════════════════
// MATRIX
// ══════════════════════════════════════════════════════════════

function writeMatrix(ss, matrix) {
  var ws = getOrCreate(ss, 'Matrix');
  clearSheet(ws);

  var compNames = asArray(matrix.componentNames);
  var sourceRows = asArray(matrix.rows);
  var headers = ['Токен','Категория','Компонентов','Вхождений','Light alias','Dark alias'].concat(compNames);

  var rows = sourceRows.map(function(r) {
    var row = [r.token, r.category, r.numComponents, r.numOccurrences,
               r.lightAlias || '—', r.darkAlias || '—'];
    compNames.forEach(function(cn) { row.push(r[cn] || ''); });
    return row;
  });

  ws.getRange(1, 1, 1, headers.length).setValues([headers]);
  styleHeader(ws, 1, headers.length);
  if (rows.length) batchWrite(ws, 2, rows);

  ws.setFrozenRows(1);
  ws.setColumnWidth(1, 320);
  ws.setColumnWidth(5, 220);
  ws.setColumnWidth(6, 220);
  if (rows.length && compNames.length) {
    ws.getRange(2, 7, rows.length, compNames.length).setHorizontalAlignment('center');
  }
}

// ══════════════════════════════════════════════════════════════
// LIGHT DARK — сохраняет дату последнего реального изменения
// ══════════════════════════════════════════════════════════════

function lightDarkKeyFromRow(row) {
  return normalizeToken(row[0]);
}

function readLightDarkSnapshot(ws) {
  var map = {};
  if (!ws || ws.getLastRow() < 4) return map;
  var values = ws.getRange(4, 1, ws.getLastRow() - 3, 8).getValues();
  values.forEach(function(row) {
    var key = lightDarkKeyFromRow(row);
    if (!key) return;
    map[key] = {
      token: row[0],
      category: row[1],
      lightAlias: row[2],
      darkAlias: row[3],
      updatedAt: row[5]
    };
  });
  return map;
}

function writeLightDark(ss, lightDark, runChanges) {
  var ws = getOrCreate(ss, 'Light Dark');
  var prevMap = readLightDarkSnapshot(ws);
  clearSheet(ws);

  ws.getRange('A1').setValue('Маппинг Light/Dark alias для используемых токенов')
    .setFontSize(12).setFontWeight('bold');

  var headers = ['Токен','Категория','Light alias','Dark alias',
                 'Кол-во компонентов','Последнее обновление','Вхождения','Компоненты'];
  ws.getRange(3, 1, 1, headers.length).setValues([headers]);
  styleHeader(ws, 3, headers.length);

  var meta = [];
  var rows = asArray(lightDark).map(function(r) {
    var token = r.auditToken || r.token || '';
    var key = normalizeToken(token);
    var prev = key ? prevMap[key] : null;

    var lightAlias = r.lightAlias || '—';
    var darkAlias  = r.darkAlias  || '—';

    var existed = !!prev;
    var changed = false;
    var changeType = '';

    if (!existed) {
      changed = true;
      changeType = 'Новый';
    } else if (!sameToken(prev.lightAlias, lightAlias) || !sameToken(prev.darkAlias, darkAlias) || r.isChanged) {
      changed = true;
      changeType = 'Изменён';
    }

    if (r.isNew) {
      changed = true;
      changeType = 'Новый';
    }

    var date = changed
      ? formatAuditDate(r.changedAt || r.updatedAt || new Date())
      : formatAuditDate(prev && prev.updatedAt ? prev.updatedAt : (r.changedAt || r.updatedAt || new Date()));

    if (changed) {
      pushChange(
        runChanges,
        'Light Dark',
        token,
        changeType,
        existed ? ('Light: ' + (prev.lightAlias || '—') + ' / Dark: ' + (prev.darkAlias || '—')) : '—',
        'Light: ' + lightAlias + ' / Dark: ' + darkAlias,
        date
      );
    }

    meta.push({ changed: changed, type: changeType });

    return [
      token,
      r.category || '',
      lightAlias,
      darkAlias,
      r.componentsCount || 0,
      date,
      r.occurrences || 0,
      r.components || ''
    ];
  });

  if (rows.length) batchWrite(ws, 4, rows);

  if (rows.length) {
    var bgRows = rows.map(function(_, i) {
      if (meta[i].type === 'Новый')   return ['#e8f5e9','#e8f5e9','#e8f5e9','#e8f5e9','#e8f5e9','#e8f5e9','#e8f5e9','#e8f5e9'];
      if (meta[i].type === 'Изменён') return ['#fff9c4','#fff9c4','#fff9c4','#fff9c4','#fff9c4','#fff9c4','#fff9c4','#fff9c4'];
      return [null,null,null,null,null,null,null,null];
    });
    ws.getRange(4, 1, rows.length, 8).setBackgrounds(bgRows);
  }

  ws.setFrozenRows(3);
  ws.setColumnWidth(1, 320);
  ws.setColumnWidth(3, 220);
  ws.setColumnWidth(4, 220);
  ws.setColumnWidth(6, 120);
  ws.setColumnWidth(8, 350);
}

// ══════════════════════════════════════════════════════════════
// COMPONENT DETAILS — сравнение текущего Audit-токена с предыдущим
// ══════════════════════════════════════════════════════════════

function componentDetailsFullKey(component, section, componentToken, property) {
  return [component, section, componentToken, property].map(function(v) { return text(v); }).join('|');
}

function componentDetailsStableKey(component, section, property) {
  return [component, section, property].map(function(v) { return text(v); }).join('|');
}

function readComponentDetailsSnapshot(ws) {
  var maps = { full: {}, stable: {} };
  if (!ws || ws.getLastRow() < 4) return maps;
  var values = ws.getRange(4, 1, ws.getLastRow() - 3, 9).getValues();
  values.forEach(function(row) {
    var item = {
      usedToken: row[4],
      auditToken: row[5],
      lightAlias: row[6],
      darkAlias: row[7],
      note: row[8]
    };
    var fullKey = componentDetailsFullKey(row[0], row[1], row[2], row[3]);
    var stableKey = componentDetailsStableKey(row[0], row[1], row[3]);
    if (fullKey !== '|||') maps.full[fullKey] = item;
    if (stableKey !== '||') maps.stable[stableKey] = item;
  });
  return maps;
}

function writeComponentDetails(ss, componentDetails, runChanges) {
  var ws = getOrCreate(ss, 'Component details');
  var prevMap = readComponentDetailsSnapshot(ws);
  clearSheet(ws);

  ws.getRange('A1').setValue('Определения токенов компонентов — Figma Plugin API')
    .setFontSize(12).setFontWeight('bold');

  var headers = ['Компонент','Секция','Токен компонента','Свойство / роль',
                 'Предыдущий Audit-токен','Audit-токен','Light alias','Dark alias','Заметка'];
  ws.getRange(3, 1, 1, headers.length).setValues([headers]);
  styleHeader(ws, 3, headers.length);

  var meta = [];
  var rows = asArray(componentDetails).map(function(r) {
    var fullKey = componentDetailsFullKey(r.component, r.section, r.componentToken, r.property);
    var stableKey = componentDetailsStableKey(r.component, r.section, r.property);
    var prev = prevMap.full[fullKey] || prevMap.stable[stableKey];

    var currentAudit = r.auditToken || r.token || '';
    // В колонке «Предыдущий Audit-токен» держим значение из прошлого запуска,
    // чтобы новая выгрузка подсвечивала именно последнее изменение.
    var previousToken = prev && normalizeToken(prev.auditToken)
      ? prev.auditToken
      : (r.previousToken || r.usedToken || '');

    var changed = normalizeToken(previousToken) && normalizeToken(currentAudit) && !sameToken(previousToken, currentAudit);
    var note = r.note || '';

    if (changed) {
      var date = formatAuditDate(new Date());
      note = note ? (note + ' · изменено ' + date) : ('Изменено ' + date);
      pushChange(
        runChanges,
        'Component details',
        [r.component, r.section, r.property].filter(function(v) { return text(v); }).join(' / '),
        'Audit-токен изменён',
        previousToken,
        currentAudit,
        date
      );
    }

    meta.push({ changed: changed });

    return [
      r.component || '',
      r.section || '',
      r.componentToken || '',
      r.property || '',
      previousToken || '',
      currentAudit || '',
      r.lightAlias || '—',
      r.darkAlias || '—',
      note
    ];
  });

  if (rows.length) batchWrite(ws, 4, rows);

  if (rows.length) {
    var usedBgs = [];
    var auditBgs = [];
    meta.forEach(function(m) {
      usedBgs.push([m.changed ? '#fff3e0' : null]);
      auditBgs.push([m.changed ? '#ffe0b2' : null]);
    });
    ws.getRange(4, 5, rows.length, 1).setBackgrounds(usedBgs);
    ws.getRange(4, 6, rows.length, 1).setBackgrounds(auditBgs);
  }

  ws.setFrozenRows(3);
  ws.setColumnWidth(1, 180);
  ws.setColumnWidth(2, 180);
  ws.setColumnWidth(3, 280);
  ws.setColumnWidth(4, 220);
  ws.setColumnWidth(5, 280);
  ws.setColumnWidth(6, 280);
  ws.setColumnWidth(9, 260);
}

// ══════════════════════════════════════════════════════════════
// WCAG
// ══════════════════════════════════════════════════════════════

function writeWCAG(ss, wcag) {
  var ws = getOrCreate(ss, 'WCAG');
  clearSheet(ws);

  ws.getRange('A1').setValue('WCAG — контрастность токенов (Light + Dark)')
    .setFontSize(12).setFontWeight('bold');
  ws.getRange('A2').setValue('✓ Pass = соответствует порогу | ✗ Fail = не соответствует')
    .setFontColor('#757593');

  var headers = [
    'Контекст','Компонент','FG токен','BG токен',
    'Light FG hex','Light BG hex','Light Ratio','AA 4.5 Light','AA 3.0 Light',
    'Dark FG hex','Dark BG hex','Dark Ratio','AA 4.5 Dark','AA 3.0 Dark',
    'Роль / Заметка'
  ];
  ws.getRange(3, 1, 1, headers.length).setValues([headers]);
  styleHeader(ws, 3, headers.length);

  var rows = asArray(wcag).map(function(r) {
    return [
      r.context, r.component, r.fgToken, r.bgToken,
      r.lightFgHex, r.lightBgHex, r.lightRatio, r.lightAA45, r.lightAA30,
      r.darkFgHex,  r.darkBgHex,  r.darkRatio,  r.darkAA45,  r.darkAA30,
      r.note || ''
    ];
  });
  if (rows.length) batchWrite(ws, 4, rows);

  if (rows.length) {
    var passBg = '#ebfaf0'; var passFg = '#29994e';
    var failBg = '#fff5f6'; var failFg = '#ed0c1f';
    var checkCols = [[8, 'lightAA45'], [9, 'lightAA30'], [13, 'darkAA45'], [14, 'darkAA30']];

    checkCols.forEach(function(cp) {
      var col = cp[0]; var key = cp[1];
      var bgs = asArray(wcag).map(function(r) {
        var v = r[key];
        if (!v || v === '—') return [null];
        return [String(v).indexOf('Pass') !== -1 ? passBg : String(v).indexOf('Fail') !== -1 ? failBg : null];
      });
      var fgs = asArray(wcag).map(function(r) {
        var v = r[key];
        if (!v || v === '—') return [null];
        return [String(v).indexOf('Pass') !== -1 ? passFg : String(v).indexOf('Fail') !== -1 ? failFg : null];
      });
      ws.getRange(4, col, rows.length, 1).setBackgrounds(bgs);
      ws.getRange(4, col, rows.length, 1).setFontColors(fgs);
    });
  }

  ws.setFrozenRows(3);
  ws.setColumnWidth(1, 220);
}

// ══════════════════════════════════════════════════════════════
// TOKEN OVERLAPS
// ══════════════════════════════════════════════════════════════

function writeTokenOverlaps(ss, tokenOverlaps) {
  var ws = getOrCreate(ss, 'Token overlaps');
  clearSheet(ws);

  ws.getRange('A1').setValue('Токены, разделённые двумя и более компонентами')
    .setFontSize(12).setFontWeight('bold');

  var headers = ['Токен','Категория','Компонентов','Вхождений',
                 'Компоненты','Light alias','Dark alias'];
  ws.getRange(3, 1, 1, headers.length).setValues([headers]);
  styleHeader(ws, 3, headers.length);

  var rows = asArray(tokenOverlaps).map(function(r) {
    return [r.token, r.category, r.numComponents, r.numOccurrences,
            r.components, r.lightAlias || '—', r.darkAlias || '—'];
  });
  if (rows.length) batchWrite(ws, 4, rows);

  ws.setFrozenRows(3);
  ws.setColumnWidth(1, 320);
  ws.setColumnWidth(5, 400);
}

// ══════════════════════════════════════════════════════════════
// REF COLORS — robust hex/subgroup resolver
// ══════════════════════════════════════════════════════════════

function rgbToHexPart(n) {
  var v = Number(n);
  if (isNaN(v)) return '00';
  if (v >= 0 && v <= 1) v = Math.round(v * 255);
  v = Math.max(0, Math.min(255, Math.round(v)));
  return ('0' + v.toString(16)).slice(-2).toUpperCase();
}

function normalizeHex(value) {
  if (value === null || value === undefined) return '';

  if (typeof value === 'object') {
    if (value.r !== undefined && value.g !== undefined && value.b !== undefined) {
      return '#' + rgbToHexPart(value.r) + rgbToHexPart(value.g) + rgbToHexPart(value.b);
    }
    if (value.red !== undefined && value.green !== undefined && value.blue !== undefined) {
      return '#' + rgbToHexPart(value.red) + rgbToHexPart(value.green) + rgbToHexPart(value.blue);
    }
    if (value.hex !== undefined) return normalizeHex(value.hex);
  }

  var s = String(value).trim().replace(/"/g, '');
  if (!s) return '';

  var rgba = s.match(/^rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/i);
  if (rgba) return '#' + rgbToHexPart(rgba[1]) + rgbToHexPart(rgba[2]) + rgbToHexPart(rgba[3]);

  s = s.replace(/^0x/i, '').replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) return '#' + s.toUpperCase();
  if (/^[0-9a-fA-F]{8}$/.test(s)) return '#' + s.slice(0, 6).toUpperCase();
  return '';
}

function normalizeHexText(value) {
  if (value === null || value === undefined) return '';
  var s = String(value).trim().replace(/"/g, '');
  if (!s) return '';
  s = s.replace(/^0x/i, '').replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) return '#' + s.toUpperCase();
  if (/^[0-9a-fA-F]{8}$/.test(s)) return '#' + s.toUpperCase();
  return normalizeHex(value);
}

function firstNonEmpty(values) {
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (v !== null && v !== undefined && String(v).trim() !== '') return v;
  }
  return '';
}

function inferRefColorParts(name) {
  var parts = String(name || '').split('/').map(function(p) { return p.trim(); }).filter(function(p) { return p; });
  var filtered = parts.filter(function(p) {
    var low = p.toLowerCase();
    return low !== 'rp' && low !== 'ref' && low !== 'color' && low !== 'colors';
  });
  return {
    group: filtered.length > 0 ? filtered[0] : '',
    subgroup: filtered.length > 1 ? filtered[1] : ''
  };
}

function writeRefColors(ss, refColors) {
  var ws = getOrCreate(ss, 'Ref Colors');
  var incoming = asArray(refColors);

  // Важно: если плагин не передал refColors или передал пустой массив,
  // не очищаем лист. Так мы не теряем рабочий список цветов из прошлого аудита
  // из-за временной ошибки резолва алиасов / payload.
  if (incoming.length === 0) {
    Logger.log('Ref Colors: входных данных нет — существующий лист сохранён без изменений');

    // Если лист уже пустой, оставляем видимый диагностический маркер.
    // Если на листе есть рабочие данные — ничего не трогаем.
    if (ws.getLastRow() === 0) {
      ws.getRange(1, 1, 1, 5).setValues([['Токен','Группа','Подгруппа','Hex','Образец']]);
      ws.getRange(1, 1, 1, 5)
        .setBackground('#141413').setFontColor('#ffffff')
        .setFontWeight('bold').setFontSize(10);
      ws.getRange('A2').setValue('⚠ refColors не пришёл из Figma plugin. Проверь статус в UI: строка должна быть “refColors=N”, где N > 0.');
      ws.getRange('A2').setFontColor('#d66700');
    }
    return Math.max(ws.getLastRow() - 1, 0);
  }

  clearSheet(ws);

  ws.getRange(1, 1, 1, 5).setValues([['Токен','Группа','Подгруппа','Hex','Образец']]);
  ws.getRange(1, 1, 1, 5)
    .setBackground('#141413').setFontColor('#ffffff')
    .setFontWeight('bold').setFontSize(10);
  ws.setRowHeight(1, 22);

  var normalized = asArray(refColors).map(function(r) {
    var name = firstNonEmpty([r.name, r.token, r.variableName, r.path, r.key]);
    var inferred = inferRefColorParts(name);
    var group = firstNonEmpty([r.group, inferred.group]);
    var subgroup = firstNonEmpty([r.subgroup, r.subGroup, r.category, inferred.subgroup]);
    var rawHex = firstNonEmpty([r.hex, r.resolvedHex, r.value, r.color, r.lightHex, r.defaultHex, r.$value]);
    var rawSampleHex = firstNonEmpty([r.sampleHex, r.previewHex, r.swatchHex, r.sample, rawHex]);
    var hex = normalizeHexText(rawHex);
    var sampleHex = normalizeHex(rawSampleHex) || normalizeHex(rawHex);
    return {
      name: name,
      group: group,
      subgroup: subgroup,
      hex: hex || String(rawHex || '').trim(),
      sampleHex: sampleHex
    };
  }).filter(function(r) {
    return r.name || r.hex;
  });

  var sorted = normalized.slice().sort(function(a, b) {
    var ga = (a.group || '').toLowerCase();
    var gb = (b.group || '').toLowerCase();
    if (ga !== gb) return ga < gb ? -1 : 1;
    var sa = (a.subgroup || '').toLowerCase();
    var sb = (b.subgroup || '').toLowerCase();
    if (sa !== sb) return sa < sb ? -1 : 1;
    var na = (a.name || '').toLowerCase();
    var nb = (b.name || '').toLowerCase();
    return na < nb ? -1 : na > nb ? 1 : 0;
  });

  var HEX_RE = /^#[0-9A-Fa-f]{6}$/;
  var allRows = [];
  var lastGroup = null;

  sorted.forEach(function(r) {
    var grp = r.group || '';
    if (lastGroup !== null && grp !== lastGroup) allRows.push(['', '', '', '', '']);
    lastGroup = grp;
    allRows.push([r.name || '', grp, r.subgroup || '', r.hex || '', '', r.sampleHex || '']);
  });

  if (allRows.length === 0) {
    ws.getRange('A2').setValue('⚠ refColors пришёл пустым после нормализации').setFontColor('#d66700');
    return;
  }

  var CHUNK = 500;
  for (var start = 0; start < allRows.length; start += CHUNK) {
    var chunk = allRows.slice(start, Math.min(start + CHUNK, allRows.length));
    var visibleChunk = chunk.map(function(row) { return row.slice(0, 5); });
    ws.getRange(2 + start, 1, visibleChunk.length, 5)
      .setValues(visibleChunk)
      .setFontColor('#212121');
  }

  ws.setRowHeights(2, allRows.length, 20);

  var sampleBgs2D = allRows.map(function(row) {
    var h = row[5] || row[3]; // sampleHex, fallback на Hex
    return [HEX_RE.test(h) ? h : '#ffffff'];
  });
  ws.getRange(2, 5, allRows.length, 1).setBackgrounds(sampleBgs2D);

  ws.setColumnWidth(1, 300);
  ws.setColumnWidth(2, 110);
  ws.setColumnWidth(3, 110);
  ws.setColumnWidth(4, 90);
  ws.setColumnWidth(5, 65);

  Logger.log('Ref Colors: записано ' + sorted.length + ' токенов (' + allRows.length + ' строк)');
  return allRows.length;
}

// ══════════════════════════════════════════════════════════════
// ACTION ITEMS — smart merge
// ══════════════════════════════════════════════════════════════

var AI_HEADERS = [
  'Критичность','Тип','Компонент','Контекст','Токен(ы)','Режим',
  'Проблема','Ratio Light','Ratio Dark','Источник','Рекомендация',
  'Решение','Владелец','Статус','Заметки'
];
var AI_AUTO_COLS  = 11;
var AI_TOTAL_COLS = 15;

function updateActionItems(ss, data) {
  var ws = getOrCreate(ss, 'Action items');

  if (ws.getLastRow() < 1) {
    ws.getRange(1, 1, 1, AI_TOTAL_COLS).setValues([AI_HEADERS]);
    styleHeader(ws, 1, AI_TOTAL_COLS);
    ws.setFrozenRows(1);
  }

  var newItems = generateActionItems(data || {});

  var lastRow = ws.getLastRow();
  var existingVals = lastRow > 1
    ? ws.getRange(2, 1, lastRow - 1, AI_TOTAL_COLS).getValues()
    : [];

  var keyMap = {};
  existingVals.forEach(function(row, i) {
    var k = (row[1]||'') + '|' + (row[2]||'') + '|' + (row[3]||'') + '|' + (row[5]||'');
    if (k !== '|||') keyMap[k] = i;
  });

  var toAdd = [];

  newItems.forEach(function(item) {
    var autoRow = [
      item.criticity, item.type, item.component, item.context, item.tokens, item.mode,
      item.problem, item.ratioLight, item.ratioDark, item.source, item.recommendation
    ];
    var key = item.type + '|' + item.component + '|' + item.context + '|' + item.mode;

    if (keyMap.hasOwnProperty(key)) {
      var sheetRow = keyMap[key] + 2;
      ws.getRange(sheetRow, 1, 1, AI_AUTO_COLS)
        .setValues([autoRow])
        .setFontColor('#212121');
    } else {
      toAdd.push(autoRow.concat(['', '', 'Новая', '']));
    }
  });

  if (toAdd.length) {
    var insertAt = ws.getLastRow() + 1;
    ws.getRange(insertAt, 1, toAdd.length, AI_TOTAL_COLS)
      .setValues(toAdd)
      .setFontColor('#212121');
    ws.getRange(insertAt, 1, toAdd.length, AI_TOTAL_COLS).setBackground('#fffde7');
  }

  applyActionItemsCF(ws);
}

function generateActionItems(data) {
  var items = [];
  var seen  = {};

  function add(item) {
    var k = item.type + '|' + item.component + '|' + item.context + '|' + item.mode;
    if (seen[k]) return;
    seen[k] = true;
    items.push(item);
  }

  asArray(data.wcag).forEach(function(r) {
    [['Light', r.lightAA30, r.lightAA45, r.lightRatio, r.darkRatio],
     ['Dark',  r.darkAA30,  r.darkAA45,  r.lightRatio, r.darkRatio]
    ].forEach(function(p) {
      var mode = p[0]; var aa30 = p[1]; var aa45 = p[2];
      var ratioL = p[3]; var ratioD = p[4];
      var failAA30 = aa30 && String(aa30).indexOf('Fail') !== -1;
      var failAA45 = aa45 && String(aa45).indexOf('Fail') !== -1;
      if (!failAA30 && !failAA45) return;

      add({
        criticity:      failAA30 ? 'Critical' : 'High',
        type:           'WCAG contrast',
        component:      r.component,
        context:        r.context,
        tokens:         r.fgToken + ' on ' + r.bgToken,
        mode:           mode,
        problem:        failAA30 ? 'Не проходит AA 3.0' : 'Не проходит AA 4.5',
        ratioLight:     ratioL || '—',
        ratioDark:      ratioD || '—',
        source:         'WCAG',
        recommendation: failAA30
          ? 'Скорректировать FG/BG до ≥3.0 в обоих режимах; затем проверить ≥4.5'
          : 'Проверить: если текст обычный — скорректировать до ≥4.5'
      });
    });
  });

  asArray(data.aliasDuplicates).forEach(function(r) {
    add({
      criticity:      'Medium',
      type:           'Alias duplicate',
      component:      (r.components || '').split(', ')[0] || '—',
      context:        r.lightAlias || '—',
      tokens:         (r.tokens || '').replace(/\n/g, ', '),
      mode:           'Light/Dark',
      problem:        r.groupType || '—',
      ratioLight:     '',
      ratioDark:      '',
      source:         'Light Dark',
      recommendation: r.risk || '—'
    });
  });

  asArray(data.tokenOverlaps).forEach(function(r) {
    if ((r.numComponents || 0) < 3) return;
    add({
      criticity:      'Low',
      type:           'Shared token review',
      component:      '—',
      context:        r.token,
      tokens:         r.token,
      mode:           '—',
      problem:        'Токен в ' + r.numComponents + ' компонентах (' + r.numOccurrences + ' вхождений)',
      ratioLight:     '',
      ratioDark:      '',
      source:         'Matrix',
      recommendation: 'Валидировать семантику для всех компонентов: ' + (r.components || '')
    });
  });

  return items;
}

function applyActionItemsCF(ws) {
  ws.clearConditionalFormatRules();
  var lastRow = Math.max(ws.getLastRow(), 2);
  var rng = ws.getRange(2, 1, lastRow - 1, AI_TOTAL_COLS);

  var rules = [
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$A2="Critical"')
      .setBackground('#ffebee')
      .setRanges([rng]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$N2="На проверке"')
      .setBackground('#fff9c4')
      .setRanges([rng]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=OR($N2="Решено",$N2="Устранено",$N2="Закрыто")')
      .setBackground('#e8f5e9')
      .setFontColor('#1b5e20')
      .setRanges([rng]).build()
  ];

  ws.setConditionalFormatRules(rules);
}

function deleteMethodologySheet(ss) {
  var ws = ss.getSheetByName('Methodology');
  if (ws) ss.deleteSheet(ws);
}

// ══════════════════════════════════════════════════════════════
// DASHBOARD — без формул, чтобы не ловить #ERROR! в локали таблицы
// ══════════════════════════════════════════════════════════════

function dashMetric(summary, labelKey) {
  if (!summary || !summary.metrics) return 0;
  for (var i = 0; i < summary.metrics.length; i++) {
    if (String(summary.metrics[i].label || '').indexOf(labelKey) !== -1) return summary.metrics[i].value;
  }
  return 0;
}

function getActionItemStats(ss) {
  var stats = {
    total: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    wcag: 0,
    alias: 0,
    shared: 0,
    open: 0,
    criticalWcag: 0,
    highWcag: 0
  };

  var ws = ss.getSheetByName('Action items');
  if (!ws || ws.getLastRow() < 2) return stats;

  var values = ws.getRange(2, 1, ws.getLastRow() - 1, AI_TOTAL_COLS).getValues();
  values.forEach(function(row) {
    if (!row[0] && !row[1] && !row[2]) return;
    stats.total++;

    var crit = String(row[0] || '');
    var type = String(row[1] || '');
    var status = String(row[13] || '');

    if (crit === 'Critical') stats.critical++;
    if (crit === 'High') stats.high++;
    if (crit === 'Medium') stats.medium++;
    if (crit === 'Low') stats.low++;

    if (type === 'WCAG contrast') stats.wcag++;
    if (type === 'Alias duplicate') stats.alias++;
    if (type === 'Shared token review') stats.shared++;

    if (status === 'Новая' || status === 'На проверке') stats.open++;
    if (type === 'WCAG contrast' && crit === 'Critical') stats.criticalWcag++;
    if (type === 'WCAG contrast' && crit === 'High') stats.highWcag++;
  });

  return stats;
}

function writeChangeLog(ss, runChanges) {
  var ws = getOrCreate(ss, 'Журнал изменений');

  // Создать заголовки если лист пустой
  if (ws.getLastRow() === 0) {
    ws.getRange(1, 1, 1, 6).setValues([['Дата','Источник','Объект','Тип изменения','Было','Стало']]);
    styleHeader(ws, 1, 6);
    ws.setColumnWidth(1, 120);
    ws.setColumnWidth(2, 140);
    ws.setColumnWidth(3, 300);
    ws.setColumnWidth(4, 160);
    ws.setColumnWidth(5, 300);
    ws.setColumnWidth(6, 300);
    ws.setFrozenRows(1);
  }

  var changes = asArray(runChanges);
  if (changes.length === 0) return;

  var lastRow = ws.getLastRow();
  var logRows = changes.map(function(r) {
    return [r.date, r.source, r.object, r.type, r.oldValue, r.newValue];
  });
  ws.getRange(lastRow + 1, 1, logRows.length, 6).setValues(logRows);
  ws.getRange(lastRow + 1, 1, logRows.length, 6)
    .setBackground('#fff9c4')
    .setFontColor('#212121');
}

function writeDashboard(ss, summary) {
  var ws = getOrCreate(ss, 'Dashboard');
  ws.clearContents();
  ws.clearFormats();
  ws.getRange(1, 1, 100, 10).setFontColor('#212121');

  var dateStr = formatAuditDate(new Date());
  var stats = getActionItemStats(ss);

  ws.getRange('A1').setValue('Figma Token Audit')
    .setFontSize(16).setFontWeight('bold');
  ws.getRange('A2').setValue('Обновлено: ' + dateStr + ' · WCAG: лист WCAG')
    .setFontColor('#757593').setFontSize(10);

  ws.getRange('A4:F4').setValues([['КОМПОНЕНТОВ','','СИСТЕМНЫХ ТОКЕНОВ','','ЗАДАЧ ВСЕГО','']]);
  ws.getRange('A4:F4').setFontWeight('bold').setFontSize(9).setBackground('#f5f5fb');
  ws.getRange('A5').setValue(dashMetric(summary, 'Компонентов'))
    .setFontSize(22).setFontWeight('bold').setFontColor('#7d5ae7');
  ws.getRange('C5').setValue(dashMetric(summary, 'Уникальных'))
    .setFontSize(22).setFontWeight('bold').setFontColor('#7d5ae7');
  ws.getRange('E5').setValue(stats.total)
    .setFontSize(22).setFontWeight('bold').setFontColor('#7d5ae7');
  ws.getRange('A6:F6').setValues([['в аудите','','rp/sys/color/…','','WCAG + alias + shared','']])
    .setFontColor('#9e9e9e').setFontSize(9);

  var KRIT_BG = '#ffffff';
  var KRIT_BORDER = '#e8e8f0';

  ws.getRange('A8:B8').setValues([['КРИТИЧНОСТЬ','КОЛ-ВО']])
    .setFontWeight('bold').setFontSize(9).setBackground(KRIT_BORDER);
  ws.getRange(9, 1, 4, 2).setValues([
    ['Critical', stats.critical],
    ['High', stats.high],
    ['Medium', stats.medium],
    ['Low', stats.low]
  ]).setBackground(KRIT_BG);
  ws.getRange('A9').setFontColor('#c62828').setFontWeight('bold');
  ws.getRange('A10').setFontColor('#e65100').setFontWeight('bold');
  ws.getRange('A11').setFontColor('#f9a825').setFontWeight('bold');
  ws.getRange('A12').setFontColor('#2e7d32').setFontWeight('bold');

  ws.getRange('D8:E8').setValues([['ТИП ЗАДАЧИ','КОЛ-ВО']])
    .setFontWeight('bold').setFontSize(9).setBackground(KRIT_BORDER);
  ws.getRange(9, 4, 3, 2).setValues([
    ['WCAG contrast', stats.wcag],
    ['Alias duplicate', stats.alias],
    ['Shared token review', stats.shared]
  ]).setBackground(KRIT_BG);

  ws.getRange('G8:H8').setValues([['МЕТРИКА','ЗНАЧ.']])
    .setFontWeight('bold').setFontSize(9).setBackground(KRIT_BORDER);
  ws.getRange(9, 7, 4, 2).setValues([
    ['Открытых задач', stats.open],
    ['Critical WCAG (AA 3.0)', stats.criticalWcag],
    ['High WCAG (AA 4.5)', stats.highWcag],
    ['Alias-дубликатов', stats.alias]
  ]).setBackground(KRIT_BG);

  ws.setColumnWidth(1, 120);
  ws.setColumnWidth(2, 140);
  ws.setColumnWidth(3, 300);
  ws.setColumnWidth(4, 160);
  ws.setColumnWidth(5, 300);
  ws.setColumnWidth(6, 300);
  ws.setColumnWidth(7, 200);
  ws.setColumnWidth(8, 80);
}
