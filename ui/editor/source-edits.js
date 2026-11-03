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

function sourcePatchFor(ledger, step, insertionBias = 'right') {
  if (!Number.isInteger(step.from) || !Number.isInteger(step.to) || step.from < 0 || step.to < step.from) return null;
  const collapsed = step.from === step.to;
  // Right affinity at an insertion point/start keeps typing after an opening
  // delimiter inside the marked run.  Left affinity at a deletion end stops
  // before the closing delimiter, leaving the syntax intact.
  const start = exactEndpoint(ledger, step.from, collapsed ? insertionBias : 'right', step.from);
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
function nodesByPosition(doc) {
  const nodes = new Map();
  doc.descendants((node, position) => { if (!node.isText) nodes.set(position, node); });
  return nodes;
}

function rebaseLedger(ledger, doc) {
  if (!ledger) return null;
  const nodes = nodesByPosition(doc);
  for (const owner of ledger.owners) {
    const node = nodes.get(owner.pmFrom);
    if (!node || node.type !== owner.node.type || node.nodeSize !== owner.node.nodeSize || !node.eq(owner.node)) return null;
    owner.node = node;
  }
  ledger.doc = doc;
  return ledger;
}

// Rebuild the derived structures for a single in-run text edit without
// re-parsing. Returns null whenever any invariant cannot be re-established,
// which sends the caller down the full-parse path.
function shiftModel(previous, step, patch, insert, intendedDoc) {
  const { ledger, segments, gaps, prefix } = previous;
  const sourceDelta = insert.length - (patch.to - patch.from);
  const pmDelta = insert.length - (step.to - step.from);
  // Pick the edited run by the *verified* source offset, not by position alone:
  // an insertion at a run boundary belongs to whichever run maps to the patch,
  // and adjacent runs both contain the position.
  let editedRun = -1;
  for (let index = 0; index < ledger.runs.length; index++) {
    const candidate = ledger.runs[index];
    if (!candidate.linear || candidate.kind !== 'text') continue;
    if (candidate.pmFrom > step.from || candidate.pmTo < step.to) continue;
    if (candidate.sourceTo - candidate.sourceFrom !== candidate.text.length) continue;
    if (candidate.sourceFrom + (step.from - candidate.pmFrom) !== patch.from) continue;
    editedRun = index; break;
  }
  if (editedRun < 0) return null;
  // A zero-length run (an empty paragraph) has no character to be "inside"; its
  // source anchor needs the block separators rebuilt, which the splice does not
  // do. Fall back for those.
  if (ledger.runs[editedRun].text.length === 0) return null;
  const runs = [];
  for (let index = 0; index < ledger.runs.length; index++) {
    const run = ledger.runs[index];
    if (index === editedRun) {
      const localStart = step.from - run.pmFrom;
      const localEnd = step.to - run.pmFrom;
      runs.push({ ...run,
        text: run.text.slice(0, localStart) + insert + run.text.slice(localEnd),
        pmTo: run.pmTo + pmDelta, sourceTo: run.sourceTo + sourceDelta });
      continue;
    }
    if (run.pmTo <= step.from) { runs.push(run); continue; }
    if (run.pmFrom >= step.to) {
      runs.push({ ...run,
        pmFrom: run.pmFrom + pmDelta, pmTo: run.pmTo + pmDelta,
        sourceFrom: run.sourceFrom + sourceDelta, sourceTo: run.sourceTo + sourceDelta,
        charMap: run.charMap?.map(char => ({ from: char.from + sourceDelta, to: char.to + sourceDelta })) || null });
      continue;
    }
    return null;
  }
  const owners = [];
  const nodes = nodesByPosition(intendedDoc);
  for (const owner of ledger.owners) {
    const shifted = { ...owner };
    if (owner.pmFrom >= step.to) {
      shifted.pmFrom = owner.pmFrom + pmDelta;
      shifted.pmTo = owner.pmTo + pmDelta;
      shifted.sourceFrom = owner.sourceFrom + sourceDelta;
      shifted.sourceTo = owner.sourceTo + sourceDelta;
      if (Number.isInteger(owner.pmContentFrom)) shifted.pmContentFrom = owner.pmContentFrom + pmDelta;
      if (Number.isInteger(owner.pmContentTo)) shifted.pmContentTo = owner.pmContentTo + pmDelta;
      if (Number.isInteger(owner.contentFrom)) shifted.contentFrom = owner.contentFrom + sourceDelta;
      if (Number.isInteger(owner.contentTo)) shifted.contentTo = owner.contentTo + sourceDelta;
    } else if (owner.pmTo >= step.to) {
      shifted.pmTo = owner.pmTo + pmDelta;
      shifted.sourceTo = owner.sourceTo + sourceDelta;
      if (Number.isInteger(owner.pmContentTo) && owner.pmContentTo >= step.to) shifted.pmContentTo = owner.pmContentTo + pmDelta;
      if (Number.isInteger(owner.contentTo) && owner.contentTo >= patch.to) shifted.contentTo = owner.contentTo + sourceDelta;
    }
    shifted.node = nodes.get(shifted.pmFrom);
    if (!shifted.node || shifted.node.type.name !== owner.type) return null;
    owners.push(shifted);
  }
  const ledgerGaps = ledger.gaps.map(gap => gap.sourceFrom >= patch.to
    ? { ...gap, sourceFrom: gap.sourceFrom + sourceDelta, sourceTo: gap.sourceTo + sourceDelta }
    : gap);
  const ledgerNext = {
    ...ledger,
    source: previous.source.slice(0, patch.from) + insert + previous.source.slice(patch.to),
    doc: intendedDoc,
    owners,
    ownerById: new Map(owners.map(owner => [owner.id, owner])),
    runs,
    gaps: ledgerGaps,
    unmapped: ledger.unmapped.map(range => range.sourceFrom >= patch.to && range.pmFrom >= step.to
      ? { ...range, sourceFrom: range.sourceFrom + sourceDelta, sourceTo: range.sourceTo + sourceDelta,
          pmFrom: range.pmFrom + pmDelta, pmTo: range.pmTo + pmDelta }
      : range),
    metadata: (() => {
      const exactOwners = owners.filter(owner => owner.confidence === 'exact').length;
      const partialOwners = owners.filter(owner => owner.confidence === 'partial').length;
      const unmappedOwners = owners.filter(owner => owner.confidence === 'unmapped').length;
      let covered = 0;
      for (const run of runs) covered += Math.max(0, run.sourceTo - run.sourceFrom);
      const sourceLength = ledger.metadata.sourceLength + sourceDelta;
      return {
        ...ledger.metadata,
        sourceLength,
        docSize: intendedDoc.content.size,
        owners: owners.length,
        runs: runs.length,
        gaps: ledgerGaps.length,
        exactOwners,
        partialOwners,
        unmappedOwners,
        coverage: sourceLength ? covered / sourceLength : 1,
        complete: unmappedOwners === 0 && partialOwners === 0 && ledger.errors.length === 0,
        unsupported: unmappedOwners > 0,
        partial: partialOwners > 0,
      };
    })(),
  };
  // Segments: exactly one block changes, the rest shift.
  let edited = -1;
  for (let index = 0; index < segments.length; index++) {
    if (segments[index].from <= patch.from && segments[index].to >= patch.to) { edited = index; break; }
  }
  if (edited < 0 || segments.length !== intendedDoc.childCount) return null;
  const nextSegments = segments.map((segment, index) => {
    const node = intendedDoc.child(index);
    if (index === edited) {
      const to = segment.to + sourceDelta;
      return { node, from: segment.from, to, raw: ledgerNext.source.slice(segment.from, to) };
    }
    if (segment.from >= patch.to) {
      const from = segment.from + sourceDelta, to = segment.to + sourceDelta;
      return { node, from, to, raw: segment.raw };
    }
    return { ...segment, node };
  });
  return { doc: intendedDoc, source: ledgerNext.source, prefix, gaps, segments: nextSegments, ledger: ledgerNext, syntaxFacts: previous.syntaxFacts };
}

// A top-level paragraph/heading is independent when it has no reference or
// extension syntax, no embedded line boundaries and the edit changes neither
// source newlines nor surrounding blocks. Parse that exact slice (including its
// heading markers), so linkification and delimiter flanking are checked by the
// real parser, rather than guessed from an allowed-character regex.
function tryIncremental(previousModel, step, intendedDoc) {
  const ledger = previousModel?.ledger;
  if (!ledger || ledger.errors.length || !Array.isArray(previousModel.segments)) return null;
  const applied = step.apply(previousModel.doc);
  if (applied.failed || !applied.doc.eq(intendedDoc)) return null;
  const json = typeof step.toJSON === 'function' ? step.toJSON() : null;
  if (!json || json.stepType !== 'replace' || json.structure) return null;
  const insert = textSlice(json);
  if (insert === null || /[\r\n]/.test(insert)) return null;
  for (const bias of step.from === step.to ? ['right', 'left'] : ['right']) {
    const patch = sourcePatchFor(ledger, step, bias);
    if (!patch) continue;
    const next = localTextEdit(previousModel, step, patch, insert, intendedDoc);
    if (next) return next;
  }
  return null;
}

function localTextEdit(previousModel, step, patch, insert, intendedDoc = null) {
  const ledger = previousModel.ledger;
  const owner = ledger.ownerById.get(patch.ownerId);
  if (owner.type !== 'paragraph' && owner.type !== 'heading') return null;
  const index = previousModel.segments.findIndex(segment => segment.node === owner.node &&
    segment.from === owner.sourceFrom && segment.to === owner.sourceTo);
  if (index < 0 || previousModel.segments.length !== (intendedDoc || previousModel.doc).childCount) return null;
  const segment = previousModel.segments[index];
  // Partial mappings in other top-level blocks are safe to rebase, but an
  // uncertain range touching the edited block must retain full validation.
  if (ledger.unmapped.some(range => range.sourceFrom < segment.to && range.sourceTo > segment.from ||
      range.pmFrom < owner.pmTo && range.pmTo > owner.pmFrom)) return null;
  // Brackets can depend on definitions anywhere in the document. HTML and
  // extension delimiters can depend on surrounding parser context. Escaped
  // boundaries and multiline blocks retain the full-document validation path.
  const body = segment.raw.replace(/[\r\n]+$/, '');
  if (/[<>\\\r\n]/.test(body) || /[<>\\]/.test(insert)) return null;
  if (previousModel.syntaxFacts?.hasReferences !== false && /[\[\]]/.test(body + insert)) return null;
  if (/[\r\n]/.test(previousModel.source.slice(patch.from, patch.to))) return null;
  const raw = segment.raw.slice(0, patch.from - segment.from) + insert + segment.raw.slice(patch.to - segment.from);
  // This lexical subset cannot introduce Markdown syntax or linkification.
  // Keep long plain paragraphs cheap without trusting arbitrary word edits
  // beside punctuation (which can complete a URL, escape or delimiter).
  const plain = /^\p{L}(?:[\p{L}\p{N} \t]*[\p{L}\p{N}])?[.!?]?$/u;
  const nextBody = raw.replace(/[\r\n]+$/, '');
  if (owner.type === 'paragraph' && plain.test(body) && plain.test(nextBody) &&
      owner.node.childCount === 1 && owner.node.firstChild.isText && !owner.node.firstChild.marks.length &&
      owner.node.textContent === body) {
    const node = owner.node.type.create(owner.node.attrs, owner.node.type.schema.text(nextBody));
    const candidate = previousModel.doc.copy(previousModel.doc.content.replaceChild(index, node));
    if (!intendedDoc || candidate.eq(intendedDoc)) {
      const next = shiftModel(previousModel, step, patch, insert, intendedDoc || candidate);
      if (next) return next;
    }
  }
  let local;
  try { local = parseSource(raw); } catch { return null; }
  if (local.doc.childCount !== 1 || local.ledger.owners.length !== 1 ||
      !local.ledger.metadata.complete) return null;
  if (intendedDoc && !local.doc.firstChild.eq(intendedDoc.child(index))) return null;
  if (!intendedDoc) intendedDoc = previousModel.doc.copy(previousModel.doc.content.replaceChild(index, local.doc.firstChild));
  if (local.doc.firstChild.nodeSize - owner.node.nodeSize !== insert.length - (step.to - step.from)) return null;
  const next = shiftModel(previousModel, step, patch, insert, intendedDoc);
  if (!next) return null;
  // A splice may preserve the rich document yet change the number/boundaries
  // of ledger runs (entities, merged marked runs, etc.). Keep the cheap shift
  // only if the freshly parsed owner proves those exact associations too.
  const shiftedRuns = next.ledger.runs.filter(run => run.ownerId === owner.id);
  if (shiftedRuns.length !== local.ledger.runs.length) return null;
  for (let i = 0; i < shiftedRuns.length; i++) {
    const actual = shiftedRuns[i], expected = local.ledger.runs[i];
    if (!actual.linear || !expected.linear || actual.kind !== expected.kind || actual.text !== expected.text ||
        actual.pmFrom !== expected.pmFrom + owner.pmFrom || actual.pmTo !== expected.pmTo + owner.pmFrom ||
        actual.sourceFrom !== expected.sourceFrom + segment.from || actual.sourceTo !== expected.sourceTo + segment.from) return null;
  }
  return next;
}

export function tryTextEdits(previousModel, transactions, intendedDoc) {
  if (!previousModel || typeof previousModel.source !== 'string' || !previousModel.doc) return null;
  if (!intendedDoc || typeof intendedDoc.eq !== 'function') return null;
  const steps = stepsFrom(transactions);
  if (!steps) return null;
  // Ordinary word typing in an unambiguous text run avoids reparsing and
  // rebuilding the whole document ledger. Every other edit continues through
  // the validated parse-and-compare path below.
  if (steps.length === 1) {
    const incremental = tryIncremental(previousModel, steps[0], intendedDoc);
    if (incremental) return incremental;
  }

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
    ledger: finalLedger,
    syntaxFacts: final.syntaxFacts
  };
}

// Source-first keyboard edits enter here before building a full candidate.
// Syntax-changing/ambiguous patches return null for the canonical full parser.
export function trySourceEdit(previousModel, edit) {
  if (!previousModel?.ledger || previousModel.ledger.errors.length || !Array.isArray(previousModel.segments) ||
      !edit || !Number.isInteger(edit.from) || !Number.isInteger(edit.to) ||
      edit.from < 0 || edit.to < edit.from || edit.to > previousModel.source.length ||
      typeof edit.insert !== 'string' || /[\r\n]/.test(edit.insert)) return null;
  const { ledger } = previousModel;
  const start = mapSource(ledger, edit.from, { bias: 'right' });
  const end = edit.from === edit.to ? start : mapSource(ledger, edit.to, { bias: 'left' });
  if (!start.exact || !end.exact || start.pm > end.pm) return null;
  const step = { from: start.pm, to: end.pm };
  const patch = sourcePatchFor(ledger, step);
  if (!patch || patch.from !== edit.from || patch.to !== edit.to) return null;
  return localTextEdit(previousModel, step, patch, edit.insert);
}
