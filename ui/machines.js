'use strict';
// Machine definitions for Folio's nervous system.
//
// Authoritative machines own their state and reject illegal events. Observed
// machines (save) project an existing per-document value into the same
// snapshot so agents and tests see one model while older code is migrated.
// Every guard reads the live app globals at call time; definitions stay free
// of startup-order dependencies.

// --- Surface: welcome, folder-only, or an active document ------------------
const surfaceMachine = FolioState.define('surface', {
  initial: 'welcome',
  context: { folder: null, documentId: null },
  states: {
    welcome: { on: { WELCOME: 'welcome', FOLDER: 'folder', DOCUMENT: 'document' } },
    folder: { on: { WELCOME: 'welcome', FOLDER: 'folder', DOCUMENT: 'document' } },
    document: { on: { WELCOME: 'welcome', FOLDER: 'folder', DOCUMENT: 'document' } }
  }
});
function syncSurfaceMachine() {
  const visible = !$('document-view')?.hidden;
  const state = current?.active ? 'document' : visible && activeFolder ? 'folder' : 'welcome';
  surfaceMachine.sync(state, { folder: activeFolder?.path || null, documentId: current?.active ? current.documentId || null : null }, 'render');
}

// --- Document mode: Read, Edit, Source -------------------------------------
// Read-only and transition protection are context, not states. That keeps the
// three visible modes independent from the two locks, exactly as the UI
// promises: read-only protects every mode without hiding the mode itself.
const modeMachine = FolioState.define('mode', {
  initial: 'reading',
  context: { readOnly: false, writable: true, transitioning: false, companion: false },
  states: {
    reading: {
      on: {
        READING: 'reading',
        EDIT: { target: 'edit', guard: () => modeCanEdit() },
        SOURCE: { target: 'source', guard: () => modeCanSource() },
        TOGGLE_LOCK: { assign: context => ({ readOnly: !context.readOnly }) }
      }
    },
    edit: {
      on: {
        READING: 'reading',
        EDIT: { target: 'edit', guard: () => modeCanEdit() },
        SOURCE: { target: 'source', guard: () => modeCanSource() },
        TOGGLE_LOCK: { assign: context => ({ readOnly: !context.readOnly }) }
      }
    },
    source: {
      on: {
        READING: 'reading',
        EDIT: { target: 'edit', guard: () => modeCanEdit() },
        SOURCE: { target: 'source', guard: () => modeCanSource() },
        TOGGLE_LOCK: { assign: context => ({ readOnly: !context.readOnly }) }
      }
    }
  }
});
function modeCanEdit() {
  return Boolean(current?.active && current.writable !== false && !transitionLocked && focusedPane !== 'companion');
}
function modeCanSource() {
  return Boolean(current?.active && !transitionLocked && focusedPane !== 'companion');
}
function syncModeMachine() {
  modeMachine.update({
    readOnly: Boolean(documentReadOnly),
    writable: current?.writable !== false,
    transitioning: Boolean(transitionLocked),
    companion: focusedPane === 'companion'
  }, 'live');
}
modeMachine.subscribe(machine => {
  if (documentMode !== machine.state) documentMode = machine.state;
  if (documentReadOnly !== machine.context.readOnly) documentReadOnly = machine.context.readOnly;
});

// --- Save: clean, dirty, saving, error, paused -----------------------------
// The per-document status remains the storage while background saves are
// still owned by save(). This projection makes the focused indicator, the
// inspector and the invariant checks agree on one state name.
const saveMachine = FolioState.define('save', {
  initial: 'clean',
  context: { documentId: null, error: null, dirty: false, automatic: false },
  states: {
    clean: { on: { EDIT: 'dirty', SAVE: 'saving', FAIL: 'error', PAUSE: 'paused', CONFLICT: 'error' } },
    dirty: { on: { EDIT: 'dirty', SAVE: 'saving', FAIL: 'error', PAUSE: 'paused', CONFLICT: 'error' } },
    saving: { on: { SAVE: 'saving', SAVED: 'clean', FAIL: 'error', PAUSE: 'paused', CONFLICT: 'error' } },
    error: { on: { EDIT: 'dirty', SAVE: 'saving', FAIL: 'error', PAUSE: 'paused' } },
    paused: { on: { EDIT: 'paused', SAVE: 'saving', PAUSE: 'paused', FAIL: 'error' } }
  }
});
function saveStatusFor(owner) {
  return owner === current ? saveStatus : owner?.saveStatus || owner?.view?.saveStatus;
}
function syncSaveMachine(owner = typeof focusedDocument === 'function' ? focusedDocument() : current) {
  if (!owner) return;
  const status = saveStatusFor(owner);
  const dirty = owner.content !== owner.saved;
  const state = owner.autoSavePaused ? 'paused' : status === 'saving' ? 'saving' : status?.error ? 'error' : dirty ? 'dirty' : 'clean';
  saveMachine.sync(state, { documentId: owner.documentId || null, error: status?.error || null, dirty, automatic: false }, 'render');
}

