# State machines

Folio's UI is a set of small state machines that grew inside plain variables,
DOM attributes and promises. This document is the inventory of those machines,
the contract for the ones that are now explicit, and the migration path for the
rest. It is written for people and agents: every machine has a stable id, named
states, named events, guards, and a JSON snapshot.

The runtime is `ui/state.js`; definitions live in `ui/machines.js`. There is no
framework and no build step. A machine is a plain object and its snapshot is
JSON-safe, so it can be pasted into an issue or read by a test.

## Why this exists

The same lifecycle used to be described in several places at once:

- Read / Edit / Source lived in `documentMode`, while read-only lived in
  `documentReadOnly`, filesystem permission in `current.writable`, transition
  protection in `transitionLocked`, and the editor's own `locked`/`sourceOnly`.
- The save indicator was `saveStatus`, `doc.saveStatus`, `doc.view.saveStatus`
  and a derived dirty check.
- Find was two hidden bars, an array of matches, an index, a source snapshot,
  a timer and an `aria-invalid` flag.
- The reading companion was a document pointer, a follows boolean, a focus
  pane, a generation counter, an abort controller and several timers.

Those variables still exist where they are the right storage, but the legal
combinations now have names. That gives three concrete wins:

- **UX:** an event that is not legal for the current state is rejected instead
  of producing a half-painted UI (for example Edit while a document is being
  replaced, or a companion sync control for a different document).
- **DX:** one transition table answers "what can happen next?" and one snapshot
  answers "what is happening now?".
- **AX:** agents can read the machine table, send a named event, and inspect
  the resulting state without reverse-engineering the DOM.

## Runtime

```js
const machine = FolioState.define('example', {
  initial: 'idle',
  context: { count: 0 },
  states: {
    idle: { on: { START: { target: 'running', guard: context => context.ready } } },
    running: { on: { STOP: 'idle', TICK: { target: 'running', assign: context => ({ count: context.count + 1 }) } } }
  }
});

machine.send('START', { reason: 'user' }); // false when the guard or state rejects it
machine.update({ ready: true }, 'permission'); // context-only, no new state
machine.sync('running', { count: 0 }, 'restore'); // bridge for restored variables
machine.snapshot; // { state, context, history, updatedAt }
```

Rules:

- `send` is the only way to change state for new code. It returns `false` and
  records a violation when the event is not defined for the current state or a
  guard rejects it. It never throws and never applies a partial transition.
- `update` changes orthogonal context (focus, read-only, permission) without
  inventing a state for every combination.
- `sync` is a compatibility bridge for restored sessions and existing tests
  that assign the old variables directly. It records `SYNC:<reason>` so the
  snapshot still shows how the value arrived.
- `assign` runs before entry/exit and the optional `action`; `entry`/`exit`
  are for effects. Keep effects idempotent: a restored session may replay them.
- `FolioState.invariant(name, predicate, message)` registers an assumption
  checked after every notification. Failures are recorded, not thrown, so a
  recoverable UI glitch cannot become a lost document.
- History is bounded (40 transitions per machine) and details are summarized
  so documents, DOM nodes and promises never leak into a snapshot.

## Inspect it

- Command window → **Inspect app state**.
- `window.FolioState.snapshot()` returns every machine, context, recent
  transitions and violations.
- `window.FolioState.inspect()` returns the same information as readable text.
- `localStorage.setItem('folio.debugState', 'true')` also prints rejected
  events and invariant failures to the console.
- `npm run test:state` runs the browser contract tests.

## Machines that are explicit today

### `surface` — `ui/machines.js`, synced by `showDocument`/`showWelcome`

| State | Meaning |
| --- | --- |
| `welcome` | No document view; welcome screen is visible. |
| `folder` | Folder is open, no document is active, document view is visible. |
| `document` | A document is active. |

Events are the three states as `WELCOME`, `FOLDER`, `DOCUMENT`. The machine is
a projection of `current.active`, `activeFolder` and `#document-view.hidden`,
so the welcome screen cannot claim a document is open.

Invariant: `surface-document-is-active` — a `document` surface requires an
active document.

### `mode` — `ui/machines.js`, authoritative in `ui/chrome.js`

| State | Meaning |
| --- | --- |
| `reading` | Read mode. The editor is locked but links, selection and copy work. |
| `edit` | Formatted editing. |
| `source` | Exact Markdown editing in the textarea. |

Events: `READING`, `EDIT`, `SOURCE`, `TOGGLE_LOCK`.

Context:

- `readOnly` — the user's persistent **Open as read-only** lock.
- `writable` — filesystem permission (`current.writable !== false`).
- `transitioning` — temporary protection while a document is replaced.
- `companion` — the reading companion owns focus.

