# Техническое задание: Frontend интеграция с Trackista Backend

## 1. Окружения и схема подключения

### Принцип: все запросы — relative URL

**Никаких hardcoded `http://...` в production-коде.**

Все API запросы должны быть по **относительному пути**:

```ts
// ✅ Правильно
fetch('/api/symbols')
fetch('/api/binance/futures/v1/klines?symbol=BTCUSDT&interval=1m&limit=1000')
new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/fstream/btcusdt@depth`)

// ❌ Неправильно — ломает production
fetch('http://localhost:3000/api/symbols')
fetch(`${process.env.VITE_API_URL}/api/symbols`)  // если VITE_API_URL пустая → Invalid URL
```

---

### Локальная разработка

```
Browser → Vite Dev Server :5173 (или :3001)
              ↓ /api/* proxy
          trackista-backend :3000

              ↓ /ws/* proxy
          trackista-backend :3000
```

**vite.config.ts:**

```ts
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
```

Backend запускается через:
```bash
cd trackista-server
docker compose up -d
# backend доступен на localhost:3000
```

---

### Production

```
Browser → nginx :80
           ↓ /api/*  proxy_pass → trackista-backend:3000
           ↓ /ws/*   proxy_pass → trackista-backend:3000 (WebSocket)
           ↓ /*      static files (frontend build)
```

Frontend build кладётся в `trackista-server/frontend/dist/`.

Запуск production стека:
```bash
cd trackista-server
docker compose --profile production up -d
```

Все запросы same-origin — никаких CORS проблем.

---

## 2. Переменные окружения

Если нужны env vars — **только опциональные overrides**, по умолчанию работает без них.

```env
# .env.local (только для локальной разработки, если нужно)
# Не использовать для базового URL — всё должно работать без этой переменной
VITE_BACKEND_URL=http://localhost:3000   # только для прямого dev без Vite proxy
```

**Никаких `VITE_API_URL` без fallback!**

```ts
// ❌ Так нельзя
const BASE = import.meta.env.VITE_API_URL  // → undefined в production → Invalid URL

// ✅ Так можно
const BASE = import.meta.env.VITE_API_URL ?? ''  // пустая строка = relative URL
```

---

## 3. REST API — полный контракт

### Базовый URL: `/api`

Все ответы в формате JSON. При ошибке — HTTP код + `{ success: false, error: string }`.

---

### 3.1 Binance REST Proxy

Проксирует Binance API через backend (обходит CORS и rate limits).

#### Spot

| Метод | Path | Описание |
|-------|------|----------|
| GET | `/api/binance/spot/v3/exchangeInfo` | Информация о всех спот-торговых парах |
| GET | `/api/binance/spot/v3/exchangeInfo?symbol=BTCUSDT` | Данные одной пары |
| GET | `/api/binance/spot/v3/ticker/24hr` | 24h тикеры всех символов |
| GET | `/api/binance/spot/v3/ticker/24hr?symbol=BTCUSDT` | 24h тикер одного символа |
| GET | `/api/binance/spot/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000` | Свечи |
| GET | `/api/binance/spot/v3/depth?symbol=BTCUSDT&limit=1000` | Стакан ордеров |
| GET | `/api/binance/spot/v3/aggTrades?symbol=...` | Aggregated trades |

#### Futures (USDT-M)

| Метод | Path | Описание |
|-------|------|----------|
| GET | `/api/binance/futures/v1/exchangeInfo` | Информация о фьючерсных парах |
| GET | `/api/binance/futures/v1/exchangeInfo?symbol=BTCUSDT` | Данные одной пары |
| GET | `/api/binance/futures/v1/ticker/24hr` | 24h тикеры |
| GET | `/api/binance/futures/v1/klines?symbol=BTCUSDT&interval=1m&limit=1000` | Свечи |
| GET | `/api/binance/futures/v1/depth?symbol=BTCUSDT&limit=1000` | Стакан |
| GET | `/api/binance/futures/v1/aggTrades?symbol=BTCUSDT&startTime=...&endTime=...&limit=1000` | Trades |

**Примечание:** `exchangeInfo` и `ticker/24hr` кешируются на сервере (5 мин и 30 сек).  
В ответе может быть заголовок `x-proxy-cache: hit | miss | stale`.

**Ошибки Binance прокси** возвращают:
```json
{
  "success": false,
  "reason": "upstream_http_error | upstream_rate_limit | upstream_network_error | market_backoff_active",
  "status": 429
}
```

#### Debug

| Метод | Path | Описание |
|-------|------|----------|
| GET | `/api/binance/debug` | Состояние прокси (cache hits, backoff state) |

---

### 3.2 Активные символы

| Метод | Path | Описание |
|-------|------|----------|
| GET | `/api/symbols` | Все активные USDT символы |

```json
{
  "success": true,
  "count": 439,
  "symbols": ["BTCUSDT", "ETHUSDT", ...]
}
```

---

### 3.3 Рыночные данные

| Метод | Path | Описание |
|-------|------|----------|
| GET | `/api/price/:symbol` | Последняя цена |
| GET | `/api/trade/:symbol/last` | Последняя сделка |
| GET | `/api/metrics/:symbol` | Метрики активности |
| GET | `/api/signals/:symbol` | Сигнальный слепок |
| GET | `/api/market/in-play?limit=20` | Топ по in-play score |
| GET | `/api/market/impulse?limit=20&direction=up\|down\|mixed\|all` | Топ по импульсу |
| GET | `/api/market/top-active?limit=20` | Топ по активности (объём, трейды) |

```json
// GET /api/metrics/:symbol
{
  "success": true,
  "symbol": "BTCUSDT",
  "metrics": {
    "symbol": "BTCUSDT",
    "activityScore": 87.3,
    "volumeUsdt60s": 1234567,
    "tradeCount60s": 512,
    "priceChangePct60s": 0.12,
    "lastPrice": "82450.50"
  }
}
```

---

### 3.4 Стакан ордеров (Redis snapshot)

| Метод | Path | Query | Описание |
|-------|------|-------|----------|
| GET | `/api/orderbook` | `symbol=BTCUSDT&marketType=spot\|futures` | Снапшот стакана |
| GET | `/api/orderbook/debug-compare` | `symbol=BTCUSDT&marketType=spot\|futures` | Debug сравнение |

```json
{
  "success": true,
  "symbol": "BTCUSDT",
  "marketType": "futures",
  "bids": [[82450.0, 1.234], ...],
  "asks": [[82451.0, 0.567], ...],
  "lastUpdateId": 12345678
}
```

---

### 3.5 Walls (крупные ордера в стакане)

| Метод | Path | Query | Описание |
|-------|------|-------|----------|
| GET | `/api/walls` | `symbol=BTCUSDT&marketType=spot\|futures` | Стены по одному символу |
| GET | `/api/walls-batch` | `symbols=BTCUSDT,ETHUSDT&marketType=futures` | Стены по нескольким символам |

---

### 3.6 Density (плотность объёма)

| Метод | Path | Query | Описание |
|-------|------|-------|----------|
| GET | `/api/density-view` | `symbol=BTCUSDT&marketType=futures` | Детальный density view |
| GET | `/api/density-summary` | `symbol=BTCUSDT&marketType=futures` | Краткая сводка |
| GET | `/api/wall-watchlist` | — | Список символов с активными стенами |
| GET | `/api/density-tracked-symbols` | — | Символы под слежкой density |

---

### 3.7 Уровни (Levels)

| Метод | Path | Query | Описание |
|-------|------|-------|----------|
| GET | `/api/autolevels` | `symbol=BTCUSDT&tf=1h&type=local\|global&marketType=futures` | AutoLevels (основной) |
| GET | `/api/levels/:symbol` | — | Уровни из БД по символу |
| GET | `/api/levels/state/:symbol` | — | Состояние мониторинга уровней |
| GET | `/api/levels/watchlist` | — | Символы с приближением/пробоем |
| POST | `/api/levels/manual` | body | Создать ручной уровень |
| PATCH | `/api/levels/:id` | body | Обновить уровень |
| DELETE | `/api/levels/:id` | — | Деактивировать уровень |

> **Важно:** `GET /api/levels` (без параметров) → **410 Gone** — deprecated. Используй `/api/autolevels`.

**AutoLevels query params:**
- `symbol` — обязательный, e.g. `BTCUSDT`
- `tf` — таймфрейм: `1m`, `5m`, `15m`, `1h`, `4h`, `1d`
- `type` — `local` или `global`
- `marketType` — `spot` или `futures`

---

### 3.8 Ручные уровни

| Метод | Path | Описание |
|-------|------|----------|
| POST | `/api/manual-levels` | Создать |
| GET | `/api/manual-levels` | Список (query: `symbol`, `marketType`) |
| DELETE | `/api/manual-levels/:id` | Удалить |

---

### 3.9 Tracked Levels

| Метод | Path | Описание |
|-------|------|----------|
| POST | `/api/tracked-levels/bulk` | Bulk save |
| GET | `/api/tracked-levels` | Список (query: `symbol`, `marketType`) |
| DELETE | `/api/tracked-levels/:id` | Удалить один |
| POST | `/api/tracked-levels/delete-many` | Удалить несколько |
| PATCH | `/api/tracked-levels/:id` | Обновить один |
| POST | `/api/tracked-levels/patch-many` | Обновить несколько |

---

### 3.10 Tracked Extremes

Аналогично tracked-levels, но под `/api/tracked-extremes`:

| Метод | Path |
|-------|------|
| POST | `/api/tracked-extremes/bulk` |
| GET | `/api/tracked-extremes` |
| DELETE | `/api/tracked-extremes/:id` |
| POST | `/api/tracked-extremes/delete-many` |
| PATCH | `/api/tracked-extremes/:id` |
| POST | `/api/tracked-extremes/patch-many` |

---

### 3.11 Tracked Rays

| Метод | Path | Описание |
|-------|------|----------|
| POST | `/api/tracked-rays/bulk` | Bulk save |
| GET | `/api/tracked-rays` | Список |
| DELETE | `/api/tracked-rays/:id` | Удалить один |
| POST | `/api/tracked-rays/delete-many` | Удалить несколько |
| PATCH | `/api/tracked-rays/:id` | Обновить один |
| POST | `/api/tracked-rays/patch-many` | Обновить несколько |
| GET | `/api/tracked-rays/:id/value` | Текущее значение линии (sloped) |

---

### 3.12 Saved Rays

| Метод | Path | Query / Body | Описание |
|-------|------|--------------|----------|
| POST | `/api/saved-rays/bulk` | body | Сохранить лучи (additive, no wipe) |
| GET | `/api/saved-rays` | `symbol`, `marketType`, `source?` | Список |
| DELETE | `/api/saved-rays/:id` | — | Удалить один |
| POST | `/api/saved-rays/delete-many` | `{ ids: number[] }` | Удалить несколько |
| PATCH | `/api/saved-rays/:id` | body | Обновить один |
| POST | `/api/saved-rays/patch-many` | body | Обновить несколько |

**POST /api/saved-rays/bulk body:**
```json
{
  "symbol": "BTCUSDT",
  "marketType": "futures",
  "source": "manual-sloped-level",
  "rays": [
    {
      "side": "support",
      "kind": "ray",
      "shape": "sloped",
      "points": [
        { "timestamp": 1700000000000, "value": 82000.0 },
        { "timestamp": 1700001000000, "value": 82100.0 }
      ],
      "strength": 3,
      "touches": 2
    }
  ]
}
```

**Допустимые значения:**
- `side`: `"support"` | `"resistance"`
- `kind`: `"ray"` | `"line"` | `"level"` | `"extreme"`
- `shape`: `"sloped"` | `"horizontal"`
- `marketType`: `"spot"` | `"futures"`

**GET /api/saved-rays response:**
```json
{
  "success": true,
  "count": 2,
  "rays": [
    {
      "id": 1,
      "symbol": "BTCUSDT",
      "marketType": "futures",
      "source": "saved-rays",
      "side": "support",
      "kind": "ray",
      "shape": "sloped",
      "points": [...],
      "strength": 3,
      "touches": 2,
      "createdAt": "2026-03-18T12:00:00.000Z"
    }
  ]
}
```

---

### 3.13 Manual Sloped Levels

| Метод | Path | Описание |
|-------|------|----------|
| POST | `/api/manual-sloped-levels` | Создать |
| GET | `/api/manual-sloped-levels` | Список |
| DELETE | `/api/manual-sloped-levels/:id` | Удалить |
| PATCH | `/api/manual-sloped-levels/:id` | Обновить |
| GET | `/api/manual-sloped-levels/:id/value` | Текущее значение линии |

---

### 3.14 Extremes Rays

| Метод | Path | Описание |
|-------|------|----------|
| POST | `/api/extremes-rays` | Создать |
| GET | `/api/extremes-rays` | Список |
| PATCH | `/api/extremes-rays/:id` | Обновить |
| DELETE | `/api/extremes-rays/:id` | Удалить |

---

### 3.15 Алерты

| Метод | Path | Query | Описание |
|-------|------|-------|----------|
| GET | `/api/alerts/recent` | `limit=50` | Последние алерты |
| GET | `/api/alerts/watchlist` | — | Символы с алертами |
| GET | `/api/alerts/:symbol` | `limit=20` | Алерты по символу |

```json
{
  "success": true,
  "count": 3,
  "alerts": [
    {
      "type": "market_impulse",
      "symbol": "BTCUSDT",
      "severity": "high",
      "createdAt": 1700000000000,
      "currentPrice": 82450.5,
      "signalContext": {
        "impulseDirection": "up",
        "impulseScore": 78.5,
        "signalConfidence": 82.3,
        "priceMovePct5s": 0.8,
        "volumeSpikeRatio": 3.2
      }
    }
  ]
}
```

---

### 3.16 Posts (социальный фид)

| Метод | Path | Query / Headers | Описание |
|-------|------|-----------------|----------|
| POST | `/api/posts` | `Authorization: Bearer <token>` | Создать пост |
| GET | `/api/posts` | `limit`, `cursor`, `symbol`, `authorId`, `timeframe`, `market` | Лента |
| GET | `/api/posts/:id` | — | Один пост |
| DELETE | `/api/posts/:id` | `Authorization: Bearer <token>` | Удалить |
| POST | `/api/posts/:id/vote` | `Authorization: Bearer <token>` | Лайк/дизлайк |
| POST | `/api/posts/:id/comments` | `Authorization: Bearer <token>` | Добавить комментарий |
| DELETE | `/api/posts/comments/:commentId` | `Authorization: Bearer <token>` | Удалить комментарий |

**POST /api/posts** — multipart/form-data:
```
image: File  (обязательно, max 10MB, JPEG/PNG/WebP/GIF)
symbol: string
marketType: "spot" | "futures"
timeframe: string
side: "long" | "short" | "neutral"
description: string (опционально)
tags: JSON string array (опционально)
```

**Pagination (`GET /api/posts`):**
- Cursor-based: берёшь `nextCursor` из ответа, передаёшь в следующий запрос как `?cursor=...`
- `nextCursor: null` — последняя страница

---

### 3.17 Аутентификация

| Метод | Path | Body | Описание |
|-------|------|------|----------|
| POST | `/api/auth/register` | `{ username, password }` | Регистрация |
| POST | `/api/auth/login` | `{ username, password }` | Логин |
| GET | `/api/auth/me` | — (нужен токен) | Текущий пользователь |

**Ограничения username:** 3–64 символа, только `a-z A-Z 0-9 _ . -`  
**Минимальная длина password:** 6 символов

**Ответ при успехе:**
```json
{
  "success": true,
  "token": "eyJhbGci...",
  "user": {
    "id": "42",
    "username": "trader42",
    "role": "user",
    "avatarUrl": null
  }
}
```

**Хранить токен:** `localStorage.getItem('trackista_token')`  
**Передавать:** `Authorization: Bearer <token>`

---

### 3.18 Системные

| Метод | Path | Описание |
|-------|------|----------|
| GET | `/health` | Статус backend (не `/api/health`) |
| GET | `/api/delivery/status` | Статус Telegram доставки |
| GET | `/api/binance-rate-limit-state` | Rate limit состояние Binance прокси |
| GET | `/api/futures-ob/state` | Состояние futures OB |
| GET | `/api/ws-proxy/debug` | Debug WS proxy |

---

## 4. WebSocket API

### Подключение

```ts
// Правильно: относительный WS URL
const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
const ws = new WebSocket(`${protocol}://${location.host}/ws/fstream/btcusdt@depth`)

// ❌ Неправильно
const ws = new WebSocket('wss://fstream.binance.com/ws/btcusdt@depth')  // прямое подключение к Binance
```

### Spot Streams

```
/ws/stream/<streamName>  →  wss://stream.binance.com:9443/ws/<streamName>
```

Примеры:
```
/ws/stream/btcusdt@trade
/ws/stream/btcusdt@depth@100ms
/ws/stream/btcusdt@kline_1m
/ws/stream/!ticker@arr
```

### Futures Streams

```
/ws/fstream/<streamName>  →  wss://fstream.binance.com/ws/<streamName>
```

Примеры:
```
/ws/fstream/btcusdt@depth
/ws/fstream/btcusdt@aggTrade
/ws/fstream/btcusdt@kline_1m
/ws/fstream/btcusdt@markPrice@1s
```

### Поведение прокси

- Upstream auto-reconnect: до 10 попыток, exponential backoff (от 2s до 30s)
- Клиентское соединение сохраняется при reconnect upstream
- Клиентские сообщения (subscribe/unsubscribe) форвардятся в Binance
- Закрытие upstream после исчерпания попыток → закрытие клиентского соединения

### Комбинированные стримы

Binance поддерживает несколько стримов на одно соединение:
```ts
const ws = new WebSocket(`${protocol}://${location.host}/ws/fstream/btcusdt@depth/btcusdt@aggTrade`)
```

---

## 5. Сборка и деплой

### Структура директорий

```
trackista-server/
├── backend/             ← Node.js API
├── collector/           ← Data collector
├── nginx/
│   └── nginx.conf       ← Production nginx config
├── frontend/
│   └── dist/            ← Сюда кладётся production build фронтенда
├── docker-compose.yml
└── .env
```

### Деплой фронтенда

```bash
# 1. В репозитории фронтенда
npm run build

# 2. Копируем build в trackista-server
cp -r dist/* /path/to/trackista-server/frontend/dist/

# 3. Перезапускаем nginx (подхватит новые файлы через volume mount)
docker compose --profile production restart nginx
```

### Переменные окружения для фронтенда в .env

```env
# Для локальной разработки не нужно ничего настраивать если используется Vite proxy.
# Для production build — тоже не нужно: nginx сам роутит /api на backend.
```

---

## 6. Диагностика — как проверить что всё работает

### Локально

```bash
# Backend
curl http://localhost:3000/health
curl http://localhost:3000/api/symbols
curl "http://localhost:3000/api/binance/futures/v1/exchangeInfo?symbol=BTCUSDT"

# Через Vite proxy (когда запущен dev server)
curl http://localhost:5173/api/symbols
```

### Production (через nginx)

```bash
curl http://your-domain.com/health
curl http://your-domain.com/api/symbols
curl "http://your-domain.com/api/binance/spot/v3/exchangeInfo?symbol=BTCUSDT"
curl "http://your-domain.com/api/saved-rays?symbol=BTCUSDT&marketType=futures"
```

---

## 7. Частые ошибки

### `TypeError: Failed to construct 'URL': Invalid URL`

**Причина:** `VITE_API_URL` или другая переменная окружения не задана → undefined → передаётся в `new URL(undefined)`.

**Исправление:**
```ts
// ❌ Неправильно
const url = new URL(path, import.meta.env.VITE_API_URL)

// ✅ Правильно — relative fetch без базового URL
const response = await fetch(`/api${path}`)

// ✅ Или с fallback на пустую строку
const BASE = import.meta.env.VITE_API_URL ?? ''
const response = await fetch(`${BASE}/api${path}`)
```

---

### `404` + HTML redirect вместо JSON

**Причина:** браузер делает запрос `api/levels?...` (без leading slash), который попадает в SPA, а не на API.

**Исправление:**
```ts
// ❌ Без слэша — относительный URL, идёт к текущей странице
fetch('api/levels?symbol=BTCUSDT')

// ✅ Со слэшем — абсолютный путь от корня
fetch('/api/levels?symbol=BTCUSDT')
```

---

### WebSocket `wss://trackista.live/ws/...` не подключается

**Причина:** нет nginx или nginx не запущен с production профилем.

**Проверка:**
```bash
# На production сервере
docker compose --profile production ps

# Тест WebSocket через curl
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Key: test" -H "Sec-WebSocket-Version: 13" \
     http://localhost/ws/fstream/btcusdt@trade
# Ожидаем: HTTP/1.1 101 Switching Protocols
```

---

### `500` в `/api/posts` при загрузке изображений

MinIO должен быть запущен. Проверить:
```bash
docker compose ps minio
curl http://localhost:9000/minio/health/live
```

---

## 8. Rate Limits (серверная защита)

Backend защищён rate limitами через Redis. Если превышено:

```json
HTTP 429
{
  "success": false,
  "error": "Too many requests"
}
```

| Endpoint | Лимит по умолчанию |
|-----------|-------------------|
| `/api/auth/*` | Rate limited (строго) |
| `POST /api/posts` | 500 постов / час |
| `POST /api/posts/:id/comments` | 200 комментариев / час |
| `POST /api/posts/:id/vote` | 500 голосов / час |

Лимиты настраиваются через `.env`:
```env
RATE_LIMIT_POST_MAX=500
RATE_LIMIT_POST_WINDOW_SEC=3600
RATE_LIMIT_COMMENT_MAX=200
RATE_LIMIT_VOTE_MAX=500
```
