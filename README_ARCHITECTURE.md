# Trackista Server — Architecture Overview

## Обзор системы

Trackista — real-time платформа для мониторинга крипто-рынка (Binance Spot + Futures).  
Система строится вокруг принципа: **Binance видит только соединения коллектора**,  
бэкенд и фронтенд работают исключительно через внутренние данные.

---

## Инфраструктура (Docker Compose)

```
┌─────────────────────────────────────────────────────────────┐
│  Nginx (80) — SPA + proxy                                   │
│    /api/*  →  trackista-backend:3000                        │
│    /ws/*   →  trackista-backend:3000 (WS upgrade)          │
│    /*      →  frontend static files (dist/)                 │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│  Backend (Node.js :3000)                                    │
│    Express HTTP API + WebSocket gateway                     │
│    Reads: Redis (realtime) + MySQL (history)                │
└──────────────────┬──────────────────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
┌───────▼──────┐    ┌─────────▼────────┐
│  Redis 7     │    │  MySQL 8          │
│  (realtime)  │    │  (history/meta)   │
└───────▲──────┘    └──────────────────┘
        │
┌───────┴─────────────────────────────────────────────────────┐
│  Collector (Node.js)                                        │
│    Единственная точка подключения к Binance WS              │
│    Writes: Redis pub/sub + hash keys                        │
└─────────────────────────────────────────────────────────────┘
        │
        │  WebSocket streams
        ▼
┌─────────────────────────────────────────────────────────────┐
│  fstream.binance.com  (Futures)                             │
│  stream.binance.com   (Spot)                                │
└─────────────────────────────────────────────────────────────┘
```

---

## Collector (`collector/src/`)

Единственный компонент, открывающий соединения к Binance WebSocket.

### Потоки данных

| Поток | Что делает | Redis ключ |
|-------|-----------|-----------|
| `@aggTrade` (Futures) | Агрегирует сделки в 1s/5s/15s/60s бакеты | `metrics:<SYM>`, `signal:<SYM>` |
| `@aggTrade` (Spot) | То же для спот рынка | `spot:metrics:<SYM>`, `spot:signal:<SYM>` |
| `@kline_1m..1d` (Futures, 12 ТФ) | Публикует kline тики | `kline:futures:<SYM>:<IV>` (pub/sub) |
| `@kline_1m..1d` (Spot, 12 ТФ) | То же для спот | `kline:spot:<SYM>:<IV>` (pub/sub) |
| Futures OB (depth, `futuresOrderbookCollector.js`) | Поддерживает локальный ордербук | `futures:orderbook:<SYM>`, `futures:walls:<SYM>` |

### Ключевые файлы

- **`collector.js`** — главный процесс. Запускает все сборщики, 1s flush timer, запись в Redis.
- **`futuresOrderbookCollector.js`** — Futures depth WS + REST snapshot, wall detection, anti-ban logic.
- **`orderbookCollector.js`** — Spot ордербук (аналог для спот).
- **`futuresWallDetector.js`** / **`wallDetector.js`** — алгоритм поиска стен в ордербуке.
- **`symbolsUniverseBuilder.js`** — строит `tracked:universe:filtered`, `tracked:futures:symbols` — список монет для мониторинга стен.
- **`densityFuturesConfig.js`** — все конфигурационные параметры (пороги, таймауты, лимиты).
- **`binanceRestLogger.js`** — обёртка над `fetch` с rate-limit защитой (IP ban detection, backoff).

### Агрегация сигналов (collector.js)

Каждую секунду flush timer пишет для каждого символа:

```
metrics:<SYM>   = { lastPrice, volumeUsdt60s, tradeCount60s, open60s/high/low,
                    volumeUsdt5m/15m/30m/60m, buyVolumeUsdt60s, sellVolumeUsdt60s,
                    deltaUsdt60s, priceChangePct60s, ... }

signal:<SYM>    = { volumeSpikeRatio60s, volumeSpikeRatio15s, tradeAcceleration,
                    deltaImbalancePct60s, inPlayScore, impulseScore, impulseDirection,
                    baselineReady, signalConfidence }

price:<SYM>     = lastPrice (plain string)
```

