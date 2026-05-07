// ============================================================
// RockUP Token Audit — Figma Plugin
// code.js — Main Thread (runs in Figma sandbox)
// ============================================================

// ── Team defaults — fill these once, commit to repo ─────────
// Все участники команды получат их автоматически.
// scriptUrl:     задеплоенный URL Google Apps Script Web App
// spreadsheetId: ID Google Sheets таблицы (часть URL между /d/ и /edit)
var TEAM_DEFAULTS = {
  scriptUrl:     'https://script.google.com/macros/s/AKfycbwFHCdMDYxRlQLDllJ7BVBijtJxCbGNc_Jp8CAmCURkm0BMDZaED_DyBPGXFuwtK3L9/exec',
  spreadsheetId: '1Cv1kW-06_uk2FIR6okKtea9CwL_CMpWiwufnuHDPs7U'
};
// ────────────────────────────────────────────────────────────

figma.showUI(__html__, { width: 440, height: 380, themeColors: true });

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
    'NEW Sys / Theme': 'rp/sys/',
    'NEW Sys / Unit':  'rp/sys/unit/',
    'NEW Ref / Color': 'rp/ref/color/',
    'NEW Ref / Unit':  'rp/ref/unit/'
  };

  if (prefixMap[collectionName]) return prefixMap[collectionName] + variable.name;

  if (collectionName && collectionName.indexOf('NEW Cmp / ') === 0) {
    var cmp = collectionName.replace('NEW Cmp / ', '').toLowerCase().replace(/\s+/g, '-');
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

// ── Helper: RGBA → hex ───────────────────────────────────────
function toHex(c) {
  var r = Math.round(c.r * 255).toString(16);
  var g = Math.round(c.g * 255).toString(16);
  var b = Math.round(c.b * 255).toString(16);
  return '#' + (r.length < 2 ? '0' + r : r) +
               (g.length < 2 ? '0' + g : g) +
               (b.length < 2 ? '0' + b : b);
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

// ── Main audit function ─────────────────────────────────────
async function runAudit(scriptUrl, spreadsheetId) {
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
      if (coll.name === 'NEW Sys / Theme') sysThemeColl = coll;
      if (coll.name === 'NEW Ref / Color') refColorColl = coll;
      if (coll.name.indexOf('NEW Cmp / ') === 0) cmpColls.push(coll);
    }

    if (!sysThemeColl) {
      throw new Error('Коллекция "NEW Sys / Theme" не найдена. Убедись что открыт RockUP UI Kit с подключёнными библиотеками.');
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

    // Ref hex values
    var refHexLight = {};
    if (refColorColl) {
      var refVars = [];
      for (var vi = 0; vi < allVars.length; vi++) {
        if (allVars[vi].variableCollectionId === refColorColl.id) refVars.push(allVars[vi]);
      }
      var rModeId = refColorColl.modes[0].modeId;
      for (var ri = 0; ri < refVars.length; ri++) {
        var rv = refVars[ri];
        var rval = rv.valuesByMode[rModeId];
        if (rval && rval.r !== undefined) {
          refHexLight[getFullName(rv, refColorColl.name)] = toHex(rval);
        }
      }
    }

    post('status', { text: '🔍 Маппинг компонентных токенов…', pct: 30 });

    // Component details
    var componentDetails = [];
    var compNamesArr = [];

    for (var ki = 0; ki < cmpColls.length; ki++) {
      var cmpColl = cmpColls[ki];
      var compName = cmpColl.name.replace('NEW Cmp / ', '').trim();
      if (compNamesArr.indexOf(compName) === -1) compNamesArr.push(compName);

      var cmpMode = cmpColl.modes[0].modeId;
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
          usedToken:      sysToken,
          auditToken:     sysToken,
          tokenClass:     tokenClass,
          lightAlias:     lightAlias,
          darkAlias:      darkAlias,
          note:           null
        });
      }
    }

    compNamesArr.sort();

    // Sort component details alphabetically by component name, then by token
    componentDetails.sort(function(a, b) {
      if (a.component < b.component) return -1;
      if (a.component > b.component) return 1;
      if (a.componentToken < b.componentToken) return -1;
      if (a.componentToken > b.componentToken) return 1;
      return 0;
    });

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

    // Summary
    var now = new Date();
    var months = ['январе','феврале','марте','апреле','мае','июне','июле','августе','сентябре','октябре','ноябре','декабре'];
    var monthYear = 'май ' + now.getFullYear();

    var summary = {
      title:    'Figma token audit — NEW Cmp x NEW Sys / Theme (' + monthYear + ')',
      subtitle: 'Источник: Figma Plugin API — matrix ссылок на переменные/alias tokens, не hex-совпадения.',
      metrics: [
        { label: 'Компонентов в аудите',                      value: compNamesArr.length },
        { label: 'Уникальных системных токенов',              value: Object.keys(tokenCompMap).length },
        { label: 'Компонентных токенов (rp/cmp/*)',           value: componentDetails.length },
        { label: 'Токенов с light≠dark (different)',          value: lightDarkRows.filter(function(r) { return r.themeDelta === 'different'; }).length },
        { label: 'Токенов с light=dark (same)',               value: lightDarkRows.filter(function(r) { return r.themeDelta === 'same'; }).length },
        { label: 'Alias-конфликтов (same Light, diff Dark)',  value: aliasDuplicates.filter(function(r) { return r.groupType === 'same Light, different Dark'; }).length }
      ],
      topShared: tokenOverlaps.slice(0, 10).map(function(r) {
        return { token: r.token, numComponents: r.numComponents, occurrences: r.numOccurrences, components: r.components };
      }),
      generatedAt: now.toISOString()
    };

    // Ref Colors — sorted by token name
    var refColorsArr = [];
    var refColorKeys = Object.keys(refHexLight);
    for (var rci = 0; rci < refColorKeys.length; rci++) {
      var rcName = refColorKeys[rci];
      var rcParts = rcName.split('/');
      var rcColorIdx = rcParts.indexOf('color');
      var rcGroup = rcColorIdx !== -1 && rcParts[rcColorIdx + 1] ? rcParts[rcColorIdx + 1] : rcParts[rcParts.length - 2] || '';
      var rcSubgroup = rcColorIdx !== -1 && rcParts[rcColorIdx + 2] ? rcParts[rcColorIdx + 2] : '';
      refColorsArr.push({ name: rcName, hex: refHexLight[rcName], group: rcGroup, subgroup: rcSubgroup });
    }
    refColorsArr.sort(function(a, b) {
      if (a.group < b.group) return -1;
      if (a.group > b.group) return 1;
      // Sort subgroup numerically (10, 20, 30 … 190) if both are numbers
      var aNum = parseInt(a.subgroup, 10);
      var bNum = parseInt(b.subgroup, 10);
      if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
      if (a.subgroup < b.subgroup) return -1;
      if (a.subgroup > b.subgroup) return 1;
      return 0;
    });

    var auditData = {
      summary:          summary,
      matrix:           { componentNames: compNamesArr, rows: matrixRows },
      tokenOverlaps:    tokenOverlaps,
      componentDetails: componentDetails,
      lightDark:        lightDarkRows,
      wcag:             wcagRows,
      aliasDuplicates:  aliasDuplicates,
      refColors:        refColorsArr
    };

    // ── Try figma.fetch() (main thread, no CORS issues) ────
    var sentViaFigmaFetch = false;
    if (typeof figma.fetch === 'function') {
      try {
        post('status', { text: '📤 Отправляю через figma.fetch…', pct: 90 });
        var fbody = JSON.stringify({ data: auditData, spreadsheetId: spreadsheetId || null });
        var fres = await figma.fetch(scriptUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: fbody,
          redirect: 'follow'
        });
        if (!fres.ok) throw new Error('HTTP ' + fres.status);
        var fresult = await fres.json();
        post('status', { text: '✅ Готово!', pct: 100 });
        post('audit-complete', { sheetUrl: fresult.url || null, sheetId: fresult.spreadsheetId || null });
        sentViaFigmaFetch = true;
      } catch (fe) {
        post('status', { text: 'figma.fetch: ' + fe.message + '. Пробую через UI…', pct: 88 });
      }
    }

    if (!sentViaFigmaFetch) {
      // Fallback: UI handles fetch (or download if CORS blocks)
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