// --- Find and Replace -------------------------------------------------------
const findMachine = FolioState.define('find', {
  initial: 'closed',
  context: { query: '', matches: 0, index: -1, invalid: false },
  states: {
    closed: { on: { FIND: 'find', REPLACE: 'replace', CLOSE: 'closed' } },
    find: {
      on: {
        FIND: 'find',
        REPLACE: 'replace',
        CLOSE: 'closed',
        QUERY: { target: 'find', assign: (_, detail) => findContext(detail) },
        RESULT: { target: 'find', assign: (_, detail) => findContext(detail) }
      }
    },
    replace: {
      on: {
        FIND: 'find',
        REPLACE: 'replace',
        CLOSE: 'closed',
        QUERY: { target: 'replace', assign: (_, detail) => findContext(detail) },
        RESULT: { target: 'replace', assign: (_, detail) => findContext(detail) }
      }
    }
  }
});
function findContext(detail = {}) {
  return {
    query: String(detail.query ?? ''),
    matches: Number(detail.matches) || 0,
    index: Number.isInteger(detail.index) ? detail.index : -1,
    invalid: Boolean(detail.invalid)
  };
}
function syncFindMachine() {
  const bar = $('find-bar'), replace = $('replace-bar'), input = $('find-input');
  if (!bar) return;
  const state = bar.hidden ? 'closed' : replace && !replace.hidden ? 'replace' : 'find';
  findMachine.sync(state, findContext({
    query: input?.value || '',
    matches: typeof matches === 'undefined' ? 0 : matches.length,
    index: typeof findIndex === 'undefined' ? -1 : findIndex,
    invalid: input?.getAttribute('aria-invalid') === 'true'
  }), 'render');
}

// --- Reading companion ------------------------------------------------------
const companionMachine = FolioState.define('companion', {
  initial: 'hidden',
  context: { documentId: null, follows: false, focused: false },
  states: {
    hidden: { on: { CLOSE: 'hidden', FOLLOW: 'following', PIN: 'pinned' } },
    following: { on: { CLOSE: 'hidden', FOLLOW: 'following', PIN: 'pinned' } },
    pinned: { on: { CLOSE: 'hidden', FOLLOW: 'following', PIN: 'pinned' } }
  }
});
function syncCompanionMachine() {
  const state = !companionDocument ? 'hidden' : companionFollows ? 'following' : 'pinned';
  companionMachine.sync(state, { documentId: companionDocument?.documentId || null, follows: companionFollows, focused: focusedPane === 'companion' }, 'render');
}
companionMachine.subscribe(machine => {
  companionFollows = machine.state === 'following';
  if (machine.state === 'hidden') companionDocument = null;
});

// --- Preview mount ----------------------------------------------------------
const previewMachine = FolioState.define('preview', {
  initial: 'idle',
  context: { documentId: null, reason: null },
  states: {
    idle: { on: { IDLE: 'idle', MOUNT: { target: 'mounting', assign: (_, detail) => ({ documentId: detail.documentId || null, reason: null }) }, FALLBACK: { target: 'fallback', assign: (_, detail) => ({ reason: detail.reason || 'limited' }) }, FAIL: { target: 'error', assign: (_, detail) => ({ reason: detail.reason || 'mount' }) } } },
    mounting: { on: { MOUNT: { target: 'mounting', assign: (_, detail) => ({ documentId: detail.documentId || null, reason: null }) }, READY: { target: 'ready', assign: () => ({ reason: null }) }, FALLBACK: { target: 'fallback', assign: (_, detail) => ({ reason: detail.reason || 'limited' }) }, FAIL: { target: 'error', assign: (_, detail) => ({ reason: detail.reason || 'mount' }) }, IDLE: 'idle' } },
    ready: { on: { READY: 'ready', MOUNT: { target: 'mounting', assign: (_, detail) => ({ documentId: detail.documentId || null, reason: null }) }, IDLE: 'idle', FALLBACK: { target: 'fallback', assign: (_, detail) => ({ reason: detail.reason || 'limited' }) }, FAIL: { target: 'error', assign: (_, detail) => ({ reason: detail.reason || 'mount' }) } } },
    fallback: { on: { MOUNT: { target: 'mounting', assign: (_, detail) => ({ documentId: detail.documentId || null, reason: null }) }, IDLE: 'idle', FAIL: { target: 'error', assign: (_, detail) => ({ reason: detail.reason || 'mount' }) } } },
    error: { on: { MOUNT: { target: 'mounting', assign: (_, detail) => ({ documentId: detail.documentId || null, reason: null }) }, IDLE: 'idle' } }
  }
});

