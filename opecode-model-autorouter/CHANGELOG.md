# Журнал изменений

Плагин использует [Semantic Versioning](https://semver.org/lang/ru/). Каждый релиз помечается Git-тегом `opecode-model-autorouter/vX.Y.Z`.

## [0.1.0] - 2026-10-30

### Добавлено

- Автоматическое обнаружение и группировка включённых chat-моделей с одинаковым ID у разных провайдеров.
- Ручные группы с разными model ID, variant, приоритетами и стратегиями `free-fastest`, `fastest`, `cheapest` и `manual`.
- Онлайн-метрики TTFB, latency, скорости генерации, фактической стоимости и токенов по событиям шагов.
- Cooldown после ошибок лимита, перебор альтернатив и автоматическое synthetic-продолжение без повторной отправки пользовательского prompt.
- RPC `status`, `rescan` и `select`.
- Unit-, race-, cleanup-, memory-, SDK- и live-проверки.