---

## Backend (`backend/src/`)

### server.js — Точка входа

Инициализирует все сервисы, монтирует маршруты, запускает фоновые движки.

### Слои архитектуры

```
Routes (/api/*)
    ↓
Services (бизнес-логика, кэш, агрегация)
    ↓
Engines (алгоритмы: уровни, moves, pre-event, risk)
    ↓
Redis / MySQL
```

---

### Screener Domain

Центральная часть системы — мониторинг всех монет в реальном времени.

**`services/screenerAggregationService.js`**
- Основной агрегатор: за 2 round-trip к Redis собирает полный snapshot всех символов.
- Pipeline: `metrics:`, `signal:`, `derivatives:`, `move:live:`, `presignal:`, `bars:1m:` (16 последних баров).
- Кэш 1.5s — при параллельных запросах (несколько вкладок) пересчёт идёт только один раз.
- Поддерживает фильтры: `priceDir`, `tradesMin`, `turnoverMin`, `vol24hMin`, `minImpulse`, `hasAlerts`, `symbolSearch` и др.

**Routes:**
- `GET /api/screener/snapshot` — полный snapshot (до 500 строк)
- `GET /api/screener/live` — дельта-обновления (только изменившиеся строки с `since=`)
- `GET /api/screener/spot-stats` — аналогичный endpoint для спот рынка

**`routes/liveWsGateway.js`** (`ws://host/ws/live`)
- WebSocket gateway для realtime обновлений.
- Scopes: `screener` (500ms), `monitor` (2000ms), `testpage` (250ms), `alerts` (500ms), `watch` (2000ms).
- Один loop на scope: delta строится один раз, раздаётся всем подписчикам.
- Протокол: `hello → subscribed → delta → heartbeat`.

---

### Chart Domain

**`routes/binanceWsProxy.js`**
- `kline`-стримы (`@kline_*`): читает из Redis pub/sub (заполняется коллектором).  
  **Ноль новых Binance соединений** при любом количестве пользователей.
- Остальные стримы (depth, bookTicker): проксируются к Binance напрямую.

**`routes/binanceProxyRoute.js`**
- REST прокси: `/api/binance/spot/*`, `/api/binance/futures/*`.
- Скрывает ключи API, добавляет rate-limit защиту.

**`routes/klineFlatRoute.js`** / **`routes/klineStatsRoute.js`**
- Исторические бары и статистика по периодам.

**`services/barAggregatorService.js`**
- Раз в минуту (по границе Clock Minute + 5s settle) собирает 1m бар из Redis и записывает в MySQL (`symbol_bars_1m`) + Redis Sorted Set `bars:1m:<SYM>`.

---

### Level Watch Domain

**`services/levelWatchEngine.js`** — тикает 1 раз в секунду.
- Загружает уровни из MySQL + файловых адаптеров (manual-levels.json, saved-rays.json и др.).
- Для каждого уровня вычисляет расстояние до текущей цены, фазу (`approaching`, `precontact`, `contact_hit`, `crossed`).
- При срабатывании пишет событие в MySQL `level_events` + `alerts:recent` Redis + Telegram.

**`services/unifiedWatchLevelsLoader.js`** — унифицированный загрузчик уровней из всех источников.

**Хранилища уровней:**
- `services/manualLevelsStore.js` — ручные горизонтальные уровни (`data/manual-levels.json`)
- `services/manualSlopedLevelsStore.js` — ручные наклонные уровни
- `services/trackedLevelsStore.js` — автоматически отслеживаемые уровни
- `services/savedRaysStore.js` — сохранённые лучи
- `services/trackedRaysStore.js` — отслеживаемые лучи

---

### Move Detection Domain

**`services/moveDetectionService.js`** — тикает 1s.
- Хранит rolling price history для каждого символа.
- Детектирует движения (pumps/dumps) на таймфреймах 1m, 3m, 5m, 15m.
- Пишет в `move:live:<SYM>` (Redis) + MySQL `move_events`.

**`services/preEventService.js`** — тикает 5s.
- Вычисляет `readinessScore` — вероятность начала движения.
- Пишет в `presignal:<SYM>` (Redis, TTL 30s).

