'use strict';
// Canonical buffer snapshots are copied when queued, never read from a later active tab.
class RecoveryWriter {
  constructor(invoke, warning, timers = globalThis) { this.invoke = invoke; this.warning = warning; this.timers = timers; this.states = new Map(); }
  state(id) { if (!this.states.has(id)) this.states.set(id, { pending: null, running: null, quiet: null, maximum: null, retired: false }); return this.states.get(id); }
  clear(state) { this.timers.clearTimeout(state.quiet); this.timers.clearTimeout(state.maximum); state.quiet = state.maximum = null; }
  changed(doc) {
    if (!doc.documentId) return;
    const state = this.state(doc.documentId); if (state.retired) return;
    state.pending = { documentId: doc.documentId, revision: doc.revision, content: doc.content, name: doc.name };
    this.timers.clearTimeout(state.quiet);
    state.quiet = this.timers.setTimeout(() => this.flush(doc), 1000);
    if (!state.maximum) state.maximum = this.timers.setTimeout(() => this.flush(doc), 5000);
  }
  async flush(doc) {
    if (!doc.documentId) return;
    const state = this.state(doc.documentId); this.clear(state);
    if (state.running) { await state.running; if (state.pending && !state.retired) return this.flush(doc); return; }
    if (!state.pending || state.retired) return;
    const snapshot = state.pending; state.pending = null;
    state.running = Promise.resolve().then(() => this.invoke('recovery_write', snapshot)).catch(error => { this.warning(String(error?.message || error)); }).finally(() => { state.running = null; });
    await state.running;
    if (state.pending && !state.retired) return this.flush(doc);
  }
  async saved(doc, revision) { await this.flush(doc); if (!doc.documentId) return; await this.invoke('recovery_saved', { documentId: doc.documentId, revision }).catch(error => this.warning(String(error?.message || error))); }
  async discard(doc) {
    if (!doc.documentId) return;
    const state = this.state(doc.documentId); state.retired = true; state.pending = null; this.clear(state);
    if (state.running) await state.running;
    try { await this.invoke('recovery_discard', { documentId: doc.documentId }); } catch (error) { state.retired = false; this.warning(String(error?.message || error)); throw error; }
  }
}
if (typeof module !== 'undefined') module.exports = { RecoveryWriter };
