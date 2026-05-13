/**
 * Статистика пользователя изолирована по контексту чата (ключ = String(chat.id)).
 * В личке с ботом chat.id совпадает с id пользователя — отдельный «контекст лички».
 * Для будущей сводной статистики: aggregateUserAcrossWorkspaces(user).
 */

const { normalizeDailyDoneForStorage } = require("./dailyDoneEntries");

function createEmptyChatWorkspace() {
  return {
    goalPerDay: null,
    carryOver: 0,
    remainingToday: 0,
    currentDateKey: null,
    bestDay: 0,
    dailyDone: {},
    totalDone: 0,
  };
}

function cloneWorkspaceData(data) {
  return JSON.parse(JSON.stringify(data));
}

function sliceLegacyUserStats(user) {
  const rawDaily =
    user.dailyDone && typeof user.dailyDone === "object" && !Array.isArray(user.dailyDone)
      ? cloneWorkspaceData(user.dailyDone)
      : {};
  return {
    goalPerDay: user.goalPerDay != null ? user.goalPerDay : null,
    carryOver: Math.max(0, Number(user.carryOver || 0)),
    remainingToday: Math.max(0, Number(user.remainingToday || 0)),
    currentDateKey: user.currentDateKey != null ? user.currentDateKey : null,
    bestDay: Math.max(0, Number(user.bestDay || 0)),
    dailyDone: normalizeDailyDoneForStorage(rawDaily),
    totalDone: Math.max(0, Number(user.totalDone || 0)),
  };
}

function stripLegacyRootStats(user) {
  for (const key of [
    "goalPerDay",
    "carryOver",
    "remainingToday",
    "currentDateKey",
    "bestDay",
    "dailyDone",
    "totalDone",
  ]) {
    if (Object.prototype.hasOwnProperty.call(user, key)) {
      delete user[key];
    }
  }
}

/**
 * Одноразовая миграция со старой схемы (поля на корне user) на chatWorkspaces.
 * Копия накопленных данных кладётся в каждый чат из db.chats, где пользователь уже числится,
 * и в контекст лички (id пользователя), чтобы не потерять историю.
 */
function migrateLegacyUserToChatWorkspaces(db, userId) {
  const user = db.users[userId];
  if (!user) {
    return false;
  }
  if (user.chatWorkspaces && typeof user.chatWorkspaces === "object") {
    return false;
  }

  const legacy = sliceLegacyUserStats(user);
  user.chatWorkspaces = {};
  for (const [cid, ch] of Object.entries(db.chats || {})) {
    if (Array.isArray(ch.userIds) && ch.userIds.includes(userId)) {
      user.chatWorkspaces[cid] = cloneWorkspaceData(legacy);
    }
  }
  user.chatWorkspaces[String(userId)] = cloneWorkspaceData(legacy);
  stripLegacyRootStats(user);
  return true;
}

function getContextIdFromMessage(msg) {
  if (!msg || !msg.chat) {
    return null;
  }
  return String(msg.chat.id);
}

function ensureWorkspaceForContext(db, userId, contextId) {
  migrateLegacyUserToChatWorkspaces(db, userId);
  const user = db.users[userId];
  if (!user.chatWorkspaces[contextId]) {
    user.chatWorkspaces[contextId] = createEmptyChatWorkspace();
  }
  return user.chatWorkspaces[contextId];
}

function getWorkspaceForMessage(db, msg, userId) {
  const contextId = getContextIdFromMessage(msg);
  if (!contextId) {
    return createEmptyChatWorkspace();
  }
  return ensureWorkspaceForContext(db, userId, contextId);
}

/** Суммарные отжимания по всем чатам (для будущей команды «вся статистика по мне»). */
function aggregateUserAcrossWorkspaces(user) {
  if (!user || !user.chatWorkspaces) {
    return { totalDone: 0, workspaceCount: 0 };
  }
  let totalDone = 0;
  const keys = Object.keys(user.chatWorkspaces);
  for (const k of keys) {
    const ws = user.chatWorkspaces[k];
    totalDone += Math.max(0, Number(ws.totalDone || 0));
  }
  return { totalDone, workspaceCount: keys.length };
}

module.exports = {
  createEmptyChatWorkspace,
  cloneWorkspaceData,
  sliceLegacyUserStats,
  migrateLegacyUserToChatWorkspaces,
  getContextIdFromMessage,
  ensureWorkspaceForContext,
  getWorkspaceForMessage,
  aggregateUserAcrossWorkspaces,
};
