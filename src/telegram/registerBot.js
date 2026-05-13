const { BUTTONS } = require("../config");
const { readDb, writeDb, ensureUser, touchChatParticipant } = require("../persistence");
const {
  ensureGlobalDayState,
  syncUserToActiveDay,
} = require("../dayEngine");
const { nowDateInTimezone, formatDateForUser } = require("../time");
const {
  parsePositiveInt,
  recalculateBestDay,
  getTodayTargetTotal,
  sumFromDate,
  normalizeDateInput,
} = require("../stats");
const { getGroupBestDayRecord } = require("../ratings");
const { dayEntryTotal, recordDayChange } = require("../dailyDoneEntries");
const { getWorkspaceForMessage } = require("../chatWorkspaces");
const { getReplyKeyboard } = require("./keyboards");
const { createAmountPromptService } = require("./amountPrompt");
const { createReplyTotalLeaderboard } = require("./leaderboard");
const {
  pendingAllFrom,
  pendingAdd,
  pendingRemove,
  pendingStartGoal,
} = require("./flowState");

function registerBot(bot) {
  const { clearPendingAmountPrompt, sendAmountPrompt } = createAmountPromptService(bot);
  const replyTotalLeaderboard = createReplyTotalLeaderboard(bot);

  bot.onText(/\/start(?:@\w+)?(?:\s+(.+))?/, (msg, match) => {
    const userId = String(msg.from.id);
    const db = readDb();
    const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
    const workspace = getWorkspaceForMessage(db, msg, userId);
    const now = nowDateInTimezone();
    const { activeDayKey } = ensureGlobalDayState(db, now);
    syncUserToActiveDay(workspace, activeDayKey);

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

    workspace.goalPerDay = goal;
    workspace.remainingToday = goal + Math.max(0, Number(workspace.carryOver || 0));
    workspace.currentDateKey = activeDayKey;
    pendingStartGoal.delete(userId);
    writeDb(db);

    bot.sendMessage(
      msg.chat.id,
      `Цель установлена: ${goal} отжиманий в день.\nНа сегодня осталось: ${workspace.remainingToday}.`,
      getReplyKeyboard()
    );
  });

  bot.onText(/\/add(?:@\w+)?(?:\s+(.+))?/, (msg, match) => {
    const userId = String(msg.from.id);
    const db = readDb();
    const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
    const workspace = getWorkspaceForMessage(db, msg, userId);
    const now = nowDateInTimezone();
    const { activeDayKey } = ensureGlobalDayState(db, now);
    syncUserToActiveDay(workspace, activeDayKey);

    if (!workspace.goalPerDay) {
      writeDb(db);
      bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
      return;
    }

    const arg = match && match[1] ? match[1].trim() : "";
    const value = parsePositiveInt(arg);

    if (!value) {
      pendingAdd.add(userId);
      writeDb(db);
      sendAmountPrompt(msg.chat.id, userId, "add");
      return;
    }

    const dateKey = activeDayKey;
    recordDayChange(workspace, dateKey, value, now);
    workspace.totalDone += value;
    workspace.remainingToday = Math.max(0, Number(workspace.remainingToday || 0) - value);
    workspace.bestDay = recalculateBestDay(workspace.dailyDone);

    writeDb(db);
    bot.sendMessage(
      msg.chat.id,
      `Добавил ${value}. Осталось на сегодня: ${workspace.remainingToday}.`,
      getReplyKeyboard()
    );
  });

  bot.onText(/\/remove(?:@\w+)?(?:\s+(.+))?/, (msg, match) => {
    const userId = String(msg.from.id);
    const db = readDb();
    const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
    const workspace = getWorkspaceForMessage(db, msg, userId);
    const now = nowDateInTimezone();
    const { activeDayKey } = ensureGlobalDayState(db, now);
    syncUserToActiveDay(workspace, activeDayKey);

    if (!workspace.goalPerDay) {
      writeDb(db);
      bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
      return;
    }

    const arg = match && match[1] ? match[1].trim() : "";
    const value = parsePositiveInt(arg);
    const dateKey = activeDayKey;
    const todayDone = dayEntryTotal(workspace.dailyDone[dateKey]);

    if (!value) {
      pendingRemove.add(userId);
      writeDb(db);
      sendAmountPrompt(msg.chat.id, userId, "remove");
      return;
    }

    if (todayDone <= 0) {
      writeDb(db);
      bot.sendMessage(msg.chat.id, "За сегодня пока нечего убирать.", getReplyKeyboard());
      return;
    }

    const removeValue = Math.min(value, todayDone);
    recordDayChange(workspace, dateKey, -removeValue, now);
    workspace.totalDone = Math.max(0, Number(workspace.totalDone || 0) - removeValue);
    const todayTarget = getTodayTargetTotal(workspace);
    workspace.remainingToday = Math.min(
      todayTarget,
      Math.max(0, Number(workspace.remainingToday || 0) + removeValue)
    );
    workspace.bestDay = recalculateBestDay(workspace.dailyDone);

    writeDb(db);
    bot.sendMessage(
      msg.chat.id,
      `Убрал ${removeValue}. Осталось на сегодня: ${workspace.remainingToday}.`,
      getReplyKeyboard()
    );
  });

  bot.onText(/\/left(?:@\w+)?/, (msg) => {
    const userId = String(msg.from.id);
    const db = readDb();
    const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
    const workspace = getWorkspaceForMessage(db, msg, userId);
    const now = nowDateInTimezone();
    const { activeDayKey } = ensureGlobalDayState(db, now);
    syncUserToActiveDay(workspace, activeDayKey);
    writeDb(db);

    if (!workspace.goalPerDay) {
      bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
      return;
    }

    bot.sendMessage(
      msg.chat.id,
      `На сегодня осталось: ${workspace.remainingToday} отжиманий.`,
      getReplyKeyboard()
    );
  });

  bot.onText(/\/record(?:@\w+)?/, (msg) => {
    const userId = String(msg.from.id);
    const db = readDb();
    const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
    const workspace = getWorkspaceForMessage(db, msg, userId);
    const now = nowDateInTimezone();
    const { activeDayKey } = ensureGlobalDayState(db, now);
    syncUserToActiveDay(workspace, activeDayKey);
    workspace.bestDay = recalculateBestDay(workspace.dailyDone);

    let groupRecordText = "Рекорд в группе: доступно в групповом чате.";
    const chatType = msg.chat.type;
    if (chatType === "group" || chatType === "supergroup") {
      const chatId = String(msg.chat.id);
      const groupRecord = getGroupBestDayRecord(db, chatId);
      if (!groupRecord) {
        groupRecordText = "Рекорд в группе: 0 отжиманий - пока нет владельца рекорда.";
      } else {
        groupRecordText = `Рекорд в группе: ${groupRecord.value} отжиманий - ${groupRecord.ownerName}.`;
      }
    }
    writeDb(db);

    bot.sendMessage(
      msg.chat.id,
      `Личный рекорд: ${workspace.bestDay || 0} отжиманий.\n${groupRecordText}`,
      getReplyKeyboard()
    );
  });

  bot.onText(/\/allfrom(?:@\w+)?/, (msg) => {
    const userId = String(msg.from.id);
    const db = readDb();
    const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
    const workspace = getWorkspaceForMessage(db, msg, userId);
    const now = nowDateInTimezone();
    const { activeDayKey } = ensureGlobalDayState(db, now);
    syncUserToActiveDay(workspace, activeDayKey);
    writeDb(db);

    if (!workspace.goalPerDay) {
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
      const workspace = getWorkspaceForMessage(db, msg, userId);
      const now = nowDateInTimezone();
      const { activeDayKey } = ensureGlobalDayState(db, now);
      syncUserToActiveDay(workspace, activeDayKey);

      workspace.goalPerDay = goal;
      workspace.remainingToday = goal + Math.max(0, Number(workspace.carryOver || 0));
      workspace.currentDateKey = activeDayKey;

      pendingStartGoal.delete(userId);
      writeDb(db);

      bot.sendMessage(
        msg.chat.id,
        `Цель установлена: ${goal} отжиманий в день.\nНа сегодня осталось: ${workspace.remainingToday}.`,
        getReplyKeyboard()
      );
      return;
    }

    if (text === BUTTONS.add) {
      const db = readDb();
      const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
      const workspace = getWorkspaceForMessage(db, msg, userId);
      const now = nowDateInTimezone();
      const { activeDayKey } = ensureGlobalDayState(db, now);
      syncUserToActiveDay(workspace, activeDayKey);

      if (!workspace.goalPerDay) {
        writeDb(db);
        bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
        return;
      }

      pendingAdd.add(userId);
      writeDb(db);
      sendAmountPrompt(msg.chat.id, userId, "add");
      return;
    }

    if (text === BUTTONS.remove) {
      const db = readDb();
      const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
      const workspace = getWorkspaceForMessage(db, msg, userId);
      const now = nowDateInTimezone();
      const { activeDayKey } = ensureGlobalDayState(db, now);
      syncUserToActiveDay(workspace, activeDayKey);

      if (!workspace.goalPerDay) {
        writeDb(db);
        bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
        return;
      }

      pendingRemove.add(userId);
      writeDb(db);
      sendAmountPrompt(msg.chat.id, userId, "remove");
      return;
    }

    if (text === BUTTONS.left) {
      const db = readDb();
      const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
      const workspace = getWorkspaceForMessage(db, msg, userId);
      const now = nowDateInTimezone();
      const { activeDayKey } = ensureGlobalDayState(db, now);
      syncUserToActiveDay(workspace, activeDayKey);
      writeDb(db);

      if (!workspace.goalPerDay) {
        bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
        return;
      }

      bot.sendMessage(
        msg.chat.id,
        `На сегодня осталось: ${workspace.remainingToday} отжиманий.`,
        getReplyKeyboard()
      );
      return;
    }

    if (text === BUTTONS.record) {
      const db = readDb();
      const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
      const workspace = getWorkspaceForMessage(db, msg, userId);
      const now = nowDateInTimezone();
      const { activeDayKey } = ensureGlobalDayState(db, now);
      syncUserToActiveDay(workspace, activeDayKey);
      workspace.bestDay = recalculateBestDay(workspace.dailyDone);

      let groupRecordText = "Рекорд в группе: доступно в групповом чате.";
      const chatType = msg.chat.type;
      if (chatType === "group" || chatType === "supergroup") {
        const chatId = String(msg.chat.id);
        const groupRecord = getGroupBestDayRecord(db, chatId);
        if (!groupRecord) {
          groupRecordText = "Рекорд в группе: 0 отжиманий - пока нет владельца рекорда.";
        } else {
          groupRecordText = `Рекорд в группе: ${groupRecord.value} отжиманий - ${groupRecord.ownerName}.`;
        }
      }
      writeDb(db);

      bot.sendMessage(
        msg.chat.id,
        `Личный рекорд: ${workspace.bestDay || 0} отжиманий.\n${groupRecordText}`,
        getReplyKeyboard()
      );
      return;
    }

    if (text === BUTTONS.allFrom) {
      const db = readDb();
      const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
      const workspace = getWorkspaceForMessage(db, msg, userId);
      const now = nowDateInTimezone();
      const { activeDayKey } = ensureGlobalDayState(db, now);
      syncUserToActiveDay(workspace, activeDayKey);
      writeDb(db);

      if (!workspace.goalPerDay) {
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
      clearPendingAmountPrompt(userId);
      const value = parsePositiveInt(text);
      if (!value) {
        bot.sendMessage(msg.chat.id, "Нужно положительное целое число. Попробуй еще раз.");
        return;
      }

      const db = readDb();
      const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
      const workspace = getWorkspaceForMessage(db, msg, userId);
      const now = nowDateInTimezone();
      const { activeDayKey } = ensureGlobalDayState(db, now);
      syncUserToActiveDay(workspace, activeDayKey);
      if (!workspace.goalPerDay) {
        pendingAdd.delete(userId);
        writeDb(db);
        bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
        return;
      }

      const dateKey = activeDayKey;
      recordDayChange(workspace, dateKey, value, now);
      workspace.totalDone += value;
      workspace.remainingToday = Math.max(0, Number(workspace.remainingToday || 0) - value);
      workspace.bestDay = recalculateBestDay(workspace.dailyDone);

      pendingAdd.delete(userId);
      writeDb(db);

      bot.sendMessage(
        msg.chat.id,
        `Добавил ${value}. Осталось на сегодня: ${workspace.remainingToday}.`,
        getReplyKeyboard()
      );
      return;
    }

    if (pendingRemove.has(userId)) {
      clearPendingAmountPrompt(userId);
      const value = parsePositiveInt(text);
      if (!value) {
        bot.sendMessage(msg.chat.id, "Нужно положительное целое число. Попробуй еще раз.");
        return;
      }

      const db = readDb();
      const userState = ensureUser(db, userId, msg.from.first_name || "Пользователь");
      const workspace = getWorkspaceForMessage(db, msg, userId);
      const now = nowDateInTimezone();
      const { activeDayKey } = ensureGlobalDayState(db, now);
      syncUserToActiveDay(workspace, activeDayKey);
      if (!workspace.goalPerDay) {
        pendingRemove.delete(userId);
        writeDb(db);
        bot.sendMessage(msg.chat.id, "Сначала задай цель через /start 100", getReplyKeyboard());
        return;
      }
      const dateKey = activeDayKey;
      const todayDone = dayEntryTotal(workspace.dailyDone[dateKey]);

      if (todayDone <= 0) {
        pendingRemove.delete(userId);
        writeDb(db);
        bot.sendMessage(msg.chat.id, "За сегодня пока нечего убирать.", getReplyKeyboard());
        return;
      }

      const removeValue = Math.min(value, todayDone);
      recordDayChange(workspace, dateKey, -removeValue, now);
      workspace.totalDone = Math.max(0, Number(workspace.totalDone || 0) - removeValue);
      const todayTarget = getTodayTargetTotal(workspace);
      workspace.remainingToday = Math.min(
        todayTarget,
        Math.max(0, Number(workspace.remainingToday || 0) + removeValue)
      );
      workspace.bestDay = recalculateBestDay(workspace.dailyDone);

      pendingRemove.delete(userId);
      writeDb(db);

      bot.sendMessage(
        msg.chat.id,
        `Убрал ${removeValue}. Осталось на сегодня: ${workspace.remainingToday}.`,
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
      const workspace = getWorkspaceForMessage(db, msg, userId);
      const now = nowDateInTimezone();
      const { activeDayKey } = ensureGlobalDayState(db, now);
      syncUserToActiveDay(workspace, activeDayKey);

      let sum = 0;
      if (normalized.type === "beginning") {
        sum = Number(workspace.totalDone || 0);
        pendingAllFrom.delete(userId);
        writeDb(db);
        bot.sendMessage(
          msg.chat.id,
          `С начала отслеживания выполнено: ${sum} отжиманий.`,
          getReplyKeyboard()
        );
        return;
      }

      sum = sumFromDate(workspace, normalized.dateKey);
      pendingAllFrom.delete(userId);
      writeDb(db);
      bot.sendMessage(
        msg.chat.id,
        `С ${formatDateForUser(normalized.dateKey)} выполнено: ${sum} отжиманий.`,
        getReplyKeyboard()
      );
    }
  });

  bot.on("callback_query", (query) => {
    const data = query.data || "";
    const match = data.match(/^amount:(add|remove):(\d+)$/);
    if (!match || !query.from || !query.message) {
      if (query.id) {
        bot.answerCallbackQuery(query.id).catch(() => null);
      }
      return;
    }

    const [, mode, amountText] = match;
    const value = parsePositiveInt(amountText);
    const userId = String(query.from.id);
    const chatId = query.message.chat.id;

    clearPendingAmountPrompt(userId);

    if (!value) {
      if (query.id) {
        bot.answerCallbackQuery(query.id, { text: "Некорректное число", show_alert: false }).catch(() => null);
      }
      return;
    }

    const db = readDb();
    const userState = ensureUser(db, userId, query.from.first_name || "Пользователь");
    const workspace = getWorkspaceForMessage(db, query.message, userId);
    const now = nowDateInTimezone();
    const { activeDayKey } = ensureGlobalDayState(db, now);
    syncUserToActiveDay(workspace, activeDayKey);

    if (!workspace.goalPerDay) {
      pendingAdd.delete(userId);
      pendingRemove.delete(userId);
      writeDb(db);
      bot.sendMessage(chatId, "Сначала задай цель через /start 100", getReplyKeyboard());
      if (query.id) {
        bot.answerCallbackQuery(query.id).catch(() => null);
      }
      return;
    }

    if (mode === "add") {
      const dateKey = activeDayKey;
      recordDayChange(workspace, dateKey, value, now);
      workspace.totalDone += value;
      workspace.remainingToday = Math.max(0, Number(workspace.remainingToday || 0) - value);
      workspace.bestDay = recalculateBestDay(workspace.dailyDone);
      pendingAdd.delete(userId);
      writeDb(db);
      bot.sendMessage(chatId, `Добавил ${value}. Осталось на сегодня: ${workspace.remainingToday}.`, getReplyKeyboard());
    } else {
      const dateKey = activeDayKey;
      const todayDone = dayEntryTotal(workspace.dailyDone[dateKey]);
      if (todayDone <= 0) {
        pendingRemove.delete(userId);
        writeDb(db);
        bot.sendMessage(chatId, "За сегодня пока нечего убирать.", getReplyKeyboard());
        if (query.id) {
          bot.answerCallbackQuery(query.id).catch(() => null);
        }
        return;
      }

      const removeValue = Math.min(value, todayDone);
      recordDayChange(workspace, dateKey, -removeValue, now);
      workspace.totalDone = Math.max(0, Number(workspace.totalDone || 0) - removeValue);
      const todayTarget = getTodayTargetTotal(workspace);
      workspace.remainingToday = Math.min(
        todayTarget,
        Math.max(0, Number(workspace.remainingToday || 0) + removeValue)
      );
      workspace.bestDay = recalculateBestDay(workspace.dailyDone);
      pendingRemove.delete(userId);
      writeDb(db);
      bot.sendMessage(chatId, `Убрал ${removeValue}. Осталось на сегодня: ${workspace.remainingToday}.`, getReplyKeyboard());
    }

    if (query.id) {
      bot.answerCallbackQuery(query.id).catch(() => null);
    }
  });
}

module.exports = {
  registerBot,
};
