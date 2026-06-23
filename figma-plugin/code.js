// ============================================================
// RockUP Token Audit — Figma Plugin
// code.js v3-refcolors — Main Thread (runs in Figma sandbox)
// ============================================================

// ── Team defaults — fill these once, commit to repo ─────────
// Все участники команды получат их автоматически.
// scriptUrl:     задеплоенный URL Google Apps Script Web App
// spreadsheetId: ID Google Sheets таблицы (часть URL между /d/ и /edit)
var TEAM_DEFAULTS = {
  scriptUrl:     'https://script.google.com/macros/s/AKfycbzhZmpXmxKTKsL97jDkSDRAq1nV31WcbttcSx1bM1CUGfSHSP3GSi2cIzmxKzFT4piI/exec',
  spreadsheetId: '1GvxfhQqdfbtR6czzPKbnekzLgSpGhSnYnA9EakRWN_Q'
};
// ────────────────────────────────────────────────────────────

figma.showUI(__html__, { width: 900, height: 720, themeColors: true });

// ── Message handler ─────────────────────────────────────────
figma.ui.onmessage = async function(msg) {
  if (msg.type === 'ui-ready') {
    var config = null;
    try {
      config = await figma.clientStorage.getAsync('rockup-audit-config');
    } catch (e) {}
    // Personal storage takes priority; fall back to team defaults
    figma.ui.postMessage({
      type: 'stored-config',
      scriptUrl:     (config && config.scriptUrl)     ? config.scriptUrl     : TEAM_DEFAULTS.scriptUrl,
      spreadsheetId: (config && config.spreadsheetId) ? config.spreadsheetId : TEAM_DEFAULTS.spreadsheetId
    });

  } else if (msg.type === 'run-audit') {
    await runAudit(msg.scriptUrl, msg.spreadsheetId);

  } else if (msg.type === 'export-json') {
    await exportVariablesJson();

  } else if (msg.type === 'check-json') {
    await checkBackupJson(msg.data, msg.options || {});

  } else if (msg.type === 'rebind-variables') {
    await rebindVariables();

  } else if (msg.type === 'import-json') {
    await importBackupJson(msg.data, msg.options || {});

  } else if (msg.type === 'save-config') {
    try {
      await figma.clientStorage.setAsync('rockup-audit-config', msg.config);
    } catch (e) {}
  } else if (msg.type === 'open-url') {
    figma.openExternal(msg.url);
  }
};

// ── Helper: post message to UI (no spread) ──────────────────
function post(type, payload) {
  var msg = Object.assign({ type: type }, payload || {});
  figma.ui.postMessage(msg);
}

// ── Helper: build object map ────────────────────────────────
function buildMap(arr, key) {
  var map = {};
  for (var i = 0; i < arr.length; i++) {
    map[arr[i][key]] = arr[i];
  }
  return map;
}

// ── Helper: full token name from variable + collection name ─
function getFullName(variable, collectionName) {
  if (variable.name.indexOf('rp/') === 0) return variable.name;

  var prefixMap = {
    'Sys / Theme':     'rp/sys/',
    'NEW Sys / Theme': 'rp/sys/',
    'Sys / Unit':      'rp/sys/unit/',
    'NEW Sys / Unit':  'rp/sys/unit/',
    'Ref / Color':     'rp/ref/color/',
    'NEW Ref / Color': 'rp/ref/color/',
    'Ref / Unit':      'rp/ref/unit/',
    'NEW Ref / Unit':  'rp/ref/unit/'
  };

  if (prefixMap[collectionName]) return prefixMap[collectionName] + variable.name;

  if (collectionName && (collectionName.indexOf('Cmp / ') === 0 || collectionName.indexOf('NEW Cmp / ') === 0)) {
    var cmp = collectionName.replace('NEW Cmp / ', '').replace('Cmp / ', '').toLowerCase().replace(/\s+/g, '-');
    return 'rp/cmp/' + cmp + '/' + variable.name;
  }

  return variable.name;
}

// ── Helper: semantic suffix sort rank ───────────────────────
// Scale: bolder(0) → [none](1) → subtle(2) → subtler(3) → subtlest(4)
// State: default(0) → hover(1) → active(2) → disabled(3) → focus(4) → other(9)
function getSuffixRank(tokenName) {
  var last = (tokenName.split('/').pop() || '').toLowerCase();

  // Scale rank from prefix
  var scaleRank;
  if      (last.indexOf('bolder')   === 0) scaleRank = 0;
  else if (last.indexOf('subtlest') === 0) scaleRank = 4;
  else if (last.indexOf('subtler')  === 0) scaleRank = 3;
  else if (last.indexOf('subtle')   === 0) scaleRank = 2;
  else                                     scaleRank = 1;

  // Strip scale prefix to isolate state
  var state = last
    .replace(/^bolder-?/, '')
    .replace(/^subtlest-?/, '')
    .replace(/^subtler-?/, '')
    .replace(/^subtle-?/, '');

  var stateRank;
  if (!state || state === 'default' || state === 'bolder' ||
      state === 'subtle' || state === 'subtler' || state === 'subtlest') stateRank = 0;
  else if (state === 'hover')    stateRank = 1;
  else if (state === 'active')   stateRank = 2;
  else if (state === 'disabled') stateRank = 3;
  else if (state === 'focus')    stateRank = 4;
  else                           stateRank = 9;

  return scaleRank * 10 + stateRank;
}

// ── Helper: colour category from token name ─────────────────
function getCategory(tokenName) {
  var parts = tokenName.split('/');
  var colorIdx = parts.indexOf('color');
  if (colorIdx === -1) return parts.length >= 2 ? parts[parts.length - 2] : '—';
  var type = parts[colorIdx + 1] || '—';
  var sub  = parts[colorIdx + 2] || '';
  // For bg tokens show the subcategory (fill / surface) for clearer grouping
  if (type === 'bg' && sub) return sub;
  return type;
}

// ── Helper: get direct alias variable ───────────────────────
function getAliasVar(variable, modeId, varById) {
  var val = variable.valuesByMode[modeId];
  if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS') {
    return varById[val.id] || null;
  }
  // fallback: first mode
  var modes = Object.keys(variable.valuesByMode);
  for (var i = 0; i < modes.length; i++) {
    var v = variable.valuesByMode[modes[i]];
    if (v && typeof v === 'object' && v.type === 'VARIABLE_ALIAS') {
      return varById[v.id] || null;
    }
  }
  return null;
}

// ── Helper: собирает ID алиасов которых нет в varById ───────
// Используется для предзагрузки удалённых переменных.
function collectMissingIds(variable, modeId, varById, out) {
  var val = variable.valuesByMode[modeId];
  if (!val) {
    var modes = Object.keys(variable.valuesByMode);
    val = modes.length ? variable.valuesByMode[modes[0]] : null;
  }
  if (val && val.type === 'VARIABLE_ALIAS' && !varById[val.id]) {
    out[val.id] = true;
  }
}

// ── Helper: resolve variable value to hex (синхронная, только varById) ─
// Для корректной работы varById должен содержать все нужные переменные,
// включая удалённые (загружаются асинхронно в runAudit перед вызовом).
function resolveColorToHex(variable, modeId, varById, depth) {
  if (!variable || (depth || 0) > 10) return null;
  var val = variable.valuesByMode[modeId];
  if (!val) {
    var modes = Object.keys(variable.valuesByMode);
    if (modes.length === 0) return null;
    val = variable.valuesByMode[modes[0]];
  }
  if (!val) return null;
  if (val.r !== undefined) return toHex(val);
  if (val.type === 'VARIABLE_ALIAS') {
    var target = varById[val.id];
    if (target) return resolveColorToHex(target, modeId, varById, (depth || 0) + 1);
  }
  return null;
}

// ── Helper: RGBA → hex ───────────────────────────────────────
function toHex(c) {
  var r = Math.round(c.r * 255).toString(16);
  var g = Math.round(c.g * 255).toString(16);
  var b = Math.round(c.b * 255).toString(16);
  return '#' + (r.length < 2 ? '0' + r : r) +
               (g.length < 2 ? '0' + g : g) +
               (b.length < 2 ? '0' + b : b);
}

function toHexWithAlpha(c) {
  var base = toHex(c);
  var a = c.a !== undefined ? c.a : 1;
  if (a >= 0.999) return base;
  var aa = Math.round(a * 255).toString(16);
  return base + (aa.length < 2 ? '0' + aa : aa);
}

function toOpaqueSampleHex(c) {
  var a = c.a !== undefined ? c.a : 1;
  function channel(v) {
    // Превью для alpha-цветов: композитим поверх белого листа Google Sheets.
    return Math.round((v * a + (1 - a)) * 255).toString(16);
  }
  var r = channel(c.r);
  var g = channel(c.g);
  var b = channel(c.b);
  return '#' + (r.length < 2 ? '0' + r : r) +
               (g.length < 2 ? '0' + g : g) +
               (b.length < 2 ? '0' + b : b);
}

// ── Helper: resolve single mode value for all-tokens export ─
// Returns: primitive value OR { alias: "collection/token/name" }
function resolveExportValue(rawVal, type, varById, collById) {
  if (rawVal === undefined || rawVal === null) return null;
  if (rawVal && rawVal.type === 'VARIABLE_ALIAS') {
    var ref = varById[rawVal.id];
    if (ref) {
      var refColl = collById[ref.variableCollectionId];
      var refCollName = refColl ? refColl.name : '';
      return { alias: getFullName(ref, refCollName) };
    }
    return { alias: rawVal.id };
  }
  if (type === 'COLOR' && rawVal && rawVal.r !== undefined) {
    return toHexWithAlpha(rawVal);
  }
  return rawVal;
}

// ── Helper: value formatter for clean variables backup JSON ─
// Returns the same compact shape as 2026-05-29_rockup_variables.json:
// aliases as "@rp/..." and colors as hex.
function resolveVariablesBackupValue(rawVal, type, varById, collById) {
  if (rawVal === undefined || rawVal === null) return null;

  if (rawVal && rawVal.type === 'VARIABLE_ALIAS') {
    var ref = varById[rawVal.id];
    if (ref) {
      var refColl = collById[ref.variableCollectionId];
      var refCollName = refColl ? refColl.name : '';
      return '@' + getFullName(ref, refCollName);
    }
    // Fallback for unavailable library variables.
    return '@' + rawVal.id;
  }

  if (type === 'COLOR' && rawVal && rawVal.r !== undefined) {
    return toHexWithAlpha(rawVal);
  }

  return rawVal;
}

function resolveColorInfo(variable, modeId, varById, depth) {
  if (!variable || (depth || 0) > 10) return null;
  var val = variable.valuesByMode[modeId];
  if (!val) {
    var modes = Object.keys(variable.valuesByMode);
    if (modes.length === 0) return null;
    val = variable.valuesByMode[modes[0]];
  }
  if (!val) return null;
  if (val.r !== undefined) {
    return {
      hex: toHexWithAlpha(val),
      baseHex: toHex(val),
      sampleHex: toOpaqueSampleHex(val),
      alpha: val.a !== undefined ? val.a : 1
    };
  }
  if (val.type === 'VARIABLE_ALIAS') {
    var target = varById[val.id];
    if (target) return resolveColorInfo(target, modeId, varById, (depth || 0) + 1);
  }
  return null;
}

// ── Helper: WCAG luminance ───────────────────────────────────
function luminance(hex) {
  var r = parseInt(hex.slice(1, 3), 16) / 255;
  var g = parseInt(hex.slice(3, 5), 16) / 255;
  var b = parseInt(hex.slice(5, 7), 16) / 255;
  var channels = [r, g, b];
  var result = 0;
  var weights = [0.2126, 0.7152, 0.0722];
  for (var i = 0; i < channels.length; i++) {
    var c = channels[i];
    var lin = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    result += lin * weights[i];
  }
  return result;
}

function contrastRatio(hex1, hex2) {
  var l1 = luminance(hex1);
  var l2 = luminance(hex2);
  var lighter = Math.max(l1, l2);
  var darker  = Math.min(l1, l2);
  return ((lighter + 0.05) / (darker + 0.05)).toFixed(1) + ':1';
}

function wcagPass(ratio, threshold) {
  return parseFloat(ratio) >= threshold ? '✓ Pass' : '✗ Fail';
}


