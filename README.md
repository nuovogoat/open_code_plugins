# open_code_plugins

Небольшая коллекция серверных плагинов для **OpenCode V2**. Каждый плагин лежит в отдельном каталоге и имеет собственный README.

## Плагины

| Плагин | Версия | Назначение |
| --- | --- | --- |
| [project-folder-tabs](project-folder-tabs/) | 1.4.1 | Показывает имена папок проектов на вкладках сессий |
| [opecode-model-autorouter](opecode-model-autorouter/) | 0.5.0 | Выбирает модели по скорости, стоимости и доступности; аккаунтные тарифы и баланс из API провайдеров; мониторинг минимального остатка и глобальных границ цены с автопереключением; необязательная ориентировка по курсу ЦБ РФ; необязательный зашифрованный сейф аккаунтных ключей; GUI каталога и route-групп |

## Установка и обновление

Требуется OpenCode V2 с поддержкой Git-пакетов. Установка из ветки `main`:

```sh
opencode plugin add 'github:nuovogoat/open_code_plugins#main::path:project-folder-tabs'
opencode plugin add 'github:nuovogoat/open_code_plugins#main::path:opecode-model-autorouter'
```

Фиксированная версия устанавливается по Git-тегу и не обновляется автоматически:

```sh
opencode plugin add 'github:nuovogoat/open_code_plugins#project-folder-tabs/v1.4.1::path:project-folder-tabs'
opencode plugin add 'github:nuovogoat/open_code_plugins#opecode-model-autorouter/v0.5.0::path:opecode-model-autorouter'
```

Проверка и установка обновлений всех настроенных пакетных плагинов:

```sh
opencode plugin check
opencode plugin update
```

Не подключайте одновременно Git-пакет и локальную копию с тем же ID плагина. Перед обновлением просматривайте изменения: серверные плагины выполняются как доверенный код OpenCode.

## Разработка

Исходники и тесты включены в репозиторий; журналы, `node_modules` и результаты прогонов исключены. Для каждого изменения запускайте тесты плагина и увеличивайте его версию в `package.json`.

Релизы используют SemVer. При выпуске обновите версию в `package.json`, таблицу
выше, команды фиксированной установки и changelog плагина, затем создайте тег
`project-folder-tabs/vX.Y.Z` или `opecode-model-autorouter/vX.Y.Z`. Автотесты не позволяют
этим ссылкам разойтись.

Проверки выполняются автоматически в GitHub Actions для `push` и pull request.
