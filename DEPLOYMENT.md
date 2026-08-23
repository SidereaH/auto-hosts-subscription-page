# Развёртывание в Docker Compose

Форк [remnawave-subscription-page](https://docs.rw/) с поддержкой:

- подстановки реального UUID пользователя вместо плейсхолдера `<UUID>` в шаблонах Remnawave (`vnext` outbound'ы);
- инжектора кастомных JSON/YAML-шаблонов хостов в ответ подписки, в зависимости от статуса подписки пользователя.

Документ описывает два сценария: **без инжектора кастомных шаблонов** (стандартное поведение) и **с инжектором**.

---

## 1. Предварительные требования

- Docker + Docker Compose plugin.
- Развёрнутая панель Remnawave, доступная с хоста, где будет запущен `remnawave-subscription-page` (по HTTP/HTTPS).
- API-токен Remnawave: **Remnawave Dashboard → Remnawave Settings → API Tokens**.

---

## 2. Переменные окружения (`.env`)

Скопируй `.env.sample` в `.env` и заполни:

| Переменная | Обязательна | Описание |
|---|---|---|
| `APP_PORT` | нет (default `3010`) | Порт, на котором слушает backend внутри контейнера. |
| `REMNAWAVE_PANEL_URL` | да | URL панели Remnawave, например `https://panel.example.com` или `http://remnawave:3000` (если в одной docker-сети). |
| `REMNAWAVE_API_TOKEN` | да | API-токен из панели. |
| `SUBPAGE_CONFIG_UUID` | нет | UUID конфига страницы подписки в Remnawave. По умолчанию используется дефолтный конфиг панели. |
| `CUSTOM_SUB_PREFIX` | нет | Кастомный префикс пути, например `sub` (без `/` в начале/конце). |
| `CADDY_AUTH_API_TOKEN` | нет | Если перед сервисом стоит Caddy с security-аддоном / Tiny Auth — токен уйдёт в заголовок `X-Api-Key` к панели. |
| `CLOUDFLARE_ZERO_TRUST_CLIENT_ID` / `_SECRET` | нет | Для доступа к панели через Cloudflare Zero Trust. |
| `MARZBAN_LEGACY_LINK_ENABLED` | нет (default `false`) | Поддержка старых ссылок формата Marzban. |
| `MARZBAN_LEGACY_SECRET_KEY` | да, если включено выше | Секрет(ы) Marzban, через запятую можно указать несколько. |
| `CUSTOM_TEMPLATES_ENABLED` | нет (default `false`) | Включает инжектор кастомных шаблонов (раздел 4). |
| `CUSTOM_TEMPLATES_CONFIG_PATH` | нет (default `/opt/app/templates/template-injector.yml`) | Путь **внутри контейнера** к YAML-конфигу инжектора. |
| `TRUST_PROXY` | нет (default `1`) | Express `trust proxy` — сколько хопов обратного прокси доверять при определении реального IP клиента (`"true"`/`"false"`, число хопов, либо список пресетов/CIDR через запятую). Если сервис стоит за одним реверс-прокси (Caddy/Nginx/Traefik) — дефолтного `1` обычно достаточно. |

`INTERNAL_JWT_SECRET` в `.env` задавать не нужно — `docker-entrypoint.sh` генерирует его случайно при каждом старте контейнера (это значит, что сессионные cookie веб-страницы подписки инвалидируются при рестарте контейнера — это ожидаемо и не влияет на выдачу самой подписки).

> База форка — upstream `remnawave-subscription-page` 8.0.0 (`@remnawave/backend-contract` 3.1.1), это версия, совместимая с панелью Remnawave 3.x (включая 3.3.2). При старте контейнера в логах должна быть строка `[OK] Connected to Remnawave v3.x.x` — если панель ниже 3.x, подключение не пройдёт.

---

## 3. Вариант A — без кастомного инжектора шаблонов

Это стандартный режим форка: единственная кастомизация — автоматическая подстановка `<UUID>` в шаблонах, которые уже присылает сама Remnawave (это работает всегда, отдельно не включается и не зависит от `CUSTOM_TEMPLATES_ENABLED`).

`.env`:
```env
CUSTOM_TEMPLATES_ENABLED=false
```

`docker-compose.yml`:
```yaml
services:
  remnawave-subscription-page:
    image: aliquamsiderea/remnawave-subscription-page-templates:3.0.0
    container_name: remnawave-subscription-page
    hostname: remnawave-subscription-page
    restart: always
    env_file:
      - .env
    ports:
      - '127.0.0.1:3010:3010'
    networks:
      - remnawave-network

networks:
  remnawave-network:
    name: remnawave-network
    driver: bridge
    external: false
```

Никаких volume-монтирований шаблонов здесь нет — намеренно. Если смонтировать пути `template-injector.yml` / `*.txt`, которых физически нет на хосте, Docker создаст на их месте **пустые директории** вместо файлов, и при `CUSTOM_TEMPLATES_ENABLED=true` сервис не сможет их прочитать (см. вариант B). При `false` инжектор вообще не пытается читать конфиг, так что лишние волюмы просто не нужны.

Запуск:
```bash
docker compose up -d
docker compose logs -f remnawave-subscription-page
```
В логах не должно быть строк про `Custom template injector` — значит модуль не активирован.

---

## 4. Вариант B — с инжектором кастомных шаблонов

### 4.1 Как это работает (кратко)

При каждом запросе подписки (не из браузера) backend:

1. Получает от Remnawave сырой ответ `GET /api/sub/{shortUuid}` (тело + HTTP-заголовки ответа).
2. Если тело — JSON-массив хостов/outbound'ов, заменяет в нём `<UUID>`-плейсхолдеры на реальный UUID пользователя. Если это не JSON-массив (base64/clash и т.п. форматы клиента) — подписка отдаётся как есть, без модификаций и без инжекции шаблонов.
3. Определяет статус подписки **по HTTP-заголовку `subscription-userinfo`**, который Remnawave сама проксирует на этот же ответ (стандартный заголовок формата v2ray/xray-подписок: `upload=...; download=...; total=...; expire=...`):
   - `EXPIRED` — `expire > 0` и `expire` уже в прошлом;
   - `LIMITED` — `total > 0` и `upload + download >= total`;
   - `HWID`, `HWID_NOT_SUPPORTED`, `DISABLED` — **пока всегда `false`**. На сыром эндпоинте подписки Remnawave также отдаёт заголовки `x-hwid-limit` / `x-hwid-not-supported`, но, по факту проверки, они выставлены в `true` даже у полностью активной подписки — то есть это флаги возможностей клиента, а не текущего состояния лимита. Реального сигнала для этих трёх статусов пока не найдено, поэтому они закреплены как явный документированный переключатель в `backend/src/common/utils/subscription-status/subscription-status.util.ts` (`detectStatusFlags`) — включать их в `statuses.*.enabled: true` в конфиге ниже бессмысленно, пока это не заменено на реальную проверку в коде.
4. Подбирает набор кастомных шаблонов для определённого статуса (по приоритету `statusPriority`, побеждает первый совпавший) и **добавляет их в начало** итогового списка хостов (текущая реализация не поддерживает добавление в конец списка, несмотря на то, что это может быть заявлено как фича форка — учитывай это как ограничение).
5. В подставляемых шаблонах `<UUID>` тоже заменяется на реальный UUID пользователя.

Никакой ручной настройки в панели Remnawave для этого не требуется — `subscription-userinfo` присутствует в ответе всегда, никакой дополнительный запрос к панели не делается (в отличие от более ранних версий этой логики в форке).

### 4.2 Структура файлов на хосте

Рекомендуемая раскладка (пути произвольны, главное — соответствие volume-монтированиям):

```
.
├── docker-compose.yml
├── .env
└── templates/
    ├── template-injector.yml
    ├── lte-template.txt
    └── wifi-template.txt
```

Файлы `template-injector.yml`, `lte-template.txt`, `wifi-template.txt` **не входят в репозиторий** — их нужно создать самостоятельно (несмотря на то, что `docker-compose.yml`/`docker-compose-prod.yml` в репозитории уже ссылаются на них).

### 4.3 `templates/template-injector.yml`

```yaml
# Пути указаны так, как они будут видны ВНУТРИ контейнера (см. volumes ниже)
templates:
  lte: /opt/app/templates/lte-template.txt
  wifi: /opt/app/templates/wifi-template.txt

# Фолбэк-список шаблонов, если статус не определён И статус DEFAULT выключен
activeTemplates:
  - wifi

# Порядок проверки статусов; можно не задавать — тогда берётся порядок по умолчанию.
# Реально сработать сейчас могут только EXPIRED и LIMITED (см. 4.1) — HWID,
# HWID_NOT_SUPPORTED, DISABLED зафиксированы как false в коде, включать их
# здесь пока бессмысленно.
statusPriority:
  - HWID
  - EXPIRED
  - DISABLED
  - HWID_NOT_SUPPORTED
  - LIMITED
  - DEFAULT

statuses:
  EXPIRED:
    enabled: true
    templates:
      - lte

  LIMITED:
    enabled: true
    templates:
      - lte

  DISABLED:
    enabled: false
    templates: []

  HWID:
    enabled: false
    templates: []

  HWID_NOT_SUPPORTED:
    enabled: false
    templates: []

  # Срабатывает, если статус не определён (нет заголовка subscription-userinfo
  # или ни один из статусов выше не совпал)
  DEFAULT:
    enabled: true
    templates:
      - wifi
```

Поля:
- `templates` (или `templatePaths`, поддерживаются оба имени) — словарь `имя → путь к файлу` внутри контейнера. Файл может быть как `.yml`, так и `.txt` — парсится всегда как YAML (`yaml.load`), расширение не важно, важно валидное содержимое.
- `activeTemplates` — список имён шаблонов, применяемых, когда статус не определён и `statuses.DEFAULT.enabled: false`.
- `statusPriority` — порядок проверки; значения вне множества `HWID, EXPIRED, DISABLED, HWID_NOT_SUPPORTED, LIMITED, DEFAULT` игнорируются.
- `statuses.<STATUS>.enabled` — булево, обязательно `true`, иначе правило пропускается целиком, даже если статус пользователя ему соответствует.
- `statuses.<STATUS>.templates` — какие шаблоны (по именам из `templates`) вставлять при совпадении.

Никаких `keywords` или `statusPriority` в этой версии конфига больше нет — статус приходит из панели одним точным значением, а не выбирается эвристикой среди нескольких кандидатов.

### 4.4 Файл шаблона хоста (`templates/lte-template.txt`, `wifi-template.txt`)

Каждый файл — один объект (или несколько, в зависимости от того, что ожидает твой клиентский формат), в формате, идентичном обычным элементам ответа подписки Remnawave, с `<UUID>` там, где должен быть UUID пользователя:

```yaml
remarks: "⚠️ Ваша подписка истекла — обновите тариф"
outbounds:
  - protocol: vless
    settings:
      vnext:
        - address: fallback.example.com
          port: 443
          users:
            - id: <UUID>
              encryption: none
              flow: xtls-rprx-vision
    streamSettings:
      network: tcp
      security: tls
      tlsSettings:
        serverName: fallback.example.com
```

### 4.5 `.env`

```env
CUSTOM_TEMPLATES_ENABLED=true
CUSTOM_TEMPLATES_CONFIG_PATH=/opt/app/templates/template-injector.yml
```

### 4.6 `docker-compose.yml`

```yaml
services:
  remnawave-subscription-page:
    image: aliquamsiderea/remnawave-subscription-page-templates:3.0.0
    container_name: remnawave-subscription-page
    hostname: remnawave-subscription-page
    restart: always
    env_file:
      - .env
    volumes:
      - ./templates/template-injector.yml:/opt/app/templates/template-injector.yml:ro
      - ./templates/lte-template.txt:/opt/app/templates/lte-template.txt:ro
      - ./templates/wifi-template.txt:/opt/app/templates/wifi-template.txt:ro
    ports:
      - '127.0.0.1:3010:3010'
    networks:
      - remnawave-network

networks:
  remnawave-network:
    name: remnawave-network
    driver: bridge
    external: false
```

Если нужно собирать образ из исходников этого форка вместо готового `image:` — используй вариант из `docker-compose.yml` репозитория:
```yaml
    build:
      context: .
      dockerfile: Dockerfile
```
вместо `image:`.

Пути в `volumes` **обязаны** совпадать с `CUSTOM_TEMPLATES_CONFIG_PATH` и с путями, указанными внутри `template-injector.yml` — иначе при старте будет `[FAILED]`/предупреждение в логах и инжектор откатится к оригинальной подписке без кастомных шаблонов (это безопасный фолбэк, не падение сервиса).

### 4.7 Запуск и проверка

```bash
docker compose up -d
docker compose logs -f remnawave-subscription-page
```

Ожидаемые строки в логах при успешной загрузке:
```
[OK] Custom template injector loaded
```

Если конфиг не грузится:
```
[CONFIG] Custom template injector cannot be initialized, fallback to original subscription
```
— проверь пути в volumes, синтаксис YAML и права на чтение файлов.

Никакой настройки в самой панели Remnawave для детекции статуса не требуется — заголовок `subscription-userinfo` присутствует в ответе `/api/sub/{shortUuid}` всегда.

Проверка самого заголовка (то, от чего зависит детекция):
```bash
curl -sD - "http://127.0.0.1:3010/<shortUuid>" -o /dev/null | grep -i subscription-userinfo
# ожидается что-то вроде: subscription-userinfo: upload=0; download=11016307284; total=429496729600; expire=1790621473
```

Проверка подстановки шаблона:
```bash
curl -s "http://127.0.0.1:3010/<shortUuid>" | jq '.[0]'
```
Первым элементом массива должен быть инжектированный шаблон (если у пользователя совпал соответствующий статус), с уже подставленным реальным UUID вместо `<UUID>`.

---

## 5. Частые ошибки

| Симптом | Причина | Решение |
|---|---|---|
| `Custom template injector cannot be initialized` | Файл по `CUSTOM_TEMPLATES_CONFIG_PATH` не существует / не смонтирован / это директория, а не файл | Проверить volumes, убедиться, что файлы существуют на хосте **до** `docker compose up` |
| `Template "<name>" is not loaded, skip` | В `statuses.<STATUS>.templates` указано имя, которого нет в секции `templates` | Свести имена в `templates:` и в `statuses.*.templates:` |
| `Cannot inject templates: user UUID is not found in subscription response` | В ответе Remnawave нет ни одного `outbounds[].settings.vnext[].users[].id`, отличного от `<UUID>` | Убедиться, что панель отдаёт реальный UUID хотя бы в одном хосте подписки |
| Шаблон никогда не подставляется, статус всегда `DEFAULT` | Либо `enabled: false` для нужного статуса, либо заголовка `subscription-userinfo` нет в ответе панели, либо это `HWID`/`HWID_NOT_SUPPORTED`/`DISABLED` — они сейчас зафиксированы как `false` в коде (см. 4.1) | Проверить заголовок `curl`-командой выше; для `HWID`/`HWID_NOT_SUPPORTED`/`DISABLED` пока нет обхода без правки кода |
| Ожидалось добавление хоста в конец списка, а он оказался в начале | Текущая реализация поддерживает только prepend | Ограничение текущей версии кода, не баг конфигурации — см. раздел 4.1 |
