const { botTimezone, RESET_HOUR } = require("./config");

function nowDateInTimezone() {
  return new Date();
}

function getDatePartsInTimezone(date) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: botTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });

  const parts = dtf.formatToParts(date);
  const result = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
  }
  return {
    dateKey: `${result.year}-${result.month}-${result.day}`,
    hour: Number(result.hour),
  };
}

function dateToTimestampAtStartOfDay(dateKey) {
  return new Date(`${dateKey}T00:00:00`).getTime();
}

function shiftDateKey(dateKey, daysDelta) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day + daysDelta));
  const yyyy = utcDate.getUTCFullYear();
  const mm = String(utcDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utcDate.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getDateKeyDiffInDays(fromDateKey, toDateKey) {
  const [fromYear, fromMonth, fromDay] = (fromDateKey || "").split("-").map(Number);
  const [toYear, toMonth, toDay] = (toDateKey || "").split("-").map(Number);
  if (
    !Number.isInteger(fromYear) ||
    !Number.isInteger(fromMonth) ||
    !Number.isInteger(fromDay) ||
    !Number.isInteger(toYear) ||
    !Number.isInteger(toMonth) ||
    !Number.isInteger(toDay)
  ) {
    return 1;
  }
  const fromTs = Date.UTC(fromYear, fromMonth - 1, fromDay);
  const toTs = Date.UTC(toYear, toMonth - 1, toDay);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs)) {
    return 1;
  }
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.floor((toTs - fromTs) / dayMs);
}

function getActiveDayKey(now) {
  const parts = getDatePartsInTimezone(now);
  if (parts.hour >= RESET_HOUR) {
    return parts.dateKey;
  }
  return shiftDateKey(parts.dateKey, -1);
}

function formatDateForUser(dateKey) {
  const ts = dateToTimestampAtStartOfDay(dateKey);
  if (Number.isNaN(ts)) {
    return dateKey;
  }
  return new Date(ts).toLocaleDateString("ru-RU");
}

/** Календарный «вчера» в BOT_TIMEZONE (для рейтинга в полночь). */
function getYesterdayDateKeyInBotTimezone(now) {
  const ref = new Date(now.getTime() - 60 * 60 * 1000);
  return getDatePartsInTimezone(ref).dateKey;
}

module.exports = {
  nowDateInTimezone,
  getDatePartsInTimezone,
  dateToTimestampAtStartOfDay,
  shiftDateKey,
  getDateKeyDiffInDays,
  getActiveDayKey,
  formatDateForUser,
  getYesterdayDateKeyInBotTimezone,
};
