const {
  REMINDER_HOURS,
  botTimezone,
} = require("../config");
const { readDb, writeDb } = require("../persistence");
const { ensureGlobalDayState, syncUserToActiveDay } = require("../dayEngine");
const { migrateLegacyUserToChatWorkspaces } = require("../chatWorkspaces");
const { nowDateInTimezone, getDatePartsInTimezone, getYesterdayDateKeyInBotTimezone } = require("../time");
const { buildChatDailyRatingText } = require("../ratings");
const { getReplyKeyboard } = require("../telegram/keyboards");

let lastTickKey = "";

const minuteFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: botTimezone,
  minute: "2-digit",
});

function createDailyReminderTick(bot) {
  return function processDailyRollAndReminders() {
    const now = nowDateInTimezone();
    const parts = getDatePartsInTimezone(now);
    const minute = minuteFormatter.format(now);

    const tickKey = `${parts.dateKey}-${parts.hour}-${minute}`;
    if (tickKey === lastTickKey) {
      return;
    }
    lastTickKey = tickKey;

    const db = readDb();
    const { activeDayKey, usersChanged } = ensureGlobalDayState(db, now);
    let changed = usersChanged;

    for (const [userId, user] of Object.entries(db.users)) {
      migrateLegacyUserToChatWorkspaces(db, userId);
      const map = user.chatWorkspaces;
      if (!map) {
        continue;
      }
      for (const ws of Object.values(map)) {
        if (syncUserToActiveDay(ws, activeDayKey)) {
          changed = true;
        }
      }

      const shouldRemind = REMINDER_HOURS.has(parts.hour) && minute === "00";
      if (!shouldRemind) {
        continue;
      }

      let sumLeft = 0;
      let remind = false;
      for (const ws of Object.values(map)) {
        if (!ws.goalPerDay) {
          continue;
        }
        const left = Math.max(0, Number(ws.remainingToday || 0));
        if (left > 0) {
          remind = true;
          sumLeft += left;
        }
      }
      if (!remind) {
        continue;
      }

      bot
        .sendMessage(
          Number(userId),
          `Напоминание: по всем чатам с ботом на сегодня осталось ${sumLeft} отжиманий.`,
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
        bot.sendMessage(Number(chatId), ratingText).catch(() => null);
      }
    }

    if (changed) {
      writeDb(db);
    }
  };
}

module.exports = {
  createDailyReminderTick,
};
