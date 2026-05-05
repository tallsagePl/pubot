require("dotenv").config();

const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");

const token = process.env.TELEGRAM_BOT_TOKEN;
const botTimezone = process.env.BOT_TIMEZONE || "Europe/Moscow";

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN not set in environment");
}

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "users.json");
const DAY_STATE_FILE = path.join(DATA_DIR, "day-state.json");
const REMINDER_HOURS = new Set([13, 16, 19, 22]);
const RESET_HOUR = 4;
const NEW_DAY_DEFAULT_GOAL = Number(process.env.NEW_DAY_DEFAULT_GOAL || 100);
const FORCE_NEW_DAY_ON_START = process.argv.includes("--newday");
const CLEAR_LEADERBOARD_ON_START = process.argv.includes("--clearleader");
const BUTTONS = {
  add: "/add",
  remove: "/remove",
  left: "/left",
  record: "/record",
  allFrom: "/allfrom",
  leaderboard: "/leaderboard",
};

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ users: {}, chats: {} }, null, 2), "utf-8");
}

if (!fs.existsSync(DAY_STATE_FILE)) {
  fs.writeFileSync(DAY_STATE_FILE, JSON.stringify({ activeDayKey: null, updatedAt: null }, null, 2), "utf-8");
}

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

function getActiveDayKey(now) {
  const parts = getDatePartsInTimezone(now);
  if (parts.hour >= RESET_HOUR) {
    return parts.dateKey;
  }
  return shiftDateKey(parts.dateKey, -1);
}

function readDb() {
  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  const db = JSON.parse(raw);
  if (!db.users || typeof db.users !== "object") {
    db.users = {};
  }
  if (!db.chats) {
    db.chats = {};
  }
  return db;
}

function writeDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf-8");
}

function readDayState() {
  let dayState = { activeDayKey: null, updatedAt: null };
  try {
    const raw = fs.readFileSync(DAY_STATE_FILE, "utf-8");
    dayState = JSON.parse(raw);
  } catch {
    // Восстанавливаем файл состояния дня при битом JSON.
    writeDayState(dayState);
    return dayState;
  }
  if (!Object.prototype.hasOwnProperty.call(dayState, "activeDayKey")) {
    dayState.activeDayKey = null;
  }
  if (!Object.prototype.hasOwnProperty.call(dayState, "updatedAt")) {
    dayState.updatedAt = null;
  }
  return dayState;
}

function writeDayState(dayState) {
  fs.writeFileSync(DAY_STATE_FILE, JSON.stringify(dayState, null, 2), "utf-8");
}

function ensureUser(db, userId, fallbackName = "Пользователь") {
  if (!db.users[userId]) {
    db.users[userId] = {
      profile: {
        name: fallbackName,
      },
      goalPerDay: null,
      carryOver: 0,
      remainingToday: 0,
      currentDateKey: null,
      bestDay: 0,
      dailyDone: {},
      totalDone: 0,
      statsInitializedAt: Date.now(),
    };
  }
  return db.users[userId];
}

