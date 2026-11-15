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
// Debug counters used by the benchmark/regression tests; harmless in production.
export const editDebug = { reason: '', full: 0, local: 0, incremental: 0 };
function fail(reason) { editDebug.reason = reason; return null; }

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

function insertionEndpoint(ledger, position, bias) {
  const exact = exactEndpoint(ledger, position, bias, position);
  if (exact) return exact;
  // Caret at the very end/start of a textblock is often reported as a "gap":
  // the position is between the text run and the block's syntax or neighbor.
  // Typing there still belongs at the verified text edge, not in the gap.
  const mapped = mapRich(ledger, position, { bias });
  const owner = mapped.owner;
  if (!owner || owner.confidence !== 'exact' || owner.supported === false) return null;
  if (!TEXTBLOCK_TYPES.has(owner.type)) return null;
  if (position === owner.pmTo) return { ...mapped, source: owner.sourceTo, owner };
  if (position === owner.pmFrom) return { ...mapped, source: owner.sourceFrom, owner };
  return null;
}

function sourcePatchFor(ledger, step, insertionBias = 'right') {
  if (!Number.isInteger(step.from) || !Number.isInteger(step.to) || step.from < 0 || step.to < step.from) return null;
  const collapsed = step.from === step.to;
  // Right affinity at an insertion point/start keeps typing after an opening
  // delimiter inside the marked run.  Left affinity at a deletion end stops
  // before the closing delimiter, leaving the syntax intact.
  const start = collapsed
    ? insertionEndpoint(ledger, step.from, insertionBias)
    : exactEndpoint(ledger, step.from, 'right', step.from);
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
  if (editedRun < 0) return fail('run-not-found');
  // A zero-length run (an empty paragraph) has no character to be "inside"; its
  // source anchor needs the block separators rebuilt, which the splice does not
  // do. Fall back for those.
  if (ledger.runs[editedRun].text.length === 0) return fail('empty-run');
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
        charMap: run.charMap ? run.charMap.map(char => ({ from: char.from + sourceDelta, to: char.to + sourceDelta })) : run.charMap });
      continue;
    }
    return fail('run-overlap');
  }
  // Only nodes in the edited top-level block can have new identity. Owners in
  // every other block keep the same immutable node, so rebuilding a document-
  // wide position map on every keystroke is wasted work.
  let edited = -1;
  let segmentPmFrom = 0;
  for (let index = 0; index < segments.length; index++) {
    const segmentPmTo = segmentPmFrom + segments[index].node.nodeSize;
    if (ledger.runs[editedRun].pmFrom >= segmentPmFrom && ledger.runs[editedRun].pmFrom < segmentPmTo &&
        segments[index].from <= patch.from && segments[index].to >= patch.to) { edited = index; break; }
    segmentPmFrom = segmentPmTo;
  }
  if (edited < 0 || segments.length !== intendedDoc.childCount) return fail('edited-segment');
  let editedPmFrom = 0;
  for (let index = 0; index < edited; index++) editedPmFrom += segments[index].node.nodeSize;
  const editedNode = intendedDoc.child(edited);
  const editedOldEnd = editedPmFrom + previous.doc.child(edited).nodeSize;
  const nodes = new Map();
  editedNode.descendants((node, position) => { if (!node.isText) nodes.set(editedPmFrom + 1 + position, node); });
  nodes.set(editedPmFrom, editedNode);
  const owners = [];
  for (const owner of ledger.owners) {
    const inEdited = owner.pmFrom >= editedPmFrom && owner.pmFrom < editedOldEnd;
    if (!inEdited && owner.pmTo < step.to) {
      owners.push(owner);
      continue;
    }
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
      // A node that ends exactly at a collapsed insertion point sits before
      // the new text, not around it. Shifting its end would make an atom
      // (raw inline, soft break) claim the inserted byte.
      if (!(step.from === step.to && owner.pmTo === step.to && owner.pmFrom < step.from)) {
        shifted.pmTo = owner.pmTo + pmDelta;
        shifted.sourceTo = owner.sourceTo + sourceDelta;
        if (Number.isInteger(owner.pmContentTo) && owner.pmContentTo >= step.to) shifted.pmContentTo = owner.pmContentTo + pmDelta;
        if (Number.isInteger(owner.contentTo) && owner.contentTo >= patch.to) shifted.contentTo = owner.contentTo + sourceDelta;
      }
    }
    shifted.node = inEdited ? nodes.get(shifted.pmFrom) : owner.node;
    if (!shifted.node || shifted.node.type.name !== owner.type) return fail(`owner-node:${owner.type}:${shifted.pmFrom}:${editedPmFrom}:${editedNode.nodeSize}`);
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
      const { exactOwners, partialOwners, unmappedOwners } = ledger.metadata;
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
  editDebug.reason = '';
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
    if (!patch) { editDebug.reason = 'no-patch'; continue; }
    const next = localTextEdit(previousModel, step, patch, insert, intendedDoc);
    if (next) { editDebug.incremental++; return next; }
  }
  return null;
}

