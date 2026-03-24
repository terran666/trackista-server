# BACKEND — роль и ответственность

Бэкенд является **source of truth** для watch engine и alert engine.
Вся бизнес-логика уровней выполняется на сервере.

---

## 1. Сбор рыночных данных

- Подключается к Binance WebSocket
- Получает realtime market data
- Пишет актуальную цену в Redis: `price:SYMBOL`
- Получает orderbook / walls / market context
- Поддерживает актуальные данные для расчётов watch engine

> **Важно:** watch engine сравнивает текущую realtime-цену из Redis `price:SYMBOL` с ценой уровня.
> Это не OHLC/candles — это live price.

---

## 2. Хранение уровней и настроек

- Manual levels (файловые и MySQL)
- Watch config
- Alert options
- Служебные настройки engine

---

## 3. Загрузка активных уровней

- Выбирает все уровни с включённым слежением
- Объединяет: цену уровня, symbol, market, тип уровня, watch settings, alert settings
- Подготавливает уровни для расчёта

---

## 4. Watch Engine (1 раз в секунду)

Для каждого активного уровня:

- Берёт текущую realtime-цену из Redis `price:SYMBOL`
- Сравнивает её с ценой уровня
- Считает `distancePct`, `signedDistancePct`
- Считает `approachSpeed`, `approachAcceleration`
- Определяет текущую `phase`
- Учитывает market context: `impulseScore`, `inPlayScore`, `wallContext`
- Проверяет cooldown / dedup / fingerprint
- Решает, нужно ли создавать событие

---

## 5. Watch State

Создаёт snapshot текущего состояния уровня и пишет в Redis.
Фронтенд читает состояние через `GET /api/manual-levels/:id/watch-state`.

Пример полей:

```json
{
  "externalLevelId": "93",
  "symbol": "SIRENUSDT",
  "market": "futures",
  "levelPrice": 1.005951,
  "currentPrice": 1.00831,
  "distancePct": 0.234,
  "phase": "approaching",
  "approachSpeed": -0.031,
  "impulseScore": 272.7,
  "wallContext": { "wallNearby": false },
  "updatedAt": 1774333574062
}
```

---

## 6. Alert Events

Когда engine решает, что произошло событие:

- Определяет тип события (`level_approaching`, `level_touched`, `level_crossed`, `early_warning`, …)
- Прикладывает context snapshot
- Рассчитывает delivery policy
- Пишет событие в `alerts:recent`

---

## 7. Delivery Policy

Сервер решает, должен ли alert иметь:

- `popup`
- `sound` + `soundId`
- `telegram`
- `popupPriority`

Фронтенд **не вычисляет** delivery сам — он только исполняет `delivery` flags из события.

---

## 8. API Layer

API слой не вычисляет бизнес-логику.

Роль API:
- Принимать команды от фронтенда
- Сохранять уровни и watch config
- Читать state и alerts из Redis / DB
- Возвращать JSON

Основные endpoints:

| Метод | Endpoint | Описание |
|---|---|---|
| `POST` | `/api/manual-levels` | Создать файловый уровень |
| `PATCH` | `/api/manual-levels/:id/watch` | Включить/настроить слежение |
| `GET` | `/api/manual-levels/:id/watch-state` | Текущее состояние уровня из Redis |
| `GET` | `/api/alerts/recent` | Лента алертов |

---

## Главный принцип

Бэкенд является **единственным вычислительным ядром**.

Именно сервер принимает решение:
- насколько цена близко к уровню
- какая сейчас phase
- произошло ли событие
- нужен ли alert
- нужен ли popup / sound / telegram