Read-only is deliberately **not** a fourth mode. A read-only document can still
be viewed in Edit or Source; the editor stays locked, which is exactly what the
mode menu promises. Guards only reject Edit when the file is not writable, a
document transition is in flight, or the companion owns focus. Source is
available while read-only because inspection is always allowed.

Invariant: `mode-is-known`.

`ui/app.js` also carries a legacy `mode` variable pinned to `read` by
`editorPresentation()` and mirrored to `data-mode`. It is not a user mode; the
real mode is `documentMode`. Remove it when the old presentation branch is
deleted rather than teaching it new values.

### `find` — `ui/machines.js`, authoritative in `ui/app.js`

| State | Meaning |
| --- | --- |
| `closed` | Both find bars are hidden. |
| `find` | Find bar is open. |
| `replace` | Find and Replace bars are open. |

Events: `FIND`, `REPLACE`, `CLOSE`, `QUERY`, `RESULT`.

Context: `query`, `matches`, `index`, `invalid`. Invalid regular expressions
are a context flag, not an error state, so the bar stays open and the user can
correct the pattern.

Invariant: `find-open-has-bar`.

### `companion` — `ui/machines.js`, authoritative in `ui/panes.js`

| State | Meaning |
| --- | --- |
| `hidden` | No companion pane. |
| `following` | Companion shows the current document and follows tab changes. |
| `pinned` | Companion shows a specific document, which may differ from the main pane. |

Events: `FOLLOW`, `PIN`, `CLOSE`.

Context: `documentId`, `follows`, `focused`.

Invariant: `companion-has-document`.

The sync-scroll control is only offered in `following`/`pinned` when both panes
show the same document; the machine records the pane relationship that the
control depends on.

### `preview` — `ui/machines.js`, authoritative in `ui/editor.js`

| State | Meaning |
| --- | --- |
| `idle` | No document or the editor is torn down. |
| `mounting` | Loading the editor bundle, checking native limits, or creating the editor. |
| `ready` | Formatted editor is mounted. |
| `fallback` | Document exceeds an editor budget; complete Markdown is shown read-only. |
| `error` | The editor bundle or editor construction failed; Markdown remains readable. |

Events: `MOUNT`, `READY`, `FALLBACK`, `FAIL`, `IDLE`.

Context: `documentId`, `reason` (for fallback/error).

### `menu` — `ui/machines.js`, observed from the DOM and announced by `setupMenu`

| State | Meaning |
| --- | --- |
| `closed` | No top-level menu is visible. |
| `open` | Exactly one top-level menu is visible; `active` names it. |

Events: `OPEN`, `SUBMENU`, `CLOSE`. `context.submenu` tracks the Open Recent
flyout. The native hidden attribute remains the rendering source; the machine
is the shared name for "which menu is open" and records focus/pointer opens.

Invariant: `menu-single-open` — nested submenus are allowed, sibling top-level
menus are not.

### `modals` — `ui/machines.js`, observed from native `<dialog open>`

| State | Meaning |
| --- | --- |
| `idle` | No native dialog is open. |
| `open` | One or more dialogs are open; `context.stack` is the open dialog id stack. |

The stack is updated from the dialog `toggle` event and the `open` attribute.
This is the authoritative answer for "is a modal in front of the app?" and is
used by tests and the inspector. Invariant: `modal-stack-unique`.

### `save` — `ui/machines.js`, projected from the existing per-document status

| State | Meaning |
| --- | --- |
| `clean` | Active document has no unsaved changes. |
| `dirty` | Active document has unsaved changes. |
| `saving` | A save is in flight. |
| `error` | The last save failed; `context.error` carries the message. |
| `paused` | Automatic saving stopped after an external change. |

This is currently a projection because background saves already carry their
own `doc.saveStatus` and `doc.view.saveStatus`. The projection gives the save
indicator, inspector and invariants one vocabulary while the storage migration
is completed.

Invariants: `save-clean-is-not-dirty`, `save-error-has-message`.

## Inventory of implicit machines not yet promoted

These are real machines today, expressed in variables, DOM state and timers.
They are listed with the owner and the event vocabulary they imply. Promote
them one at a time, starting with the ones that can lose data or strand focus.