// ── Helper: component token sort for Component details ───────
// Keeps design-system variants in a predictable order:
// primary → secondary → tertiary → ghost → other, then natural token path.
function getComponentVariantRank(tokenName) {
  var parts = String(tokenName || '').split('/');
  var cmpIdx = parts.indexOf('cmp');
  var variant = cmpIdx !== -1 ? (parts[cmpIdx + 2] || '') : '';
  var map = {
    primary: 0,
    secondary: 1,
    tertiary: 2,
    ghost: 3,
    default: 4,
    md: 20,
    sm: 21,
    xs: 22
  };
  return map.hasOwnProperty(variant) ? map[variant] : 10;
}

function compareComponentDetails(a, b) {
  if (a.component < b.component) return -1;
  if (a.component > b.component) return 1;

  var ar = getComponentVariantRank(a.componentToken);
  var br = getComponentVariantRank(b.componentToken);
  if (ar !== br) return ar - br;

  return compareTokenNames(a.componentToken, b.componentToken);
}


// ── Helper: deterministic token order for Ref Colors ────────
// Требуемый порядок для Ref / Color:
// white, black, shadow, overlay, transparent → группы → числовые шаги 10..190.
var REF_COLOR_HEAD_ORDER = {
  'rp/ref/color/white': 0,
  'rp/ref/color/black': 1,
  'rp/ref/color/shadow': 2,
  'rp/ref/color/overlay': 3,
  'rp/ref/color/transparent': 4
};

function refColorSortInfo(tokenName) {
  if (!tokenName || tokenName.indexOf('rp/ref/color/') !== 0) return null;
  if (Object.prototype.hasOwnProperty.call(REF_COLOR_HEAD_ORDER, tokenName)) {
    return { bucket: 0, head: REF_COLOR_HEAD_ORDER[tokenName], group: '', step: -1, rawStep: '', name: tokenName };
  }
  var rest = tokenName.replace('rp/ref/color/', '');
  var parts = rest.split('/');
  var group = parts[0] || '';
  var rawStep = parts[1] || '';
  var stepNum = parseInt(rawStep, 10);
  return {
    bucket: 1,
    head: 999,
    group: group,
    step: isNaN(stepNum) ? 999999 : stepNum,
    rawStep: rawStep,
    name: tokenName
  };
}

function compareTokenNames(aName, bName) {
  var aInfo = refColorSortInfo(aName);
  var bInfo = refColorSortInfo(bName);

  if (aInfo && bInfo) {
    if (aInfo.bucket !== bInfo.bucket) return aInfo.bucket - bInfo.bucket;
    if (aInfo.bucket === 0 && aInfo.head !== bInfo.head) return aInfo.head - bInfo.head;
    if (aInfo.group < bInfo.group) return -1;
    if (aInfo.group > bInfo.group) return 1;
    if (aInfo.step !== bInfo.step) return aInfo.step - bInfo.step;
    if (aInfo.rawStep < bInfo.rawStep) return -1;
    if (aInfo.rawStep > bInfo.rawStep) return 1;
  }

  if (aName < bName) return -1;
  if (aName > bName) return 1;
  return 0;
}

// ── Clean variables export: backup JSON for restoring collections ──
async function exportVariablesJson() {
  try {
    post('status', { text: '⏳ Читаю локальные переменные Figma…', pct: 5 });

    var allVars        = await figma.variables.getLocalVariablesAsync();
    var allCollections = await figma.variables.getLocalVariableCollectionsAsync();
    var varById        = buildMap(allVars, 'id');
    var collById       = buildMap(allCollections, 'id');

    post('status', { text: '🔗 Проверяю alias-ссылки…', pct: 20 });

    // Если локальная переменная ссылается на library variable, пробуем подгрузить её,
    // но экспорт не должен зависать из-за внешних alias. Ограничиваем ожидание.
    var missingAliasIds = {};
    for (var ai = 0; ai < allVars.length; ai++) {
      var values = allVars[ai].valuesByMode || {};
      var modeIds = Object.keys(values);
      for (var ami = 0; ami < modeIds.length; ami++) {
        var rawVal = values[modeIds[ami]];
        if (rawVal && rawVal.type === 'VARIABLE_ALIAS' && !varById[rawVal.id]) {
          missingAliasIds[rawVal.id] = true;
        }
      }
    }

    var missingKeys = Object.keys(missingAliasIds);
    var loadedExternalAliases = 0;
    if (missingKeys.length > 0) {
      post('status', { text: '🔗 Подгружаю внешние alias: ' + missingKeys.length, pct: 30 });
      var fetchJobs = missingKeys.map(function(id) {
        return figma.variables.getVariableByIdAsync(id).then(function(v) { return v || null; }).catch(function() { return null; });
      });
      var timeout = new Promise(function(resolve) { setTimeout(function() { resolve('__timeout__'); }, 12000); });
      var fetched = await Promise.race([Promise.all(fetchJobs), timeout]);
      if (fetched !== '__timeout__') {
        for (var fi = 0; fi < fetched.length; fi++) {
          if (fetched[fi]) {
            varById[fetched[fi].id] = fetched[fi];
            loadedExternalAliases++;
          }
        }
      }
    }

    post('status', { text: '📦 Собираю backup JSON…', pct: 45 });

    var exportData = {};
    var totalCollections = allCollections.length || 1;

    // Keep the same top-level shape as the original variables backup:
    // { "Collection name": { "rp/full/token/name": { "t": "COLOR", "Mode": value } } }
    for (var ci = 0; ci < allCollections.length; ci++) {
      var coll = allCollections[ci];
      exportData[coll.name] = {};

      var collVars = [];
      for (var fvi = 0; fvi < allVars.length; fvi++) {
        if (allVars[fvi].variableCollectionId === coll.id) collVars.push(allVars[fvi]);
      }

      collVars.sort(function(a, b) {
        var aName = getFullName(a, coll.name);
        var bName = getFullName(b, coll.name);
        return compareTokenNames(aName, bName);
      });

      for (var vi = 0; vi < collVars.length; vi++) {
        var variable = collVars[vi];
        var fullName = getFullName(variable, coll.name);
        var entry = { t: variable.resolvedType };

        for (var mi = 0; mi < coll.modes.length; mi++) {
          var mode = coll.modes[mi];
          var rawValue = variable.valuesByMode[mode.modeId];
          entry[mode.name] = resolveVariablesBackupValue(
            rawValue,
            variable.resolvedType,
            varById,
            collById
          );
        }

        exportData[coll.name][fullName] = entry;
      }

      if (ci % 2 === 0 || ci === allCollections.length - 1) {
        post('status', {
          text: '📦 Собираю backup JSON: ' + (ci + 1) + ' из ' + allCollections.length + ' коллекций',
          pct: 45 + Math.round(((ci + 1) / totalCollections) * 30)
        });
        await new Promise(function(resolve) { setTimeout(resolve, 0); });
      }
    }

    post('status', { text: '🧩 Сериализую JSON…', pct: 82 });
    var jsonString = JSON.stringify(exportData, null, 2);
    var date = new Date().toISOString().slice(0, 10);
    var note = missingKeys.length > 0 && loadedExternalAliases < missingKeys.length
      ? 'Часть внешних alias не подгрузилась за 12 сек, они сохранены как raw variable id.'
      : null;

    post('status', { text: '⬇️ Передаю файл в UI…', pct: 92 });
    post('variables-json-ready', {
      json: jsonString,
      filename: date + '_rockup_variables.json',
      stats: {
        collections: allCollections.length,
        variables: allVars.length,
        externalAliasIds: missingKeys.length,
        loadedExternalAliases: loadedExternalAliases,
        note: note
      }
    });
  } catch (err) {
    post('error', { text: err && err.stack ? err.stack : (err.message || String(err)) });
  }
}

// ── Import helpers: restore variables from clean backup JSON ──
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCollectionBackup(data) {
  if (!isPlainObject(data)) return false;
  var keys = Object.keys(data);
  if (keys.length === 0) return false;
  for (var i = 0; i < keys.length; i++) {
    var collData = data[keys[i]];
    if (!isPlainObject(collData)) return false;
    var tokenKeys = Object.keys(collData);
    if (tokenKeys.length === 0) continue;
    var sample = collData[tokenKeys[0]];
    if (!isPlainObject(sample) || !sample.t) return false;
  }
  return true;
}

function normalizeImportData(data) {
  // Supports both the clean backup JSON and an audit JSON that contains allTokens.
  if (isCollectionBackup(data)) return data;

  if (data && Array.isArray(data.allTokens)) {
    var byCollection = {};
    for (var i = 0; i < data.allTokens.length; i++) {
      var tok = data.allTokens[i];
      if (!tok || !tok.collection || !tok.name || !tok.type || !tok.modes) continue;
      if (!byCollection[tok.collection]) byCollection[tok.collection] = {};
      var entry = { t: tok.type };
      var modeNames = Object.keys(tok.modes);
      for (var mi = 0; mi < modeNames.length; mi++) {
        var raw = tok.modes[modeNames[mi]];
        if (raw && raw.alias) entry[modeNames[mi]] = '@' + raw.alias;
        else entry[modeNames[mi]] = raw;
      }
      byCollection[tok.collection][tok.name] = entry;
    }
    if (isCollectionBackup(byCollection)) return byCollection;
  }

  throw new Error('JSON не похож на backup переменных. Нужен файл вида YYYY-MM-DD_rockup_variables.json.');
}

function getModeNamesFromCollectionData(collData) {
  var modeSet = {};
  var tokenNames = Object.keys(collData);
  for (var i = 0; i < tokenNames.length; i++) {
    var entry = collData[tokenNames[i]];
    if (!entry) continue;
    var keys = Object.keys(entry);
    for (var k = 0; k < keys.length; k++) {
      if (keys[k] !== 't') modeSet[keys[k]] = true;
    }
  }
  return Object.keys(modeSet);
}

function ensureModeMap(collection, desiredModeNames) {
  var modeMap = {};
  for (var i = 0; i < collection.modes.length; i++) {
    modeMap[collection.modes[i].name] = collection.modes[i].modeId;
  }

  if (desiredModeNames.length > 0) {
    var firstDesired = desiredModeNames[0];
    if (!modeMap[firstDesired] && collection.modes.length === 1) {
      try {
        collection.renameMode(collection.modes[0].modeId, firstDesired);
        modeMap = {};
        for (var r = 0; r < collection.modes.length; r++) {
          modeMap[collection.modes[r].name] = collection.modes[r].modeId;
        }
      } catch (_) {}
    }
  }

  for (var mi = 0; mi < desiredModeNames.length; mi++) {
    var modeName = desiredModeNames[mi];
    if (!modeMap[modeName]) {
      try {
        var newModeId = collection.addMode(modeName);
        modeMap[modeName] = newModeId;
      } catch (e) {
        // If a mode was created concurrently or Figma rejected the name, refresh map and continue.
        modeMap = {};
        for (var x = 0; x < collection.modes.length; x++) {
          modeMap[collection.modes[x].name] = collection.modes[x].modeId;
        }
        if (!modeMap[modeName]) throw e;
      }
    }
  }
  return modeMap;
}

function parseHexColor(hex) {
  if (typeof hex !== 'string') throw new Error('COLOR ожидает hex-строку, получено: ' + String(hex));
  var value = hex.trim();
  if (value.charAt(0) === '#') value = value.slice(1);
  if (value.length !== 6 && value.length !== 8) {
    throw new Error('Некорректный COLOR hex: #' + value);
  }
  function ch(start) { return parseInt(value.slice(start, start + 2), 16) / 255; }
  var color = { r: ch(0), g: ch(2), b: ch(4) };
  if (value.length === 8) color.a = ch(6);
  return color;
}

function castImportValue(rawValue, type) {
  if (rawValue === null || rawValue === undefined) return null;
  if (type === 'COLOR') return parseHexColor(rawValue);
  if (type === 'FLOAT') return typeof rawValue === 'number' ? rawValue : Number(rawValue);
  if (type === 'BOOLEAN') return rawValue === true || rawValue === 'true';
  if (type === 'STRING') return String(rawValue);
  return rawValue;
}

function getImportedAliasName(value) {
  if (typeof value !== 'string') return null;
  if (value.charAt(0) !== '@') return null;
  return value.slice(1);
}

