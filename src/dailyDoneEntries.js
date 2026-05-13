const LEGACY_FLAT_TOTAL_KEY = "__migratedFromFlatTotal";

/**
 * Суммы за день без времени записи — под ключом LEGACY_FLAT_TOTAL_KEY (не фиктивный ISO),
 * чтобы почасовая статистика не кластеризовалась в одно время. Ключи с префиксом "__" — служебные.
 * Сумма отжиманий за день: поддерживается число (устар.) и объект по дням/записям.
 */
function dayEntryTotal(dayEntry) {
  if (dayEntry == null) {
    return 0;
  }
  if (typeof dayEntry === "number") {
    return Math.max(0, Number(dayEntry));
  }
  if (typeof dayEntry === "object" && !Array.isArray(dayEntry)) {
    const sum = Object.values(dayEntry).reduce((acc, v) => acc + Number(v || 0), 0);
    return Math.max(0, sum);
  }
  return 0;
}

/** Подключи при почасовой разбивке: такие ключи — не момент записи, а агрегат без времени. */
function isReservedDailyDoneSubKey(subKey) {
  return typeof subKey === "string" && subKey.startsWith("__");
}

function uniqueTimestampKey(map, at) {
  let key = at.toISOString();
  let n = 0;
  while (Object.prototype.hasOwnProperty.call(map, key)) {
    n += 1;
    key = `${at.toISOString()}#${n}`;
  }
  return key;
}

function migrateDayToObjectIfNeeded(workspace, dateKey) {
  const cur = workspace.dailyDone[dateKey];
  if (cur == null) {
    workspace.dailyDone[dateKey] = {};
    return workspace.dailyDone[dateKey];
  }
  if (typeof cur === "number") {
    const n = Number(cur || 0);
    workspace.dailyDone[dateKey] = n === 0 ? {} : { [LEGACY_FLAT_TOTAL_KEY]: n };
    return workspace.dailyDone[dateKey];
  }
  if (typeof cur === "object" && !Array.isArray(cur)) {
    return cur;
  }
  workspace.dailyDone[dateKey] = {};
  return workspace.dailyDone[dateKey];
}

/**
 * Приводит dailyDone к виду для БД/экспорта: за календарный день число заменяется на
 * { [LEGACY_FLAT_TOTAL_KEY]: n } — сумма без известного времени, не ISO-метка.
 */
function normalizeDailyDoneForStorage(dailyDone) {
  if (!dailyDone || typeof dailyDone !== "object" || Array.isArray(dailyDone)) {
    return {};
  }
  const out = {};
  for (const [dateKey, val] of Object.entries(dailyDone)) {
    if (val == null) {
      continue;
    }
    if (typeof val === "number") {
      const n = Number(val);
      out[dateKey] = n === 0 ? {} : { [LEGACY_FLAT_TOTAL_KEY]: n };
      continue;
    }
    if (typeof val === "object" && !Array.isArray(val)) {
      const day = {};
      for (const [k, v] of Object.entries(val)) {
        if (typeof v === "number" && Number.isFinite(v)) {
          day[k] = v;
        }
      }
      out[dateKey] = day;
    }
  }
  return out;
}

/** Запись изменения за календарный день: delta > 0 — добавление, < 0 — снятие (по времени at). */
function recordDayChange(workspace, dateKey, delta, at = new Date()) {
  const map = migrateDayToObjectIfNeeded(workspace, dateKey);
  const key = uniqueTimestampKey(map, at);
  map[key] = delta;
}

module.exports = {
  LEGACY_FLAT_TOTAL_KEY,
  dayEntryTotal,
  isReservedDailyDoneSubKey,
  normalizeDailyDoneForStorage,
  recordDayChange,
};
