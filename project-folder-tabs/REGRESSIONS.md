# Регрессии

- Зависшие `hook`, `list`, `update` или `iterator.next()` блокировали setup и cleanup → `test/lifecycle.test.ts` (`setup returns`, `bounded deadlines`, `abort closes`).
- Обрыв потока событий навсегда отключал именование новых сессий → `test/lifecycle.test.ts` (`dropped event stream reconnects`).
- Сессия, созданная между reconnect-sync и новой подпиской, терялась → `test/lifecycle.test.ts` (`without a creation gap`).
- Удалённый event API или незакрывшийся iterator вызывал бесконечные reconnect/sync и накопление подписок → `test/lifecycle.test.ts` (`degrades once`, `never replaced`).
- Неограниченные уникальные курсоры могли бесконечно растить состояние синхронизации → `test/lifecycle.test.ts` (`endless unique cursors`).
- Начальная синхронизация и watcher могли одновременно переименовывать одну сессию → `test/lifecycle.test.ts` (`share one in-flight rename`).
- Готовая или поздно завершившаяся hook-регистрация могла пережить cleanup → `test/lifecycle.test.ts` (`ready and late hook registrations`).
- Повторные setup/cleanup с never-resolving API могли накапливать подписки и память → `test/memory.test.ts`.
- Изменение или удаление частей SDK после обновления OpenCode могло ронять setup → `test/drift.test.ts`; контракт реального SDK проверяется `test/sdk-compat.ts`.
- Отдельные module graph для расположений OpenCode не видели общий реестр одинаковых имён → `test/collision.test.ts` (`isolated OpenCode module graphs`) и `test/live-collisions.ts`.
- Поздний rename со старой подписью мог перезаписать актуальный различитель после смены реестра → `test/collision.test.ts` (`late update`).
- Повторные plugin instances подпапок одного canonical root ошибочно получали родительские и числовые суффиксы → `test/collision.test.ts` (`one canonical root`) и `test/live-symbols.ts`.
- Долгоживущий реестр удерживал полные canonical paths → дескрипторы без исходных путей и проверки приватности в `test/collision.test.ts` (`retains no raw paths`).
- Hot reload нового формата реестра падал на активных записях прежней версии → ленивая миграция и `test/collision.test.ts` (`hot reload migrates legacy registry entries`).
- Неполная очистка всех расположений могла оставлять глобальное состояние → проверки пустого реестра в `test/collision.test.ts` и `test/memory.test.ts`.
