import process from 'node:process';
import { cert, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { activePlanDay, dueSlots, isMissingInActiveGroups, slotKey, wasAlreadySent, windowSlots } from './decision.mjs';

const MESSAGE_TTL_MILLIS = 30 * 60 * 1000;
const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-argument',
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

function serviceAccountFromEnvironment() {
  const value = process.env.FIREBASE_SERVICE_ACCOUNT;
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!value) throw new Error('service account is unavailable');
  const parsed = JSON.parse(value);
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) throw new Error('service account is invalid');
  return parsed;
}

/** The run time. GitHub does not pass the scheduled instant to scheduled runs, so the actual start is used. */
function runTime() {
  const raw = process.env.SCHEDULED_AT?.trim();
  const value = raw ? new Date(raw) : new Date();
  if (!Number.isFinite(value.getTime())) throw new Error('scheduled time is invalid');
  return value;
}

async function activeGroupProgress(firestore, uid, at) {
  const memberships = await firestore.collection(`users/${uid}/memberships`).where('status', '==', 'active').get();
  const groups = [];
  for (const membership of memberships.docs) {
    const group = await firestore.doc(`groups/${membership.id}`).get();
    if (!group.exists) continue;
    const day = activePlanDay(group.data(), uid, at);
    if (day == null) continue;
    const entry = await firestore.doc(`groups/${membership.id}/entries/${day}_${uid}`).get();
    groups.push({ values: entry.exists ? entry.data()?.values : {} });
  }
  return groups;
}

/** Records the slot as sent unless a concurrent or earlier run already did. The device document is the claim. */
async function claimSlot(firestore, ref, kind, slot) {
  return firestore.runTransaction(async (transaction) => {
    const current = await transaction.get(ref);
    if (!current.exists || wasAlreadySent(slot, current.data()?.lastSent?.[kind])) return false;
    transaction.update(ref, {
      [`lastSent.${kind}`]: slotKey(slot),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

async function run() {
  const account = serviceAccountFromEnvironment();
  const app = initializeApp({ credential: cert(account), projectId: account.project_id });
  const firestore = getFirestore(app);
  const messaging = getMessaging(app);
  const at = runTime();
  // Only registrations whose reminders fall in this run's window; never a scan of every device.
  const snapshot = await firestore.collectionGroup('devices').where('dueSlots', 'array-contains-any', windowSlots(at)).get();
  const counts = {
    devices: snapshot.size,
    due: 0,
    sent: 0,
    complete: 0,
    noActiveGroups: 0,
    deduped: 0,
    invalidDeleted: 0,
    failed: 0,
  };

  for (const registration of snapshot.docs) {
    try {
      const uid = registration.ref.parent.parent?.id;
      if (!uid) {
        counts.failed += 1;
        continue;
      }
      const device = registration.data();
      const due = dueSlots(device, at);
      counts.due += due.length;
      if (due.length === 0) continue;
      const groups = await activeGroupProgress(firestore, uid, at);
      if (groups.length === 0) {
        counts.noActiveGroups += due.length;
        continue;
      }
      for (const { kind, slot } of due) {
        if (!isMissingInActiveGroups(groups, kind)) {
          counts.complete += 1;
          continue;
        }
        if (!await claimSlot(firestore, registration.ref, kind, slot)) {
          counts.deduped += 1;
          continue;
        }
        try {
          await messaging.send({
            token: device.token,
            data: { kind, date: slot.date, followUp: String(slot.followUp) },
            android: { priority: 'high', ttl: MESSAGE_TTL_MILLIS },
          });
          counts.sent += 1;
        } catch (error) {
          if (INVALID_TOKEN_CODES.has(error?.code)) {
            await registration.ref.delete();
            counts.invalidDeleted += 1;
          } else {
            counts.failed += 1;
          }
        }
      }
    } catch {
      counts.failed += 1;
    }
  }
  console.log(JSON.stringify(counts));
}

run().catch(() => {
  console.error('Reminder sender failed.');
  process.exitCode = 1;
});