function isSupportedVariableType(type) {
  return type === 'COLOR' || type === 'FLOAT' || type === 'STRING' || type === 'BOOLEAN';
}

// ── Import variables backup JSON into local Figma collections ──
async function importVariablesJson(rawData) {
  try {
    post('status', { text: '⏳ Читаю JSON…', pct: 3 });

    var data = normalizeImportData(rawData);
    var collectionNames = Object.keys(data);
    if (collectionNames.length === 0) throw new Error('В JSON нет коллекций.');

    post('status', { text: '🔍 Проверяю текущие коллекции…', pct: 10 });

    var allCollections = await figma.variables.getLocalVariableCollectionsAsync();
    var allVars = await figma.variables.getLocalVariablesAsync();
    var collByName = {};
    for (var ci = 0; ci < allCollections.length; ci++) {
      collByName[allCollections[ci].name] = allCollections[ci];
    }

    var stats = {
      collectionsCreated: 0,
      collectionsUpdated: 0,
      variablesCreated: 0,
      variablesUpdated: 0,
      valuesSet: 0,
      aliasesSet: 0,
      aliasesMissing: 0,
      skipped: 0
    };

    var importCollections = {};
    var modeMapsByCollection = {};

    // 1) Create missing collections and modes.
    for (var cn = 0; cn < collectionNames.length; cn++) {
      var collName = collectionNames[cn];
      var coll = collByName[collName];
      if (!coll) {
        coll = figma.variables.createVariableCollection(collName);
        collByName[collName] = coll;
        stats.collectionsCreated++;
      } else {
        stats.collectionsUpdated++;
      }
      var modeNames = getModeNamesFromCollectionData(data[collName]);
      modeMapsByCollection[collName] = ensureModeMap(coll, modeNames);
      importCollections[collName] = coll;
    }

    post('status', { text: '🧱 Создаю отсутствующие переменные…', pct: 32 });

    // Existing variable map by collection + full token name.
    var tokenByFullName = {};
    for (var vi = 0; vi < allVars.length; vi++) {
      var existingVar = allVars[vi];
      var existingColl = null;
      for (var eci = 0; eci < allCollections.length; eci++) {
        if (allCollections[eci].id === existingVar.variableCollectionId) {
          existingColl = allCollections[eci];
          break;
        }
      }
      if (!existingColl) continue;
      var existingFullName = getFullName(existingVar, existingColl.name);
      tokenByFullName[existingFullName] = existingVar;
    }

    // 2) Create all variables first, before setting aliases.
    for (var cni = 0; cni < collectionNames.length; cni++) {
      var collectionName = collectionNames[cni];
      var collection = importCollections[collectionName];
      var tokens = data[collectionName];
      var tokenNames = Object.keys(tokens).sort(compareTokenNames);

      for (var tni = 0; tni < tokenNames.length; tni++) {
        var tokenName = tokenNames[tni];
        var entry = tokens[tokenName];
        var type = entry && entry.t;
        if (!isSupportedVariableType(type)) {
          stats.skipped++;
          continue;
        }

        var variable = tokenByFullName[tokenName];
        if (!variable) {
          try {
            variable = figma.variables.createVariable(tokenName, collection, type);
            tokenByFullName[tokenName] = variable;
            stats.variablesCreated++;
          } catch (e) {
            stats.skipped++;
            continue;
          }
        } else {
          stats.variablesUpdated++;
        }
      }
    }

    post('status', { text: '🎚️ Записываю значения и alias…', pct: 68 });

    // 3) Set mode values. Alias values can now point to variables created above.
    for (var cni2 = 0; cni2 < collectionNames.length; cni2++) {
      var collectionName2 = collectionNames[cni2];
      var tokens2 = data[collectionName2];
      var modeMap = modeMapsByCollection[collectionName2];
      var tokenNames2 = Object.keys(tokens2).sort();

      for (var tni2 = 0; tni2 < tokenNames2.length; tni2++) {
        var tokenName2 = tokenNames2[tni2];
        var entry2 = tokens2[tokenName2];
        var type2 = entry2 && entry2.t;
        var variable2 = tokenByFullName[tokenName2];
        if (!variable2 || !isSupportedVariableType(type2)) continue;

        var modes = Object.keys(entry2).filter(function(k) { return k !== 't'; });
        for (var mii = 0; mii < modes.length; mii++) {
          var modeName2 = modes[mii];
          var modeId = modeMap[modeName2];
          if (!modeId) continue;
          var rawModeValue = entry2[modeName2];
          if (rawModeValue === null || rawModeValue === undefined) continue;

          var aliasName = getImportedAliasName(rawModeValue);
          try {
            if (aliasName) {
              var target = tokenByFullName[aliasName];
              if (target) {
                variable2.setValueForMode(modeId, figma.variables.createVariableAlias(target));
                stats.aliasesSet++;
              } else {
                stats.aliasesMissing++;
              }
            } else {
              variable2.setValueForMode(modeId, castImportValue(rawModeValue, type2));
              stats.valuesSet++;
            }
          } catch (setErr) {
            stats.skipped++;
          }
        }
      }
    }

    post('status', { text: '✅ Импорт завершён', pct: 100 });
    post('import-complete', { stats: stats });
  } catch (err) {
    post('error', { text: err.message || String(err) });
  }
}

