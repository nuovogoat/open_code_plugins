# Отчёт о тестировании opencode-model-autorouter

Дата последнего прогона: **2026-10-31**
Версия: **0.7.0**
Коммит: `9ead781`

## Сводка

| Категория | Кол-во | Статус |
| :--- | :--- | :--- |
| Всего тестов | 94 | ✅ |
| Пройдено (unit) | 85 | ✅ |
| Пройдено (GC) | 7 | ✅ |
| Пропущено (без --expose-gc) | 2 | ℹ️ |
| Ошибок | 0 | ✅ |
| Утечек данных | 0 | ✅ |
| Утечек памяти | 0 | ✅ |
| Typecheck | clean | ✅ |
| GUI bundle | 72.68 KB | ✅ |
| Время выполнения (unit) | ~1.9 с | ⚡ |
| Время выполнения (GC) | ~0.7 с | ⚡ |

> **Примечание:** 2 GC-теста пропускаются в обычном режиме (`--test test/*.test.ts`). При запуске с `--expose-gc` все 7 GC-тестов проходят.

## Результаты жёсткого прогона (2026-10-31)

### Unit-тесты (87 тестов, 85 pass, 2 skipped)
```
✔ vault: keys roundtrip through storage encrypted and are trimmed (64ms)
✔ vault: a reopened instance decrypts the stored key via the persisted salt (101ms)
✔ vault: tampered or malformed records resolve as absent instead of throwing (41ms)
✔ vault: clear removes the key and the provider list, reporting repeats (50ms)
✔ vault: rejects keys for providers not in the current known roster (46ms)
✔ vault: empty, blank and oversized keys are rejected (40ms)
✔ vault: without plugin storage the vault stays disabled (0.2ms)
✔ vault: account keys never leak into RPC responses, logs or public pricing (111ms)
✔ vault: RPC schema has no hardcoded provider enum (dynamic allowlist) (6ms)
✔ version: manifest, changelog and pinned installation docs stay in sync (10ms)
✔ name: every identifier uses the canonical product spelling (8ms)
... (76 дополнительных тестов router/failover/pricing/config/guardrails/cbr)
ℹ tests 87 | pass 85 | fail 0 | skipped 2
```

### GC-тесты (7 тестов, 7 pass)
```
✔ memory: 3,000 setup/cleanup cycles — retained 210 KB (365ms)
✔ robustness: garbage providerSites normalized, prototypes clean (2ms)
✔ robustness: absurd configure patches normalized, not fatal (14ms)
✔ robustness: hostile fetch never crashes, invents no prices (69ms)
✔ robustness: cleanup during in-flight discovery aborts cleanly (32ms)
✔ robustness: repeated site churn keeps snapshots bounded (56ms)
✔ robustness: 500 discovery cycles — retained 701 KB (189ms)
ℹ tests 7 | pass 7 | fail 0 | skipped 0
```

### Память
- **3000 циклов setup/cleanup:** удержано **210 KB** (порог <16 MB)
- **500 циклов discovery:** удержано **701 KB** (порог <16 MB)
- Подписки: 3200 закрыто, 16000 dispose вызвано, 0 активных утечек

## Категории тестов

### 🔒 Безопасность и утечки данных
-   **vault: account keys never leak into RPC responses, logs or public pricing** — *ЖЁСТКИЙ ТЕСТ*. Подставляет реалистичные секреты (`sk-or-v1-LEAK-CANARY-*`, `tmr-LEAK-CANARY-*`, `pv-LEAK-CANARY-*`) в vault и credentials, вызывает все RPC-методы (`status`, `configure`, `rescan`), перехватывает `console.error` и сканирует весь выход на наличие канареек. **Утечек не обнаружено.**
-   **vault: RPC schema has no hardcoded provider enum** — гарантирует отсутствие регрессии к статическому whitelist'у; валидация динамическая.
-   **vault: keys roundtrip through storage encrypted** — plaintext никогда не попадает в storage (только AES-256-GCM `{v, iv, tag, data}`).
-   **vault: tampered or malformed records resolve as absent** — подделка записей vault не вызывает исключений и не раскрывает данные.
-   **vault: rejects keys for unknown providers** — динамический ростер предотвращает инъекцию произвольных providerID.
-   **robustness: garbage providerSites normalized, prototypes clean** — защита от prototype pollution и инъекций через конфиг.

