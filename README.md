# RockUP Token Audit — Figma Plugin

Плагин автоматически собирает все токены из Figma Variables API и отправляет их в Google Sheets. Одна кнопка — и таблица обновлена.

**Google Sheets:** [Открыть таблицу](https://docs.google.com/spreadsheets/d/1GvxfhQqdfbtR6czzPKbnekzLgSpGhSnYnA9EakRWN_Q/edit)

---

## Установка (один раз)

1. Клонируй репо
   ```bash
   git clone https://github.com/Diceyka/rockup-token-audit.git
   ```

2. Открой **Figma Desktop** → меню → **Plugins → Development → Import plugin from manifest...**

3. Укажи путь к файлу `figma-plugin/manifest.json`

4. Плагин появится в разделе **Development plugins**

---

## Запуск аудита

1. Открой файл **⭐ Rock UP – UI Kit** в Figma
2. `Cmd+Option+P` → **Plugins → Development → RockUP Token Audit**
3. URL и Spreadsheet ID уже заполнены — нажми **▶ Запустить аудит**
4. Через несколько секунд таблица обновится

---

## Получить обновления

```bash
git pull
```

---

## Структура таблицы

| Лист | Содержание |
|------|-----------|
| **Журнал изменений** | История изменений токенов между аудитами |
| **Dashboard** | Сводные метрики + счётчики Action items по критичности |
| **Matrix** | Матрица токен × компонент |
| **Light Dark** | Маппинг Light/Dark alias по всем токенам |
| **Component details** | Полный список: cmp-токен → sys-токен |
| **WCAG** | Контрастность FG/BG пар (Pass/Fail) |
| **Token overlaps** | Токены, используемые в 2+ компонентах |
| **Ref Colors** | Все ref-цвета с hex и визуальным свотчем |
| **Action items** | ⚠️ Smart-merge — ручные статусы/владельцы сохраняются между запусками |

---

## Обновление плагина

Когда в репо появились изменения:
```
git pull
```
Перезапусти плагин в Figma — изменения подтянутся автоматически (reimport не нужен).