// --- Menus ------------------------------------------------------------------
const menuMachine = FolioState.define('menu', {
  initial: 'closed',
  context: { active: null, submenu: null },
  states: {
    closed: { on: { OPEN: { target: 'open', assign: (_, detail) => ({ active: detail.id || null, submenu: detail.submenu || null }) }, CLOSE: 'closed' } },
    open: {
      on: {
        OPEN: { target: 'open', assign: (_, detail) => ({ active: detail.id || null, submenu: detail.submenu || null }) },
        SUBMENU: { target: 'open', assign: (_, detail) => ({ submenu: detail.submenu || null }) },
        CLOSE: { target: 'closed', assign: () => ({ active: null, submenu: null }) }
      }
    }
  }
});
function syncMenuMachine() {
  const open = [...document.querySelectorAll('.menu')].filter(menu => !menu.hidden && !menu.parentElement?.closest('.menu'));
  const active = open.find(menu => menu.id)?.id || null;
  menuMachine.sync(active ? 'open' : 'closed', { active, submenu: $('open-recent-menu') && !$('open-recent-menu').hidden ? 'open-recent-menu' : null }, 'render');
}

// --- Modal stack ------------------------------------------------------------
const modalMachine = FolioState.define('modals', {
  initial: 'idle',
  context: { stack: [] },
  states: {
    idle: { on: { OPEN: 'open', CLOSE: 'idle' } },
    open: { on: { OPEN: 'open', CLOSE: 'idle' } }
  }
});
function syncModalMachine() {
  const stack = [...document.querySelectorAll('dialog[open]')].map(dialog => dialog.id || 'dialog');
  modalMachine.sync(stack.length ? 'open' : 'idle', { stack }, 'render');
}

// --- Invariants -------------------------------------------------------------
// These are the combinations the rest of the app assumes. A failure is
// recorded in the snapshot instead of thrown, so a stale event cannot turn a
// recoverable UI glitch into a lost document.
FolioState.invariant('surface-document-is-active', () => surfaceMachine.state !== 'document' || Boolean(current?.active), 'A document surface requires an active document.');
FolioState.invariant('mode-is-known', () => ['reading', 'edit', 'source'].includes(modeMachine.state), 'The document mode must be one of reading, edit or source.');
FolioState.invariant('save-clean-is-not-dirty', () => saveMachine.state !== 'clean' || saveMachine.context.dirty === false, 'A clean save state cannot hold unsaved content.');
FolioState.invariant('save-error-has-message', () => saveMachine.state !== 'error' || Boolean(saveMachine.context.error), 'A save error must carry a message.');
FolioState.invariant('find-open-has-bar', () => findMachine.state === 'closed' || $('find-bar')?.hidden === false, 'An open find state requires the find bar.');
FolioState.invariant('companion-has-document', () => companionMachine.state === 'hidden' || Boolean(companionDocument), 'A visible companion requires a document.');
FolioState.invariant('menu-single-open', () => document.querySelectorAll('.menu:not([hidden])').length <= 1 || Boolean(document.querySelector('.menu .menu:not([hidden])')), 'At most one top-level menu may be open.');
FolioState.invariant('modal-stack-unique', () => new Set(modalMachine.context.stack).size === modalMachine.context.stack.length, 'A dialog cannot appear twice in the modal stack.');

// Keep the observed machines live for code paths that mutate the underlying
// variables directly, and expose the modal stack as native dialogs open.
if (typeof MutationObserver === 'function') {
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      const target = mutation.target;
      if (target instanceof HTMLDialogElement) syncModalMachine();
      else if (target instanceof Element && target.classList.contains('menu')) syncMenuMachine();
    }
  });
  observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });
}
document.addEventListener('toggle', event => { if (event.target instanceof HTMLDialogElement) syncModalMachine(); }, true);
