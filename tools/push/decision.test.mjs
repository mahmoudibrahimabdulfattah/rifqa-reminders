import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activePlanDay,
  dueSlots,
  isMissingInActiveGroups,
  latestDueSlot,
  localParts,
  slotKey,
  wasAlreadySent,
  windowSlots,
} from './decision.mjs';

test('local parts follow the device zone across calendar dates', () => {
  const instant = new Date('2026-10-21T22:30:00Z');
  assert.deepEqual(localParts(instant, 'Africa/Cairo'), { date: '2026-10-22', time: '01:30' });
  assert.deepEqual(localParts(instant, 'America/New_York'), { date: '2026-10-21', time: '18:30' });
});

test('the catch-up window excludes its start and includes its end', () => {
  const input = { scheduledAt: new Date('2026-10-22T07:30:00Z'), timeZoneId: 'UTC', keepReminding: false };
  assert.equal(latestDueSlot({ ...input, time: '06:00' }), null);
  assert.equal(latestDueSlot({ ...input, time: '06:01' }).date, '2026-10-22');
  assert.equal(latestDueSlot({ ...input, time: '07:30' }).followUp, 0);
});

test('a run delayed by an hour still catches the initial slot', () => {
  const slot = latestDueSlot({
    scheduledAt: new Date('2026-10-22T09:00:00Z'),
    timeZoneId: 'UTC',
    time: '08:00',
    keepReminding: false,
  });
  assert.deepEqual({ date: slot.date, followUp: slot.followUp }, { date: '2026-10-22', followUp: 0 });
});

test('dedupe refuses the same or an older follow-up on a date', () => {
  assert.equal(wasAlreadySent({ date: '2026-10-22', followUp: 1 }, '2026-10-22#1'), true);
  assert.equal(wasAlreadySent({ date: '2026-10-22', followUp: 1 }, '2026-10-22#2'), true);
  assert.equal(wasAlreadySent({ date: '2026-10-22', followUp: 2 }, '2026-10-22#1'), false);
  assert.equal(wasAlreadySent({ date: '2026-10-23', followUp: 0 }, '2026-10-22#2'), false);
});

test('follow-ups are hourly, capped at two and never cross local midnight', () => {
  const base = { timeZoneId: 'UTC', keepReminding: true };
  assert.equal(latestDueSlot({ ...base, scheduledAt: new Date('2026-10-22T11:00:00Z'), time: '09:00' }).followUp, 2);
  assert.equal(
    latestDueSlot({ ...base, scheduledAt: new Date('2026-10-22T12:00:00Z'), time: '09:00', lastSent: '2026-10-22#2' }),
    null,
  );
  assert.equal(latestDueSlot({ ...base, scheduledAt: new Date('2026-10-23T00:30:00Z'), time: '23:30' }), null);
});

test('disabling keep-reminding permits only the initial slot', () => {
  const slot = latestDueSlot({
    scheduledAt: new Date('2026-10-22T10:00:00Z'),
    timeZoneId: 'UTC',
    time: '09:00',
    keepReminding: false,
  });
  assert.equal(slot.followUp, 0);
});

test('group plan day uses the fixed group zone and plan bounds', () => {
  const group = {
    status: 'Active', roster: { mahmoud: true }, planId: 'Madinah604V1',
    startDate: '2026-10-18', timeZoneId: 'Africa/Cairo',
  };
  assert.equal(activePlanDay(group, 'mahmoud', new Date('2026-10-21T22:30:00Z')), 5);
  assert.equal(activePlanDay({ ...group, status: 'Archived' }, 'mahmoud', new Date('2026-10-21T22:30:00Z')), null);
  assert.equal(activePlanDay(group, 'other', new Date('2026-10-21T22:30:00Z')), null);
});

test('an item must be done in every active group', () => {
  assert.equal(isMissingInActiveGroups([], 'QuranWird'), false);
  assert.equal(isMissingInActiveGroups([{ values: { QuranWird: 1 } }], 'QuranWird'), false);
  assert.equal(isMissingInActiveGroups([{ values: { QuranWird: 1 } }, { values: {} }], 'QuranWird'), true);
});

const device = (overrides = {}) => ({
  platform: 'android',
  token: 'fcm-token',
  timeZoneId: 'UTC',
  reminders: {
    morning: { enabled: true, time: '08:00' },
    evening: { enabled: false, time: '18:00' },
    wird: { enabled: true, time: '08:00' },
    keepReminding: true,
  },
  ...overrides,
});

test('due slots only cover enabled kinds for Android devices with valid fields', () => {
  const at = new Date('2026-10-22T08:10:00Z');
  const due = dueSlots(device(), at).map((entry) => entry.kind);
  assert.deepEqual(due, ['MorningAdhkar', 'QuranWird']);
  assert.deepEqual(dueSlots(device({ platform: 'ios' }), at), []);
  assert.deepEqual(dueSlots(device({ token: undefined }), at), []);
  assert.deepEqual(dueSlots(device({ reminders: null }), at), []);
  assert.throws(() => dueSlots(device({ timeZoneId: 'Mars/Olympus' }), at), RangeError);
});

test('due slots honour the sent markers and the keep-reminding switch', () => {
  const at = new Date('2026-10-22T08:10:00Z');
  const sent = device({ lastSent: { MorningAdhkar: '2026-10-22#0' } });
  assert.deepEqual(dueSlots(sent, at).map((entry) => entry.kind), ['QuranWird']);
  const at09 = new Date('2026-10-22T09:10:00Z');
  const once = device({ reminders: { ...device().reminders, keepReminding: false } });
  const initialOnly = dueSlots(once, at09).find((entry) => entry.kind === 'MorningAdhkar');
  assert.equal(initialOnly.slot.followUp, 0);
  const followed = dueSlots(device(), at09).find((entry) => entry.kind === 'MorningAdhkar');
  assert.equal(followed.slot.followUp, 1);
});

test('overlapping half-hour runs send each slot once, in order', () => {
  const runs = ['08:00', '08:30', '09:00', '10:00', '11:00', '11:30'].map((hh) => new Date(`2026-10-22T${hh}:00Z`));
  let lastSent;
  const sent = [];
  for (const scheduledAt of runs) {
    const slot = latestDueSlot({ scheduledAt, timeZoneId: 'UTC', time: '08:00', keepReminding: true, lastSent });
    if (!slot) continue;
    lastSent = slotKey(slot);
    sent.push(lastSent);
  }
  assert.deepEqual(sent, ['2026-10-22#0', '2026-10-22#1', '2026-10-22#2']);
});

test('a run reads the slots covering its window and the runner delay', () => {
  assert.deepEqual(windowSlots(new Date('2026-10-25T04:30:00Z')), [6, 7, 8, 9]);
  assert.deepEqual(windowSlots(new Date('2026-10-25T00:20:00Z')), [0, 45, 46, 47]);
});