// ── Main audit function ─────────────────────────────────────
async function runAudit(scriptUrl, spreadsheetId, jsonOnly) {
  try {
    post('status', { text: '⏳ Читаю переменные Figma…', pct: 5 });

    var allVars        = await figma.variables.getLocalVariablesAsync();
    var allCollections = await figma.variables.getLocalVariableCollectionsAsync();
    var varById        = buildMap(allVars, 'id');
    var collById       = buildMap(allCollections, 'id');

    post('status', { text: '🔍 Ищу коллекции…', pct: 15 });

    var sysThemeColl = null;
    var refColorColl = null;
    var cmpColls     = [];

    for (var ci = 0; ci < allCollections.length; ci++) {
      var coll = allCollections[ci];
      if (coll.name === 'Sys / Theme' || coll.name === 'NEW Sys / Theme') sysThemeColl = coll;
      if (coll.name === 'Ref / Color' || coll.name === 'NEW Ref / Color' || /Ref\s*\/\s*Color/i.test(coll.name)) refColorColl = coll;
      if (coll.name.indexOf('Cmp / ') === 0 || coll.name.indexOf('NEW Cmp / ') === 0) cmpColls.push(coll);
    }

    if (!sysThemeColl) {
      throw new Error('Коллекция "Sys / Theme" или "NEW Sys / Theme" не найдена. Убедись что открыт RockUP UI Kit с подключёнными библиотеками.');
    }

    // Modes
    var lightMode = null;
    var darkMode  = null;
    for (var mi = 0; mi < sysThemeColl.modes.length; mi++) {
      var mode = sysThemeColl.modes[mi];
      if (/light/i.test(mode.name) && !lightMode) lightMode = mode;
      if (/dark/i.test(mode.name) && !darkMode)   darkMode  = mode;
    }
    if (!lightMode) lightMode = sysThemeColl.modes[0];
    if (!darkMode && sysThemeColl.modes.length > 1) darkMode = sysThemeColl.modes[1];

    // ── Ref hex values (async, поддерживает внешние библиотеки) ──
    // varById сейчас содержит только локальные переменные.
    // Если Ref / Color алиасит на внешнюю библиотеку —
    // делаем 2 прохода getVariableByIdAsync, расширяя varById.
    var refHexLight = {};
    var refColorInfo = {};
    if (refColorColl) {
      var refVars = [];
      for (var vi = 0; vi < allVars.length; vi++) {
        if (allVars[vi].variableCollectionId === refColorColl.id &&
            allVars[vi].resolvedType === 'COLOR') {
          refVars.push(allVars[vi]);
        }
      }
      var rModeId = refColorColl.modes[0].modeId;

      post('status', { text: '🎨 Загружаю Ref Colors (' + refVars.length + ' переменных)…', pct: 22 });

      // Проход 1: найти ID алиасов которых нет локально
      var missing1 = {};
      for (var rp1 = 0; rp1 < refVars.length; rp1++) {
        collectMissingIds(refVars[rp1], rModeId, varById, missing1);
      }
      var miss1Keys = Object.keys(missing1);
      if (miss1Keys.length > 0) {
        var fetched1 = await Promise.all(miss1Keys.map(function(id) {
          return figma.variables.getVariableByIdAsync(id).catch(function() { return null; });
        }));
        for (var f1 = 0; f1 < fetched1.length; f1++) {
          if (fetched1[f1]) varById[fetched1[f1].id] = fetched1[f1];
        }

        // Проход 2: загруженные переменные тоже могут быть алиасами
        var missing2 = {};
        for (var f2 = 0; f2 < fetched1.length; f2++) {
          if (fetched1[f2]) collectMissingIds(fetched1[f2], rModeId, varById, missing2);
        }
        var miss2Keys = Object.keys(missing2);
        if (miss2Keys.length > 0) {
          var fetched2 = await Promise.all(miss2Keys.map(function(id) {
            return figma.variables.getVariableByIdAsync(id).catch(function() { return null; });
          }));
          for (var f3 = 0; f3 < fetched2.length; f3++) {
            if (fetched2[f3]) varById[fetched2[f3].id] = fetched2[f3];
          }
        }
      }

      // Теперь varById расширен — резолвим цвет + preview для alpha-токенов.
      for (var ri = 0; ri < refVars.length; ri++) {
        var rv = refVars[ri];
        var info = resolveColorInfo(rv, rModeId, varById, 0);
        if (info && info.baseHex) {
          var fullName = getFullName(rv, refColorColl.name);
          refHexLight[fullName] = info.baseHex; // для WCAG оставляем 6-digit hex
          refColorInfo[fullName] = info;        // для листа Ref Colors: hex + sampleHex + alpha
        }
      }

      post('status', {
        text: '🎨 Ref Colors: ' + Object.keys(refHexLight).length + ' из ' + refVars.length +
              (miss1Keys.length ? ' (загружено из библиотек: ' + miss1Keys.length + ')' : ''),
        pct: 25
      });
    } else {
      post('status', { text: '⚠️ Коллекция «Ref / Color» / «NEW Ref / Color» не найдена', pct: 25 });
    }

    // Fallback: если коллекция переименована/импортирована нестандартно,
    // всё равно пробуем собрать Ref Colors по полным именам rp/ref/color/*.
    if (Object.keys(refHexLight).length === 0) {
      var fallbackFound = 0;
      for (var rf = 0; rf < allVars.length; rf++) {
        var fv = allVars[rf];
        if (fv.resolvedType !== 'COLOR') continue;
        var fc = collById[fv.variableCollectionId];
        if (!fc || !fc.modes || !fc.modes.length) continue;
        var fName = getFullName(fv, fc.name);
        if (fName.indexOf('rp/ref/color/') !== 0) continue;
        var fModeId = fc.modes[0].modeId;
        var fInfo = resolveColorInfo(fv, fModeId, varById, 0);
        if (fInfo && fInfo.baseHex) {
          refHexLight[fName] = fInfo.baseHex;
          refColorInfo[fName] = fInfo;
          fallbackFound++;
        }
      }
      if (fallbackFound > 0) {
        post('status', { text: '🎨 Ref Colors fallback: ' + fallbackFound + ' переменных', pct: 26 });
      }
    }

    post('status', { text: '🔍 Маппинг компонентных токенов…', pct: 30 });

    // Component details
    var componentDetails = [];
    var compNamesArr = [];

    for (var ki = 0; ki < cmpColls.length; ki++) {
      var cmpColl = cmpColls[ki];
      var compBaseName = cmpColl.name.replace('NEW Cmp / ', '').replace('Cmp / ', '').trim();

      // ── Обходим ВСЕ режимы коллекции ─────────────────────────
      // Если у коллекции несколько режимов (напр. Primary / Secondary / Tertiary / Ghost),
      // каждый режим = отдельный вариант компонента с отдельными алиасами.
      for (var mdi = 0; mdi < cmpColl.modes.length; mdi++) {
        var cmpMode = cmpColl.modes[mdi].modeId;
        // Один режим → имя компонента как есть; много → добавляем имя режима
        var compName = cmpColl.modes.length > 1
          ? compBaseName + ' / ' + cmpColl.modes[mdi].name
          : compBaseName;
        if (compNamesArr.indexOf(compName) === -1) compNamesArr.push(compName);

        for (var vi2 = 0; vi2 < allVars.length; vi2++) {
          var cmpVar = allVars[vi2];
          if (cmpVar.variableCollectionId !== cmpColl.id) continue;
          if (cmpVar.resolvedType !== 'COLOR') continue;

          var cmpTokenName = getFullName(cmpVar, cmpColl.name);
          var sysVar = getAliasVar(cmpVar, cmpMode, varById);
          var sysCollName = sysVar ? (collById[sysVar.variableCollectionId] || {}).name || '' : '';
          var sysToken = sysVar ? getFullName(sysVar, sysCollName) : '—';

          var lightAlias = '—';
          var darkAlias  = '—';
          var themeDelta = '—';

          if (sysVar) {
            var lRefVar = getAliasVar(sysVar, lightMode.modeId, varById);
            var dRefVar = darkMode ? getAliasVar(sysVar, darkMode.modeId, varById) : null;
            var lCollName = lRefVar ? (collById[lRefVar.variableCollectionId] || {}).name || '' : '';
            var dCollName = dRefVar ? (collById[dRefVar.variableCollectionId] || {}).name || '' : '';
            lightAlias = lRefVar ? getFullName(lRefVar, lCollName) : '—';
            darkAlias  = dRefVar ? getFullName(dRefVar, dCollName) : '—';
            if (lightAlias !== '—' && darkAlias !== '—') {
              themeDelta = lightAlias !== darkAlias ? 'different' : 'same';
            }
          }

          var tokenParts = cmpTokenName.split('/');
          var section = tokenParts.slice(0, 4).join('/');
          var property = tokenParts.slice(3).join('/');
          var tokenClass = sysToken.indexOf('/sys/') !== -1 ? 'system token' :
                           sysToken.indexOf('/ref/') !== -1 ? 'reference token' : 'other';

          componentDetails.push({
            component:      compName,
            section:        section,
            componentToken: cmpTokenName,
            property:       property,
            usedToken:      sysToken,  // текущий системный токен; нужен для Matrix/WCAG/Light Dark
            auditToken:     sysToken,  // текущее значение из Figma
            tokenClass:     tokenClass,
            lightAlias:     lightAlias,
            darkAlias:      darkAlias,
            themeDelta:     themeDelta,
            note:           null
          });
        }
      }
    }

    compNamesArr.sort();

    // ── Трекинг изменений componentDetails ───────────────────
    // previousToken = что было в предыдущем запуске (из снапшота)
    // auditToken    = текущее значение из Figma
    // usedToken не перезаписываем: он должен оставаться текущим токеном для Matrix/WCAG/Light Dark.
    var CD_SNAPSHOT_KEY = 'rockup-cd-snapshot';
    var prevCdSnapshot = {};
    try { prevCdSnapshot = (await figma.clientStorage.getAsync(CD_SNAPSHOT_KEY)) || {}; } catch(e) {}
    var newCdSnapshot = {};
    for (var cdi = 0; cdi < componentDetails.length; cdi++) {
      var cd = componentDetails[cdi];
      var cdKey = cd.component + '|' + cd.componentToken;
      cd.previousToken = prevCdSnapshot.hasOwnProperty(cdKey) ? prevCdSnapshot[cdKey] : cd.auditToken;
      newCdSnapshot[cdKey] = cd.auditToken;
    }
    try { await figma.clientStorage.setAsync(CD_SNAPSHOT_KEY, newCdSnapshot); } catch(e) {}
    // ─────────────────────────────────────────────────────────

    // Sort component details alphabetically by component name, then by token
    componentDetails.sort(compareComponentDetails);

    post('status', { text: '📊 Строю матрицу токенов…', pct: 55 });

    // Token → components map
    var tokenCompMap = {};
    var tokenOccMap  = {};

    for (var di = 0; di < componentDetails.length; di++) {
      var d = componentDetails[di];
      if (!d.usedToken || d.usedToken === '—') continue;
      if (!tokenCompMap[d.usedToken]) {
        tokenCompMap[d.usedToken] = {};
        tokenOccMap[d.usedToken]  = 0;
      }
      tokenCompMap[d.usedToken][d.component] = true;
      tokenOccMap[d.usedToken]++;
    }

    // Light/dark per sys token
    var lightDarkByToken = {};
    for (var di2 = 0; di2 < componentDetails.length; di2++) {
      var d2 = componentDetails[di2];
      if (d2.usedToken === '—') continue;
      if (!lightDarkByToken[d2.usedToken]) {
        lightDarkByToken[d2.usedToken] = {
          lightAlias: d2.lightAlias,
          darkAlias:  d2.darkAlias
        };
      }
    }

    // Matrix rows
    var matrixRows = [];
    var tokenKeys = Object.keys(tokenCompMap);
    for (var ti = 0; ti < tokenKeys.length; ti++) {
      var tok = tokenKeys[ti];
      var ld = lightDarkByToken[tok] || { lightAlias: '—', darkAlias: '—' };
      var comps = tokenCompMap[tok];
      var row = {
        token:          tok,
        category:       getCategory(tok),
        numComponents:  Object.keys(comps).length,
        numOccurrences: tokenOccMap[tok],
        lightAlias:     ld.lightAlias,
        darkAlias:      ld.darkAlias
      };
      for (var ci2 = 0; ci2 < compNamesArr.length; ci2++) {
        row[compNamesArr[ci2]] = comps[compNamesArr[ci2]] ? '●' : null;
      }
      matrixRows.push(row);
    }
    matrixRows.sort(function(a, b) {
      if (a.category < b.category) return -1;
      if (a.category > b.category) return 1;
      var aBase = a.token.split('/').slice(0, -1).join('/');
      var bBase = b.token.split('/').slice(0, -1).join('/');
      if (aBase < bBase) return -1;
      if (aBase > bBase) return 1;
      return getSuffixRank(a.token) - getSuffixRank(b.token);
    });

    // Token overlaps
    var tokenOverlaps = [];
    for (var mi2 = 0; mi2 < matrixRows.length; mi2++) {
      var mr = matrixRows[mi2];
      if (mr.numComponents < 2) continue;
      var compList = [];
      for (var ci3 = 0; ci3 < compNamesArr.length; ci3++) {
        if (mr[compNamesArr[ci3]] === '●') compList.push(compNamesArr[ci3]);
      }
      tokenOverlaps.push({
        token:          mr.token,
        category:       mr.category,
        numComponents:  mr.numComponents,
        numOccurrences: mr.numOccurrences,
        components:     compList.join(', '),
        lightAlias:     mr.lightAlias,
        darkAlias:      mr.darkAlias
      });
    }

    // Light Dark sheet
    var lightDarkMap = {};
    for (var di3 = 0; di3 < componentDetails.length; di3++) {
      var d3 = componentDetails[di3];
      if (d3.usedToken === '—') continue;
      if (!lightDarkMap[d3.usedToken]) {
        lightDarkMap[d3.usedToken] = {
          auditToken:   d3.usedToken,
          category:     getCategory(d3.usedToken),
          lightAlias:   d3.lightAlias,
          darkAlias:    d3.darkAlias,
          comps:        {},
          occurrences:  0
        };
      }
      lightDarkMap[d3.usedToken].comps[d3.component] = true;
      lightDarkMap[d3.usedToken].occurrences++;
    }

    var lightDarkRows = [];
    var ldKeys = Object.keys(lightDarkMap);
    for (var li = 0; li < ldKeys.length; li++) {
      var ldr = lightDarkMap[ldKeys[li]];
      var ldComps = Object.keys(ldr.comps).sort();
      lightDarkRows.push({
        auditToken:      ldr.auditToken,
        category:        ldr.category,
        lightAlias:      ldr.lightAlias,
        darkAlias:       ldr.darkAlias,
        themeDelta:      (ldr.lightAlias !== '—' && ldr.darkAlias !== '—') ? (ldr.lightAlias !== ldr.darkAlias ? 'different' : 'same') : '—',
        componentsCount: ldComps.length,
        occurrences:     ldr.occurrences,
        components:      ldComps.join(', ')
      });
    }
    lightDarkRows.sort(function(a, b) {
      if (a.category < b.category) return -1;
      if (a.category > b.category) return 1;
      var aBase = a.auditToken.split('/').slice(0, -1).join('/');
      var bBase = b.auditToken.split('/').slice(0, -1).join('/');
      if (aBase < bBase) return -1;
      if (aBase > bBase) return 1;
      return getSuffixRank(a.auditToken) - getSuffixRank(b.auditToken);
    });

    // Alias duplicates
    var byLightAlias = {};
    for (var li2 = 0; li2 < lightDarkRows.length; li2++) {
      var lrow = lightDarkRows[li2];
      if (lrow.lightAlias === '—') continue;
      if (!byLightAlias[lrow.lightAlias]) byLightAlias[lrow.lightAlias] = [];
      byLightAlias[lrow.lightAlias].push(lrow);
    }

    var aliasDuplicates = [];
    var laKeys = Object.keys(byLightAlias);
    for (var lai = 0; lai < laKeys.length; lai++) {
      var laGroup = byLightAlias[laKeys[lai]];
      if (laGroup.length < 2) continue;
      var darkSet = {};
      for (var lg = 0; lg < laGroup.length; lg++) darkSet[laGroup[lg].darkAlias] = true;
      var darkVariants = Object.keys(darkSet);
      var type = darkVariants.length > 1 ? 'same Light, different Dark' : 'same Light, same Dark';
      var risk = type === 'same Light, different Dark'
        ? 'проверить семантику: визуально токены совпадают, имена разные'
        : 'возможный дубликат токена: разные имена, одинаковые значения';
      var allCompsSet = {};
      for (var lgc = 0; lgc < laGroup.length; lgc++) {
        var cArr = laGroup[lgc].components.split(', ');
        for (var lcc = 0; lcc < cArr.length; lcc++) {
          if (cArr[lcc]) allCompsSet[cArr[lcc]] = true;
        }
      }
      var allComps = Object.keys(allCompsSet).sort();
      for (var dvi = 0; dvi < darkVariants.length; dvi++) {
        var subset = laGroup.filter(function(r) { return r.darkAlias === darkVariants[dvi]; });
        aliasDuplicates.push({
          groupType:  type,
          lightAlias: laKeys[lai],
          darkAlias:  darkVariants[dvi],
          tokenCount: subset.length,
          tokens:     subset.map(function(r) { return r.auditToken.split('/').slice(-2).join('/'); }).join('\n'),
          components: allComps.join(', '),
          risk:       risk
        });
      }
    }

    post('status', { text: '🎨 Вычисляю WCAG…', pct: 75 });

    // WCAG pairs
    var wcagRows = [];
    var sectionFgBg = {};
    for (var wdi = 0; wdi < componentDetails.length; wdi++) {
      var wd = componentDetails[wdi];
      var wKey = wd.component + '|' + wd.section;
      if (!sectionFgBg[wKey]) sectionFgBg[wKey] = { fgTokens: {}, bgTokens: {}, comp: wd.component, section: wd.section };
      if (wd.usedToken.indexOf('/fg/') !== -1) sectionFgBg[wKey].fgTokens[wd.usedToken] = true;
      if (wd.usedToken.indexOf('/bg/') !== -1) sectionFgBg[wKey].bgTokens[wd.usedToken] = true;
    }

    var seenPairs = {};
    var sfbKeys = Object.keys(sectionFgBg);
    for (var si = 0; si < sfbKeys.length; si++) {
      var sfb = sectionFgBg[sfbKeys[si]];
      var fgList = Object.keys(sfb.fgTokens);
      var bgList = Object.keys(sfb.bgTokens);
      for (var fi = 0; fi < fgList.length; fi++) {
        for (var bgi = 0; bgi < bgList.length; bgi++) {
          var pairKey = fgList[fi] + '|' + bgList[bgi];
          if (seenPairs[pairKey]) continue;
          seenPairs[pairKey] = true;
          var fgLd = lightDarkByToken[fgList[fi]] || {};
          var bgLd = lightDarkByToken[bgList[bgi]] || {};
          var lightFgHex = refHexLight[fgLd.lightAlias] || '—';
          var lightBgHex = refHexLight[bgLd.lightAlias] || '—';
          var darkFgHex  = refHexLight[fgLd.darkAlias]  || '—';
          var darkBgHex  = refHexLight[bgLd.darkAlias]  || '—';
          var lightRatio = (lightFgHex !== '—' && lightBgHex !== '—') ? contrastRatio(lightFgHex, lightBgHex) : '—';
          var darkRatio  = (darkFgHex  !== '—' && darkBgHex  !== '—') ? contrastRatio(darkFgHex, darkBgHex)   : '—';
          var fgShort = fgList[fi].split('/').slice(-2).join('/');
          var bgShort = bgList[bgi].split('/').slice(-2).join('/');
          wcagRows.push({
            context:    fgShort + ' on ' + bgShort,
            component:  sfb.comp,
            fgToken:    fgShort,
            bgToken:    bgShort,
            lightFgHex: lightFgHex,
            lightBgHex: lightBgHex,
            lightRatio: lightRatio,
            lightAA45:  lightRatio !== '—' ? wcagPass(lightRatio, 4.5) : '—',
            lightAA30:  lightRatio !== '—' ? wcagPass(lightRatio, 3.0) : '—',
            darkFgHex:  darkFgHex,
            darkBgHex:  darkBgHex,
            darkRatio:  darkRatio,
            darkAA45:   darkRatio  !== '—' ? wcagPass(darkRatio,  4.5) : '—',
            darkAA30:   darkRatio  !== '—' ? wcagPass(darkRatio,  3.0) : '—',
            note:       sfb.section.split('/').pop() || ''
          });
        }
      }
    }

    // ── Change tracking for Light/Dark sheet ────────────────
    // Figma Plugin API не даёт дату изменения токена — сравниваем
    // с предыдущим снапшотом, сохранённым в clientStorage.
    var SNAPSHOT_KEY = 'rockup-ld-snapshot';
    var prevSnapshot = {};
    try { prevSnapshot = (await figma.clientStorage.getAsync(SNAPSHOT_KEY)) || {}; } catch(e) {}

    var now      = new Date();
    var _dd = String(now.getDate()).padStart(2, '0');
    var _mm = String(now.getMonth() + 1).padStart(2, '0');
    var todayStr = _dd + '.' + _mm + '.' + now.getFullYear(); // "дд.мм.гггг"
    var newSnapshot = {};

    for (var cti = 0; cti < lightDarkRows.length; cti++) {
      var ctr = lightDarkRows[cti];
      var tk  = ctr.auditToken;
      var prev = prevSnapshot[tk];

      var changedAt, isNew, isChanged;
      if (!prev) {
        // Токен появился впервые
        changedAt = todayStr;
        isNew     = true;
        isChanged = false;
      } else if (prev.lightAlias !== ctr.lightAlias || prev.darkAlias !== ctr.darkAlias) {
        // Алиас изменился с прошлого запуска
        changedAt = todayStr;
        isNew     = false;
        isChanged = true;
      } else {
        // Без изменений — сохраняем историческую дату
        changedAt = prev.changedAt || todayStr;
        isNew     = false;
        isChanged = false;
      }

      ctr.changedAt = changedAt;
      ctr.isNew     = isNew;
      ctr.isChanged = isChanged;

      newSnapshot[tk] = {
        lightAlias: ctr.lightAlias,
        darkAlias:  ctr.darkAlias,
        changedAt:  changedAt
      };
    }

    // Сохраняем обновлённый снапшот
    try { await figma.clientStorage.setAsync(SNAPSHOT_KEY, newSnapshot); } catch(e) {}
    // ────────────────────────────────────────────────────────

    // Summary
    var months = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
    var monthYear = months[now.getMonth()] + ' ' + now.getFullYear();

    var summary = {
      title:    'Figma token audit — Cmp x Sys / Theme (' + monthYear + ')',
      subtitle: 'Источник: Figma Plugin API — matrix ссылок на переменные/alias tokens, не hex-совпадения.',
      metrics: [
        { label: 'Компонентов в аудите',                      value: compNamesArr.length },
        { label: 'Уникальных системных токенов',              value: Object.keys(tokenCompMap).length },
        { label: 'Компонентных токенов (rp/cmp/*)',           value: componentDetails.length },
        { label: 'Токенов с light≠dark (different)',          value: lightDarkRows.filter(function(r) { return r.themeDelta === 'different'; }).length },
        { label: 'Токенов с light=dark (same)',               value: lightDarkRows.filter(function(r) { return r.themeDelta === 'same'; }).length },
        { label: 'Alias-конфликтов (same Light, diff Dark)',  value: aliasDuplicates.filter(function(r) { return r.groupType === 'same Light, different Dark'; }).length },
        { label: 'Всего токенов в файле (все коллекции)',     value: allVars.length }
      ],
      topShared: tokenOverlaps.slice(0, 10).map(function(r) {
        return { token: r.token, numComponents: r.numComponents, occurrences: r.numOccurrences, components: r.components };
      }),
      generatedAt: now.toISOString()
    };

    // Ref Colors — sorted and normalized for the Google Sheets «Ref Colors» sheet
    var refColorsArr = [];
    var refColorKeys = Object.keys(refHexLight);
    for (var rci = 0; rci < refColorKeys.length; rci++) {
      var rcName = refColorKeys[rci];
      var rcParts = rcName.split('/');
      var rcColorIdx = rcParts.indexOf('color');
      var rcGroup = rcColorIdx !== -1 && rcParts[rcColorIdx + 1] ? rcParts[rcColorIdx + 1] : rcParts[rcParts.length - 2] || '';
      var rcSubgroup = rcColorIdx !== -1 && rcParts[rcColorIdx + 2] ? rcParts[rcColorIdx + 2] : '';
      var rcInfo = refColorInfo[rcName] || {};
      var rcAlpha = rcInfo.alpha !== undefined ? rcInfo.alpha : '';
      var rcBaseHex = rcInfo.baseHex || refHexLight[rcName] || '';
      var rcFullHex = rcInfo.hex || refHexLight[rcName] || '';
      var rcSampleHex = rcInfo.sampleHex || rcBaseHex || refHexLight[rcName] || '';
      var rcIsAlphaGroup = /alpha$/i.test(rcGroup);
      var rcDisplaySubgroup = rcIsAlphaGroup && rcAlpha !== '' ? rcAlpha : rcSubgroup;

      refColorsArr.push({
        name: rcName,
        hex: rcBaseHex,
        rawHex: rcFullHex,
        sampleHex: rcSampleHex,
        alpha: rcAlpha,
        group: rcGroup,
        subgroup: rcDisplaySubgroup,
        step: rcSubgroup
      });
    }
    refColorsArr.sort(function(a, b) {
      return compareTokenNames(a.name, b.name);
    });

    // ── All tokens flat export ───────────────────────────────
    post('status', { text: '📋 Собираю все токены…', pct: 89 });

    var allTokens = [];
    for (var ati = 0; ati < allVars.length; ati++) {
      var tv      = allVars[ati];
      var tcoll   = collById[tv.variableCollectionId];
      if (!tcoll) continue;

      var tokenEntry = {
        name:       tv.name,
        collection: tcoll.name,
        type:       tv.resolvedType,
        scopes:     tv.scopes || [],
        modes:      {}
      };

      for (var tmi = 0; tmi < tcoll.modes.length; tmi++) {
        var tmode  = tcoll.modes[tmi];
        var rawVal = tv.valuesByMode[tmode.modeId];
        tokenEntry.modes[tmode.name] = resolveExportValue(rawVal, tv.resolvedType, varById, collById);
      }

      allTokens.push(tokenEntry);
    }

    allTokens.sort(function(a, b) {
      if (a.collection < b.collection) return -1;
      if (a.collection > b.collection) return 1;
      return compareTokenNames(a.name, b.name);
    });
    // ────────────────────────────────────────────────────────

    var auditData = {
      summary:          summary,
      matrix:           { componentNames: compNamesArr, rows: matrixRows },
      tokenOverlaps:    tokenOverlaps,
      componentDetails: componentDetails,
      lightDark:        lightDarkRows,
      wcag:             wcagRows,
      aliasDuplicates:  aliasDuplicates,
      refColors:        refColorsArr,
      allTokens:        allTokens
    };

    // ── Diagnostic: count collected data ─────────────────────
    post('status', {
      text: '🔢 Собрано: компонентов=' + compNamesArr.length +
            ', cmp-токенов=' + componentDetails.length +
            ', sys-токенов=' + lightDarkRows.length +
            ', refColors=' + refColorsArr.length,
      pct: 88
    });
    // Пауза чтобы успеть прочитать
    await new Promise(function(r) { setTimeout(r, 3000); });

    // ── JSON-only export (no Sheets upload) ────────────────
    if (jsonOnly) {
      post('json-ready', { data: auditData });
      return;
    }

    // ── Try figma.fetch() (main thread, bypasses CORS) ─────
    // figma.fetch работает в main thread — без CORS-ограничений браузера.
    // UI fallback (fetch из iframe) ВСЕГДА блокируется CORS на Apps Script редиректах,
    // поэтому на Figma Desktop UI fallback не используем.
    var sentViaFigmaFetch = false;
    var hasFigmaFetch = typeof figma.fetch === 'function';

    if (hasFigmaFetch) {
      try {
        post('status', { text: '📤 Отправляю через figma.fetch…', pct: 90 });
        var fbody = JSON.stringify({ data: auditData, spreadsheetId: spreadsheetId || null });
        var fres = await figma.fetch(scriptUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: fbody,
          redirect: 'follow'
        });

        if (!fres.ok) {
          // Читаем тело ответа чтобы понять причину ошибки
          var errBody = '';
          try { errBody = await fres.text(); } catch (_) {}
          var preview = errBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
          throw new Error('HTTP ' + fres.status + (preview ? ': ' + preview : ''));
        }

        var responseText = await fres.text();
        var fresult;
        try {
          fresult = JSON.parse(responseText);
        } catch (_) {
          throw new Error('Ответ не JSON. Первые 200 символов: ' + responseText.slice(0, 200));
        }

        // Показываем что реально записалось (для диагностики)
        var writtenInfo = '';
        if (fresult.written) {
          var parts = [];
          var refWritten = fresult.written['Ref Colors'];
          var refUnitsWritten = fresult.written['Ref Units'];
          var sysUnitsWritten = fresult.written['Sys Units'];
          var cmpUnitsWritten = fresult.written['Component Units'];
          if (typeof refWritten === 'number') parts.push('Ref Colors: ' + refWritten + ' строк');
          if (typeof refUnitsWritten === 'number') parts.push('Ref Units: ' + refUnitsWritten);
          if (typeof sysUnitsWritten === 'number') parts.push('Sys Units: ' + sysUnitsWritten);
          if (typeof cmpUnitsWritten === 'number') parts.push('Component Units: ' + cmpUnitsWritten);
          if (parts.length) writtenInfo = ' | ' + parts.join(' · ');
        }

        var versionInfo = fresult.codeVersion ? ' [Code.gs ' + fresult.codeVersion + ']' : ' [Code.gs: старая версия — задеплой новую!]';

        if (fresult.errors && fresult.errors.length > 0) {
          post('status', {
            text: '⚠️ Записано с ошибками: ' + fresult.errors.join(' | ') + writtenInfo + versionInfo,
            pct: 100
          });
        } else {
          post('status', { text: '✅ Готово!' + writtenInfo + versionInfo, pct: 100 });
        }
        post('audit-complete', { sheetUrl: fresult.url || null, sheetId: fresult.spreadsheetId || null });
        sentViaFigmaFetch = true;

      } catch (fe) {
        // Показываем точную причину — не просто "CORS"
        post('error', {
          text: '❌ figma.fetch завершился с ошибкой:\n' + fe.message +
                '\n\nПроверь: Apps Script задеплоен? URL скопирован верно? ' +
                'Открой в браузере GET-запрос к scriptUrl — должен вернуть {"status":"ok"}'
        });
        return; // не падаем в UI fallback — там всё равно CORS
      }
    }

    if (!sentViaFigmaFetch) {
      // Только для окружений без figma.fetch (старые версии / browser preview)
      post('data-ready', {
        data:          auditData,
        scriptUrl:     scriptUrl,
        spreadsheetId: spreadsheetId || null
      });
    }

  } catch (err) {
    post('error', { text: err.message || String(err) });
  }
}


