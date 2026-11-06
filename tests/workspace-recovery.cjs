const assert = require('node:assert/strict');
const { RecoveryWriter } = require('../ui/recovery.js');
(async () => {
  let release; const calls = [];
  const writer = new RecoveryWriter(async (cmd, args) => { calls.push([cmd, args]); if (calls.length === 1) await new Promise(r => release = r); return args.revision; }, () => {});
  const doc = { documentId: 'a', revision: 1, content: 'first', saved: '', name: 'A.md' };
  writer.changed(doc); const first = writer.flush(doc); await Promise.resolve();
  doc.revision = 2; doc.content = 'newest'; writer.changed(doc);
  assert.equal(calls.length, 1, 'one snapshot is in flight'); release(); await first; await writer.flush(doc);
  assert.deepEqual(calls.map(c => c[1].content), ['first', 'newest']);
  assert.equal(calls[0][1].documentId, 'a');
  await writer.saved(doc, 1); assert.equal(calls.at(-1)[0], 'recovery_saved'); assert.equal(calls.at(-1)[1].revision, 1);
  await writer.discard(doc); doc.revision++; writer.changed(doc); await writer.flush(doc);
  assert.equal(calls.at(-1)[0], 'recovery_discard', 'retired writer cannot resurrect a discarded draft');
  const failures = []; const bad = new RecoveryWriter(async () => { throw Error('disk full'); }, e => failures.push(e));
  bad.changed({ ...doc, documentId: 'b' }); await bad.flush({ documentId: 'b' }); assert.match(failures[0], /disk full/);
  // Quiet and maximum deadlines are independent: continuous edits cannot postpone protection forever.
  let now = 0, serial = 0; const jobs = new Map(), snapshots = [];
  const timers = { setTimeout(fn, ms) { const id = ++serial; jobs.set(id, { fn, at: now + ms }); return id; }, clearTimeout(id) { jobs.delete(id); } };
  async function advance(ms) { now += ms; for (const [id, job] of [...jobs]) if (job.at <= now && jobs.has(id)) { jobs.delete(id); job.fn(); } await Promise.resolve(); await Promise.resolve(); }
  const timed = new RecoveryWriter(async (cmd, args) => snapshots.push(args), () => {}, timers);
  const continuous = { documentId: 'timed', revision: 1, content: '1', name: 'Timed' };
  timed.changed(continuous); await advance(999); assert.equal(snapshots.length, 0);
  await advance(1); assert.equal(snapshots.length, 1, 'quiet snapshot at one second');
  await timed.flush(continuous);
  for (let i = 0; i < 7; i++) { continuous.revision++; continuous.content += 'x'; timed.changed(continuous); await advance(800); }
  assert.ok(snapshots.length >= 2, 'maximum wait snapshots continuous typing');
  await timed.flush(continuous);
  console.log('workspace recovery ordering and deadlines passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
