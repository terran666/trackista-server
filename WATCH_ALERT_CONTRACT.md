# BACKEND ТЗ — Watch/Alert Architecture Contract

**Цель:**
Закрепить архитектуру, в которой вся бизнес-логика уровней и сигналов находится только на backend.
Frontend является только consumer/executor и не принимает решений по типам событий, popup, sound, badge.

---

## 1. Роль Backend

Backend является **единственным вычислительным ядром** системы.

Backend отвечает за:
- сбор realtime market data
- хранение уровней и watch config
- расчёт текущего состояния уровня
- принятие решения о генерации события
- формирование delivery policy
- публикацию state и alert events
- выдачу API фронтенду

**Главный принцип:**
Именно backend решает:
- насколько цена близко к уровню
- какая сейчас phase
- произошло ли событие
- нужно ли создавать alert
- нужны ли popup / sound / badge / telegram

Frontend эти решения не дублирует.

---

## 2. Источник текущей цены

Watch engine сравнивает **текущую realtime-цену из Redis `price:SYMBOL`** с ценой уровня.

**Правильно:** "watch engine сравнивает текущую realtime-цену из Redis `price:SYMBOL` с ценой уровня"

**Неправильно:** "сравнивает цену из баров с ценой уровня"

Логика watching/approaching/contact/crossed опирается на **live price**, а не на OHLC-бары.

> В коде, документации, логах и комментариях не использовать формулировку "цена из баров", если источник — Redis live price.

---

## 3. Основные слои Backend

### 3.1 Market Data Layer
- Binance WebSocket → collector → price feed
- orderbook / walls / market context

Пишет в Redis:
- `price:SYMBOL`
- orderbook / walls / auxiliary realtime keys

### 3.2 Level Repository Layer
- manual levels (file + MySQL)
- watch config
- alert options

Отдаёт engine уже пригодную для расчёта структуру уровня.

### 3.3 Watch Engine
- получение active watched levels
- чтение current price из Redis `price:SYMBOL`
- расчёт watch-state
- определение phase
- проверку cooldown / dedup
- создание alert-event

### 3.4 Delivery Planner
- формирование delivery policy: sound / popup / badge / telegram / другие каналы

Delivery planner является **backend-логикой**.
Frontend только **исполняет** delivery flags.

### 3.5 API Layer
Только:
- приём команд
- чтение state/events
- сохранение config
- JSON ответы

API **не содержит** дублирующую бизнес-логику signal engine.

---

## 4. Две разные сущности: Watch-State и Alert-Event

### 4.1 Watch State

Snapshot текущего состояния уровня **"на сейчас"**.

**Назначение:** UI status / diagnostics / база для следующего engine tick.
Watch-state **НЕ является** alert.

Пример полей:
```json
{
  "externalLevelId": "93",
  "symbol": "SIRENUSDT",
  "market": "futures",
  "source": "manual",
  "levelPrice": 1.005951,
  "currentPrice": 1.00831,
  "distancePct": 0.234,
  "signedDistancePct": 0.234,
  "sideRelativeToLevel": "above",
  "phase": "approaching",
  "prevPhase": "watching",
  "phaseEnteredAt": 1774333500000,
  "phaseDurationMs": 74062,
  "ticksInPhase": 74,
  "approachSpeed": -0.031,
  "approachAcceleration": -0.031,
  "impulseScore": 272.7,
  "inPlayScore": 179.2,
  "wallContext": { "wallNearby": false },
  "lastTouchAt": null,
  "lastCrossAt": null,
  "updatedAt": 1774333574062
}
```

### 4.2 Alert Event

Отдельное **дискретное событие**.

**Назначение:** recent alerts / popup / sound / badge / telegram / история сигналов / аналитика.
Alert-event **НЕ создаётся** на каждом тике — только когда backend подтверждает событие.

Пример полей:
```json
{
  "eventId": "SIRENUSDT-level_approaching-1774333565062-93",
  "eventType": "level_approaching",
  "externalLevelId": "93",
  "symbol": "SIRENUSDT",
  "market": "futures",
  "source": "manual",
  "levelPrice": 1.005951,
  "currentPrice": 1.00957,
  "phaseFrom": "watching",
  "phaseTo": "approaching",
  "reason": "distance_threshold",
  "score": 240.1,
  "severity": "medium",
  "contextSnapshot": { "impulseScore": 240.1, "wallContext": {} },
  "delivery": { "sound": true, "popup": true, "badge": false, "telegram": false },
  "fingerprint": "SIRENUSDT:futures:manual-93:level_approaching:29572226",
  "createdAt": 1774333565062
}
```