// ============================================================
// RockUP Token Import / Check — Safe upsert helpers
// ============================================================

function isRockupCollectionName(name) {
  return name.indexOf('Ref / ') === 0 || name.indexOf('Sys / ') === 0 || name.indexOf('Cmp / ') === 0 ||
         name.indexOf('NEW Ref / ') === 0 || name.indexOf('NEW Sys / ') === 0 || name.indexOf('NEW Cmp / ') === 0;
}

function normalizeCmpName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function getFullName(variable, collectionName) {
  if (variable.name && variable.name.indexOf('rp/') === 0) return variable.name;

  var prefixMap = {
    'Sys / Theme': 'rp/sys/',
    'Sys / Unit':  'rp/sys/unit/',
    'Ref / Color': 'rp/ref/color/',
    'Ref / Unit':  'rp/ref/unit/'
  };

  if (prefixMap[collectionName]) return prefixMap[collectionName] + variable.name;

  if (collectionName && collectionName.indexOf('Cmp / ') === 0) {
    var cmp = normalizeCmpName(collectionName.replace('Cmp / ', ''));
    return 'rp/cmp/' + cmp + '/' + variable.name;
  }

  return variable.name;
}

function buildFullNameFromRawName(name, collectionName) {
  if (String(name).indexOf('rp/') === 0) return name;

  var prefixMap = {
    'Sys / Theme':     'rp/sys/',
    'NEW Sys / Theme': 'rp/sys/',
    'Sys / Unit':      'rp/sys/unit/',
    'NEW Sys / Unit':  'rp/sys/unit/',
    'Ref / Color':     'rp/ref/color/',
    'NEW Ref / Color': 'rp/ref/color/',
    'Ref / Unit':      'rp/ref/unit/',
    'NEW Ref / Unit':  'rp/ref/unit/'
  };

  if (prefixMap[collectionName]) return prefixMap[collectionName] + name;

  if (collectionName && (collectionName.indexOf('Cmp / ') === 0 || collectionName.indexOf('NEW Cmp / ') === 0)) {
    var cmp = normalizeCmpName(collectionName.replace('NEW Cmp / ', '').replace('Cmp / ', ''));
    return 'rp/cmp/' + cmp + '/' + name;
  }

  return name;
}