function touchChatParticipant(db, msg) {
  if (!msg.chat || !msg.from) {
    return false;
  }
  const chatType = msg.chat.type;
  if (chatType !== "group" && chatType !== "supergroup") {
    return false;
  }

  const chatId = String(msg.chat.id);
  const userId = String(msg.from.id);
  const displayName =
    [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ").trim() ||
    msg.from.username ||
    "Пользователь";

  let changed = false;

  if (!db.chats[chatId]) {
    db.chats[chatId] = { userIds: [] };
    changed = true;
  }

  const chatEntry = db.chats[chatId];
  if (!Array.isArray(chatEntry.userIds)) {
    chatEntry.userIds = [];
    changed = true;
  }

  if (!chatEntry.userIds.includes(userId)) {
    chatEntry.userIds.push(userId);
    changed = true;
  }

  const userState = ensureUser(db, userId, displayName);
  if (userState.profile.name !== displayName) {
    userState.profile.name = displayName;
    changed = true;
  }

  return changed;
}

function ensureUserDailyFields(userState) {
  if (typeof userState.remainingToday !== "number") {
    userState.remainingToday = 0;
  }
  if (typeof userState.carryOver !== "number") {
    userState.carryOver = 0;
  }
}

function syncUserToActiveDay(userState, activeDayKey) {
  ensureUserDailyFields(userState);
  if (!userState.currentDateKey) {
    const goal = Number(userState.goalPerDay || 0);
    const carry = Math.max(0, Number(userState.carryOver || 0));
    const bootstrappedRemaining = Math.max(0, goal) + carry;
    if (Number(userState.remainingToday || 0) !== bootstrappedRemaining) {
      userState.remainingToday = bootstrappedRemaining;
    }
    userState.currentDateKey = activeDayKey;
    return true;
  }
  if (userState.currentDateKey === activeDayKey) {
    return false;
  }

  const previousRemaining = Math.max(0, Number(userState.remainingToday || 0));
  const goal = Number(userState.goalPerDay || 0);
  userState.carryOver = previousRemaining;
  userState.remainingToday = Math.max(0, goal) + userState.carryOver;
  userState.currentDateKey = activeDayKey;
  return true;
}

function rollAllUsersToDay(db, activeDayKey) {
  let changed = false;
  for (const userState of Object.values(db.users || {})) {
    if (syncUserToActiveDay(userState, activeDayKey)) {
      changed = true;
    }
  }
  return changed;
}

function ensureGlobalDayState(db, now) {
  const dayState = readDayState();
  const activeDayKey = getActiveDayKey(now);
  let usersChanged = false;
  let dayStateChanged = false;

  if (!dayState.activeDayKey) {
    dayState.activeDayKey = activeDayKey;
    usersChanged = rollAllUsersToDay(db, activeDayKey);
    dayStateChanged = true;
  } else if (dayState.activeDayKey !== activeDayKey) {
    dayState.activeDayKey = activeDayKey;
    usersChanged = rollAllUsersToDay(db, activeDayKey);
    dayStateChanged = true;
  } else {
    usersChanged = rollAllUsersToDay(db, activeDayKey);
  }

  if (dayStateChanged) {
    dayState.updatedAt = Date.now();
    writeDayState(dayState);
  }

  return { activeDayKey, usersChanged, dayStateChanged };
}

function forceNewDayReset(db, now, baseGoal) {
  const dayState = readDayState();
  const activeDayKey = getActiveDayKey(now);
  const normalizedBaseGoal = Number.isInteger(baseGoal) && baseGoal > 0 ? baseGoal : 100;

  for (const userState of Object.values(db.users || {})) {
    const goal = Number(userState.goalPerDay || 0);
    const effectiveGoal = goal > 0 ? goal : normalizedBaseGoal;
    userState.carryOver = 0;
    userState.remainingToday = effectiveGoal;
    userState.currentDateKey = activeDayKey;
  }

  dayState.activeDayKey = activeDayKey;
  dayState.updatedAt = Date.now();
  writeDayState(dayState);
}

function clearLeaderboardAndRecords(db) {
  for (const userState of Object.values(db.users || {})) {
    userState.bestDay = 0;
    userState.dailyDone = {};
    userState.totalDone = 0;
  }
}

function getReplyKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [BUTTONS.add, BUTTONS.remove],
        [BUTTONS.left, BUTTONS.record],
        [BUTTONS.allFrom, BUTTONS.leaderboard],
      ],
      resize_keyboard: true,
      persistent: true,
    },
  };
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return null;
  }
  return n;
}

function recalculateBestDay(dailyDone) {
  return Object.values(dailyDone || {}).reduce(
    (max, val) => Math.max(max, Number(val || 0)),
    0
  );
}