**Главное правило:**
- `watch-state` = snapshot
- `alert-event` = discrete event

---

## 5. Как работает Watch Engine

Цикл 1 раз в секунду.

| Шаг | Действие |
|---|---|
| **A** | Загружает список активных watched levels |
| **B** | Для каждого уровня получает current realtime price из Redis `price:SYMBOL` |
| **C** | Загружает previous watch-state уровня |
| **D** | Рассчитывает новый current watch-state (currentPrice, distancePct, phase, approachSpeed, impulse, …) |
| **E** | Сравнивает previous ↔ current state, определяет произошло ли событие |
| **F** | Если события нет → только обновляет watch-state |
| **G** | Если событие есть → проверяет cooldown/dedup → формирует alert-event → формирует delivery → пишет в alerts/recent → обновляет watch-state |

> **Главный принцип:** каждый tick обновляет state, но не каждый tick создаёт event.

---

## 6. Event Types

Стабильный string enum. Пример:

```
approaching_entered
precontact_entered
contact_hit
crossed_up
crossed_down
rejection_candidate
breakout_candidate
breakout_confirmed
```

Требования:
- `eventType` — стабильный string enum
- Frontend не интерпретирует `eventType` как бизнес-правило delivery
- Delivery определяется отдельно backend-ом

---

## 7. Delivery Policy

Backend формирует delivery для каждого alert-event:

```json
{
  "sound": true,
  "soundId": "soft_ping",
  "popup": true,
  "popupPriority": "normal",
  "badge": false,
  "telegram": false
}
```

Правила:
- Backend принимает решение о delivery
- Frontend **не имеет** локальных списков `SOUND_TYPES` / `POPUP_TYPES`
- Frontend **не решает** самостоятельно, что событие звуковое или требует popup
- `delivery` приходит в каждом alert-event как **готовое решение backend**

---

## 8. Redis / Storage Contract

### 8.1 Redis (realtime fast state)

| Ключ | Назначение |
|---|---|
| `price:BTCUSDT` | Текущая live-цена |
| `levelwatchstate:futures:BTCUSDT:manual-93` | Watch-state уровня |
| `watchcooldown:{type}:{market}:{symbol}:{id}` | Cooldown guard |
| `watcheventfp:{fingerprint}` | Dedup fingerprint |
| `alerts:recent` | Лента alert-events (Redis list) |

### 8.2 MySQL (persistent config & history)

- `levels` — уровни
- `level_watch_configs` — watch config
- `level_alert_options` — alert options
- `level_events` — event history / audit

---

## 9. API Contract

| Метод | Endpoint | Назначение |
|---|---|---|
| `POST` | `/api/manual-levels` | Создать уровень |
| `PATCH` | `/api/manual-levels/:id/watch` | Включить/выключить watch, обновить config |
| `GET` | `/api/manual-levels/:id/watch-state` | Watch-state snapshot |
| `GET` | `/api/alerts/recent` | Alert events лента |

Требования:
- `/watch-state` возвращает только state snapshot
- `/alerts/recent` возвращает только alert events
- Не смешивать state и event в одном ответе без специальной причины

---

## 10. Что запрещено на Backend

- Считать watch-state и alert-event одной и той же сущностью
- Публиковать alert на каждом tick без event-condition
- Описывать current price как "цена из баров", если источник Redis live price
- Перекладывать решение popup/sound/badge на frontend
- Дублировать business logic в API handlers
- Смешивать delivery policy и frontend fallback-правила

---

## 11. Логирование и диагностика

Минимум на каждое событие:

```
symbol          externalLevelId   currentPrice   levelPrice
distancePct     prevPhase         nextPhase       eventType
cooldownHit     dedupHit          delivery        updatedAt
```

Необходимо для отладки:
- почему событие создалось / не создалось
- почему не пришёл popup/sound
- почему phase изменилась

---

## 12. Короткий итог

| Сторона | Роль |
|---|---|
| **Backend** | Собирает данные → считает состояние → определяет событие → формирует delivery → публикует state и alerts |
| **Frontend** | Отправляет команды → читает state/events → исполняет delivery |

```
Backend = decision maker
Frontend = executor
```

---

## 13. Следующий шаг

После соблюдения этого контракта архитектура готова к:
- State machine + hysteresis + hold time
- Tactic events (breakout / bounce / fakeout)
- Bar-close confirmation
- Sloped level support
- Wall context integration
