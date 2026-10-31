# Отчёт о тестировании opencode-model-autorouter

Дата последнего прогона: **2026-10-31**
Версия: **0.7.0**
Коммит: `e98e564`

## Сводка

| Категория | Кол-во | Статус |
| :--- | :--- | :--- |
| Всего тестов | 87 | ✅ |
| Пройдено | 85 | ✅ |
| Пропущено (GC) | 2 | ℹ️ |
| Ошибок | 0 | ✅ |
| Утечек данных | 0 | ✅ |
| Время выполнения | ~1.8 с | ⚡ |

> **Примечание:** 2 теста пропущены в обычном режиме, так как требуют флаг `--expose-gc`. При запуске с `node --expose-gc --test test/memory.test.ts test/robustness.test.ts` они проходят (GC-runs 7/7, удержанная память <16 МБ после 3000+ циклов).

## Категории тестов

### 🔒 Безопасность и утечки данных
-   **vault: account keys never leak into RPC responses, logs or public pricing** — *ЖЁСТКИЙ ТЕСТ*. Подставляет реалистичные секреты в vault и credentials, вызывает все RPC-методы (`status`, `configure`, `rescan`), перехватывает логи и сканирует весь выход на наличие канареек. **Утечек не обнаружено.**
-   **vault: keys roundtrip through storage encrypted and are trimmed** — проверяет, что plaintext никогда не попадает в storage (только AES-256-GCM `{v, iv, tag, data}`).
-   **vault: tampered or malformed records resolve as absent** — подделка записей vault не вызывает исключений и не раскрывает данные.
-   **vault: empty, blank and oversized keys are rejected** — валидация входных ключей.
-   **robustness: garbage providerSites are normalized away, prototypes stay clean** — защита от prototype pollution и инъекций через конфиг.

### 🧠 Память и надёжность
-   **memory: 3,000 setup/cleanup cycles leave no registrations...** — проверка отсутствия утечек подписок и регистраций.
-   **robustness: 500 setup/discovery/cleanup cycles do not grow the heap unboundedly** — стабильность heap при интенсивной работе.
-   **robustness: hostile fetch behavior never crashes a refresh and invents no prices** — устойчивость к враждебным ответам сети (HTML вместо JSON, 500, sync/async throw).
-   **robustness: cleanup during in-flight discovery aborts requests without unhandled rejections** — корректная отмена запросов при остановке.
-   **robustness: repeated site churn keeps public snapshots bounded** — отсутствие накопления мусора при частой смене сайтов.

### ⚙️ Функциональность
-   **router / failover / routing** — маршрутизация, переключение при лимитах, synthetic-resume, cooldowns.
-   **pricing / public pricing** — аккаунтные и публичные цены, приоритет аккаунтных, обработка ошибок discovery.
-   **configuration / guardrails** — пороги балансов, лимиты цен, CBR-ориентация.
-   **catalog / version / name** — синхронизация версий, каноническое имя, соответствие RPC-схем.

## Защита по конструкции (подтверждена кодом)

1.  **RPC-схемы:** Все методы, возвращающие состояние (`status`, `configure`, `rescan`), имеют `additionalProperties: false` и **не содержат полей для ключей**. Метод `setAccountKey` принимает ключ только во *входе*, в *выходе* возвращает лишь `{stored, providerID}`.
2.  **Core:** Ключ из vault передаётся исключительно в `fetch` к захардкоженному origin своего провайдера. В статус и GUI попадает только метка `keySource: "vault" | "opencode"`, **никогда сам ключ**.
3.  **Vault:** Plaintext никогда не сериализуется. В storage хранится только `{v, iv, tag, data}` (AES-256-GCM).
4.  **Логи:** Единственный канал вывода — `console.error` с префиксом `[opencode-model-autorouter]`. Тест на утечки перехватывает этот поток и гарантирует отсутствие секретов.

## Как запустить

```powershell
# Обычные тесты
& "C:\Runners\Runner-asr_local\externals\node24\bin\node.exe" --test "test/*.test.ts"

# GC-тесты (требуют флага)
& "C:\Runners\Runner-asr_local\externals\node24\bin\node.exe" --expose-gc --test test/memory.test.ts test/robustness.test.ts

# Live-тест (требуется OpenCode CLI)
$env:OPENCODE_CLI = "C:\Users\Honor\AppData\Local\Programs\ai.opencode.desktop\resources\opencode-cli.exe"
& "C:\Runners\Runner-asr_local\externals\node24\bin\node.exe" test/live-router.ts
```

## История изменений

-   **2026-10-31 (e98e564):** Добавлен жёсткий тест на утечки секретов в RPC и логах. Все 87 тестов зелёные.
-   **2026-10-30 (3cd19b4):** v0.7.0 — переименование в `opencode-model-autorouter`, name-gate тест.
-   **2026-10-29 (85af01c):** v0.6.0 — публичное обнаружение цен, robustness-тесты, GC-гейл.