function getTodayTargetTotal(userState) {
  const goal = Math.max(0, Number(userState.goalPerDay || 0));
  const carry = Math.max(0, Number(userState.carryOver || 0));
  return goal + carry;
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

function buildChatDailyRatingText(db, chatId, dateKey) {
  const entry = db.chats[chatId];
  if (!entry || !Array.isArray(entry.userIds) || entry.userIds.length === 0) {
    return null;
  }

  const rows = [];
  for (const uid of entry.userIds) {
    const st = db.users[uid];
    if (!st) continue;
    const done = Math.max(0, Number(st.dailyDone?.[dateKey] || 0));
    const name = (st.profile && st.profile.name) || `id:${uid}`;
    rows.push({ uid, name, done });
  }

  if (rows.length === 0) {
    return null;
  }

  rows.sort((a, b) => {
    if (b.done !== a.done) return b.done - a.done;
    return a.name.localeCompare(b.name, "ru");
  });

  const dateLabel = formatDateForUser(dateKey);
  const lines = [`Рейтинг за ${dateLabel} (по календарю ${botTimezone}):`];
  const maxLines = 60;
  let place = 1;
  for (const r of rows) {
    if (lines.length >= maxLines) {
      lines.push("… (список обрезан, в чате много участников)");
      break;
    }
    lines.push(`${place}. ${r.name} — ${r.done}`);
    place += 1;
  }
  return lines.join("\n");
}

function buildChatTotalLeaderboardText(db, chatId) {
  const entry = db.chats[chatId];
  if (!entry || !Array.isArray(entry.userIds) || entry.userIds.length === 0) {
    return null;
  }

  const rows = [];
  for (const uid of entry.userIds) {
    const st = db.users[uid];
    if (!st) continue;
    const total = Math.max(0, Number(st.totalDone || 0));
    const name = (st.profile && st.profile.name) || `id:${uid}`;
    rows.push({ uid, name, total });
  }

  if (rows.length === 0) {
    return null;
  }

  rows.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.name.localeCompare(b.name, "ru");
  });

  const lines = ["Таблица лидеров (всего отжиманий за всё время):"];
  const maxLines = 60;
  let place = 1;
  for (const r of rows) {
    if (lines.length >= maxLines) {
      lines.push("… (список обрезан, в чате много участников)");
      break;
    }
    lines.push(`${place}. ${r.name} — ${r.total}`);
    place += 1;
  }
  return lines.join("\n");
}

function sumFromDate(userState, fromDateKey) {
  return Object.entries(userState.dailyDone || {})
    .filter(([dateKey]) => dateKey >= fromDateKey)
    .reduce((acc, [, value]) => acc + Number(value || 0), 0);
}

function normalizeDateInput(input) {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "начало") {
    return { type: "beginning" };
  }

  const dotMatch = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (dotMatch) {
    const [, dd, mm, yyyy] = dotMatch;
    return { type: "date", dateKey: `${yyyy}-${mm}-${dd}` };
  }

  const dashMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dashMatch) {
    const [, yyyy, mm, dd] = dashMatch;
    return { type: "date", dateKey: `${yyyy}-${mm}-${dd}` };
  }

  return null;
}

const pendingAllFrom = new Set();
const pendingAdd = new Set();
const pendingRemove = new Set();
const pendingStartGoal = new Set();

const bot = new TelegramBot(token, { polling: true });

function replyTotalLeaderboard(msg) {
  const chatType = msg.chat.type;
  if (chatType !== "group" && chatType !== "supergroup") {
    bot.sendMessage(
      msg.chat.id,
      "Таблица лидеров строится в групповом чате, где бот видит участников.",
      getReplyKeyboard()
    );
    return;
  }

  const chatId = String(msg.chat.id);
  const db = readDb();
  const text = buildChatTotalLeaderboardText(db, chatId);
  if (!text) {
    bot.sendMessage(
      msg.chat.id,
      "Пока пусто: пусть участники напишут боту в этом чате (любое сообщение или команду), чтобы попасть в рейтинг.",
      getReplyKeyboard()
    );
    return;
  }

  bot.sendMessage(msg.chat.id, text, getReplyKeyboard());
}

