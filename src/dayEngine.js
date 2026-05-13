const { readDayState, writeDayState } = require("./persistence");
const { getActiveDayKey, getDateKeyDiffInDays } = require("./time");
const { migrateLegacyUserToChatWorkspaces } = require("./chatWorkspaces");

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
  const daysPassed = Math.max(1, getDateKeyDiffInDays(userState.currentDateKey, activeDayKey));
  const normalizedGoal = Math.max(0, goal);
  userState.carryOver = previousRemaining + normalizedGoal * (daysPassed - 1);
  userState.remainingToday = previousRemaining + normalizedGoal * daysPassed;
  userState.currentDateKey = activeDayKey;
  return true;
}

function rollAllUsersToDay(db, activeDayKey) {
  let changed = false;
  for (const [userId, user] of Object.entries(db.users || {})) {
    migrateLegacyUserToChatWorkspaces(db, userId);
    const map = user.chatWorkspaces;
    if (!map || typeof map !== "object") {
      continue;
    }
    for (const ws of Object.values(map)) {
      if (syncUserToActiveDay(ws, activeDayKey)) {
        changed = true;
      }
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

  for (const [userId, user] of Object.entries(db.users || {})) {
    migrateLegacyUserToChatWorkspaces(db, userId);
    const map = user.chatWorkspaces;
    if (!map) {
      continue;
    }
    for (const ws of Object.values(map)) {
      const goal = Number(ws.goalPerDay || 0);
      const effectiveGoal = goal > 0 ? goal : normalizedBaseGoal;
      ws.carryOver = 0;
      ws.remainingToday = effectiveGoal;
      ws.currentDateKey = activeDayKey;
    }
  }

  dayState.activeDayKey = activeDayKey;
  dayState.updatedAt = Date.now();
  writeDayState(dayState);
}

function clearLeaderboardAndRecords(db) {
  for (const [userId, user] of Object.entries(db.users || {})) {
    migrateLegacyUserToChatWorkspaces(db, userId);
    const map = user.chatWorkspaces;
    if (!map) {
      continue;
    }
    for (const ws of Object.values(map)) {
      ws.bestDay = 0;
      ws.dailyDone = {};
      ws.totalDone = 0;
    }
  }
}

module.exports = {
  syncUserToActiveDay,
  rollAllUsersToDay,
  ensureGlobalDayState,
  forceNewDayReset,
  clearLeaderboardAndRecords,
};
