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
const REMINDER_HOURS = new Set([13, 16, 19, 22]);
const BUTTONS = {
  add: "Добавить",
  remove: "Убрать",
  left: "Сколько осталось",
  record: "Рекорд за день",
  allFrom: "Всего за период",
};

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ users: {} }, null, 2), "utf-8");
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

function readDb() {
  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  return JSON.parse(raw);
}

function writeDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf-8");
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

function rollDailyStateIfNeeded(userState, now) {
  const { dateKey, hour } = getDatePartsInTimezone(now);
  if (!userState.currentDateKey) {
    userState.currentDateKey = dateKey;
    if (typeof userState.remainingToday !== "number") {
      userState.remainingToday = 0;
    }
    return;
  }

  if (userState.currentDateKey === dateKey) {
    return;
  }

  const crossedResetBoundary = hour >= 4;
  if (!crossedResetBoundary) {
    return;
  }

  const previousRemaining = Math.max(0, Number(userState.remainingToday || 0));
  userState.carryOver = previousRemaining;

  if (typeof userState.goalPerDay === "number" && userState.goalPerDay > 0) {
    userState.remainingToday = userState.goalPerDay + userState.carryOver;
  } else {
    userState.remainingToday = userState.carryOver;
  }

  userState.currentDateKey = dateKey;
}

function getReplyKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [BUTTONS.add, BUTTONS.remove],
        [BUTTONS.left, BUTTONS.record],
        [BUTTONS.allFrom],
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

function formatDateForUser(dateKey) {
  const ts = dateToTimestampAtStartOfDay(dateKey);
  if (Number.isNaN(ts)) {
    return dateKey;
  }
  return new Date(ts).toLocaleDateString("ru-RU");
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

const bot = new TelegramBot(token, { polling: true });

bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const userId = String(msg.from.id);
  const db = readDb();
  const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
  rollDailyStateIfNeeded(userState, nowDateInTimezone());

  const arg = match && match[1] ? match[1].trim() : "";
  const goal = parsePositiveInt(arg);

  if (!goal) {
    writeDb(db);
    bot.sendMessage(
      msg.chat.id,
      "Привет! Введи цель на день командой:\n/start 100\n\nГде 100 - количество отжиманий за день.",
      getReplyKeyboard()
    );
    return;
  }

  userState.goalPerDay = goal;
  userState.remainingToday = goal + Math.max(0, Number(userState.carryOver || 0));
  userState.currentDateKey = getDatePartsInTimezone(nowDateInTimezone()).dateKey;
  writeDb(db);

  bot.sendMessage(
    msg.chat.id,
    `Цель установлена: ${goal} отжиманий в день.\nНа сегодня осталось: ${userState.remainingToday}.`,
    getReplyKeyboard()
  );
});

bot.onText(/\/add(?:\s+(.+))?/, (msg, match) => {
  const userId = String(msg.from.id);
  const db = readDb();
  const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
  rollDailyStateIfNeeded(userState, nowDateInTimezone());

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

  const dateKey = getDatePartsInTimezone(nowDateInTimezone()).dateKey;
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

bot.onText(/\/remove(?:\s+(.+))?/, (msg, match) => {
  const userId = String(msg.from.id);
  const db = readDb();
  const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
  rollDailyStateIfNeeded(userState, nowDateInTimezone());

  if (!userState.goalPerDay) {
    writeDb(db);
    bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
    return;
  }

  const arg = match && match[1] ? match[1].trim() : "";
  const value = parsePositiveInt(arg);
  const dateKey = getDatePartsInTimezone(nowDateInTimezone()).dateKey;
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
  userState.remainingToday = Math.max(0, Number(userState.remainingToday || 0) + removeValue);
  userState.bestDay = recalculateBestDay(userState.dailyDone);

  writeDb(db);
  bot.sendMessage(
    msg.chat.id,
    `Убрал ${removeValue}. Осталось на сегодня: ${userState.remainingToday}.`,
    getReplyKeyboard()
  );
});

bot.onText(/\/left/, (msg) => {
  const userId = String(msg.from.id);
  const db = readDb();
  const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
  rollDailyStateIfNeeded(userState, nowDateInTimezone());
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

bot.onText(/\/record/, (msg) => {
  const userId = String(msg.from.id);
  const db = readDb();
  const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
  rollDailyStateIfNeeded(userState, nowDateInTimezone());
  writeDb(db);

  bot.sendMessage(
    msg.chat.id,
    `Рекорд за день: ${userState.bestDay || 0} отжиманий.`,
    getReplyKeyboard()
  );
});

bot.onText(/\/allfrom/, (msg) => {
  const userId = String(msg.from.id);
  const db = readDb();
  const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
  rollDailyStateIfNeeded(userState, nowDateInTimezone());
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

bot.on("message", (msg) => {
  if (!msg.text || msg.text.startsWith("/")) {
    return;
  }

  const userId = String(msg.from.id);
  const text = msg.text.trim();

  if (text === BUTTONS.add) {
    const db = readDb();
    const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
    rollDailyStateIfNeeded(userState, nowDateInTimezone());

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
    rollDailyStateIfNeeded(userState, nowDateInTimezone());

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
    rollDailyStateIfNeeded(userState, nowDateInTimezone());
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
    rollDailyStateIfNeeded(userState, nowDateInTimezone());
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
    rollDailyStateIfNeeded(userState, nowDateInTimezone());
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

  if (pendingAdd.has(userId)) {
    const value = parsePositiveInt(text);
    if (!value) {
      bot.sendMessage(msg.chat.id, "Нужно положительное целое число. Попробуй еще раз.");
      return;
    }

    const db = readDb();
    const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
    rollDailyStateIfNeeded(userState, nowDateInTimezone());

    const dateKey = getDatePartsInTimezone(nowDateInTimezone()).dateKey;
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
    rollDailyStateIfNeeded(userState, nowDateInTimezone());
    const dateKey = getDatePartsInTimezone(nowDateInTimezone()).dateKey;
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
    userState.remainingToday = Math.max(0, Number(userState.remainingToday || 0) + removeValue);
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
    rollDailyStateIfNeeded(userState, nowDateInTimezone());

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
  let changed = false;

  for (const [userId, userState] of Object.entries(db.users)) {
    const previousDate = userState.currentDateKey;
    const previousRemaining = userState.remainingToday;

    rollDailyStateIfNeeded(userState, now);

    if (
      previousDate !== userState.currentDateKey ||
      previousRemaining !== userState.remainingToday
    ) {
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

  if (changed) {
    writeDb(db);
  }
}

setInterval(processDailyRollAndReminders, 30 * 1000);
processDailyRollAndReminders();

console.log("Push-up bot is running...");
