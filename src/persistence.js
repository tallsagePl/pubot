const { migrateLegacyUserToChatWorkspaces, ensureWorkspaceForContext } = require("./chatWorkspaces");
const { readDb, writeDb, readDayState, writeDayState } = require("./sqliteStore");

function ensureUser(db, userId, fallbackName = "Пользователь") {
  if (!db.users[userId]) {
    db.users[userId] = {
      profile: {
        name: fallbackName,
      },
      statsInitializedAt: Date.now(),
      chatWorkspaces: {},
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

  migrateLegacyUserToChatWorkspaces(db, userId);
  ensureWorkspaceForContext(db, userId, chatId);

  return changed;
}

module.exports = {
  readDb,
  writeDb,
  readDayState,
  writeDayState,
  ensureUser,
  touchChatParticipant,
};