bot.onText(/\/start(?:@\w+)?(?:\s+(.+))?/, (msg, match) => {
  const userId = String(msg.from.id);
  const db = readDb();
  const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
  const now = nowDateInTimezone();
  const { activeDayKey } = ensureGlobalDayState(db, now);
  syncUserToActiveDay(userState, activeDayKey);

  const arg = match && match[1] ? match[1].trim() : "";
  const goal = parsePositiveInt(arg);

  if (!goal) {
    pendingStartGoal.add(userId);
    writeDb(db);
    bot.sendMessage(
      msg.chat.id,
      "Привет! Введи цель на день числом, например: 100\n\nИли командой: /start 100",
      getReplyKeyboard()
    );
    return;
  }

  userState.goalPerDay = goal;
  userState.remainingToday = goal + Math.max(0, Number(userState.carryOver || 0));
  userState.currentDateKey = activeDayKey;
  pendingStartGoal.delete(userId);
  writeDb(db);

  bot.sendMessage(
    msg.chat.id,
    `Цель установлена: ${goal} отжиманий в день.\nНа сегодня осталось: ${userState.remainingToday}.`,
    getReplyKeyboard()
  );
});

bot.onText(/\/add(?:@\w+)?(?:\s+(.+))?/, (msg, match) => {
  const userId = String(msg.from.id);
  const db = readDb();
  const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
  const now = nowDateInTimezone();
  const { activeDayKey } = ensureGlobalDayState(db, now);
  syncUserToActiveDay(userState, activeDayKey);

  if (!userState.goalPerDay) {
    writeDb(db);
    bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
    return;
  }

  const arg = match && match[1] ? match[1].trim() : "";
  const value = parsePositiveInt(arg);

  if (!value) {
    pendingAdd.add(userId);
    writeDb(db);
    bot.sendMessage(
      msg.chat.id,
      "Напиши количество отжиманий числом, например: 25",
      getReplyKeyboard()
    );
    return;
  }

  const dateKey = activeDayKey;
  userState.dailyDone[dateKey] = Number(userState.dailyDone[dateKey] || 0) + value;
  userState.totalDone += value;
  userState.remainingToday = Math.max(0, Number(userState.remainingToday || 0) - value);

  if (userState.dailyDone[dateKey] > userState.bestDay) {
    userState.bestDay = userState.dailyDone[dateKey];
  }

  writeDb(db);
  bot.sendMessage(
    msg.chat.id,
    `Добавил ${value}. Осталось на сегодня: ${userState.remainingToday}.`,
    getReplyKeyboard()
  );
});

bot.onText(/\/remove(?:@\w+)?(?:\s+(.+))?/, (msg, match) => {
  const userId = String(msg.from.id);
  const db = readDb();
  const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
  const now = nowDateInTimezone();
  const { activeDayKey } = ensureGlobalDayState(db, now);
  syncUserToActiveDay(userState, activeDayKey);

  if (!userState.goalPerDay) {
    writeDb(db);
    bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
    return;
  }

  const arg = match && match[1] ? match[1].trim() : "";
  const value = parsePositiveInt(arg);
  const dateKey = activeDayKey;
  const todayDone = Number(userState.dailyDone[dateKey] || 0);

  if (!value) {
    pendingRemove.add(userId);
    writeDb(db);
    bot.sendMessage(
      msg.chat.id,
      "Напиши, сколько отжиманий убрать за сегодня (ошибка ввода), например: 10",
      getReplyKeyboard()
    );
    return;
  }

  if (todayDone <= 0) {
    writeDb(db);
    bot.sendMessage(msg.chat.id, "За сегодня пока нечего убирать.", getReplyKeyboard());
    return;
  }

  const removeValue = Math.min(value, todayDone);
  userState.dailyDone[dateKey] = todayDone - removeValue;
  userState.totalDone = Math.max(0, Number(userState.totalDone || 0) - removeValue);
  const todayTarget = getTodayTargetTotal(userState);
  userState.remainingToday = Math.min(
    todayTarget,
    Math.max(0, Number(userState.remainingToday || 0) + removeValue)
  );
  userState.bestDay = recalculateBestDay(userState.dailyDone);

  writeDb(db);
  bot.sendMessage(
    msg.chat.id,
    `Убрал ${removeValue}. Осталось на сегодня: ${userState.remainingToday}.`,
    getReplyKeyboard()
  );
});