| Machine | Owner | Current representation | States / events to name |
| --- | --- | --- | --- |
| Document session | `ui/app.js`, `ui/workspace.js` | `current`, `documents`, `closedDocuments`, `busy`, `queue`, `transitionLocked`, `doc.closing`, `doc.transferring` | `empty`, `opening`, `active`, `replacing`, `closing`, `transferred`, `failed`; `OPEN`, `OPENED`, `REPLACE`, `CLOSE`, `TRANSFER`, `FAIL` |
| Document transition queue | `ui/app.js` | `busy`, `queue`, `nativePickActive`, `documentSaves` | `idle`, `queued`, `running`, `failed`; `ENQUEUE`, `START`, `FINISH`, `FAIL` |
| Workspace tabs | `ui/workspace.js` | `documents` Map, `closedDocuments`, `renderedTabs`, `tabDrag`, `suppressTabClick` | `idle`, `pending-drag`, `dragging`, `drop-beside`, `finishing`, `canceled`; `PRESS`, `DRAG`, `DROP`, `CANCEL` |
| Window transfer | `ui/panes.js` | `workspaceWindowLabel`, `doc.transferring`, `mountTransferredDocument`, `finish_window_transfer` | `source`, `sending`, `sent`, `receiving`, `mounted`, `failed`; `TRANSFER`, `ACK`, `MOUNT`, `FAIL` |
| Window close review | `ui/workspace.js` | `requestClose`, `reviewWindowClose`, `busy`, `transitionLocked` | `idle`, `reviewing`, `saving`, `closing`, `canceled`; `REQUEST`, `REVIEW`, `SAVE`, `CONFIRM`, `CANCEL` |
| Confirm prompts | `ui/app.js` | `confirmQueue`, `#confirm-dialog` | `idle`, `asking`, `queued`; `ASK`, `ANSWER`, `CANCEL` |
| Dock | `ui/app.js` | `dockTab`, `dockVisible`, `dockAutoClosed`, `outlineVisible`, `folderVisible` | `hidden`, `outline`, `files`, `search`; `OPEN`, `SWITCH`, `CLOSE`, `VIEWPORT_NARROW` |
| Outline | `ui/preview.js`, `ui/outline.js`, `ui/editor.js` | `outlineEntries`, `outlineActiveIndex`, `outlineCollapsed`, `outlineStateDocument`, `outlineFollowSuspended`, `outlineSuppressUntil` | `empty`, `ready`, `following`, `suppressed`; `BUILD`, `ACTIVATE`, `COLLAPSE`, `SUSPEND`, `RESUME` |
| File tree | `ui/file-tree.js`, `ui/app.js` | `activeFolder`, `folderEntries`, `expandedFolders`, `renderedFolder`, `treeMenuOrigin`, `treeNameForm` | `none`, `loading`, `loaded`, `limited`, `failed`, `renaming`, `moving`, `trashing`; `SCAN`, `LOAD`, `EXPAND`, `RENAME`, `MOVE`, `TRASH`, `FAIL` |
| Folder search | `ui/folder-search.js` | `grepEpoch`, `grepTimer`, `grepResultsFolder`, status text | `idle`, `typing`, `searching`, `results`, `empty`, `stale`, `failed`; `QUERY`, `SEARCH`, `RESULT`, `CLEAR` |
| Navigation history | `ui/chrome.js` | `documentNavigation`, `documentNavigationIndex`, `navigatingHistory` | `idle`, `navigating`; `RECORD`, `BACK`, `FORWARD`, `ARRIVE` |
| Command window | `ui/app.js` | `commandScope`, `commandRows`, `filteredRows`, `selectedCommand`, `#command-dialog.open` | `closed`, `commands`, `files`, `themes`, `documents`; `OPEN`, `SCOPE`, `FILTER`, `SELECT`, `RUN`, `CLOSE` |
| Selection toolbar | `ui/affordances.js` | `selectionOwner`, `selectionPoint`, `bubbleFrame`, `lastGroup`, `paintedTable` | `hidden`, `measuring`, `visible`, `editing`; `SELECT`, `COLLAPSE`, `SCROLL`, `HIDE` |
| Sidebar resize | `ui/app.js` | `otherWidth`, `dragLeft`, `pendingX`, `frame`, `appliedWidth`, divider `dragging` | `idle`, `dragging`, `committed`; `PRESS`, `MOVE`, `RELEASE`, `CANCEL` |
| Editor history | `ui/editor/entry.js` | `history`, `future`, `groupTime`, `groupSelection`, `sourceOnly`, `richStale` | `rich`, `source`, `grouped-typing`, `undoing`; `EDIT`, `CHECKPOINT`, `UNDO`, `REDO`, `SWITCH_SOURCE` |
| Image consent/cache | `ui/editor/entry.js` | `consent`, `imageCache`, `imageCount`, `imageBytes`, `cachedImageBytes`, `mediaEpoch` | `blocked`, `allowed`, `cached`, `expired`; `ALLOW`, `RESOLVE`, `REVOKE`, `EXPIRE` |
| Mermaid renderer | `ui/mermaid-renderer.js`, `ui/preview.js` | `renderSequence`, `active`, `activeToken`, `mermaidPending`, `mermaidBridgeListener` | `idle`, `requested`, `rendering`, `delivered`, `stale`, `canceled`; `REQUEST`, `RESULT`, `CANCEL`, `EXPIRE` |
| Recovery writer | `ui/recovery.js` | per-document `{ pending, running, quiet, maximum, retired }` | `idle`, `pending`, `running`, `retired`; `CHANGED`, `FLUSH`, `SAVED`, `DISCARD`, `FAIL` |
| Theme | `ui/theme.js` | `selectedTheme`, `omarchy`, `paletteFrame`, `paletteRetries`, `diagramThemeRevision`, `diagramRefreshTimer` | `system`, `omarchy`, named themes, `retro-terminal`; `SELECT`, `PALETTE`, `SYSTEM_CHANGE`, `DIAGRAM_REFRESH` |
| Lab extras | `ui/lab.js` | `labExtensions` Map with `cleanup`, preferences, guide paragraph/frame/timers | `disabled`, `enabled`, `active`; `ENABLE`, `DISABLE`, `ACTIVATE`, `DEACTIVATE` |
| Reading guide | `ui/lab.js` | `guideParagraph`, `guideFrame`, `guideProgrammaticScroll`, `guideFollowScroll` | `off`, `waiting`, `following`, `navigating`; `ENABLE`, `RENDER`, `SCROLL`, `NEXT`, `PREV`, `DISABLE` |
| Diagram viewer | `ui/diagram-viewer.js` | `dialog.open`, `origin`, `returnFocus`, `drawing`, `size`, `scale`, `fitting`, `viewerKind`, `backdropPress` | `closed`, `opening`, `open-fit`, `open-manual`, `closing`; `OPEN`, `FIT`, `ZOOM`, `RESIZE`, `CLOSE` |
| File picker | `ui/app.js` | `pickerListing`, `pickerSelection`, `nativePickActive`, `#open-dialog.open` | `closed`, `browsing`, `selected`, `native`, `failed`; `BROWSE`, `SELECT`, `CONFIRM`, `CANCEL` |
| Drag/drop overlay | `ui/app.js` | `#drop-overlay.hidden`, image/other path split | `hidden`, `over`, `drop`, `adding`; `ENTER`, `OVER`, `DROP`, `LEAVE` |
| Preferences panel | `ui/chrome.js` | `#view-menu.hidden`, `preferenceFrame`, `preferenceThemeFrame` | `closed`, `open`, `previewing`; `OPEN`, `INPUT`, `COMMIT`, `RESET`, `CLOSE` |
| Focus mode | `ui/app.js` | `body.focus-mode` | `off`, `on`; `TOGGLE`, `ESCAPE` |
| Toast / status | `ui/app.js` | `toastTimer`, `#toast.hidden`, `#app-status` | `idle`, `visible`; `SHOW`, `EXPIRE`, `CLEAR` |