function localNameFromFullName(collectionName, fullName) {
  // Важно для структуры Figma Variables.
  // Раньше импорт создавал переменные без префикса коллекции: item / list / complex.
  // Поэтому в панели Groups получалось: All → item/list/complex.
  // Для восстановления исходной структуры RockUP нужно создавать переменные полным именем:
  // rp/cmp/pagination/item/..., rp/ref/color/brand/..., rp/sys/color/...
  return String(fullName || '');
}

function ensureFullPathVariableName(variable, collectionName, fullTokenName, result) {
  if (!variable || !fullTokenName) return;
  if (!isRockupCollectionName(collectionName)) return;
  if (variable.name === fullTokenName) return;

  try {
    variable.name = fullTokenName;
    if (result && result.stats) {
      result.stats.variablesRenamed = (result.stats.variablesRenamed || 0) + 1;
    }
  } catch (e) {
    if (result && result.stats) {
      result.stats.warnings++;
      result.stats.renameWarnings = (result.stats.renameWarnings || 0) + 1;
    }
    if (result && result.issues) {
      result.issues.push(issue(
        'warning',
        'rename-variable-failed',
        collectionName,
        fullTokenName,
        '',
        fullTokenName,
        variable.name,
        'Не удалось переименовать переменную в полный путь: ' + (e.message || String(e))
      ));
    }
  }
}

function toHex(c) {
  var r = Math.round(c.r * 255).toString(16);
  var g = Math.round(c.g * 255).toString(16);
  var b = Math.round(c.b * 255).toString(16);
  return '#' + (r.length < 2 ? '0' + r : r) +
               (g.length < 2 ? '0' + g : g) +
               (b.length < 2 ? '0' + b : b);
}

function toHexWithAlpha(c) {
  var base = toHex(c);
  var a = c.a !== undefined ? c.a : 1;
  if (a >= 0.999) return base.toLowerCase();
  var aa = Math.round(a * 255).toString(16);
  return (base + (aa.length < 2 ? '0' + aa : aa)).toLowerCase();
}

function hexToRgba(hex) {
  if (typeof hex !== 'string') throw new Error('Ожидался цвет в формате #RRGGBB или #RRGGBBAA.');
  var h = hex.trim().replace('#', '');
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (h.length !== 6 && h.length !== 8) throw new Error('Некорректный цвет: ' + hex);
  var r = parseInt(h.slice(0, 2), 16) / 255;
  var g = parseInt(h.slice(2, 4), 16) / 255;
  var b = parseInt(h.slice(4, 6), 16) / 255;
  var a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r: r, g: g, b: b, a: a };
}

function currentValueToComparable(rawVal, type, varById, collById) {
  if (rawVal === undefined || rawVal === null) return null;

  if (rawVal && rawVal.type === 'VARIABLE_ALIAS') {
    var ref = varById[rawVal.id];
    if (ref) {
      var refColl = collById[ref.variableCollectionId];
      var refCollName = refColl ? refColl.name : '';
      return '@' + getFullName(ref, refCollName);
    }
    return '@' + rawVal.id;
  }

  if (type === 'COLOR' && rawVal && rawVal.r !== undefined) return toHexWithAlpha(rawVal);
  if (typeof rawVal === 'number') return rawVal;
  if (typeof rawVal === 'boolean') return rawVal;
  if (typeof rawVal === 'string') return rawVal;
  return JSON.stringify(rawVal);
}

function expectedValueToComparable(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    if (value.indexOf('@') === 0) return value;
    if (value.indexOf('#') === 0) return value.toLowerCase();
    return value;
  }
  if (value && typeof value === 'object' && value.alias) return '@' + value.alias;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

function valuesEqual(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  return a === b;
}

function normalizeType(t) {
  var type = String(t || '').toUpperCase();
  if (type === 'NUMBER') return 'FLOAT';
  if (['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'].indexOf(type) !== -1) return type;
  return type || 'UNKNOWN';
}

function normalizeBackup(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('JSON пустой или имеет неверный формат.');

  // Format A: clean variables backup
  // { "Ref / Color": { "rp/ref/color/white": { "t": "COLOR", "Mode 1": "#fff" } } }
  var collectionKeys = Object.keys(raw).filter(function (key) {
    return (key.indexOf('Sys / ') === 0 || key.indexOf('Ref / ') === 0 || key.indexOf('Cmp / ') === 0) && raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key]);
  });

  if (collectionKeys.length > 0) {
    var clean = {};
    for (var ci = 0; ci < collectionKeys.length; ci++) {
      var collName = collectionKeys[ci];
      clean[collName] = {};
      var tokenMap = raw[collName] || {};
      var tokenNames = Object.keys(tokenMap);
      for (var ti = 0; ti < tokenNames.length; ti++) {
        var tokenName = tokenNames[ti];
        var entry = tokenMap[tokenName] || {};
        var modes = {};
        Object.keys(entry).forEach(function (k) {
          if (k !== 't' && k !== 'type' && k !== 'description' && k !== 'scopes' && k !== 'codeSyntax') modes[k] = entry[k];
        });
        clean[collName][tokenName] = {
          type: normalizeType(entry.t || entry.type || 'UNKNOWN'),
          modes: modes,
          scopes: entry.scopes || null,
          description: entry.description || ''
        };
      }
    }
    return { format: 'variables-backup', collections: clean };
  }

  // Format B: audit JSON with allTokens
  if (Array.isArray(raw.allTokens)) {
    var fromAudit = {};
    for (var i = 0; i < raw.allTokens.length; i++) {
      var t = raw.allTokens[i];
      if (!t || !t.collection || !t.name) continue;
      if (!fromAudit[t.collection]) fromAudit[t.collection] = {};
      var fullName = buildFullNameFromRawName(t.name, t.collection);
      fromAudit[t.collection][fullName] = {
        type: normalizeType(t.type || 'UNKNOWN'),
        modes: t.modes || {},
        scopes: t.scopes || null,
        description: t.description || ''
      };
    }
    return { format: 'audit-allTokens', collections: fromAudit };
  }

  throw new Error('Не нашёл коллекции (Sys / ..., Ref / ..., Cmp / ...) и не нашёл массив allTokens. Загрузить нужно backup JSON или audit JSON.');
}

function countExpectedTokens(collections) {
  var count = 0;
  Object.keys(collections).forEach(function (c) { count += Object.keys(collections[c] || {}).length; });
  return count;
}

function issue(severity, category, collection, token, mode, expected, actual, message) {
  return {
    severity: severity,
    category: category,
    collection: collection || '',
    token: token || '',
    mode: mode || '',
    expected: expected === undefined ? '' : expected,
    actual: actual === undefined ? '' : actual,
    message: message || ''
  };
}

function buildCurrentIndexes(allVars, allCollections) {
  var collById = buildMap(allCollections, 'id');
  var varById = buildMap(allVars, 'id');
  var collectionsByName = {};
  var currentByCollection = {};
  var tokenByFullName = {};
  var tokenByScopedName = {};

  for (var ci = 0; ci < allCollections.length; ci++) {
    collectionsByName[allCollections[ci].name] = allCollections[ci];
  }

  for (var vi = 0; vi < allVars.length; vi++) {
    var v = allVars[vi];
    var c = collById[v.variableCollectionId];
    if (!c) continue;
    var fullName = getFullName(v, c.name);
    if (!currentByCollection[c.name]) currentByCollection[c.name] = {};
    currentByCollection[c.name][fullName] = v;
    tokenByFullName[fullName] = v;
    tokenByScopedName[c.name + '|' + fullName] = v;
  }

  return {
    collById: collById,
    varById: varById,
    collectionsByName: collectionsByName,
    currentByCollection: currentByCollection,
    tokenByFullName: tokenByFullName,
    tokenByScopedName: tokenByScopedName
  };
}

function getModeIdByName(collection, name) {
  for (var i = 0; i < collection.modes.length; i++) {
    if (collection.modes[i].name === name) return collection.modes[i].modeId;
  }
  return null;
}

function modeNamesFromExpectedTokenMap(tokenMap) {
  var set = {};
  Object.keys(tokenMap || {}).forEach(function (tokenName) {
    var modes = tokenMap[tokenName].modes || {};
    Object.keys(modes).forEach(function (m) { set[m] = true; });
  });
  return Object.keys(set);
}

function convertExpectedValueToFigma(value, type, tokenByFullName) {
  if (value === undefined || value === null) return null;

  var aliasName = null;
  if (typeof value === 'string' && value.indexOf('@') === 0) aliasName = value.slice(1);
  if (value && typeof value === 'object' && value.alias) aliasName = value.alias;

  if (aliasName) {
    var target = tokenByFullName[aliasName];
    if (!target) throw new Error('Alias target не найден: @' + aliasName);
    return figma.variables.createVariableAlias(target);
  }

  if (type === 'COLOR') return hexToRgba(value);
  if (type === 'FLOAT') {
    var n = Number(value);
    if (isNaN(n)) throw new Error('Ожидалось число/FLOAT, получено: ' + value);
    return n;
  }
  if (type === 'BOOLEAN') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error('Ожидалось BOOLEAN, получено: ' + value);
  }
  if (type === 'STRING') return String(value);

  throw new Error('Неподдерживаемый тип переменной: ' + type);
}