bot.onText(/\/left(?:@\w+)?/, (msg) => {
  const userId = String(msg.from.id);
  const db = readDb();
  const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
  const now = nowDateInTimezone();
  const { activeDayKey } = ensureGlobalDayState(db, now);
  syncUserToActiveDay(userState, activeDayKey);
  writeDb(db);

  if (!userState.goalPerDay) {
    bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
    return;
  }

  bot.sendMessage(
    msg.chat.id,
    `На сегодня осталось: ${userState.remainingToday} отжиманий.`,
    getReplyKeyboard()
  );
});

bot.onText(/\/record(?:@\w+)?/, (msg) => {
  const userId = String(msg.from.id);
  const db = readDb();
  const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
  const now = nowDateInTimezone();
  const { activeDayKey } = ensureGlobalDayState(db, now);
  syncUserToActiveDay(userState, activeDayKey);
  userState.bestDay = recalculateBestDay(userState.dailyDone);
  writeDb(db);

  bot.sendMessage(
    msg.chat.id,
    `Рекорд за день: ${userState.bestDay || 0} отжиманий.`,
    getReplyKeyboard()
  );
});

bot.onText(/\/allfrom(?:@\w+)?/, (msg) => {
  const userId = String(msg.from.id);
  const db = readDb();
  const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
  const now = nowDateInTimezone();
  const { activeDayKey } = ensureGlobalDayState(db, now);
  syncUserToActiveDay(userState, activeDayKey);
  writeDb(db);

  if (!userState.goalPerDay) {
    bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
    return;
  }

  pendingAllFrom.add(userId);
  bot.sendMessage(
    msg.chat.id,
    "Введи дату, с которой считать (ДД.ММ.ГГГГ или ГГГГ-ММ-ДД), либо напиши: начало",
    getReplyKeyboard()
  );
});

bot.onText(/\/leaderboard(?:@\w+)?/, (msg) => {
  replyTotalLeaderboard(msg);
});