### 🧠 Память и надёжность
-   **memory: 3,000 setup/cleanup cycles** — 210 KB retained, 0 утечек подписок/регистраций.
-   **robustness: 500 discovery cycles** — 701 KB retained, стабильный heap.
-   **robustness: hostile fetch** — HTML вместо JSON, 500, sync/async throw, json() boom — ни один сценарий не крашит роутер и не выдумывает цены.
-   **robustness: cleanup during in-flight discovery** — корректная отмена запросов при остановке, 0 unhandled rejections.
-   **robustness: repeated site churn** — публичные снапшоты не накапливаются при частой смене сайтов.

### ⚙️ Функциональность
-   **router / failover / routing** — маршрутизация, переключение при лимитах, synthetic-resume, cooldowns.
-   **pricing / public pricing** — аккаунтные и публичные цены, приоритет аккаунтных, обработка ошибок discovery.
-   **configuration / guardrails** — пороги балансов, лимиты цен, CBR-ориентация.
-   **vault: setAccountKey/clearAccountKey** — прямое обновление без debounce, немедленная видимость ключа в статусе.
-   **catalog / version / name** — синхронизация версий, каноническое имя, соответствие RPC-схем.

## Защита по конструкции (подтверждена кодом + тестами)

1.  **Динамический ростер вместо хардкода:** Vault принимает ключи только для провайдеров, которые есть в текущем `provider.list()` + vault. Нет whitelist'а эндпоинтов. RPC-схема `setAccountKey` не содержит `enum` — валидация в runtime.
2.  **Ключ → только resolved origin:** Ключ передаётся исключительно в `fetch` к `baseURL` из конфига OpenCode или `providerSites`. Редиректы при наличии auth-заголовка блокируются. Только HTTPS (кроме `http://localhost`).
3.  **RPC-схемы:** Все методы, возвращающие состояние (`status`, `configure`, `rescan`), имеют `additionalProperties: false` и **не содержат полей для ключей**. `setAccountKey` принимает ключ только во *входе*, в *выходе* возвращает лишь `{stored, providerID}`.
4.  **Vault:** Plaintext никогда не сериализуется. В storage хранится только `{v, iv, tag, data}` (AES-256-GCM). Соль привязана к машине/пользователю.
5.  **Логи:** Единственный канал вывода — `console.error` с префиксом `[opencode-model-autorouter]`. Тест на утечки перехватывает этот поток и гарантирует отсутствие секретов.
6.  **GUI:** Кнопка «Аккаунтные цены и баланс» рендерится для **всех** провайдеров без хардкод-гейта. Подпись: *«Необходим вход в учётную запись, данные хранятся локально»*.

## Как запустить

```powershell
# Обычные тесты (87 тестов)
& "C:\Runners\Runner-asr_local\externals\node24\bin\node.exe" --test "test/*.test.ts"

# GC-тесты (7 тестов, требуют флага)
& "C:\Runners\Runner-asr_local\externals\node24\bin\node.exe" --expose-gc --test test/memory.test.ts test/robustness.test.ts

# Typecheck
& "C:\Runners\Runner-asr_local\externals\node24\bin\node.exe" .\node_modules\typescript\bin\tsc --noEmit

# GUI bundle
& "C:\Runners\Runner-asr_local\externals\node24\bin\node.exe" .\node_modules\vite\bin\vite.js build

# Live-тест (требуется OpenCode CLI)
$env:OPENCODE_CLI = "C:\Users\Honor\AppData\Local\Programs\ai.opencode.desktop\resources\opencode-cli.exe"
& "C:\Runners\Runner-asr_local\externals\node24\bin\node.exe" test/live-router.ts
```

## История изменений

-   **2026-10-31 (9ead781):** Жёсткий прогон после рефакторинга «без хардкода». Все 94 теста зелёные. Typecheck clean. GUI bundle собран. Обновлён TEST_REPORT.
-   **2026-10-31 (e98e564):** Добавлен жёсткий тест на утечки секретов в RPC и логах.
-   **2026-10-30 (3cd19b4):** v0.7.0 — переименование в `opencode-model-autorouter`, name-gate тест.
-   **2026-10-29 (85af01c):** v0.6.0 — публичное обнаружение цен, robustness-тесты, GC-гейл.