## Migration rules

1. **One owner.** A machine is defined next to the module that owns the
   behavior, or in `ui/machines.js` when several modules share it.
2. **Effects stay in the owner.** Machines decide *whether* and *which* state;
   the owning module still renders and performs IPC.
3. **Keep a compatibility bridge while migrating.** Existing variables may
   remain as mirrors. Reconcile them at the public entry point (`sync…`) and
   record `SYNC:<reason>` so the snapshot stays honest.
4. **Name the user event, not the assignment.** Prefer `SAVE`, `CONFIRM`,
   `CANCEL`, `OPEN_BESIDE` over `SET_TRUE` or `TOGGLE_FLAG`.
5. **Add an invariant before adding a guard.** An invariant documents an
   assumption the rest of the code already makes; a guard prevents a transition
   the user should not be able to request.
6. **Test the rejected path.** Every new machine needs at least one test that an
   illegal event leaves state unchanged and records a violation.
7. **Do not put content in context.** Store document ids and small flags. Large
   buffers, DOM nodes and editor instances belong to their existing owners.

## Next migrations, in order

1. **Document session + transition queue.** This is the highest data-safety
   value: one state name for "opening/replacing/closing" instead of four
   booleans, and one place for the `busy`/`queue` contract.
2. **Confirm prompts + modals.** The dialog stack is already observed; the
   remaining work is to make `ask()` a machine so queued prompts cannot replace
   the actions of the prompt being answered.
3. **Dock + outline.** Both are view projections with focus and suppression
   windows; naming them removes the "stale outline after tab switch" class of
   bugs.
4. **File tree + folder search.** These share a folder epoch and have clear
   loading/limited/failed states.
5. **Recovery writer + window transfer.** These are the remaining paths where
   an asynchronous failure can strand ownership.
6. **Theme + lab extras.** Lower risk, but they benefit from the same
   enable/disable/active vocabulary and make the inspector complete.