async function checkBackupJson(rawJson, options) {
  try {
    post('status', { text: 'Разбираю JSON…', pct: 5 });

    var normalized = normalizeBackup(rawJson);
    var expectedCollections = normalized.collections;
    var expectedCollectionNames = Object.keys(expectedCollections).sort();

    post('status', { text: 'Читаю локальные Variables из Figma…', pct: 18 });

    var allVars = await figma.variables.getLocalVariablesAsync();
    var allCollections = await figma.variables.getLocalVariableCollectionsAsync();
    var idx = buildCurrentIndexes(allVars, allCollections);

    post('status', { text: 'Сравниваю коллекции, токены, modes и значения…', pct: 42 });

    var issues = [];
    var stats = {
      format: normalized.format,
      expectedCollections: expectedCollectionNames.length,
      foundCollections: 0,
      missingCollections: 0,
      extraCollections: 0,
      expectedTokens: countExpectedTokens(expectedCollections),
      foundTokens: 0,
      missingTokens: 0,
      extraTokens: 0,
      typeMismatches: 0,
      missingModes: 0,
      valueMismatches: 0,
      checkedValues: 0
    };

    for (var ec = 0; ec < expectedCollectionNames.length; ec++) {
      var collName = expectedCollectionNames[ec];
      var expectedTokenMap = expectedCollections[collName] || {};
      var currentColl = idx.collectionsByName[collName];

      if (!currentColl) {
        stats.missingCollections++;
        issues.push(issue('error', 'missing-collection', collName, '', '', 'collection exists', 'not found', 'Коллекция отсутствует в текущем файле.'));
        var missedTokenNames = Object.keys(expectedTokenMap);
        stats.missingTokens += missedTokenNames.length;
        for (var mtc = 0; mtc < missedTokenNames.length; mtc++) {
          issues.push(issue('error', 'missing-token', collName, missedTokenNames[mtc], '', 'token exists', 'not found', 'Токен отсутствует, потому что коллекция не найдена.'));
        }
        continue;
      }

      stats.foundCollections++;
      var currentTokens = idx.currentByCollection[collName] || {};
      var expectedTokenNames = Object.keys(expectedTokenMap).sort(compareTokenNames);

      for (var et = 0; et < expectedTokenNames.length; et++) {
        var expectedTokenName = expectedTokenNames[et];
        var expectedEntry = expectedTokenMap[expectedTokenName];
        var currentVar = currentTokens[expectedTokenName];

        if (!currentVar) {
          stats.missingTokens++;
          issues.push(issue('error', 'missing-token', collName, expectedTokenName, '', 'token exists', 'not found', 'Токен отсутствует в текущем файле.'));
          continue;
        }

        stats.foundTokens++;

        if (expectedEntry.type && currentVar.resolvedType !== expectedEntry.type) {
          stats.typeMismatches++;
          issues.push(issue('error', 'type-mismatch', collName, expectedTokenName, '', expectedEntry.type, currentVar.resolvedType, 'Тип токена отличается.'));
        }

        var expectedModes = Object.keys(expectedEntry.modes || {});
        for (var em = 0; em < expectedModes.length; em++) {
          var modeName = expectedModes[em];
          var modeId = getModeIdByName(currentColl, modeName);

          if (!modeId) {
            stats.missingModes++;
            issues.push(issue('error', 'missing-mode', collName, expectedTokenName, modeName, 'mode exists', 'not found', 'Mode отсутствует в текущей коллекции.'));
            continue;
          }

          var expectedComparable = expectedValueToComparable(expectedEntry.modes[modeName]);
          var rawCurrent = currentVar.valuesByMode[modeId];
          var currentComparable = currentValueToComparable(rawCurrent, currentVar.resolvedType, idx.varById, idx.collById);
          stats.checkedValues++;

          if (!valuesEqual(expectedComparable, currentComparable)) {
            stats.valueMismatches++;
            var cat = (typeof expectedComparable === 'string' && expectedComparable.indexOf('@') === 0) ? 'alias-mismatch' : 'value-mismatch';
            issues.push(issue('error', cat, collName, expectedTokenName, modeName, expectedComparable, currentComparable, 'Значение mode отличается от backup JSON.'));
          }
        }
      }

      if (options && options.checkExtraTokens !== false) {
        var currentTokenNames = Object.keys(currentTokens).sort(compareTokenNames);
        for (var ct = 0; ct < currentTokenNames.length; ct++) {
          if (!expectedTokenMap[currentTokenNames[ct]]) {
            stats.extraTokens++;
            issues.push(issue('warning', 'extra-token', collName, currentTokenNames[ct], '', 'not in backup', 'exists in Figma', 'Токен есть в Figma, но отсутствует в backup JSON.'));
          }
        }
      }
    }

    if (options && options.checkExtraCollections !== false) {
      var localCollectionNames = Object.keys(idx.collectionsByName).sort();
      for (var lc = 0; lc < localCollectionNames.length; lc++) {
        var localName = localCollectionNames[lc];
        if (isRockupCollectionName(localName) && !expectedCollections[localName]) {
          stats.extraCollections++;
          issues.push(issue('warning', 'extra-collection', localName, '', '', 'not in backup', 'exists in Figma', 'Коллекция есть в Figma, но отсутствует в backup JSON.'));
        }
      }
    }

    post('status', { text: 'Формирую отчёт…', pct: 85 });

    var hasErrors = issues.some(function (i) { return i.severity === 'error'; });
    var hasWarnings = issues.some(function (i) { return i.severity === 'warning'; });

    post('check-complete', {
      report: {
        title: 'RockUP Token Check Report',
        generatedAt: new Date().toISOString(),
        status: hasErrors ? 'fail' : (hasWarnings ? 'warning' : 'pass'),
        stats: stats,
        issues: issues
      }
    });
  } catch (err) {
    post('error', { text: err && err.message ? err.message : String(err) });
  }
}

async function importBackupJson(rawJson, options) {
  try {
    post('status', { text: 'Разбираю JSON…', pct: 5 });

    var normalized = normalizeBackup(rawJson);
    var expectedCollections = normalized.collections;
    var collectionNames = Object.keys(expectedCollections).sort();

    var result = {
      title: 'RockUP Token Import Report',
      generatedAt: new Date().toISOString(),
      status: 'pass',
      format: normalized.format,
      stats: {
        collectionsCreated: 0,
        collectionsReused: 0,
        modesCreated: 0,
        modesReused: 0,
        variablesCreated: 0,
        variablesReused: 0,
        variablesRenamed: 0,
        renameWarnings: 0,
        valuesUpdated: 0,
        valuesSkipped: 0,
        errors: 0,
        warnings: 0
      },
      issues: []
    };

    post('status', { text: 'Читаю текущие Variables…', pct: 12 });

    var allVars = await figma.variables.getLocalVariablesAsync();
    var allCollections = await figma.variables.getLocalVariableCollectionsAsync();
    var idx = buildCurrentIndexes(allVars, allCollections);

    // 1) Ensure collections and modes.
    var collectionByName = idx.collectionsByName;
    var modeIdByCollectionAndMode = {};

    for (var c = 0; c < collectionNames.length; c++) {
      var collName = collectionNames[c];
      var tokenMap = expectedCollections[collName] || {};
      var modeNames = modeNamesFromExpectedTokenMap(tokenMap);
      var coll = collectionByName[collName];

      post('status', { text: 'Готовлю коллекцию: ' + collName, pct: 18 + Math.round((c / Math.max(collectionNames.length, 1)) * 18) });

      if (!coll) {
        coll = figma.variables.createVariableCollection(collName);
        collectionByName[collName] = coll;
        result.stats.collectionsCreated++;

        // Fresh collection has one default mode. Rename it to the first expected mode when needed.
        if (modeNames.length > 0 && coll.modes.length > 0 && coll.modes[0].name !== modeNames[0]) {
          try { coll.renameMode(coll.modes[0].modeId, modeNames[0]); } catch (e) {
            result.stats.warnings++;
            result.issues.push(issue('warning', 'rename-mode-failed', collName, '', modeNames[0], modeNames[0], coll.modes[0].name, e.message || String(e)));
          }
        }
      } else {
        result.stats.collectionsReused++;
      }

      modeIdByCollectionAndMode[collName] = {};

      for (var m = 0; m < modeNames.length; m++) {
        var modeName = modeNames[m];
        var existingModeId = getModeIdByName(coll, modeName);
        if (existingModeId) {
          modeIdByCollectionAndMode[collName][modeName] = existingModeId;
          result.stats.modesReused++;
          continue;
        }

        if (options && options.createMissingModes === false) {
          result.stats.valuesSkipped++;
          result.stats.warnings++;
          result.issues.push(issue('warning', 'missing-mode-skipped', collName, '', modeName, 'mode exists', 'not found', 'Mode не создан, потому что опция createMissingModes выключена.'));
          continue;
        }

        try {
          var newModeId = coll.addMode(modeName);
          modeIdByCollectionAndMode[collName][modeName] = newModeId;
          result.stats.modesCreated++;
        } catch (e2) {
          result.stats.errors++;
          result.issues.push(issue('error', 'add-mode-failed', collName, '', modeName, 'mode exists', 'not created', e2.message || String(e2)));
        }
      }
    }

    // Refresh collections after mode changes.
    allCollections = await figma.variables.getLocalVariableCollectionsAsync();
    allVars = await figma.variables.getLocalVariablesAsync();
    idx = buildCurrentIndexes(allVars, allCollections);

    // 2) Create/reuse variables without setting aliases yet.
    var tokenByFullName = idx.tokenByFullName;
    var tokenByScopedName = idx.tokenByScopedName;

    var totalTokens = countExpectedTokens(expectedCollections);
    var doneTokens = 0;

    for (var ci = 0; ci < collectionNames.length; ci++) {
      var collectionName = collectionNames[ci];
      var collection = idx.collectionsByName[collectionName];
      if (!collection) continue;

      var tokens = expectedCollections[collectionName] || {};
      var tokenNames = Object.keys(tokens).sort(compareTokenNames);
      for (var ti = 0; ti < tokenNames.length; ti++) {
        doneTokens++;
        var fullTokenName = tokenNames[ti];
        var entry = tokens[fullTokenName];
        var scopedKey = collectionName + '|' + fullTokenName;
        var v = tokenByScopedName[scopedKey];

        post('status', { text: 'Создаю/нахожу токены: ' + doneTokens + ' из ' + totalTokens, pct: 38 + Math.round((doneTokens / Math.max(totalTokens, 1)) * 18) });

        if (!v) {
          if (options && options.createMissingVariables === false) {
            result.stats.valuesSkipped++;
            result.stats.warnings++;
            result.issues.push(issue('warning', 'missing-variable-skipped', collectionName, fullTokenName, '', 'token exists', 'not found', 'Токен не создан, потому что опция createMissingVariables выключена.'));
            continue;
          }

          try {
            var localName = localNameFromFullName(collectionName, fullTokenName);
            v = figma.variables.createVariable(localName, collection, entry.type);
            result.stats.variablesCreated++;
            tokenByScopedName[scopedKey] = v;
            tokenByFullName[fullTokenName] = v;
          } catch (e3) {
            result.stats.errors++;
            result.issues.push(issue('error', 'create-variable-failed', collectionName, fullTokenName, '', entry.type, 'not created', e3.message || String(e3)));
            continue;
          }
        } else {
          result.stats.variablesReused++;
          tokenByFullName[fullTokenName] = v;
        }

        ensureFullPathVariableName(v, collectionName, fullTokenName, result);

        if (entry.scopes && Array.isArray(entry.scopes)) {
          try { v.scopes = entry.scopes; } catch (_) {}
        }
        if (entry.description) {
          try { v.description = entry.description; } catch (_) {}
        }
      }
    }

    // Refresh variables after creation.
    allCollections = await figma.variables.getLocalVariableCollectionsAsync();
    allVars = await figma.variables.getLocalVariablesAsync();
    idx = buildCurrentIndexes(allVars, allCollections);
    tokenByFullName = idx.tokenByFullName;
    tokenByScopedName = idx.tokenByScopedName;

    // 3) Set non-alias values first, then aliases.
    var valueJobsPlain = [];
    var valueJobsAlias = [];

    collectionNames.forEach(function (collectionName) {
      var tokenMap = expectedCollections[collectionName] || {};
      var collection = idx.collectionsByName[collectionName];
      if (!collection) return;

      Object.keys(tokenMap).forEach(function (fullTokenName) {
        var entry = tokenMap[fullTokenName];
        var v = tokenByScopedName[collectionName + '|' + fullTokenName];
        if (!v) return;
        if (v.resolvedType !== entry.type) {
          result.stats.errors++;
          result.issues.push(issue('error', 'type-mismatch-skip-values', collectionName, fullTokenName, '', entry.type, v.resolvedType, 'Тип существующего токена отличается, значения не обновлялись.'));
          return;
        }

        Object.keys(entry.modes || {}).forEach(function (modeName) {
          var modeId = getModeIdByName(collection, modeName);
          if (!modeId) {
            result.stats.valuesSkipped++;
            result.stats.warnings++;
            result.issues.push(issue('warning', 'missing-mode-skip-value', collectionName, fullTokenName, modeName, 'mode exists', 'not found', 'Значение не установлено, потому что mode отсутствует.'));
            return;
          }

          var expectedVal = entry.modes[modeName];
          var isAlias = (typeof expectedVal === 'string' && expectedVal.indexOf('@') === 0) || (expectedVal && typeof expectedVal === 'object' && expectedVal.alias);
          var job = { collectionName: collectionName, fullTokenName: fullTokenName, variable: v, type: entry.type, modeName: modeName, modeId: modeId, value: expectedVal };
          if (isAlias) valueJobsAlias.push(job); else valueJobsPlain.push(job);
        });
      });
    });

    function applyJob(job) {
      try {
        var figmaValue = convertExpectedValueToFigma(job.value, job.type, tokenByFullName);
        var current = currentValueToComparable(job.variable.valuesByMode[job.modeId], job.variable.resolvedType, idx.varById, idx.collById);
        var expected = expectedValueToComparable(job.value);
        if (valuesEqual(current, expected)) {
          result.stats.valuesSkipped++;
          return;
        }
        job.variable.setValueForMode(job.modeId, figmaValue);
        result.stats.valuesUpdated++;
      } catch (e) {
        result.stats.errors++;
        result.issues.push(issue('error', 'set-value-failed', job.collectionName, job.fullTokenName, job.modeName, expectedValueToComparable(job.value), 'not set', e.message || String(e)));
      }
    }

    for (var pj = 0; pj < valueJobsPlain.length; pj++) {
      if (pj % 50 === 0) post('status', { text: 'Устанавливаю значения: ' + pj + ' из ' + valueJobsPlain.length, pct: 60 + Math.round((pj / Math.max(valueJobsPlain.length, 1)) * 15) });
      applyJob(valueJobsPlain[pj]);
    }

    // Refresh index after plain values; aliases need all variables to exist, not resolved values, but refresh helps comparable aliases.
    allCollections = await figma.variables.getLocalVariableCollectionsAsync();
    allVars = await figma.variables.getLocalVariablesAsync();
    idx = buildCurrentIndexes(allVars, allCollections);
    tokenByFullName = idx.tokenByFullName;

    for (var aj = 0; aj < valueJobsAlias.length; aj++) {
      if (aj % 50 === 0) post('status', { text: 'Восстанавливаю alias: ' + aj + ' из ' + valueJobsAlias.length, pct: 76 + Math.round((aj / Math.max(valueJobsAlias.length, 1)) * 12) });
      applyJob(valueJobsAlias[aj]);
    }

    post('status', { text: 'Формирую отчёт импорта…', pct: 94 });

    result.status = result.stats.errors > 0 ? 'fail' : (result.stats.warnings > 0 ? 'warning' : 'pass');
    post('import-complete', { report: result });
  } catch (err) {
    post('error', { text: err && err.message ? err.message : String(err) });
  }
}


