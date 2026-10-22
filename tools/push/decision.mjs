const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_FOLLOW_UPS = 2;
const KINDS = [
  ['MorningAdhkar', 'morning'],
  ['EveningAdhkar', 'evening'],
  ['QuranWird', 'wird'],
];
const formatters = new Map();

function formatter(timeZoneId) {
  let value = formatters.get(timeZoneId);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZoneId,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZoneId, value);
  }
  return value;
}

export function localParts(at, timeZoneId) {
  const values = Object.fromEntries(
    formatter(timeZoneId).formatToParts(at).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

export function slotKey(slot) {
  return `${slot.date}#${slot.followUp}`;
}

export function wasAlreadySent(slot, marker) {
  if (typeof marker !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})#([0-2])$/.exec(marker);
  if (!match) return false;
  if (match[1] > slot.date) return true;
  return match[1] === slot.date && Number(match[2]) >= slot.followUp;
}

/**
 * Finds occurrences in the normal 30-minute run window plus up to 60 minutes of runner delay. Window start is
 * exclusive and end is inclusive. When multiple slots were missed, only the newest is returned.
 */
export function latestDueSlot({
  scheduledAt,
  timeZoneId,
  time,
  keepReminding,
  lastSent,
  windowMinutes = 30,
  delayToleranceMinutes = 60,
}) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const end = scheduledAt.getTime();
  const start = end - (windowMinutes + delayToleranceMinutes) * MINUTE_MS;
  const newestByKey = new Map();
  const finalMinute = Math.floor(end / MINUTE_MS) * MINUTE_MS;
  const followUpLimit = keepReminding ? MAX_FOLLOW_UPS : 0;
  const today = localParts(scheduledAt, timeZoneId).date;
  for (let occurrenceAt = finalMinute; occurrenceAt > start; occurrenceAt -= MINUTE_MS) {
    const occurrence = localParts(new Date(occurrenceAt), timeZoneId);
    // A late run never sends yesterday's reminder: the app drops reminders that are not dated today.
    if (occurrence.date !== today) continue;
    for (let followUp = 0; followUp <= followUpLimit; followUp += 1) {
      const initialAt = occurrenceAt - followUp * HOUR_MS;
      const initial = localParts(new Date(initialAt), timeZoneId);
      if (initial.time !== time || initial.date !== occurrence.date) continue;
      const slot = { date: occurrence.date, followUp, at: new Date(occurrenceAt) };
      const key = slotKey(slot);
      if (!newestByKey.has(key)) newestByKey.set(key, slot);
    }
  }
  return [...newestByKey.values()]
    .filter((slot) => !wasAlreadySent(slot, lastSent))
    .sort((left, right) => right.at.getTime() - left.at.getTime())[0] ?? null;
}

export function activePlanDay(group, uid, at) {
  if (group?.status !== 'Active' || group?.roster?.[uid] !== true) return null;
  if (group.planId !== 'Madinah604V1' || typeof group.startDate !== 'string' || typeof group.timeZoneId !== 'string') {
    return null;
  }
  const date = localParts(at, group.timeZoneId).date;
  const start = Date.parse(`${group.startDate}T00:00:00Z`);
  const current = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(current)) return null;
  const day = Math.round((current - start) / 86_400_000) + 1;
  return day >= 1 && day <= 201 ? day : null;
}

/** An item is complete only when it is checked in every active group; no active group means no reminder. */
export function isMissingInActiveGroups(groups, kind) {
  return groups.length > 0 && groups.some((group) => Number(group.values?.[kind] ?? 0) < 1);
}

/**
 * Slots that are due for one device document: an enabled kind whose chosen time falls in the catch-up window, deduped
 * against that kind's last sent marker. Devices that are not Android or are malformed produce nothing.
 */
export function dueSlots(device, at) {
  if (device?.platform !== 'android' || typeof device.token !== 'string' || typeof device.timeZoneId !== 'string') {
    return [];
  }
  const reminders = device.reminders;
  if (!reminders || typeof reminders !== 'object') return [];
  return KINDS.flatMap(([kind, field]) => {
    const setting = reminders[field];
    if (setting?.enabled !== true || typeof setting.time !== 'string') return [];
    const slot = latestDueSlot({
      scheduledAt: at,
      timeZoneId: device.timeZoneId,
      time: setting.time,
      keepReminding: reminders.keepReminding === true,
      lastSent: device.lastSent?.[kind],
    });
    return slot ? [{ kind, slot }] : [];
  });
}
