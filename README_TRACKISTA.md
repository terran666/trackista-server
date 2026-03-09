# TRACKISTA CORE

## Realtime Crypto Market Intelligence Engine

---

## Project Purpose

Trackista Core — это реалтайм аналитический сервер крипторынка, который:

- собирает данные с Binance
- фильтрует торговые пары
- агрегирует рынок
- вычисляет сигналы активности
- ранжирует монеты
- хранит уровни поддержки/сопротивления
- предоставляет API для фронтенда Trackista

> Trackista строится как **market intelligence engine**, а не просто график.

---

## High Level Architecture

```
             Binance
               │
               ▼
         Collector Engine
               │
               ▼
             Redis
        (hot realtime data)
               │
               ▼
          Backend API
               │
        ┌──────┼────────┐
        ▼      ▼        ▼
   Signal API Level API Market API
        │      │        │
        └──────┼────────┘
               ▼
        Trackista Frontend
               │
               ▼
            Trader
```

**Persistent storage:**

- MySQL → levels storage

---

## Infrastructure

Система запускается через Docker.

**Services:**
- `collector`
- `backend`
- `redis`
- `mysql`

Управление сервисами происходит через `docker-compose.yml`.

---

## Project Structure

```
collector/
backend/
mysql/
docker-compose.yml
.env
.env.example
```

---

## Redis — Realtime Data Layer

Redis используется как горячий слой данных.

**Типы данных:**
- `price`
- `trade`
- `metrics`
- `signals`
- `levels`
- `symbols`

**Redis Keys:**

| Key | Описание |
|---|---|
| `price:SYMBOL` | Текущая цена |
| `trade:SYMBOL:last` | Последний трейд |
| `metrics:SYMBOL` | Агрегированные метрики |
| `signal:SYMBOL` | Сигнал активности |
| `levels:SYMBOL` | Уровни поддержки/сопротивления |
| `symbols:active:usdt` | Список активных символов |

---

## Phase 1 — Market Ingestion

Collector подключается к Binance WebSocket.

Используется поток: `<symbol>@trade`

Каждый trade содержит:
- `price`
- `quantity`
- `timestamp`
- `side`

Collector пишет данные в Redis:
- `price:BTCUSDT`
- `trade:BTCUSDT:last`

---

## Phase 2 — Market Universe

Collector формирует universe активных символов.

**Шаги:**

1. Получить список символов Binance — `GET /exchangeInfo`
2. Отфильтровать: `status = TRADING`, `quoteAsset = USDT`
3. Проверить ликвидность — `GET /ticker/24hr`, фильтр: `quoteVolume ≥ 10 000 USDT`

После фильтра остается примерно **~437 активных символов**.

### Stablecoin Filtering

Чтобы избежать ложных сигналов, исключаются пары stablecoin/stablecoin.

Примеры: `FDUSDUSDT`, `TUSDUSDT`, `USD1USDT`

Фильтрация происходит по `baseAsset`.

Список stablecoins:
`USDT`, `USDC`, `FDUSD`, `TUSD`, `BUSD`, `DAI`, `USDP`, `USD1`, `PYUSD`, `USDS`, `EURI`

---

## Phase 3 — Aggregation Engine

Collector агрегирует трейды в памяти.

Для каждого символа хранится **60 секундных бакетов**.

Каждый бакет содержит:
- `volumeUsdt`
- `buyVolumeUsdt`
- `sellVolumeUsdt`
- `tradeCount`
- `openPrice`
- `closePrice`

### Sliding Windows

Из бакетов вычисляются окна: `1s`, `5s`, `15s`, `60s`

Метрики:
- `volumeUsdt`
- `tradeCount`
- `delta`
- `price change`

### Market Activity Score

Каждая монета получает `activityScore`.

**Формула:**
```
activityScore =
  vol60 * 0.5
  + tradeCount60 * 10
  + |pricePct60| * 1000
```

**API:** `GET /api/market/top-active`

---

## Phase 4 — Signal Engine

Signal Engine вычисляет поведенческие признаки рынка.

**Основные метрики:**
- `volumeSpikeRatio60s`
- `volumeSpikeRatio15s`
- `tradeAcceleration`
- `deltaImbalancePct60s`
- `priceVelocity60s`

### Market States

Каждый символ может находиться в состоянии:
- `neutral`
- `in-play`
- `impulse`