bot.on("message", (msg) => {
  const dbTouch = readDb();
  if (touchChatParticipant(dbTouch, msg)) {
    writeDb(dbTouch);
  }

  if (!msg.text || msg.text.startsWith("/")) {
    return;
  }

  const userId = String(msg.from.id);
  const text = msg.text.trim();

  if (pendingStartGoal.has(userId)) {
    const goal = parsePositiveInt(text);
    if (!goal) {
      bot.sendMessage(msg.chat.id, "Нужно положительное целое число, например: 100");
      return;
    }

    const db = readDb();
    const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
    const now = nowDateInTimezone();
    const { activeDayKey } = ensureGlobalDayState(db, now);
    syncUserToActiveDay(userState, activeDayKey);

    userState.goalPerDay = goal;
    userState.remainingToday = goal + Math.max(0, Number(userState.carryOver || 0));
    userState.currentDateKey = activeDayKey;

    pendingStartGoal.delete(userId);
    writeDb(db);

    bot.sendMessage(
      msg.chat.id,
      `Цель установлена: ${goal} отжиманий в день.\nНа сегодня осталось: ${userState.remainingToday}.`,
      getReplyKeyboard()
    );
    return;
  }

  if (text === BUTTONS.add) {
    const db = readDb();
    const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
    const now = nowDateInTimezone();
    const { activeDayKey } = ensureGlobalDayState(db, now);
    syncUserToActiveDay(userState, activeDayKey);

    if (!userState.goalPerDay) {
      writeDb(db);
      bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
      return;
    }

    pendingAdd.add(userId);
    writeDb(db);
    bot.sendMessage(
      msg.chat.id,
      "Напиши количество отжиманий числом, например: 25",
      getReplyKeyboard()
    );
    return;
  }

  if (text === BUTTONS.remove) {
    const db = readDb();
    const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
    const now = nowDateInTimezone();
    const { activeDayKey } = ensureGlobalDayState(db, now);
    syncUserToActiveDay(userState, activeDayKey);

    if (!userState.goalPerDay) {
      writeDb(db);
      bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
      return;
    }

    pendingRemove.add(userId);
    writeDb(db);
    bot.sendMessage(
      msg.chat.id,
      "Напиши, сколько отжиманий убрать за сегодня (ошибка ввода), например: 10",
      getReplyKeyboard()
    );
    return;
  }

  if (text === BUTTONS.left) {
    const db = readDb();
    const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
    const now = nowDateInTimezone();
    const { activeDayKey } = ensureGlobalDayState(db, now);
    syncUserToActiveDay(userState, activeDayKey);
    writeDb(db);

    if (!userState.goalPerDay) {
      bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
      return;
    }

    bot.sendMessage(
      msg.chat.id,
      `На сегодня осталось: ${userState.remainingToday} отжиманий.`,
      getReplyKeyboard()
    );
    return;
  }

  if (text === BUTTONS.record) {
    const db = readDb();
    const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
    const now = nowDateInTimezone();
    const { activeDayKey } = ensureGlobalDayState(db, now);
    syncUserToActiveDay(userState, activeDayKey);
    userState.bestDay = recalculateBestDay(userState.dailyDone);
    writeDb(db);

    bot.sendMessage(
      msg.chat.id,
      `Рекорд за день: ${userState.bestDay || 0} отжиманий.`,
      getReplyKeyboard()
    );
    return;
  }

  if (text === BUTTONS.allFrom) {
    const db = readDb();
    const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
    const now = nowDateInTimezone();
    const { activeDayKey } = ensureGlobalDayState(db, now);
    syncUserToActiveDay(userState, activeDayKey);
    writeDb(db);

    if (!userState.goalPerDay) {
      bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
      return;
    }

    pendingAllFrom.add(userId);
    bot.sendMessage(
      msg.chat.id,
      "Введи дату, с которой считать (ДД.ММ.ГГГГ или ГГГГ-ММ-ДД), либо напиши: начало",
      getReplyKeyboard()
    );
    return;
  }

  if (text === BUTTONS.leaderboard) {
    replyTotalLeaderboard(msg);
    return;
  }

  if (pendingAdd.has(userId)) {
    const value = parsePositiveInt(text);
    if (!value) {
      bot.sendMessage(msg.chat.id, "Нужно положительное целое число. Попробуй еще раз.");
      return;
    }

    const db = readDb();
    const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
    const now = nowDateInTimezone();
    const { activeDayKey } = ensureGlobalDayState(db, now);
    syncUserToActiveDay(userState, activeDayKey);
    if (!userState.goalPerDay) {
      pendingAdd.delete(userId);
      writeDb(db);
      bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
      return;
    }

    const dateKey = activeDayKey;
    userState.dailyDone[dateKey] = Number(userState.dailyDone[dateKey] || 0) + value;
    userState.totalDone += value;
    userState.remainingToday = Math.max(0, Number(userState.remainingToday || 0) - value);
    if (userState.dailyDone[dateKey] > userState.bestDay) {
      userState.bestDay = userState.dailyDone[dateKey];
    }

    pendingAdd.delete(userId);
    writeDb(db);

    bot.sendMessage(
      msg.chat.id,
      `Добавил ${value}. Осталось на сегодня: ${userState.remainingToday}.`,
      getReplyKeyboard()
    );
    return;
  }

  if (pendingRemove.has(userId)) {
    const value = parsePositiveInt(text);
    if (!value) {
      bot.sendMessage(msg.chat.id, "Нужно положительное целое число. Попробуй еще раз.");
      return;
    }

    const db = readDb();
    const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
    const now = nowDateInTimezone();
    const { activeDayKey } = ensureGlobalDayState(db, now);
    syncUserToActiveDay(userState, activeDayKey);
    if (!userState.goalPerDay) {
      pendingRemove.delete(userId);
      writeDb(db);
      bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
      return;
    }
    const dateKey = activeDayKey;
    const todayDone = Number(userState.dailyDone[dateKey] || 0);

    if (todayDone <= 0) {
      pendingRemove.delete(userId);
      writeDb(db);
      bot.sendMessage(msg.chat.id, "За сегодня пока нечего убирать.", getReplyKeyboard());
      return;
    }

    const removeValue = Math.min(value, todayDone);
    userState.dailyDone[dateKey] = todayDone - removeValue;
    userState.totalDone = Math.max(0, Number(userState.totalDone || 0) - removeValue);
    const todayTarget = getTodayTargetTotal(userState);
    userState.remainingToday = Math.min(
      todayTarget,
      Math.max(0, Number(userState.remainingToday || 0) + removeValue)
    );
    userState.bestDay = recalculateBestDay(userState.dailyDone);

    pendingRemove.delete(userId);
    writeDb(db);

    bot.sendMessage(
      msg.chat.id,
      `Убрал ${removeValue}. Осталось на сегодня: ${userState.remainingToday}.`,
      getReplyKeyboard()
    );
    return;
  }

  if (pendingAllFrom.has(userId)) {
    const normalized = normalizeDateInput(text);
    if (!normalized) {
      bot.sendMessage(
        msg.chat.id,
        "Неверный формат. Введи ДД.ММ.ГГГГ, ГГГГ-ММ-ДД или напиши: начало"
      );
      return;
    }

    const db = readDb();
    const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
    const now = nowDateInTimezone();
    const { activeDayKey } = ensureGlobalDayState(db, now);
    syncUserToActiveDay(userState, activeDayKey);

    let sum = 0;
    if (normalized.type === "beginning") {
      sum = Number(userState.totalDone || 0);
      pendingAllFrom.delete(userId);
      writeDb(db);
      bot.sendMessage(
        msg.chat.id,
        `С начала отслеживания выполнено: ${sum} отжиманий.`,
        getReplyKeyboard()
      );
      return;
    }

    sum = sumFromDate(userState, normalized.dateKey);
    pendingAllFrom.delete(userId);
    writeDb(db);
    bot.sendMessage(
      msg.chat.id,
      `С ${formatDateForUser(normalized.dateKey)} выполнено: ${sum} отжиманий.`,
      getReplyKeyboard()
    );
  }
});