// ── Rebind Variables v4 — scan-all-fills strategy ────────────
// v1/v2: relied on getVariableByIdAsync — returns null cross-file.
// v3: relied on boundVariables.fills existing — Figma strips them on paste.
// v4: scans ALL SOLID fills on ALL nodes regardless of existing bindings.
//     Matches fill color hex → local variable, creates binding from scratch.
// ────────────────────────────────────────────────────────────
async function rebindVariables() {
  try {
    post('status', { text: '⏳ Читаю локальные переменные…', pct: 5 });

    var allVars        = await figma.variables.getLocalVariablesAsync();
    var allCollections = await figma.variables.getLocalVariableCollectionsAsync();
    var collById       = buildMap(allCollections, 'id');
    var varById        = buildMap(allVars, 'id');

    // localVarIds: IDs already pointing to a local variable (skip these)
    var localVarIds = {};
    for (var i = 0; i < allVars.length; i++) localVarIds[allVars[i].id] = true;

    // ── Build hex → variable[] map ───────────────────────────
    post('status', { text: '🎨 Строю карту цветов…', pct: 12 });

    function ch(v) { var s = Math.round(v * 255).toString(16); return s.length < 2 ? '0' + s : s; }
    function rgbaToHex6(r, g, b) { return ch(r) + ch(g) + ch(b); }

    function resolveToHex(variable, modeId, depth) {
      if ((depth || 0) > 8) return null;
      var val = variable.valuesByMode[modeId];
      if (!val) {
        var keys = Object.keys(variable.valuesByMode);
        if (!keys.length) return null;
        val = variable.valuesByMode[keys[0]];
      }
      if (!val) return null;
      if (val.r !== undefined) return rgbaToHex6(val.r, val.g, val.b);
      if (val.type === 'VARIABLE_ALIAS') {
        var tgt = varById[val.id];
        if (tgt) return resolveToHex(tgt, modeId, (depth || 0) + 1);
      }
      return null;
    }

    // hex6 → [{ variable, fullName, collName }]
    // deduplicated per variable (one entry per var, best-mode hex)
    var hexToVars = {};

    for (var vi = 0; vi < allVars.length; vi++) {
      var v    = allVars[vi];
      if (v.resolvedType !== 'COLOR') continue;
      var coll = collById[v.variableCollectionId];
      if (!coll) continue;
      var fn   = getFullName(v, coll.name);
      var seen = false;

      for (var mi = 0; mi < coll.modes.length; mi++) {
        var hex = resolveToHex(v, coll.modes[mi].modeId, 0);
        if (!hex) continue;
        if (!hexToVars[hex]) hexToVars[hex] = [];
        // one entry per variable id to avoid duplicates
        var alreadyIn = hexToVars[hex].some(function(e) { return e.variable.id === v.id; });
        if (!alreadyIn) hexToVars[hex].push({ variable: v, fullName: fn, collName: coll.name });
        seen = true;
      }
    }

    var hexCount = Object.keys(hexToVars).length;
    post('status', { text: '🎨 ' + hexCount + ' уникальных цветов в ' + allVars.length + ' переменных', pct: 22 });

    // ── Find best match for a hex + node context ─────────────
    function findBestMatch(hex, nodeName, parentName) {
      var candidates = hexToVars[hex];
      if (!candidates || candidates.length === 0) return null;
      if (candidates.length === 1) return candidates[0].variable;

      var context = ((nodeName || '') + ' ' + (parentName || '')).toLowerCase();
      var scored = candidates.map(function(c) {
        var seg   = c.fullName.split('/').pop().toLowerCase();
        var score = 0;
        if (context.indexOf(seg) !== -1)          score += 10;
        if (c.fullName.indexOf('rp/cmp/')  === 0) score += 6;
        if (c.fullName.indexOf('rp/sys/')  === 0) score += 2;
        if (c.fullName.indexOf('rp/ref/')  === 0) score -= 2;
        return { entry: c, score: score };
      });
      scored.sort(function(a, b) { return b.score - a.score; });
      if (scored[0].score > scored[1].score) return scored[0].entry.variable;
      return null; // ambiguous
    }

    var rebound = 0, alreadyOk = 0, notFound = 0, ambiguous = 0;
    var assignErrors = [], diagSamples = [];

    // ── Process one node ─────────────────────────────────────
    function processNodeSync(node) {
      // Skip nodes with no fills or mixed fills
      if (!node.fills || node.fills === figma.mixed || !node.fills.length) return;

      var newFills = node.fills.slice();
      var changed  = false;

      for (var fi = 0; fi < newFills.length; fi++) {
        var paint = newFills[fi];
        if (!paint || paint.type !== 'SOLID') continue;
        if (!paint.color || paint.color.r === undefined) continue;

        // Check existing binding
        var existingBind = node.boundVariables &&
                           node.boundVariables.fills &&
                           node.boundVariables.fills[fi] &&
                           node.boundVariables.fills[fi].color;
        if (existingBind && localVarIds[existingBind.id]) { alreadyOk++; continue; }

        var hex    = rgbaToHex6(paint.color.r, paint.color.g, paint.color.b);
        var pName  = node.parent ? node.parent.name : '';
        var target = findBestMatch(hex, node.name, pName);

        if (diagSamples.length < 10) {
          var cands = hexToVars[hex] ? hexToVars[hex].length : 0;
          diagSamples.push(
            '"' + node.name + '" #' + hex + ' ' + cands + ' кандид.' +
            (target ? ' → ✓ ' + getFullName(target, (collById[target.variableCollectionId] || {}).name || '') : (cands > 1 ? ' → ✗ неоднозначно' : ' → ✗ не найден'))
          );
        }

        if (!target) {
          if (hexToVars[hex] && hexToVars[hex].length > 1) ambiguous++;
          else notFound++;
          continue;
        }

        try {
          newFills[fi] = figma.variables.setBoundVariableForPaint(newFills[fi], 'color', target);
          changed = true;
        } catch (e) {
          assignErrors.push('setBoundVar "' + node.name + '" [' + fi + ']: ' + (e.message || e));
        }
      }

      if (changed) {
        try {
          node.fills = newFills;
          rebound++;
        } catch (e) {
          assignErrors.push('fills assign "' + node.name + '": ' + (e.message || e));
        }
      }
    }

    // Strokes
    function processStrokesSync(node) {
      if (!node.strokes || node.strokes === figma.mixed || !node.strokes.length) return;

      var newStrokes = node.strokes.slice();
      var changed    = false;

      for (var si = 0; si < newStrokes.length; si++) {
        var paint = newStrokes[si];
        if (!paint || paint.type !== 'SOLID' || !paint.color) continue;

        var existingBind = node.boundVariables &&
                           node.boundVariables.strokes &&
                           node.boundVariables.strokes[si] &&
                           node.boundVariables.strokes[si].color;
        if (existingBind && localVarIds[existingBind.id]) { alreadyOk++; continue; }

        var hex    = rgbaToHex6(paint.color.r, paint.color.g, paint.color.b);
        var pName  = node.parent ? node.parent.name : '';
        var target = findBestMatch(hex, node.name, pName);
        if (!target) continue;

        try {
          newStrokes[si] = figma.variables.setBoundVariableForPaint(newStrokes[si], 'color', target);
          changed = true;
        } catch (e) {
          assignErrors.push('stroke "' + node.name + '": ' + (e.message || e));
        }
      }

      if (changed) {
        try { node.strokes = newStrokes; rebound++; }
        catch (e) { assignErrors.push('strokes assign "' + node.name + '": ' + (e.message || e)); }
      }
    }

    // ── Collect nodes — skip INSTANCE children ───────────────
    var roots = figma.currentPage.selection.length > 0
      ? figma.currentPage.selection
      : [figma.currentPage];

    var queue = [];
    function enqueue(node) {
      queue.push(node);
      if ('children' in node && node.type !== 'INSTANCE') {
        for (var ci = 0; ci < node.children.length; ci++) enqueue(node.children[ci]);
      }
    }
    for (var ri = 0; ri < roots.length; ri++) enqueue(roots[ri]);

    var componentCount = queue.filter(function(n) { return n.type === 'COMPONENT' || n.type === 'COMPONENT_SET'; }).length;
    var instanceCount  = queue.filter(function(n) { return n.type === 'INSTANCE'; }).length;

    post('status', {
      text: '🔗 Обхожу ' + queue.length + ' нодов (компонентов: ' + componentCount + ')…',
      pct: 28
    });

    for (var qi = 0; qi < queue.length; qi++) {
      if (qi % 80 === 0) {
        post('status', {
          text: '🔗 ' + qi + ' / ' + queue.length,
          pct: 28 + Math.round((qi / Math.max(queue.length, 1)) * 68)
        });
      }
      processNodeSync(queue[qi]);
      processStrokesSync(queue[qi]);
    }

    var summary = 'Перепривязано нодов: ' + rebound +
                  ' | Уже ок: ' + alreadyOk +
                  ' | Не найдено: ' + notFound +
                  ' | Неоднозначно: ' + ambiguous +
                  (assignErrors.length ? ' | Ошибок: ' + assignErrors.length : '');

    post('rebind-complete', {
      rebound:        rebound,
      alreadyOk:      alreadyOk,
      notFound:       notFound,
      ambiguous:      ambiguous,
      errors:         assignErrors,
      summary:        summary,
      componentCount: componentCount,
      instanceCount:  instanceCount,
      diagSamples:    diagSamples,
      hexCount:       hexCount
    });

  } catch (err) {
    post('error', { text: err.message || String(err) });
  }
}
