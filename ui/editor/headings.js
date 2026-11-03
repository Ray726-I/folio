// Heading identity belongs to a document's transaction history, never its label
// or a source offset (both change during ordinary typing).
export function headingFromRawBlock(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const prefix = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?/;
  const first = lines[0].replace(prefix, '');
  if (first.trimStart().startsWith('<')) return null;
  const atx = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+[ \t]*)?$/.exec(first);
  if (atx) return { level: atx[1].length, text: atx[2].trim() };
  const underline = lines[1] && /^[ \t]*(=+|-+)[ \t]*$/.exec(lines[1]);
  if (underline && first.trim()) return { level: underline[1][0] === '=' ? 1 : 2, text: first.trim() };
  return null;
}

export function createHeadingMetadata() {
  let nextId = 0, positions = new Map(), cachedModel = null, cached = null;
  const labels = new WeakMap();
  function reset() { positions.clear(); cachedModel = null; cached = null; }
  function map(transactions) {
    const mapped = new Map();
    const steps = transactions.flatMap(tr => tr.mapping.maps.map((mapping, index) => {
      const step = tr.steps[index];
      const preservesStart = step?.gapFrom === step?.from + 1 && step?.gapTo === step?.to - 1 && step?.insert === 1;
      return { mapping, preservesStart };
    }));
    for (const [start, entry] of positions) {
      let pos = start, deleted = false;
      for (const { mapping, preservesStart } of steps) {
        const result = mapping.mapResult(pos, 1);
        if (result.deletedAcross || (result.deletedAfter && !preservesStart)) { deleted = true; break; }
        pos = result.pos;
      }
      // Replaced/deleted starts must not lend their identity to a neighbour.
      if (!deleted && !mapped.has(pos)) mapped.set(pos, entry);
    }
    positions = mapped; cachedModel = null;
  }
  function splice(previous, next, edit) {
    const starts = new Map();
    for (const owner of previous.ledger?.owners || []) {
      const identity = positions.get(owner.pmFrom);
      if (!identity) continue;
      const start = owner.sourceFrom;
      // A splice crossing a heading start cannot establish identity. Starts
      // before an inline edit survive; following starts shift by its delta.
      if (start >= edit.from && start < edit.to) continue;
      const shifted = start >= edit.to ? start + edit.insert.length - (edit.to - edit.from) : start;
      starts.set(shifted, identity);
    }
    positions = new Map();
    for (const owner of next.ledger?.owners || []) {
      const identity = starts.get(owner.sourceFrom);
      if (identity?.type === owner.type) positions.set(owner.pmFrom, identity);
    }
    cachedModel = null;
  }
  function read(model) {
    if (cachedModel === model) return cached;
    if (!model.ledger) return null;
    const result = [], nextPositions = new Map();
    for (const owner of model.ledger?.owners || []) {
      if (owner.type !== 'heading' && owner.type !== 'raw_block') continue;
      const node = owner.node;
      if (!node || owner.confidence !== 'exact') { cachedModel = model; return cached = null; }
      let label = labels.get(node);
      if (label === undefined) {
        if (owner.type === 'raw_block') label = headingFromRawBlock(node.textContent);
        else {
          let semantic = '', supported = true;
          node.forEach(child => {
            if (child.isText) semantic += child.text;
            else if (child.type.name === 'math_inline') semantic += child.attrs.tex;
            else if (child.type.name === 'image') semantic += child.attrs.alt || '';
            else if (child.type.name === 'hard_break') semantic += ' ';
            else supported = false;
          });
          if (!supported) { cachedModel = model; return cached = null; }
          label = { level: node.attrs.level, text: semantic, semantic };
        }
        labels.set(node, label);
      }
      if (!label) continue;
      const previous = positions.get(owner.pmFrom);
      const identity = previous?.type === owner.type ? previous : { key: `heading-${++nextId}`, type: owner.type };
      nextPositions.set(owner.pmFrom, identity);
      const offset = owner.sourceFrom ? model.source.lastIndexOf('\n', owner.sourceFrom - 1) + 1 : 0;
      result.push({ ...label, offset, key: identity.key, ...(owner.type === 'raw_block' ? { raw: true } : {}) });
    }
    positions = nextPositions; cachedModel = model; cached = result;
    return result;
  }
  return { read, map, splice, reset };
}
