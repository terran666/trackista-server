# TRACKISTA CORE — Технический конспект

> Это рабочий конспект Copilot. Здесь записано то, что я понимаю о системе на текущий момент.
> Обновляется по мере развития проекта.

---

## Что я понимаю про этот проект

Trackista — это не торговый бот и не просто чарт.
Это **сервер обнаружения рыночной активности** в реальном времени.

Цель: видеть рынок раньше, чем его видит обычный трейдер.
Не предсказывать. Обнаруживать.

---

## Архитектурное понимание

Система состоит из двух сервисов:

### Collector
- Единственный источник рыночных данных
- Подключается к Binance WebSocket напрямую
- Хранит всё в памяти (secondBuckets, signalHistory)
- Каждую секунду сбрасывает агрегат в Redis через pipeline
- Не пишет в MySQL — только Redis
- Сам решает, какие символы торгуются (universe)

### Backend
- Читает только из Redis (горячие данные) и MySQL (уровни)
- Не подключается к Binance
- Отвечает на запросы фронтенда
- Не содержит heavy логики — только чтение и отдача

Это правильная архитектура: **collector думает, backend отдаёт**.

---

## Что реально хранится в Redis

```
price:BTCUSDT           → "84321.50"                  (последняя цена)
trade:BTCUSDT:last      → JSON последнего трейда       (цена, объём, сторона)
metrics:BTCUSDT         → JSON агрегата                (окна 1s/5s/15s/60s)
signal:BTCUSDT          → JSON сигнала                 (spike, accel, scores)
levels:BTCUSDT          → JSON массив активных уровней (TTL 5 мин)
symbols:active:usdt     → JSON массив символов         (~437 штук)
```

Всё в Redis живёт. MySQL только для уровней.

---

## Как работает Collector — пошагово

1. **Старт** → `fetchValidSymbols()` строит Map из Binance exchangeInfo + 24hr ticker
2. **Фильтрация**:
   - status = TRADING
   - quoteAsset = USDT
   - baseAsset не стейблкоин
   - quoteVolume ≥ 10 000 USDT
3. **WebSocket** → символы разбиваются по 100 штук в батч, каждый батч = один combined stream
4. **onTrade()** → каждый трейд попадает в `secondBuckets[currentSecond]` в памяти. Redis не трогается.
5. **setInterval 1s** → `startFlushTimer()` берёт все символы у которых были трейды, вычисляет snapshot + signal, пишет в Redis через pipeline одним вызовом
6. **buildSnapshot()** → из 60 бакетов собираются окна 1s/5s/15s/60s
7. **buildSignal()** → из snapshot вычисляются все метрики + применяются защиты

---

## Signal Engine — что я понимаю

Сигнал — это не предсказание. Это **аномалия**.

Аномалия обнаруживается через сравнение с baseline:

```
volumeSpikeRatio60s  = vol60_текущий / vol60_baseline
volumeSpikeRatio15s  = vol15_текущий / vol15_baseline
tradeAcceleration    = count60_текущий / count60_baseline
deltaImbalancePct60s = (buyVol - sellVol) / totalVol   → [-1, +1]
priceVelocity60s     = % изменение цены за 60 секунд
```

**Baseline** — это среднее по `signalHistory[]` (60 снимков = ~60 секунд истории).

Проблема была: пока baseline не накоплен, деление на ~0 давало взрывные значения.
Решение: минимальные значения baseline + caps + liquidity gate + warmup флаг.

### Защиты:
| Защита | Значение |
|---|---|
| `BASELINE_MIN_VOL60` | 1 000 |
| `BASELINE_MIN_VOL15` | 200 |
| `BASELINE_MIN_COUNT60` | 5 |
| `RATIO_CAP` | 20 |
| `ACCEL_CAP` | 20 |
| `deltaImbalancePct` | clamp [-1, +1] |
| Liquidity gate vol60 | ≥ 5 000 |
| Liquidity gate count60 | ≥ 20 |
| `WARMUP_SNAPSHOTS` | 30 |