**`engines/moves/`:**
- `moveDetectionEngine.js` — алгоритм детекции
- `featureSnapshotEngine.js` — feature snapshot для ML-совместимой записи
- `preEventEngine.js` — V2 алгоритм readiness score
- `rankingEngine.js` — ранжирование символов

---

### Alert Domain

**`services/alertEngineService.js`** — тикает 1s.
- Проверяет `inPlayScore`, `impulseScore`, расстояния до уровней.
- Генерирует алерты: `level_approaching`, `level_touched`, `level_breakout_candidate`, `market_impulse`, `market_in_play`.
- Пишет в `alerts:live` (Redis Sorted Set, TTL 7 дней) + MySQL `alerts`.
- Dispatch через `alertDeliveryService.js` → Telegram / Web Push.

**`services/screenerAlertEngine.js`** — алерты на базе screener фильтров (пользовательские настройки).

---

### Orderbook / Density Domain

Фьючерсный ордербук и wall detection.

**Routes:**
- `GET /api/orderbook/:symbol` — топ уровней ордербука
- `GET /api/walls/:symbol` — найденные стены
- `GET /api/density/view` — визуализация плотности
- `GET /api/density/summary` — сводка по всем символам

---

### Derivatives / Funding

**`services/derivativesContextService.js`** — собирает funding rate, OI, liquidations из Redis.  
`GET /api/funding` — текущие funding rates.

---

### Correlation

**`services/correlationService.js`** — считает Pearson correlation к BTC по 10 конфигам (1m/5m/15m/1h/4h/6h/12h/24h).  
`GET /api/correlation/btc/list` — список корреляций для CoinList.

---

### Bar History

**`routes/barsRoute.js`** — `GET /api/bars/:symbol` — исторические 1m бары из MySQL/Redis.

---

### Auth & Social

**`routes/authRoutes.js`** — JWT auth (register/login/refresh).  
**`routes/postsRoutes.js`** — alert posts, votes, comments (alert feed).

---

## Frontend (`frontend/dist/`)

Собранный React SPA. Раздаётся Nginx статически.  
В dev режиме — Vite dev server (`C:\work\trackista.live-v2`).

---

## Redis — схема ключей

| Ключ | Тип | Содержимое | TTL |
|------|-----|-----------|-----|
| `metrics:<SYM>` | string (JSON) | 1m rolling metrics (futures) | — |
| `signal:<SYM>` | string (JSON) | computed signal scores (futures) | — |
| `spot:metrics:<SYM>` | string (JSON) | то же, спот | — |
| `spot:signal:<SYM>` | string (JSON) | то же, спот | — |
| `derivatives:<SYM>` | string (JSON) | funding, OI, liquidations | — |
| `move:live:<SYM>` | string (JSON) | активное move event | — |
| `presignal:<SYM>` | string (JSON) | readinessScore | 30s |
| `price:<SYM>` | string | lastPrice | — |
| `bars:1m:<SYM>` | sorted set | 1m бары (score=ts) | 48h |
| `bars:1m:<SYM>:last` | string | последний бар | — |
| `symbols:active:usdt` | string (JSON) | список активных futures символов | — |
| `spot:symbols:active:usdt` | string (JSON) | список активных spot символов | — |
| `tracked:universe:filtered` | string (JSON) | символы для wall monitoring | 5×refresh |
| `tracked:futures:symbols` | string (JSON) | futures-only подмножество | 5×refresh |
| `futures:orderbook:<SYM>` | string (JSON) | топ уровней ордербука | — |
| `futures:walls:<SYM>` | string (JSON) | confirmed walls | — |
| `futures:tickers:all` | string (JSON) | 24h ticker snapshot (batch) | — |
| `alerts:live` | sorted set | алерты (score=ts) | 7d |
| `alerts:recent` | sorted set | level watch события | — |
| `kline:futures:<SYM>:<IV>` | pub/sub channel | kline тики от коллектора | — |
| `kline:futures:<SYM>:<IV>:last` | string (JSON) | последний kline тик | 300s |
| `kline:spot:<SYM>:<IV>` | pub/sub channel | то же, спот | — |
| `correlation:btc:current:<SYM>:<TF>:<WIN>` | string (JSON) | Pearson correlation | — |
| `levelwatchstate:<ID>` | string (JSON) | watch state уровня | 90s |
| `debug:binance-rate-limit-state` | string (JSON) | IP ban state | — |

