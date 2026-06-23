# Импорт xlsx → новый Google Sheet

## Что потребуется: 2 шага перед запуском

---

### Шаг 1 — Загрузи xlsx в Google Drive

1. Открой [drive.google.com](https://drive.google.com)
2. Перетащи файл **`RockUP Token Audit_23.05.26.xlsx`** в окно Drive
3. Подожди пока загрузится (не открывай — просто пусть лежит в корне Drive)

---

### Шаг 2 — Создай и запусти Apps Script

1. Открой [script.google.com](https://script.google.com) → **New project**
2. Назови проект: `ImportXlsx`
3. Удали содержимое `Code.gs` и вставь код из файла **`ImportXlsx.gs`**
4. Сохрани (Ctrl+S / Cmd+S)

#### Включи Drive Advanced Service:
В левой панели нажми **+** рядом с **Services** →  
найди **Drive API** → нажми **Add**

> Без этого скрипт не сможет конвертировать xlsx → Google Sheets

5. Выбери функцию `importXlsxToSheets` в выпадающем меню (вверху)
6. Нажми ▶ **Run**
7. При первом запуске появится запрос прав → **Review permissions → Allow**

---

### Результат

В логах (внизу) появится ссылка:
```
🎉 Готово!
URL: https://docs.google.com/spreadsheets/d/ВАШ_ID/edit
```

Нажми на ссылку — откроется новая таблица со всеми 9 листами из xlsx.

---

### Если ошибка "Drive Advanced Service не включён"

Значит Services не добавлен. Повтори:  
**Services (+) → Drive API → Add → сохрани → запусти снова**

### Если "Файл не найден"

Проверь что файл в корне Google Drive (не в папке) и называется точно:  
`RockUP Token Audit_23.05.26.xlsx`

---

## Альтернатива: без скрипта (ещё проще)

1. Загрузи xlsx в Google Drive
2. Правая кнопка мыши на файле → **Open with → Google Sheets**
3. Google сам создаст новую таблицу из xlsx