### Scores:
- `inPlayScore` — монета активна (высокий объём или ускорение)
- `impulseScore` — монета в импульсе (направленное движение + объём)
- `impulseDirection` — `up` / `down` / `mixed`
- `signalConfidence` — насколько зрелый baseline (0-100)

---

## Level Engine — что я понимаю

Уровни — это **ключевые ценовые зоны**, которые сервер запоминает.

Сейчас реализовано только ручное добавление (Phase 5).
Автоматическое обнаружение — следующий этап (Phase 6).

### Архитектура хранения:
```
MySQL (levels)     → постоянное хранение, soft delete через is_active
Redis (levels:SYM) → кэш активных уровней, TTL 5 мин
```

Логика простая: при любом изменении (create/update/delete) кэш перестраивается сразу.
Чтение — всегда сначала Redis, при промахе — MySQL.

### Что значит soft delete:
`is_active = FALSE` → уровень не удаляется из БД, просто перестаёт использоваться.
Это важно для истории и будущего анализа (касание уровня, пробой и т.д.).

---

## Текущий стек

| Компонент | Технология |
|---|---|
| Runtime | Node.js 20-alpine |
| Modules | CommonJS (`require`) |
| WebSocket | `ws` library |
| Cache | `ioredis` |
| HTTP | `express ^4.18` |
| Database | `mysql2/promise` |
| Infra | Docker Compose |
| Market data | Binance WebSocket API |

---

## Env-переменные (важно)

В `docker-compose.yml` переменные для backend называются:
```
DB_HOST=mysql
DB_PORT=3306
DB_USER=trackista
DB_PASSWORD=change_me_password
DB_NAME=trackista
```

Не `MYSQL_HOST` — именно `DB_HOST`. Это уже зафиксировано в коде.

---

## Что сделано по фазам

| Фаза | Что реализовано | Статус |
|---|---|---|
| Phase 1 | Подключение к Binance, запись price/trade в Redis | ✅ |
| Phase 2 | Universe ~437 символов, stablecoin filter | ✅ |
| Phase 3 | In-memory aggregation, 60 бакетов, 1s flush, `/api/market/top-active` | ✅ |
| Phase 4 | Signal engine, spike/accel/delta/velocity, in-play, impulse | ✅ |
| Phase 4.1 | Стабилизация математики (caps, baselines, liquidity gate) | ✅ |
| Phase 5 | Level engine: MySQL table, levelsService.js, CRUD API + Redis cache | ✅ |
| Phase 6 | Auto-detection уровней (swing, cluster, density) | ⏳ |
| Phase 7 | Level monitoring: distance, touch, cross, breakout, bounce | ⏳ |
| Phase 8 | Alert engine + Telegram | ⏳ |

---

## Что я считаю важным не сломать

1. **onTrade() должен быть максимально быстрым** — никаких await, никаких Redis-вызовов внутри
2. **Pipeline в flush** — все Redis-записи одним вызовом, не по одному
3. **Baseline защиты** — без них signal engine даёт мусор на холодных символах
4. **Soft delete уровней** — никогда не удалять из БД физически
5. **Cache rebuild сразу** — после любой записи уровня, не ждать TTL

---

## Следующий логичный шаг

**Phase 6 — Auto Level Detection**

Collector будет обнаруживать уровни автоматически из рыночных данных:
- **swing high/low** — локальные экстремумы из бакетов
- **cluster** — зоны скопления цены
- **density** — зоны высокого объёма

Результат пишется в MySQL через `levelsService` с `source = auto_swing` / `auto_cluster` / `auto_density`.

После этого станет возможным **Phase 7 — Level Monitoring**:
сервер будет знать расстояние от текущей цены до ближайшего уровня
и сможет генерировать события (approaching, touch, cross, breakout, bounce).