function localTextEdit(previousModel, step, patch, insert, intendedDoc = null) {
  const ledger = previousModel.ledger;
  const owner = ledger.ownerById.get(patch.ownerId);
  if (!owner) return fail('no-owner');
  const segments = previousModel.segments || [];
  // The owner may be a paragraph nested in a list item, table cell or quote.
  // Find the enclosing top-level block and validate only its source slice.
  const index = segments.findIndex(segment => owner.sourceFrom >= segment.from && owner.sourceTo <= segment.to);
  if (index < 0 || segments.length !== (intendedDoc || previousModel.doc).childCount) return fail('no-segment');
  const segment = segments[index];
  const segmentNode = previousModel.doc.child(index);
  const segmentPmFrom = segments.slice(0, index).reduce((sum, item) => sum + (item.node?.nodeSize || 0), 0);
  // Partial mappings in other top-level blocks are safe to rebase, but an
  // uncertain range touching the edited block must retain full validation.
  if (ledger.unmapped.some(range => range.sourceFrom < owner.sourceTo && range.sourceTo > owner.sourceFrom ||
      range.pmFrom < owner.pmTo && range.pmTo > owner.pmFrom)) return fail('unmapped-overlap');
  const ownerRaw = previousModel.source.slice(owner.sourceFrom, owner.sourceTo);
  const body = ownerRaw.replace(/[\r\n]+$/, '');
  // Brackets can depend on definitions anywhere in the document. HTML and
  // backslash escapes can depend on surrounding parser context. Code blocks
  // are literal text and skip the lexical probe; their slice parse decides.
  if (previousModel.syntaxFacts?.hasReferences !== false && /[\[\]]/.test(body + insert)) return fail('references');
  if (/[\r\n]/.test(previousModel.source.slice(patch.from, patch.to))) return fail('patch-newline');
  const raw = segment.raw.slice(0, patch.from - segment.from) + insert + segment.raw.slice(patch.to - segment.from);
  // This lexical subset cannot introduce Markdown syntax or linkification.
  // Keep long plain paragraphs cheap without trusting arbitrary word edits
  // beside punctuation (which can complete a URL, escape or delimiter).
  const plain = /^\p{L}(?:[\p{L}\p{N} \t]*[\p{L}\p{N}])?[.!?]?$/u;
  const nextBody = raw.replace(/[\r\n]+$/, '');
  if (owner.node === segmentNode && owner.type === 'paragraph' && plain.test(body) && plain.test(nextBody) &&
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
  try { local = parseSource(raw); } catch { return fail('local-parse-throw'); }
  if (local.doc.childCount !== 1) return fail('local-block-count');
  if (intendedDoc && !local.doc.firstChild.eq(intendedDoc.child(index))) return fail('local-doc-mismatch');
  if (!intendedDoc) intendedDoc = previousModel.doc.copy(previousModel.doc.content.replaceChild(index, local.doc.firstChild));
  const next = shiftModel(previousModel, step, patch, insert, intendedDoc);
  if (!next) { if (!editDebug.reason) editDebug.reason = 'shift-model'; return null; }
  // A splice may preserve the rich document yet change the number/boundaries
  // of ledger runs (entities, merged marked runs, soft breaks, etc.). Keep the
  // cheap shift only if the freshly parsed owner proves those exact
  // associations too. Offsets are compared against the containing segment
  // because the local parse starts at zero.
  const localOwner = local.ledger.owners.find(item => item.type === owner.type && item.pmFrom === owner.pmFrom - segmentPmFrom);
  if (!localOwner) return fail('no-local-owner');
  const shiftedRuns = next.ledger.runs.filter(run => run.ownerId === owner.id);
  const localRuns = local.ledger.runs.filter(run => run.ownerId === localOwner.id);
  if (shiftedRuns.length !== localRuns.length) return fail('run-count');
  for (let i = 0; i < shiftedRuns.length; i++) {
    const actual = shiftedRuns[i], expected = localRuns[i];
    if (actual.kind !== expected.kind || actual.text !== expected.text ||
        actual.pmFrom - segmentPmFrom !== expected.pmFrom || actual.pmTo - segmentPmFrom !== expected.pmTo ||
        actual.sourceFrom - segment.from !== expected.sourceFrom || actual.sourceTo - segment.from !== expected.sourceTo) return fail('run-mismatch');
  }
  editDebug.local++;
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

  editDebug.full++;
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

// A source card is one literal raw_block, even when it projects several parsed
// Markdown blocks. Parse it with both neighboring blocks and their separators:
// unchanged neighbors and exact projected boundaries prove syntax stays inside
// the card. Definitions have document-wide scope and retain the full parser.
export function trySourceCardEdit(previousModel, edit) {
  const { sourceEdit, ledger, segments, source } = previousModel || {};
  if (!sourceEdit || !ledger || ledger.errors.length || !Array.isArray(segments) ||
      previousModel.syntaxFacts?.hasReferences !== false || !edit ||
      !Number.isInteger(edit.from) || !Number.isInteger(edit.to) || typeof edit.insert !== 'string' ||
      edit.from < sourceEdit.from || edit.to > sourceEdit.to || edit.from > edit.to) return null;
  const index = segments.findIndex(segment => segment.from === sourceEdit.from && segment.to === sourceEdit.to &&
    segment.node.type.name === 'raw_block' && segment.node.attrs.kind === 'source-edit');
  if (index < 0 || segments.length !== previousModel.doc.childCount) return null;
  const segment = segments[index];
  const owner = ledger.owners.find(item => item.node === segment.node && item.type === 'raw_block');
  if (!owner || owner.confidence !== 'exact' || edit.from < owner.contentFrom || edit.to > owner.contentTo) return null;
  // Display-math rules scan ahead across otherwise independent blocks. A new
  // closer can activate a distant unmatched opener, or an opener can consume a
  // distant closer. Probe entire affected lines, so deletions/joins that expose
  // a delimiter are caught too; ordinary edits inside math bodies stay local.
  const lineFrom = edit.from === 0 ? 0 : source.lastIndexOf('\n', edit.from - 1) + 1;
  const newline = source.indexOf('\n', edit.to);
  const lineTo = newline < 0 ? source.length : newline;
  const affected = source.slice(lineFrom, edit.from) + edit.insert + source.slice(edit.to, lineTo);
  const before = source.slice(lineFrom, lineTo);
  const displayMath = /\$\$|\\\[|\\\]/;
  if (displayMath.test(before) || displayMath.test(affected)) return null;
  // Frontmatter uses the same unbounded lookahead from the first line. This
  // also catches a delimiter exposed by deleting text or joining lines.
  if ([before, affected].some(text => text.split('\n').some(line => line.trim() === '---'))) return null;
  const first = Math.max(0, index - 1), last = Math.min(segments.length - 1, index + 1);
  const windowFrom = first === 0 ? 0 : segments[first].from;
  const windowTo = last === segments.length - 1 ? source.length : segments[last + 1].from;
  // An unmatched opening frontmatter delimiter at the document start can be
  // closed by an edit arbitrarily far away, before our preceding neighbor.
  if (windowFrom && source.slice(0, source.indexOf('\n') < 0 ? source.length : source.indexOf('\n')).trim() === '---') return null;
  const delta = edit.insert.length - (edit.to - edit.from);
  const raw = source.slice(windowFrom, edit.from) + edit.insert + source.slice(edit.to, windowTo);
  const projected = { from: sourceEdit.from - windowFrom, to: sourceEdit.to - windowFrom + delta };
  let local;
  try { local = parseSource(raw, projected); } catch { return null; }
  if (local.syntaxFacts.hasReferences || local.sourceEdit?.from !== projected.from || local.sourceEdit?.to !== projected.to ||
      local.segments.length !== last - first + 1) return null;
  for (let i = first; i <= last; i++) {
    const actual = local.segments[i - first], expected = segments[i];
    if (actual.from !== expected.from - windowFrom + (i > index ? delta : 0) ||
        actual.to !== expected.to - windowFrom + (i >= index ? delta : 0) ||
        (i !== index && !actual.node.eq(expected.node))) return null;
  }
  const node = local.doc.child(index - first);
  const expectedText = segment.node.textContent.slice(0, edit.from - segment.from) + edit.insert +
    segment.node.textContent.slice(edit.to - segment.from);
  if (node.type !== segment.node.type || node.attrs.kind !== 'source-edit' || node.textContent !== expectedText) return null;
  const doc = previousModel.doc.copy(previousModel.doc.content.replaceChild(index, node));
  const step = { from: owner.pmContentFrom + edit.from - owner.contentFrom, to: owner.pmContentFrom + edit.to - owner.contentFrom };
  const next = shiftModel(previousModel, step, edit, edit.insert, doc);
  if (!next) return null;
  editDebug.local++;
  editDebug.incremental++;
  return { ...next, sourceEdit: { from: sourceEdit.from, to: sourceEdit.to + delta } };
}