---

## MySQL — таблицы

| Таблица | Содержимое |
|---------|-----------|
| `symbol_bars_1m` | 1-минутные бары (OHLCV + signal) |
| `move_events` | история движений |
| `alerts` | история алертов |
| `level_events` | события watch-уровней |
| `manual_levels` | ручные уровни (резервная копия) |
| `tracked_levels` | автоматически отслеживаемые уровни |
| `users` | аккаунты |
| `alert_posts` / `alert_votes` / `alert_comments` | social feed |

---

## Защита от IP-бана Binance

Binance блокирует IP при > 300 одновременных WS соединений.

**Архитектура защиты:**
1. **Коллектор** — единственная точка WS подключений (≈72+36 kline + N depth).
2. **Kline стримы** → Redis pub/sub → Backend → Клиент (0 новых соединений на пользователя).
3. **REST запросы** — через `binanceRestLogger.js` с rate-limit backoff и circuit breaker.
4. **Ордербук** — snapshot через single-concurrency queue, 418-respons → глобальный backoff.
5. **Коллектор** при старте проверяет `debug:binance-rate-limit-state` — если ban активен, ждёт.

---

## Переменные окружения (`.env`)

| Переменная | Описание |
|-----------|---------|
| `REDIS_HOST` / `REDIS_PORT` | Redis подключение |
| `MYSQL_*` | MySQL credentials |
| `FUTURES_TRACKED_MAX_SYMBOLS` | Лимит символов для ордербука (default 600, рекомендуется ≤150) |
| `TRACK_MIN_VOLUME_24H_USD` | Минимальный 24h объём для включения в universe |
| `FUTURES_FORCE_INCLUDE` | Форс-включение символов через запятую |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram алерты |
| `JWT_SECRET` | Auth |
| `MOVE_DETECTION_ENABLED` | Вкл/выкл move detection |
| `CORRELATION_ENABLED` | Вкл/выкл correlation service |

---

## Запуск

```bash
# Production
docker-compose up -d

# Rebuild и рестарт конкретных сервисов
docker-compose up -d --no-deps --force-recreate --build backend collector

# Логи коллектора
docker logs trackista-collector -f

# Логи бэкенда
docker logs trackista-backend -f
```

---

## Поток данных (конец в конец)

```
Binance WS (aggTrade)
  │
  ▼ collector.js onTrade()
  │  → in-memory 1s buckets per symbol
  │
  ▼ startFlushTimer() — каждую секунду
  │  → metrics:<SYM>, signal:<SYM>, price:<SYM>  (Redis SET)
  │
  ▼ barAggregatorService (backend) — каждую минуту
  │  → bars:1m:<SYM>  (Redis Sorted Set)
  │  → symbol_bars_1m (MySQL INSERT)
  │
  ▼ screenerAggregationService (backend) — по запросу (кэш 1.5s)
  │  → pipeline: metrics + signal + derivatives + move + presignal + bars
  │  → фильтрация + сортировка → ScreenerRowDTO[]
  │
  ▼ liveWsGateway (backend) — каждые 500ms
     → getDelta() → только изменившиеся строки
     → broadcast to all WS clients on scope "screener"


Binance WS (kline)
  │
  ▼ collector.js connectFuturesKlineBatch()
  │  → PUBLISH kline:futures:BTCUSDT:1m  {...}
  │  → SET kline:futures:BTCUSDT:1m:last {...} EX 300
  │
  ▼ binanceWsProxy.js subscribeKlineClient()
  │  → SUBSCRIBE kline:futures:BTCUSDT:1m
  │  → немедленно GET :last → send to client
  │
  ▼ Browser KlineV10TestChart.jsx WebSocket
     → onmessage → klinecharts callback(bar)
     → Chart updates in realtime
```
