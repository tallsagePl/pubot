const { botTimezone } = require("./config");
const { formatDateForUser } = require("./time");
const { dayEntryTotal } = require("./dailyDoneEntries");
const { migrateLegacyUserToChatWorkspaces } = require("./chatWorkspaces");

function buildChatDailyRatingText(db, chatId, dateKey) {
  const entry = db.chats[chatId];
  if (!entry || !Array.isArray(entry.userIds) || entry.userIds.length === 0) {
    return null;
  }

  const rows = [];
  for (const uid of entry.userIds) {
    migrateLegacyUserToChatWorkspaces(db, uid);
    const st = db.users[uid];
    if (!st) continue;
    const ws = st.chatWorkspaces && st.chatWorkspaces[chatId];
    const done = ws ? dayEntryTotal(ws.dailyDone?.[dateKey]) : 0;
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
    migrateLegacyUserToChatWorkspaces(db, uid);
    const st = db.users[uid];
    if (!st) continue;
    const ws = st.chatWorkspaces && st.chatWorkspaces[chatId];
    const total = ws ? Math.max(0, Number(ws.totalDone || 0)) : 0;
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

function getGroupBestDayRecord(db, chatId) {
  const entry = db.chats[chatId];
  if (!entry || !Array.isArray(entry.userIds) || entry.userIds.length === 0) {
    return null;
  }

  let candidateMax = 0;
  let candidateOwnerId = null;
  for (const uid of entry.userIds) {
    migrateLegacyUserToChatWorkspaces(db, uid);
    const st = db.users[uid];
    if (!st) continue;
    const ws = st.chatWorkspaces && st.chatWorkspaces[chatId];
    const best = ws ? Math.max(0, Number(ws.bestDay || 0)) : 0;
    if (best > candidateMax) {
      candidateMax = best;
      candidateOwnerId = uid;
    }
  }

  const existing = entry.groupBestDayRecord;
  const hasExisting =
    existing &&
    Number.isInteger(Number(existing.value)) &&
    Number(existing.value) >= 0 &&
    existing.ownerId;

  if (!hasExisting) {
    if (!candidateOwnerId || candidateMax <= 0) {
      return null;
    }
    entry.groupBestDayRecord = {
      value: candidateMax,
      ownerId: candidateOwnerId,
    };
  } else if (candidateMax > Number(existing.value || 0) && candidateOwnerId) {
    // Владелец рекорда меняется только если новый результат строго больше.
    entry.groupBestDayRecord = {
      value: candidateMax,
      ownerId: candidateOwnerId,
    };
  }

  const record = entry.groupBestDayRecord;
  if (!record || !record.ownerId) {
    return null;
  }

  const ownerState = db.users[record.ownerId];
  const ownerName =
    (ownerState && ownerState.profile && ownerState.profile.name) || `id:${record.ownerId}`;

  return {
    value: Number(record.value || 0),
    ownerName,
  };
}

module.exports = {
  buildChatDailyRatingText,
  buildChatTotalLeaderboardText,
  getGroupBestDayRecord,
};
