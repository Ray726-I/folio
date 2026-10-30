/**
 * Fast path for plain text edits on a source-backed rich model.
 *
 * `tryTextEdits` accepts a model produced by `parseSource`/`updateSource`, a
 * sequence of ProseMirror transactions (or bare steps) whose only effective
 * changes are text replacements, and the document the rich editor ended up
 * with.  It translates each replacement through the exact source ledger,
 * patches only the verified source interval, reparses, and requires the
 * reparsed document to be identical to the ProseMirror result.
 *
 * Anything ambiguous returns `null`: the caller then keeps the existing
 * source-preserving serializer path.  This module never searches for text,
 * matches blocks by equality, rebuilds source from serialized blocks, or
 * mutates its inputs.
 */
import { buildLedger, mapSource, mapRich, applySourcePatches } from './source-ledger.js';
import { parseSource } from './model.js';

const TEXTBLOCK_TYPES = new Set(['paragraph', 'heading', 'code_block']);

function stepsFrom(transactions) {
  const list = Array.isArray(transactions) ? transactions : (transactions ? [transactions] : null);
  if (!list) return null;
  const steps = [];
  for (const transaction of list) {
    if (!transaction) return null;
    if (typeof transaction.apply === 'function') steps.push(transaction);
    else if (Array.isArray(transaction.steps)) steps.push(...transaction.steps);
    else return null;
  }
  return steps;
}

function textSlice(json) {
  // Deletions omit `slice` entirely.  Only slices made exclusively of text
  // nodes are in scope; nodes, marks commands and structural table edits are
  // left to the existing serializer path.
  if (json.slice === undefined) return '';
  const slice = json.slice;
  if (!slice || slice.openStart || slice.openEnd || !Array.isArray(slice.content)) return null;
  let text = '';
  for (const node of slice.content) {
    if (!node || node.type !== 'text' || typeof node.text !== 'string') return null;
    text += node.text;
  }
  return text;
}

function exactEndpoint(ledger, position, bias, expected) {
  const mapped = mapRich(ledger, position, { bias });
  if (!mapped.exact || mapped.confidence !== 'exact' || !mapped.owner) return null;
  if (mapped.owner.confidence !== 'exact' || mapped.owner.supported === false) return null;
  if (!TEXTBLOCK_TYPES.has(mapped.owner.type)) return null;
  const back = mapSource(ledger, mapped.source, { bias });
  if (!back.exact || back.confidence !== 'exact' || back.pm !== expected) return null;
  return mapped;
}

function sourcePatchFor(ledger, step) {
  if (!Number.isInteger(step.from) || !Number.isInteger(step.to) || step.from < 0 || step.to < step.from) return null;
  const collapsed = step.from === step.to;
  // Right affinity at an insertion point/start keeps typing after an opening
  // delimiter inside the marked run.  Left affinity at a deletion end stops
  // before the closing delimiter, leaving the syntax intact.
  const start = exactEndpoint(ledger, step.from, 'right', step.from);
  if (!start) return null;
  const end = collapsed ? start : exactEndpoint(ledger, step.to, 'left', step.to);
  if (!end) return null;
  if (start.owner.id !== end.owner.id) return null;
  const from = start.source;
  const to = collapsed ? from : end.source;
  // A collapsed endpoint is mapped once, so it can never become reversed; a
  // non-collapsed interval that maps backwards is ambiguous, not adjustable.
  if (from > to) return null;
  return { from, to, ownerId: start.owner.id };
}

// The final ledger was built against the freshly parsed document.  The caller
// needs it against the actual intended document so later source-preserving
// updates can use node identity, so rebase verified owners by PM position.
// `ledger` here is always our own fresh parse, never the caller's object.
function rebaseLedger(ledger, doc) {
  if (!ledger) return null;
  for (const owner of ledger.owners) {
    const node = doc.nodeAt(owner.pmFrom);
    if (!node || node.type !== owner.node.type || node.nodeSize !== owner.node.nodeSize || !node.eq(owner.node)) return null;
    owner.node = node;
  }
  ledger.doc = doc;
  return ledger;
}

export function tryTextEdits(previousModel, transactions, intendedDoc) {
  if (!previousModel || typeof previousModel.source !== 'string' || !previousModel.doc) return null;
  if (!intendedDoc || typeof intendedDoc.eq !== 'function') return null;
  const steps = stepsFrom(transactions);
  if (!steps) return null;

  let doc = previousModel.doc;
  let source = previousModel.source;
  let ledger = previousModel.ledger || buildLedger(source, doc);
  let lastParsed = null;

  for (const step of steps) {
    const applied = step.apply(doc);
    if (applied.failed) return null;
    // Selection/bookkeeping steps and replacements that leave the document
    // unchanged carry no source edit.
    if (applied.doc.eq(doc)) continue;

    const json = typeof step.toJSON === 'function' ? step.toJSON() : null;
    if (!json || json.stepType !== 'replace' || json.structure) return null;
    const insert = textSlice(json);
    if (insert === null) return null;
    const patch = sourcePatchFor(ledger, step);
    if (!patch) return null;

    let patched;
    try {
      patched = applySourcePatches(ledger, [{
        from: patch.from,
        to: patch.to,
        insert,
        expected: source.slice(patch.from, patch.to),
        ownerId: patch.ownerId
      }]);
    } catch {
      return null;
    }

    let parsed;
    try { parsed = parseSource(patched.source); } catch { return null; }
    if (!parsed.doc.eq(applied.doc)) return null;

    doc = applied.doc;
    source = patched.source;
    ledger = parsed.ledger || buildLedger(source, doc);
    lastParsed = parsed;
  }

  if (!doc.eq(intendedDoc)) return null;
  let final = lastParsed;
  if (!final || final.source !== source || !final.doc.eq(intendedDoc)) {
    try { final = parseSource(source); } catch { return null; }
  }
  if (!final.doc.eq(intendedDoc) || final.segments.length !== intendedDoc.childCount) return null;

  const segments = [];
  for (let index = 0; index < final.segments.length; index++) {
    const segment = final.segments[index];
    const node = intendedDoc.child(index);
    if (!segment.node || !node.eq(segment.node)) return null;
    segments.push({ ...segment, node });
  }

  let finalLedger = rebaseLedger(final.ledger, intendedDoc);
  if (!finalLedger) {
    try { finalLedger = buildLedger(source, intendedDoc); } catch { return null; }
  }
  if (!finalLedger) return null;

  return {
    doc: intendedDoc,
    source,
    prefix: final.prefix,
    segments,
    gaps: final.gaps,
    ledger: finalLedger
  };
}
