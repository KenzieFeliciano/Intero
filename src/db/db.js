/**
 * db.js — local-first persistence via Dexie (IndexedDB).
 *
 * Two stores:
 *   - sessions: one row per meal session (timing + summary stats).
 *   - checkins: the post-meal check-in answers, linked to a session.
 */
import Dexie from 'dexie';

export const db = new Dexie('intero');

db.version(1).stores({
  // ++id = auto-increment primary key; other fields are indexed for querying.
  sessions: '++id, startedAt, endedAt',
  checkins: '++id, sessionId, createdAt',
});

/** Persist a finished session. Returns the new session id. */
export async function saveSession(session) {
  return db.sessions.add({
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? Date.now(),
    durationMs: session.durationMs,
    swallowCount: session.swallowCount,
    overpaceEvents: session.overpaceEvents ?? 0,
    baselineRate: session.baselineRate ?? null,
    paceCeiling: session.paceCeiling ?? null,
    baseline: session.baseline ?? null,
  });
}

/** Persist the post-meal check-in answers for a session. */
export async function saveCheckIn(sessionId, answers) {
  return db.checkins.add({
    sessionId,
    fullness: answers.fullness, // 1–5 scale
    awareness: answers.awareness, // 1–5 scale
    createdAt: Date.now(),
  });
}

/** Most recent sessions, newest first. */
export async function recentSessions(limit = 20) {
  return db.sessions.orderBy('startedAt').reverse().limit(limit).toArray();
}