### Impulse Detection

Импульс определяется через: volume spike, trade acceleration, delta imbalance.

- Score: `impulseScore`
- Direction: `up` / `down` / `mixed`

### Liquidity Protection

Чтобы избежать ложных сигналов:
- `vol60 < 5000` → signal = 0
- `tradeCount60 < 20` → signal = 0

### Baseline Protection

Минимальные baseline значения:
- `vol60 baseline ≥ 1000`
- `vol15 baseline ≥ 200`
- `count60 baseline ≥ 5`

Caps:
- `volumeSpikeRatio ≤ 20`
- `tradeAcceleration ≤ 20`
- `deltaImbalancePct ∈ [-1, +1]`

### Signal Confidence

Confidence вычисляется из: baseline readiness, volume liquidity, trade liquidity.

Диапазон: **0 → 100**

### Signal API

```
GET /api/signals/:symbol       # сигнал по символу
GET /api/market/in-play        # рейтинг активных монет
GET /api/market/impulse        # рейтинг монет с импульсом
```

---

## Phase 5 — Level Engine

Trackista Core хранит уровни поддержки/сопротивления.

### MySQL Table — `levels`

| Поле | Тип | Описание |
|---|---|---|
| `id` | BIGINT | Primary key |
| `symbol` | VARCHAR(32) | Торговая пара |
| `price` | DECIMAL(20,8) | Цена уровня |
| `type` | VARCHAR(32) | Тип уровня |
| `source` | VARCHAR(32) | Источник уровня |
| `strength` | INT | Сила уровня (0-100) |
| `timeframe` | VARCHAR(16) | Таймфрейм |
| `is_active` | BOOLEAN | Активен (soft delete) |
| `meta_json` | JSON | Дополнительные данные |
| `created_at` | DATETIME | Дата создания |
| `updated_at` | DATETIME | Дата обновления |

### Level Types
`support`, `resistance`, `manual`, `high`, `low`, `cluster`, `density`

### Level Sources
`manual`, `auto`, `auto_swing`, `auto_extreme`, `auto_cluster`, `auto_density`

### Level Cache

Активные уровни кешируются в Redis: `levels:SYMBOL`, TTL **5 минут**.

Cache rebuild происходит при: `create`, `update`, `delete`.

### Level API

```
GET    /api/levels/:symbol     # получить уровни
POST   /api/levels/manual      # создать уровень вручную
PATCH  /api/levels/:id         # обновить уровень
DELETE /api/levels/:id         # мягкое удаление (is_active = false)
```

Удаление происходит через `is_active = false`. Данные не удаляются из БД.

---

## Data Flow

```
Binance → Collector → Redis → Backend API → Frontend → Trader
```

---

## Trackista Frontend

Frontend отвечает за:
- chart visualization
- level rendering
- signal display
- market screener
- alerts UI

**Основные страницы:** Screener, Monitor, Trading Chart

**Chart engine:** KLineCharts

---

## Current System Capabilities

Trackista Core уже реализует:

| # | Capability |
|---|---|
| ✅ | Market ingestion (Binance WebSocket) |
| ✅ | Market universe filtering (~437 symbols) |
| ✅ | Real-time aggregation (60s rolling buckets) |
| ✅ | Signal detection (spike, acceleration, imbalance) |
| ✅ | Market ranking (top-active, in-play, impulse) |
| ✅ | Level storage (MySQL + Redis cache) |

---

## Next Phase

### Phase 6 — Level Monitoring Engine

Сервер будет вычислять:
- distance to level
- approaching level
- touch
- cross
- breakout candidate
- bounce candidate

Это позволит генерировать **реальные торговые алерты**.

---

## Long Term Vision

Trackista должен стать реалтайм системой обнаружения торговых возможностей, которая помогает трейдерам:

- видеть импульсы
- видеть монеты в игре
- видеть уровни
- ловить пробои

---

## Development Philosophy

Trackista Core строится по принципам:

- **event-driven architecture**
- **in-memory analytics**
- **low latency processing**
- **modular services**

---

> Следующий шаг: **Trackista Roadmap (Phase 1 → Phase 12)** —
> карта всей разработки, чтобы Copilot понимал следующие этапы,
> ты всегда видел где мы находимся, и архитектура проекта не потерялась.
