# Деплой Apps Script → Google Sheets

## Что нужно сделать один раз

### 1. Открой Apps Script

Перейди на [script.google.com](https://script.google.com) и создай новый проект.  
Назови его, например: `RockUP Token Audit`.

> **Совет:** Лучше создать скрипт, привязанный к таблице:  
> Открой [таблицу](https://docs.google.com/spreadsheets/d/1GvxfhQqdfbtR6czzPKbnekzLgSpGhSnYnA9EakRWN_Q/edit) →  
> **Расширения → Apps Script** → откроется редактор, уже привязанный к этому Spreadsheet ID.

---

### 2. Вставь код

1. В редакторе открой файл `Code.gs` (он уже там по умолчанию)
2. Удали всё содержимое
3. Вставь содержимое файла **`Code.gs`** из этой папки
4. Нажми **💾 Сохранить** (Ctrl+S / Cmd+S)

---

### 3. Задеплой как Web App

1. Нажми **Deploy → New deployment**
2. Тип: **Web app**
3. Настройки:
   - **Execute as:** Me *(твой аккаунт)*
   - **Who has access:** Anyone *(или Anyone with Google account)*
4. Нажми **Deploy**
5. Скопируй **Web app URL** — он выглядит так:
   ```
   https://script.google.com/macros/s/AKfycb.../exec
   ```

---

### 4. Обнови URL в плагине

Открой файл `code.js` в этой папке и замени `scriptUrl` в `TEAM_DEFAULTS`:

```javascript
var TEAM_DEFAULTS = {
  scriptUrl:     'https://script.google.com/macros/s/ВАШ_НОВЫЙ_URL/exec',
  spreadsheetId: '1GvxfhQqdfbtR6czzPKbnekzLgSpGhSnYnA9EakRWN_Q'
};
```

---

### 5. Проверь

Открой в браузере GET-запрос к скрипту:
```
https://script.google.com/macros/s/ВАШ_URL/exec
```

Должен вернуться JSON:
```json
{"status":"ok","service":"RockUP Token Audit","timestamp":"..."}
```

---

## Что делает скрипт при запуске аудита

| Лист | Действие |
|------|---------|
| **Matrix** | Перезапись целиком |
| **Light Dark** | Перезапись (новые строки → зелёный, изменившиеся → жёлтый) |
| **Component details** | Перезапись целиком |
| **WCAG** | Перезапись (Pass → зелёный, Fail → красный) |
| **Token overlaps** | Перезапись целиком |
| **Ref Colors** | Перезапись + цветные ячейки-образцы |
| **Dashboard** | Только строки 1-2 (дата) — остальное не трогает |
| **Action items** | ⚠️ **НЕ трогается** — всегда сохраняется |
| **Methodology** | ⚠️ **НЕ трогается** — всегда сохраняется |

---

## При повторном деплое (обновление скрипта)

1. Apps Script → **Deploy → Manage deployments**
2. Нажми ✏️ рядом с деплоем
3. Version: **New version**
4. **Deploy** — URL остаётся тот же

---

## Структура папки

```
figma-plugin/
├── manifest.json    — конфиг плагина
├── code.js          — главный поток Figma (читает переменные)
├── ui.html          — интерфейс плагина
├── Code.gs          — ← этот файл идёт в Apps Script
└── DEPLOY.md        — инструкция (этот файл)
```