let lastTickKey = "";

function processDailyRollAndReminders() {
  const now = nowDateInTimezone();
  const parts = getDatePartsInTimezone(now);
  const minute = new Intl.DateTimeFormat("en-GB", {
    timeZone: botTimezone,
    minute: "2-digit",
  }).format(now);

  const tickKey = `${parts.dateKey}-${parts.hour}-${minute}`;
  if (tickKey === lastTickKey) {
    return;
  }
  lastTickKey = tickKey;

  const db = readDb();
  const { activeDayKey, usersChanged } = ensureGlobalDayState(db, now);
  let changed = usersChanged;

  for (const [userId, userState] of Object.entries(db.users)) {
    if (syncUserToActiveDay(userState, activeDayKey)) {
      changed = true;
    }

    const shouldRemind = REMINDER_HOURS.has(parts.hour) && minute === "00";
    if (!shouldRemind) {
      continue;
    }

    const left = Math.max(0, Number(userState.remainingToday || 0));
    if (left <= 0 || !userState.goalPerDay) {
      continue;
    }

    bot
      .sendMessage(
        Number(userId),
        `Напоминание: на сегодня осталось ${left} отжиманий.`,
        getReplyKeyboard()
      )
      .catch(() => null);
  }

  if (parts.hour === 0 && minute === "00") {
    const yesterdayKey = getYesterdayDateKeyInBotTimezone(now);
    for (const chatId of Object.keys(db.chats || {})) {
      const ratingText = buildChatDailyRatingText(db, chatId, yesterdayKey);
      if (!ratingText) {
        continue;
      }
      bot
        .sendMessage(Number(chatId), ratingText)
        .catch(() => null);
    }
  }

  if (changed) {
    writeDb(db);
  }
}

setInterval(processDailyRollAndReminders, 30 * 1000);
if (CLEAR_LEADERBOARD_ON_START) {
  const db = readDb();
  clearLeaderboardAndRecords(db);
  writeDb(db);
  console.log("Leaderboard and records have been cleared.");
  process.exit(0);
}
if (FORCE_NEW_DAY_ON_START) {
  const db = readDb();
  forceNewDayReset(db, nowDateInTimezone(), NEW_DAY_DEFAULT_GOAL);
  writeDb(db);
  console.log(`Forced new day applied. Base goal: ${NEW_DAY_DEFAULT_GOAL}`);
}
processDailyRollAndReminders();

console.log("Push-up bot is running...");
