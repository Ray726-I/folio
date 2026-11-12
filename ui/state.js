'use strict';
// Explicit state machines for Folio's cross-cutting UI lifecycles.
//
// The runtime is deliberately small: no dependency, no build step, and no
// framework. It gives the app one place to declare states, legal events,
// guards and effects, and gives tests and agents a JSON snapshot of what the
// UI is actually doing. Illegal events are recorded and ignored instead of
// corrupting state, so a stale event can never leave the interface in a
// combination the rest of the app does not understand.
(() => {
  const MAX_HISTORY = 40;
  const MAX_VIOLATIONS = 24;
  const machines = new Map();
  const invariants = new Map();
  const listeners = new Set();
  let transitionCount = 0;
  let notifying = false;
  let debug = false;
  try { debug = localStorage.getItem('folio.debugState') === 'true'; } catch {}

  function clone(value) {
    if (value === undefined) return undefined;
    try { return structuredClone(value); } catch {}
    try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
  }
  // Transition details can contain documents, DOM nodes or promises. Keep the
  // snapshot useful without serializing the world.
  function summarize(detail) {
    if (detail === undefined) return null;
    if (detail === null || typeof detail !== 'object') return detail;
    const output = {};
    for (const [key, value] of Object.entries(detail)) {
      if (value === undefined) continue;
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) output[key] = value;
      else if (Array.isArray(value)) output[key] = value.length <= 8 && value.every(item => item === null || ['string', 'number', 'boolean'].includes(typeof item)) ? value : `[${value.length}]`;
      else if (key === 'documentId' || key === 'path' || key === 'name' || key === 'reason' || key === 'error' || key === 'mode' || key === 'state') output[key] = String(value).slice(0, 240);
      else output[key] = '{…}';
    }
    return output;
  }
  function iso(time) { return new Date(time).toISOString(); }

  class Machine {
    constructor(id, config) {
      this.id = id;
      this.config = config;
      this.state = config.initial;
      this.context = { ...(typeof config.context === 'function' ? config.context() : config.context || {}) };
      this.history = [];
      this.updatedAt = Date.now();
      this.listeners = new Set();
      if (!this.config.states?.[this.state]) throw new Error(`State machine "${id}" has no initial state "${this.state}"`);
    }
    can(event, detail = {}) { return Boolean(this._transition(event, detail)); }
    send(event, detail = {}) {
      const transition = this._transition(event, detail);
      if (!transition) { this._violate(event, detail); return false; }
      return this._apply(transition, event, detail);
    }
    // Context-only change. Useful for focus, read-only and other orthogonal
    // flags that should be visible to guards without inventing a state for
    // every combination.
    update(patch, reason = 'update') {
      if (!patch) return;
      const changed = Object.entries(patch).some(([key, value]) => !Object.is(this.context[key], value));
      if (!changed) return;
      Object.assign(this.context, patch);
      this.updatedAt = Date.now();
      this._record(this.state, this.state, `UPDATE:${reason}`, {});
      this._notify();
    }
    // Compatibility bridge for code that still assigns the old variables
    // directly (including tests). The machine becomes authoritative from this
    // point on, and the bridge is recorded as a sync rather than a user event.
    sync(state, patch = null, reason = 'external') {
      if (!this.config.states[state]) { this._violate(`SYNC:${reason}`, { state }); return false; }
      const contextChanged = patch && Object.entries(patch).some(([key, value]) => !Object.is(this.context[key], value));
      if (this.state === state && !contextChanged) return true;
      const from = this.state;
      this.state = state;
      if (patch) Object.assign(this.context, patch);
      this.updatedAt = Date.now();
      this._record(from, state, `SYNC:${reason}`, {});
      this._notify();
      return true;
    }
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    get snapshot() {
      return { state: this.state, context: clone(this.context), history: this.history.map(entry => ({ ...entry, at: iso(entry.at) })), updatedAt: iso(this.updatedAt) };
    }
    _transition(event, detail) {
      const state = this.config.states[this.state];
      if (!state) return null;
      const spec = state.on?.[event] ?? this.config.on?.[event];
      const candidates = spec == null ? [] : Array.isArray(spec) ? spec : [spec];
      for (const candidate of candidates) {
        const transition = typeof candidate === 'string' ? { target: candidate } : candidate;
        if (transition.target && !this.config.states[transition.target]) continue;
        if (transition.guard && !transition.guard(this.context, detail, this)) continue;
        return transition;
      }
      return null;
    }
    _apply(transition, event, detail) {
      const from = this.state;
      const target = transition.target || this.state;
      if (transition.assign) Object.assign(this.context, transition.assign(this.context, detail, this) || {});
      if (target !== from) {
        this.config.states[from]?.exit?.(this.context, detail, this);
        this.state = target;
        this.config.states[target]?.entry?.(this.context, detail, this);
      }
      transition.action?.(this.context, detail, this);
      this.updatedAt = Date.now();
      this._record(from, target, event, detail);
      this._notify();
      return true;
    }
    _record(from, to, event, detail) {
      this.history.push({ at: Date.now(), from, to, event, detail: summarize(detail) });
      if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
      transitionCount++;
    }
    _violate(event, detail) {
      const violation = { at: Date.now(), machine: this.id, state: this.state, event, detail: summarize(detail) };
      violations.push(violation);
      if (violations.length > MAX_VIOLATIONS) violations.splice(0, violations.length - MAX_VIOLATIONS);
      if (debug) console.warn(`[FolioState] ${this.id} ignored ${event} in ${this.state}`, detail);
    }
    _notify() {
      if (notifying) return;
      notifying = true;
      try {
        for (const listener of this.listeners) { try { listener(this); } catch (error) { if (debug) console.error(error); } }
        for (const listener of listeners) { try { listener(this); } catch (error) { if (debug) console.error(error); } }
        checkInvariants();
      } finally { notifying = false; }
    }
  }

  const violations = [];
  function define(id, config) {
    if (machines.has(id)) throw new Error(`State machine "${id}" is already defined`);
    const machine = new Machine(id, config);
    machines.set(id, machine);
    return machine;
  }
  function get(id) { return machines.get(id); }
  function invariant(name, predicate, detail = '') {
    invariants.set(name, { predicate, detail });
  }
  function checkInvariants() {
    for (const [name, invariant] of invariants) {
      let holds = false;
      try { holds = Boolean(invariant.predicate()); } catch { holds = false; }
      if (holds) continue;
      const last = violations.at(-1);
      if (last && last.machine === 'invariant' && last.event === name) continue;
      violations.push({ at: Date.now(), machine: 'invariant', state: name, event: name, detail: { detail: invariant.detail } });
      if (violations.length > MAX_VIOLATIONS) violations.splice(0, violations.length - MAX_VIOLATIONS);
      if (debug) console.warn(`[FolioState] invariant failed: ${name}`, invariant.detail);
    }
  }
  function snapshot() {
    const state = {};
    for (const [id, machine] of machines) state[id] = machine.snapshot;
    return { version: 1, at: new Date().toISOString(), transitionCount, machines: state, violations: violations.map(entry => ({ ...entry, at: iso(entry.at) })) };
  }
  function inspect() {
    const lines = [`Folio state — ${new Date().toLocaleString()}`, ''];
    for (const [id, machine] of machines) {
      const context = Object.entries(machine.context).map(([key, value]) => `${key}=${Array.isArray(value) ? `[${value.join(', ')}]` : String(value)}`).join(' ');
      lines.push(`${id.padEnd(10)} ${machine.state.padEnd(12)} ${context}`);
      const recent = machine.history.slice(-3);
      for (const entry of recent) lines.push(`  ← ${entry.event} ${entry.from}→${entry.to}  ${new Date(entry.at).toLocaleTimeString()}`);
    }
    lines.push('', `Transitions: ${transitionCount}`);
    lines.push(`Violations: ${violations.length}`);
    for (const violation of violations.slice(-8)) lines.push(`  ! ${violation.machine} ${violation.event} in ${violation.state}  ${new Date(violation.at).toLocaleTimeString()}`);
    return lines.join('\n');
  }
  function openInspector() {
    let dialog = document.getElementById('state-inspector');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'state-inspector';
      dialog.className = 'source-dialog state-inspector';
      dialog.setAttribute('aria-labelledby', 'state-inspector-title');
      const head = document.createElement('div'); head.className = 'source-dialog-head';
      const title = document.createElement('h2'); title.id = 'state-inspector-title'; title.textContent = 'App state';
      const close = document.createElement('button'); close.type = 'button'; close.className = 'icon-button'; close.setAttribute('aria-label', 'Close app state'); close.title = 'Close app state'; close.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-close"/></svg>';
      close.addEventListener('click', () => dialog.close());
      head.append(title, close);
      const lede = document.createElement('p'); lede.textContent = 'Live state machines, recent transitions and invariant violations.';
      const output = document.createElement('pre'); output.className = 'state-inspector-output'; output.tabIndex = 0;
      const actions = document.createElement('div'); actions.className = 'state-inspector-actions';
      const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'button'; refresh.textContent = 'Refresh';
      refresh.addEventListener('click', () => { output.textContent = inspect(); output.scrollTop = 0; });
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'button'; copy.textContent = 'Copy JSON';
      copy.addEventListener('click', async () => {
        const text = JSON.stringify(snapshot(), null, 2);
        try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy JSON'; }, 1200); }
        catch { copy.textContent = 'Copy failed'; }
      });
      const done = document.createElement('button'); done.type = 'button'; done.className = 'button suggested'; done.textContent = 'Close';
      done.addEventListener('click', () => dialog.close());
      actions.append(refresh, copy, done);
      dialog.append(head, lede, output, actions);
      dialog.addEventListener('keydown', event => event.stopPropagation());
      document.body.append(dialog);
    }
    const output = dialog.querySelector('.state-inspector-output');
    output.textContent = inspect();
    if (dialog.open) { dialog.querySelector('.state-inspector-actions .suggested')?.focus(); return; }
    dialog.showModal();
    dialog.querySelector('.state-inspector-actions .suggested')?.focus();
  }

  window.FolioState = {
    define, get, invariant, checkInvariants, snapshot, inspect, openInspector,
    violations: () => violations.map(entry => ({ ...entry, at: iso(entry.at) })),
    resetViolations: () => { violations.length = 0; },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }
  };
})();
