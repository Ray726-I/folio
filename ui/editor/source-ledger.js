/**
 * Source ledger: explicit source <-> rich-document position association.
 *
 * `buildLedger(source, doc)` records, for the exact Markdown string that was
 * parsed into `doc`:
 *
 *   - `owners`: every block/cell/atom that owns a source interval,
 *   - `runs`:   verified visible-text intervals (source interval <-> PM interval),
 *   - `gaps`:   source intervals occupied only by syntax/whitespace/references,
 *   - supported/unmapped metadata.
 *
 * Mapping is deliberately conservative.  A construct is either verified
 * structurally and by its visible string, or it is reported as unmapped.  No
 * lookup falls back to searching for token text, matching rich nodes by
 * equality, or rebuilding the source from serialized blocks.
 *
 * This module is an integration sidecar.  It does not edit the model, editors
 * or bundles; callers decide when to consult it.
 */
import { parser as lezerMarkdownParser, GFM } from '@lezer/markdown';
import { tokenizer as defaultTokenizer } from './model.js';

const lezerParser = lezerMarkdownParser.configure(GFM);

const TOP_LEVEL_TYPES = new Set([
  'Paragraph', 'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4',
  'ATXHeading5', 'ATXHeading6', 'SetextHeading1', 'SetextHeading2',
  'BulletList', 'OrderedList', 'ListItem', 'Blockquote', 'Table',
  'FencedCode', 'CodeBlock', 'HorizontalRule', 'HTMLBlock', 'LinkReference'
]);

// Nodes that only carry Markdown syntax and never visible text of their own.
const INLINE_SYNTAX = new Set([
  'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark', 'LinkTitle',
  'TaskMarker', 'QuoteMark', 'HeaderMark'
]);

function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

function tokenDocType(token) {
  switch (token.type) {
    case 'heading_open': return 'heading';
    case 'paragraph_open': return 'paragraph';
    case 'bullet_list_open': return 'bullet_list';
    case 'ordered_list_open': return 'ordered_list';
    case 'blockquote_open': return 'blockquote';
    case 'table_open': return 'table';
    case 'fence':
    case 'code_block': return 'code_block';
    case 'hr': return 'horizontal_rule';
    case 'math_block': return 'math_block';
    case 'raw_block':
    case 'html_block': return 'raw_block';
    default: return null;
  }
}

function plainTree(cursor) {
  const node = { name: cursor.name, from: cursor.from, to: cursor.to, children: [] };
  if (cursor.firstChild()) {
    do node.children.push(plainTree(cursor)); while (cursor.nextSibling());
    cursor.parent();
  }
  return node;
}

function lezerBlockMatches(type, node, pmNode) {
  switch (type) {
    case 'paragraph': return node.name === 'Paragraph';
    case 'heading': {
      const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
      return Boolean(match) && (!pmNode?.attrs?.level || Number(match[1]) === pmNode.attrs.level);
    }
    case 'bullet_list': return node.name === 'BulletList';
    case 'ordered_list': return node.name === 'OrderedList';
    case 'blockquote': return node.name === 'Blockquote';
    case 'table': return node.name === 'Table';
    case 'code_block': return node.name === 'FencedCode' || node.name === 'CodeBlock';
    case 'horizontal_rule': return node.name === 'HorizontalRule';
    default: return false;
  }
}

function markNames(marks) {
  return marks.map(mark => mark.type.name).sort();
}

function marksKey(names) {
  return [...names].sort().join(',');
}

function isWhitespace(text) {
  return /^[\s]*$/.test(text);
}

function trimSpace(source, from, to) {
  while (from < to && (source[from] === ' ' || source[from] === '\t')) from++;
  while (to > from && (source[to - 1] === ' ' || source[to - 1] === '\t')) to--;
  return { from, to };
}

function textLeaf(text, from, names) {
  // `source.slice(from, from + text.length)` is exactly this text, so the
  // mapping is linear by construction. Building a per-character object map
  // here cost ~70% of a 100 KB ledger build and was then discarded by
  // isLinear; the run carries `linear: true` instead.
  return {
    kind: 'text', text, sourceFrom: from, sourceTo: from + text.length,
    marks: names, marksKey: marksKey(names), charMap: null, linear: true
  };
}

function mappedLeaf(text, sourceFrom, sourceTo, names, charMap, extra = {}) {
  return {
    kind: 'text', text, sourceFrom, sourceTo, marks: names,
    marksKey: marksKey(names), charMap: charMap || null, ...extra
  };
}

function sliceLeaf(leaf, start, length) {
  if (leaf.kind !== 'text') return leaf;
  const text = leaf.text.slice(start, start + length);
  let charMap = null;
  if (leaf.charMap) {
    charMap = leaf.charMap.slice(start, start + length);
  }
  const sourceFrom = charMap?.length ? charMap[0].from : (start === 0 ? leaf.sourceFrom : leaf.sourceTo);
  const sourceTo = charMap?.length ? charMap[charMap.length - 1].to : (start + length === leaf.text.length ? leaf.sourceTo : sourceFrom);
  return { ...leaf, text, sourceFrom, sourceTo, charMap };
}

function isLinear(charMap, sourceFrom, sourceTo, length) {
  if (!charMap || charMap.length !== length || sourceTo - sourceFrom !== length) return false;
  for (let i = 0; i < charMap.length; i++) {
    if (charMap[i].from !== sourceFrom + i || charMap[i].to !== sourceFrom + i + 1) return false;
  }
  return true;
}

function headingContentRange(source, node) {
  let from = node.from, to = node.to;
  const marks = node.children.filter(child => child.name === 'HeaderMark');
  if (node.name.startsWith('ATX')) {
    const open = marks.find(mark => mark.from === node.from);
    if (open) from = open.to;
    const close = marks.find(mark => mark.from > from);
    if (close) to = close.from;
    while (from < to && (source[from] === ' ' || source[from] === '\t')) from++;
    while (to > from && (source[to - 1] === ' ' || source[to - 1] === '\t')) to--;
  } else {
    const underline = marks[marks.length - 1];
    if (underline) to = underline.from;
    while (to > from && /\s/.test(source[to - 1])) to--;
  }
  return { from, to };
}

function normaliseCode(raw) {
  const chars = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\r' && raw[i + 1] === '\n') { chars.push({ text: ' ', from: i, to: i + 2 }); i++; }
    else if (ch === '\n' || ch === '\r') chars.push({ text: ' ', from: i, to: i + 1 });
    else chars.push({ text: ch, from: i, to: i + 1 });
  }
  if (chars.length >= 2 && chars[0].text === ' ' && chars[chars.length - 1].text === ' ' && chars.some(char => char.text !== ' ')) {
    chars.shift(); chars.pop();
  }
  return chars;
}

function findMathClose(raw, open) {
  if (raw[open] !== '$' || raw[open + 1] === '$' || /\s/.test(raw[open + 1] || ' ')) return -1;
  let to = open + 1;
  for (; to < raw.length; to++) {
    if (raw[to] === '\\') { to++; continue; }
    if (raw[to] === '\n' || raw[to] === '\r') return -1;
    if (raw[to] === '$') break;
  }
  if (to >= raw.length || /\s/.test(raw[to - 1]) || /\d/.test(raw[to + 1] || '')) return -1;
  return to;
}

function unescapeAlt(text) {
  return text.replace(/\\([\\`*_[\]()#+.!<>~-])/g, '$1');
}

export function buildLedger(source, doc, options = {}) {
  if (typeof source !== 'string') throw new TypeError('buildLedger requires the exact Markdown source string');
  if (!doc || typeof doc.forEach !== 'function') throw new TypeError('buildLedger requires a ProseMirror document');
  const tokenizer = options.tokenizer || defaultTokenizer;
  const tree = plainTree(lezerParser.parse(source).cursor());
  const topLevel = tree.children.filter(node => TOP_LEVEL_TYPES.has(node.name));

  const owners = [], runs = [], hints = [], unmapped = [], errors = [];
  let nextOwnerId = 0;

  const ctx = {
    source, owners, runs, hints, unmapped, errors,
    addOwner(type, pmNode, pmFrom, sourceFrom, sourceTo, confidence = 'exact', reason = null) {
      const owner = {
        id: nextOwnerId++, type, node: pmNode,
        pmFrom, pmTo: pmFrom + pmNode.nodeSize,
        sourceFrom, sourceTo,
        confidence, supported: confidence !== 'unmapped', reason,
        contentFrom: null, contentTo: null, pmContentFrom: null, pmContentTo: null
      };
      // Owners are appended in document order and never inserted, so a
      // container's descendants are exactly the owners added after it.
      owner.childStart = owners.length;
      owners.push(owner);
      return owner;
    },
    addHint(from, to, kind) {
      if (to > from) hints.push({ from, to, kind });
    },
    addUnmapped(owner, reason, sourceFrom = owner.sourceFrom, sourceTo = owner.sourceTo) {
      unmapped.push({ ownerId: owner.id, type: owner.type, reason, sourceFrom, sourceTo, pmFrom: owner.pmFrom, pmTo: owner.pmTo });
      ctx.addHint(sourceFrom, sourceTo, 'unmapped');
    },
    addRun(owner, leaf, pmFrom, pmTo) {
      const linear = leaf.kind === 'text' && (leaf.linear === true || isLinear(leaf.charMap, leaf.sourceFrom, leaf.sourceTo, leaf.text.length));
      const run = {
        ownerId: owner.id,
        kind: leaf.kind,
        text: leaf.text ?? '',
        sourceFrom: leaf.sourceFrom,
        sourceTo: leaf.sourceTo,
        pmFrom, pmTo,
        exact: true,
        confidence: 'exact',
        linear,
        atom: leaf.kind !== 'text',
        charMap: linear ? null : leaf.charMap,
        attrs: leaf.attrs || null
      };
      runs.push(run);
      return run;
    }
  };

  // ---- Block association -------------------------------------------------
  const tokens = options.tokens || tokenizer.parse(source, {});
  const starts = lineStarts(source);
  const tokenBlocks = [];
  for (const token of tokens) {
    if (token.level !== 0 || !token.map || token.nesting === -1) continue;
    const type = tokenDocType(token);
    if (!type) continue;
    tokenBlocks.push({
      type, token,
      sourceFrom: starts[token.map[0]] ?? 0,
      sourceTo: starts[token.map[1]] ?? source.length
    });
  }

  // O(1) lookup for the association below; buckets keep insertion order so the
  // first unused candidate is still the one an ordinal scan would have chosen.
  const tokenBlocksByKey = new Map();
  for (let candidate = 0; candidate < tokenBlocks.length; candidate++) {
    const block = tokenBlocks[candidate];
    const key = `${block.type}\u0000${block.sourceFrom}`;
    let bucket = tokenBlocksByKey.get(key);
    if (!bucket) tokenBlocksByKey.set(key, bucket = []);
    bucket.push(candidate);
  }

  const pmBlocks = [];
  doc.forEach((node, offset) => pmBlocks.push({ node, pmFrom: offset }));

  // Trusted model.segments may include transient empty paragraphs that have no
  // Markdown token (e.g. Enter at a paragraph start/end).  Use those segments
  // as the authoritative one-to-one block skeleton only after validating the
  // count, node identity and ordered source bounds.  Token blocks are then
  // matched by type and exact start offset, never by ordinal count.
  const trustedSegments = options.segments;
  let blocks = tokenBlocks;
  let trusted = false;
  if (Array.isArray(trustedSegments) && trustedSegments.length === doc.childCount) {
    let previousTo = 0;
    trusted = true;
    for (let index = 0; index < trustedSegments.length; index++) {
      const segment = trustedSegments[index];
      const node = doc.child(index);
      if (!segment || segment.node !== node || !Number.isInteger(segment.from) || !Number.isInteger(segment.to) ||
          segment.from < previousTo || segment.from < 0 || segment.to < segment.from || segment.to > source.length) {
        trusted = false;
        break;
      }
      previousTo = segment.to;
    }
    if (!trusted) errors.push({ kind: 'invalid-segments' });
  }
  if (trusted) {
    const used = new Set();
    blocks = [];
    for (let index = 0; index < trustedSegments.length; index++) {
      const segment = trustedSegments[index];
      const node = doc.child(index);
      if (node.type.name === 'raw_block' && node.attrs.kind === 'source-edit') {
        tokenBlocks.forEach((block, i) => { if (block.sourceFrom >= segment.from && block.sourceFrom < segment.to) used.add(i); });
        blocks.push({ type: 'raw_block', sourceFrom: segment.from, sourceTo: segment.to });
        continue;
      }
      let match = -1;
      const bucket = tokenBlocksByKey.get(`${node.type.name}\u0000${segment.from}`);
      if (bucket) {
        for (const candidate of bucket) {
          if (!used.has(candidate)) { match = candidate; break; }
        }
      }
      if (match >= 0) {
        used.add(match);
        blocks.push({ ...tokenBlocks[match], sourceFrom: segment.from, sourceTo: segment.to });
      } else if (node.type.name === 'paragraph' && node.content.size === 0) {
        blocks.push({ type: 'paragraph', token: null, sourceFrom: segment.from, sourceTo: segment.from, empty: true });
      } else {
        blocks.push({ type: node.type.name, token: null, sourceFrom: segment.from, sourceTo: segment.to, missing: true });
      }
    }
    for (let index = 0; index < tokenBlocks.length; index++) {
      if (used.has(index)) continue;
      errors.push({ kind: 'unowned-source-block', type: tokenBlocks[index].type, sourceFrom: tokenBlocks[index].sourceFrom, sourceTo: tokenBlocks[index].sourceTo });
    }
  } else {
    // An empty/whitespace-only buffer is represented by one empty paragraph.
    // Give it an explicit zero-width anchor rather than calling it unsupported.
    if (blocks.length === 0 && pmBlocks.length === 1 && pmBlocks[0].node.type.name === 'paragraph' && pmBlocks[0].node.content.size === 0) {
      blocks.push({ type: 'paragraph', token: null, sourceFrom: 0, sourceTo: source.length, empty: true });
    }

    if (pmBlocks.length !== blocks.length) {
      errors.push({ kind: 'block-count-mismatch', blocks: blocks.length, nodes: pmBlocks.length });
    }
  }

  let lezerIndex = 0;
  const takeLezerBlock = (block, pmNode) => {
    if (block.type === 'raw_block' || block.type === 'math_block') {
      while (lezerIndex < topLevel.length && topLevel[lezerIndex].from < block.sourceTo) lezerIndex++;
      return null;
    }
    while (lezerIndex < topLevel.length && topLevel[lezerIndex].to <= block.sourceFrom) lezerIndex++;
    let fallback = null, fallbackIndex = -1;
    for (let i = lezerIndex; i < topLevel.length; i++) {
      const node = topLevel[i];
      if (node.from >= block.sourceTo) break;
      if (node.to <= block.sourceFrom) { lezerIndex = i + 1; continue; }
      if (lezerBlockMatches(block.type, node, pmNode)) {
        lezerIndex = i + 1;
        return node;
      }
      // A mismatching top-level node inside this token range means the two
      // parsers disagree about this block.  Do not guess; remember it and
      // continue looking for an exact structural match.
      if (!fallback) { fallback = node; fallbackIndex = i; }
    }
    if (fallbackIndex >= 0) {
      lezerIndex = Math.max(lezerIndex, fallbackIndex + 1);
    }
    return null;
  };

  // ---- Inline collection ------------------------------------------------
  function collectInline(node, start, end, names, out) {
    let pos = Math.max(start, node.from);
    const children = node.children || [];
    for (const child of children) {
      if (child.to <= start || child.from >= end) continue;
      const from = Math.max(child.from, start), to = Math.min(child.to, end);
      if (from > pos) addPlain(source.slice(pos, from), pos, names, out);
      const handledTo = handleInline(child, from, to, names, out);
      pos = Math.max(pos, handledTo ?? to);
    }
    if (pos < end) addPlain(source.slice(pos, end), pos, names, out);
  }

  function addPlain(raw, from, names, out) {
    if (!raw) return;
    let i = 0, runStart = 0;
    const flush = end => {
      if (end > runStart) out.push(textLeaf(source.slice(from + runStart, from + end), from + runStart, names));
    };
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === '\n' || (ch === '\r' && raw[i + 1] === '\n')) {
        flush(i);
        const sourceStart = from + i;
        let next = i + (ch === '\r' ? 2 : 1);
        while (next < raw.length && (raw[next] === ' ' || raw[next] === '\t')) next++;
        out.push({
          kind: 'text', text: ' ', sourceFrom: sourceStart, sourceTo: from + next,
          marks: names, marksKey: marksKey(names),
          charMap: [{ from: sourceStart, to: sourceStart + (ch === '\r' ? 2 : 1) }],
          softbreak: true
        });
        i = next; runStart = i;
        continue;
      }
      if (ch === '$') {
        const close = findMathClose(raw, i);
        if (close >= 0) {
          flush(i);
          out.push({
            kind: 'math', text: raw.slice(i + 1, close), tex: raw.slice(i + 1, close),
            sourceFrom: from + i, sourceTo: from + close + 1,
            marks: names, marksKey: marksKey(names)
          });
          i = close + 1; runStart = i;
          continue;
        }
      }
      i++;
    }
    flush(raw.length);
  }

  function handleInline(node, from, to, names, out) {
    const raw = source.slice(from, to);
    switch (node.name) {
      case 'Emphasis':
        collectInline(node, from, to, [...names, 'em'], out); return;
      case 'StrongEmphasis':
        collectInline(node, from, to, [...names, 'strong'], out); return;
      case 'Strikethrough':
        collectInline(node, from, to, [...names, 'strike'], out); return;
      case 'Link': {
        const labelStart = node.children.find(child => child.name === 'LinkMark' && source.slice(child.from, child.to) === '[')?.to;
        const close = [...node.children].reverse().find(child => child.name === 'LinkMark' && source.slice(child.from, child.to) === ']' && child.from >= (labelStart ?? from));
        if (labelStart == null || !close) { unsupportedInline(node, from, to, out); return; }
        collectInline(node, labelStart, close.from, [...names, 'link'], out);
        return;
      }
      case 'Autolink': {
        const url = node.children.find(child => child.name === 'URL');
        if (!url) { unsupportedInline(node, from, to, out); return; }
        out.push(mappedLeaf(source.slice(url.from, url.to), url.from, url.to, [...names, 'link'], null, { link: true }));
        return;
      }
      case 'URL':
        // Bare GFM/linkified URL.
        out.push(mappedLeaf(raw, from, to, [...names, 'link'], null, { link: true }));
        return;
      case 'Escape': {
        const visible = source.slice(from + 1, to);
        out.push(mappedLeaf(visible, from, to, names, [{ from, to }]));
        return;
      }
      case 'Entity': {
        const decoded = tokenizer.utils.unescapeAll(raw);
        if (decoded === raw) { out.push(textLeaf(raw, from, names)); return; }
        out.push(mappedLeaf(decoded, from, to, names, new Array(decoded.length).fill(null).map(() => ({ from, to }))));
        return;
      }
      case 'InlineCode': {
        const marks = node.children.filter(child => child.name === 'CodeMark');
        const open = marks[0], close = marks[marks.length - 1];
        if (!open || !close || close === open) { unsupportedInline(node, from, to, out); return; }
        const chars = normaliseCode(source.slice(open.to, close.from));
        const text = chars.map(char => char.text).join('');
        const raw = source.slice(open.to, close.from);
        if (text === raw) {
          out.push(mappedLeaf(text, open.to, close.from, [...names, 'code'], null, { linear: true }));
          return;
        }
        const charMap = chars.map(char => ({ from: open.to + char.from, to: open.to + char.to }));
        const sourceFrom = chars.length ? charMap[0].from : open.to;
        const sourceTo = chars.length ? charMap[charMap.length - 1].to : open.to;
        out.push(mappedLeaf(text, sourceFrom, sourceTo, [...names, 'code'], charMap));
        return;
      }
      case 'HardBreak':
        out.push({ kind: 'hardbreak', text: '', sourceFrom: from, sourceTo: to, marks: names, marksKey: marksKey(names) });
        return;
      case 'Image': {
        const url = node.children.find(child => child.name === 'URL');
        const marks = node.children.filter(child => child.name === 'LinkMark');
        const open = marks.find(child => source.slice(child.from, child.to) === '![');
        const close = [...marks].reverse().find(child => source.slice(child.from, child.to) === ']' && child.from >= (open?.to ?? from));
        const title = node.children.find(child => child.name === 'LinkTitle');
        if (!url) { unsupportedInline(node, from, to, out); return; }
        out.push({
          kind: 'image', text: '', sourceFrom: from, sourceTo: to,
          src: source.slice(url.from, url.to),
          alt: open && close ? unescapeAlt(source.slice(open.to, close.from)) : '',
          title: title ? source.slice(title.from + 1, title.to - 1) : null,
          marks: names, marksKey: marksKey(names)
        });
        return;
      }
      case 'HTMLTag':
        if (/^<br\s*\/?>$/i.test(raw)) {
          out.push({ kind: 'hardbreak', text: '', sourceFrom: from, sourceTo: to, marks: names, marksKey: marksKey(names) });
        } else {
          out.push({ kind: 'raw_inline', text: raw, source: raw, sourceFrom: from, sourceTo: to, marks: names, marksKey: marksKey(names) });
        }
        return;
      case 'QuoteMark': {
        // A continuation quote mark and its optional following space are
        // block syntax, not content of the quote paragraph.
        let end = to;
        if (source[end] === ' ' || source[end] === '\t') end++;
        ctx.addHint(from, end, 'syntax');
        return end;
      }
      default:
        if (INLINE_SYNTAX.has(node.name)) {
          ctx.addHint(from, to, 'syntax');
          return;
        }
        unsupportedInline(node, from, to, out);
    }
  }

  function unsupportedInline(node, from, to, out) {
    ctx.addHint(from, to, 'unmapped');
    out.push({ kind: 'unsupported', text: '', sourceFrom: from, sourceTo: to, reason: `Unsupported inline construct ${node.name}` });
  }

  // ---- Inline pairing ---------------------------------------------------
  function pairInline(owner, pmNode, leaves) {
    const contentStart = owner.pmContentFrom;
    const children = [];
    pmNode.forEach((child, offset) => children.push({ child, pmFrom: contentStart + offset }));

    let index = 0, mapped = 0, ok = true;
    for (const { child, pmFrom } of children) {
      if (!ok) break;
      const pmTo = pmFrom + child.nodeSize;
      if (child.isText) {
        let need = child.text.length, got = 0;
        const key = marksKey(markNames(child.marks));
        while (need > 0) {
          let leaf = leaves[index];
          if (!leaf || leaf.kind !== 'text' || leaf.marksKey !== key) { ok = false; break; }
          const take = Math.min(need, leaf.text.length);
          if (take <= 0 || leaf.text.slice(0, take) !== child.text.slice(got, got + take)) { ok = false; break; }
          const part = sliceLeaf(leaf, 0, take);
          ctx.addRun(owner, part, pmFrom + got, pmFrom + got + take);
          mapped++;
          if (take === leaf.text.length) index++;
          else leaves[index] = sliceLeaf(leaf, take, leaf.text.length - take);
          got += take; need -= take;
        }
        if (ok && got !== child.text.length) ok = false;
      } else {
        let leaf = leaves[index], consumed = 1;
        if (!atomMatches(child, leaf) && child.type.name === 'raw_inline') {
          // A merged pair atom (e.g. `<kbd>Ctrl</kbd>`) spans several leaves
          // (open tag, text, close tag). Consume consecutive leaves while
          // their exact source slices concatenate to the atom's verbatim
          // source. Anything else fails closed below, as before.
          const wanted = String(child.attrs.source ?? '');
          let acc = '';
          while (index + consumed - 1 < leaves.length) {
            const candidate = leaves[index + consumed - 1];
            const slice = source.slice(candidate.sourceFrom, candidate.sourceTo);
            if ((acc + slice).length > wanted.length || !wanted.startsWith(acc + slice)) break;
            acc += slice;
            if (acc === wanted) break;
            consumed++;
          }
          if (acc === wanted && consumed > 1 && leaf?.kind === 'raw_inline' && leaves[index + consumed - 1]?.kind === 'raw_inline') {
            const last = leaves[index + consumed - 1];
            leaf = { kind: 'raw_inline', text: wanted, source: wanted, sourceFrom: leaf.sourceFrom, sourceTo: last.sourceTo, marks: leaf.marks, marksKey: leaf.marksKey };
          } else {
            consumed = 0;
          }
        }
        if (!atomMatches(child, leaf)) { ok = false; break; }
        const atomOwner = ctx.addOwner(child.type.name, child, pmFrom, leaf.sourceFrom, leaf.sourceTo);
        ctx.addRun(atomOwner, leaf, pmFrom, pmTo);
        mapped++;
        index += consumed;
      }
    }

    if (children.length === 0) {
      if (leaves.length) {
        // The rich document has no inline content but the source does.  Do not
        // invent a zero-width exact mapping for real source text.
        owner.confidence = 'unmapped';
        owner.supported = false;
        owner.reason = 'Rich textblock is empty but source content is present';
        ctx.addHint(leaves[0].sourceFrom, owner.contentTo ?? leaves[leaves.length - 1].sourceTo, 'unmapped');
        ctx.addUnmapped(owner, owner.reason, leaves[0].sourceFrom, owner.contentTo ?? leaves[leaves.length - 1].sourceTo);
        return;
      }
      // Empty textblock (e.g. an empty table cell): exact zero-width anchor.
      ctx.addRun(owner, mappedLeaf('', owner.contentFrom, owner.contentFrom, [], []), contentStart, contentStart);
      owner.confidence = 'exact';
      return;
    }

    if (!ok || index < leaves.length) {
      const left = leaves[index];
      const from = left ? left.sourceFrom : (owner.contentTo ?? owner.sourceFrom);
      if ((owner.contentTo ?? from) > from) ctx.addHint(from, owner.contentTo, 'unmapped');
      owner.confidence = mapped > 0 ? 'partial' : 'unmapped';
      owner.supported = owner.confidence === 'partial';
      const reason = leaves[index]?.reason || (index < leaves.length ? 'Rich document did not account for all inline source' : 'Rich inline structure could not be paired with source');
      owner.reason = reason;
      ctx.addUnmapped(owner, reason, from, owner.contentTo ?? from);
    } else {
      owner.confidence = 'exact';
      owner.supported = true;
    }
  }

  function atomMatches(child, leaf) {
    if (!leaf) return false;
    switch (child.type.name) {
      case 'math_inline': return leaf.kind === 'math' && String(child.attrs.tex ?? '') === leaf.tex;
      case 'image': return leaf.kind === 'image' && String(child.attrs.src ?? '') === leaf.src;
      case 'raw_inline': return leaf.kind === 'raw_inline' && String(child.attrs.source ?? '') === leaf.source;
      case 'hard_break': return leaf.kind === 'hardbreak';
      default: return false;
    }
  }

  // ---- Block mapping ----------------------------------------------------
  function mapTextBlock(pmNode, pmFrom, lezerNode, owner, contentRange) {
    owner.pmContentFrom = pmFrom + 1;
    owner.pmContentTo = pmFrom + pmNode.nodeSize - 1;
    owner.contentFrom = contentRange.from;
    owner.contentTo = contentRange.to;
    const leaves = [];
    collectInline(lezerNode, contentRange.from, contentRange.to, [], leaves);
    pairInline(owner, pmNode, leaves);
  }

  function mapParagraph(pmNode, pmFrom, lezerNode, owner, range) {
    mapTextBlock(pmNode, pmFrom, lezerNode, owner, range || { from: lezerNode.from, to: lezerNode.to });
  }

  function mapHeading(pmNode, pmFrom, lezerNode, owner) {
    const range = headingContentRange(source, lezerNode);
    const marks = lezerNode.children.filter(child => child.name === 'HeaderMark');
    for (const mark of marks) ctx.addHint(mark.from, mark.to, 'syntax');
    mapTextBlock(pmNode, pmFrom, lezerNode, owner, range);
    if (pmNode.attrs.level && !lezerNode.name.endsWith(String(pmNode.attrs.level))) {
      owner.confidence = 'partial'; owner.supported = false;
      owner.reason = `Heading level differs from source (${lezerNode.name})`;
      ctx.addUnmapped(owner, owner.reason);
    }
  }

  function mapCodeBlock(pmNode, pmFrom, lezerNode, owner, range) {
    owner.pmContentFrom = pmFrom + 1;
    owner.pmContentTo = pmFrom + pmNode.nodeSize - 1;
    const codeNodes = [];
    const visit = node => {
      if (node.name === 'CodeText') codeNodes.push(node);
      for (const child of node.children) visit(child);
    };
    visit(lezerNode);
    const leaves = codeNodes.map(node => textLeaf(source.slice(node.from, node.to), node.from, []));
    if (leaves.length) {
      owner.contentFrom = codeNodes[0].from;
      owner.contentTo = codeNodes[codeNodes.length - 1].to;
    } else {
      owner.contentFrom = owner.contentTo = lezerNode.to;
    }
    for (const node of lezerNode.children) {
      if (node.name === 'CodeMark' || node.name === 'CodeInfo') ctx.addHint(node.from, node.to, 'syntax');
    }
    pairInline(owner, pmNode, leaves);
  }

  function mapBlockquote(pmNode, pmFrom, lezerNode, owner) {
    const candidates = lezerNode.children.filter(child => !['QuoteMark'].includes(child.name));
    let index = 0;
    const children = [];
    pmNode.forEach((child, offset) => children.push({ child, pmFrom: pmFrom + 1 + offset }));
    for (const { child, pmFrom: childPm } of children) {
      let matchIndex = -1;
      for (let i = index; i < candidates.length; i++) {
        if (lezerBlockMatches(child.type.name, candidates[i], child)) { matchIndex = i; break; }
      }
      if (matchIndex < 0) { markNodeUnmapped(child, childPm, ctx, 'No structural source match inside blockquote'); continue; }
      index = matchIndex + 1;
      mapBlockNode(child, childPm, candidates[matchIndex], null);
    }
    for (const node of lezerNode.children) if (node.name === 'QuoteMark') ctx.addHint(node.from, node.to, 'syntax');
    aggregate(owner);
  }

  function mapList(pmNode, pmFrom, lezerNode, owner) {
    const items = lezerNode.children.filter(child => child.name === 'ListItem');
    let index = 0;
    pmNode.forEach((child, offset) => {
      const childPm = pmFrom + 1 + offset;
      if (child.type.name !== 'list_item') { markNodeUnmapped(child, childPm, ctx, 'Unexpected child in list'); return; }
      const item = items[index++];
      if (!item) { markNodeUnmapped(child, childPm, ctx, 'No source list item'); return; }
      mapListItem(child, childPm, item);
    });
    if (index < items.length) ctx.addHint(items[index].from, lezerNode.to, 'unmapped');
    aggregate(owner);
  }

  function mapListItem(pmNode, pmFrom, item) {
    const owner = ctx.addOwner('list_item', pmNode, pmFrom, item.from, item.to);
    const listMark = item.children.find(child => child.name === 'ListMark');
    if (listMark) ctx.addHint(listMark.from, listMark.to, 'prefix');
    const task = item.children.find(child => child.name === 'Task');
    const taskMarker = task?.children.find(child => child.name === 'TaskMarker');
    let taskUsed = false;
    if (taskMarker) {
      ctx.addHint(taskMarker.from, taskMarker.to, 'prefix');
      const expected = source.slice(taskMarker.from, taskMarker.to);
      const checked = /\[[xX]\]/.test(expected);
      if (pmNode.attrs.checked !== checked) {
        owner.reason = 'Task marker does not match the rich list item';
        owner.mismatch = true;
      }
    }
    const candidates = item.children.filter(child => !['ListMark', 'TaskMarker'].includes(child.name));
    let index = 0;
    const children = [];
    pmNode.forEach((child, offset) => children.push({ child, pmFrom: pmFrom + 1 + offset }));
    for (const { child, pmFrom: childPm } of children) {
      if (child.type.name === 'paragraph') {
        const paragraphNode = candidates.slice(index).find(node => node.name === 'Paragraph');
        if (paragraphNode) {
          index = candidates.indexOf(paragraphNode) + 1;
          const paragraphOwner = ctx.addOwner('paragraph', child, childPm, paragraphNode.from, paragraphNode.to);
          mapParagraph(child, childPm, paragraphNode, paragraphOwner);
          continue;
        }
        if (task && !taskUsed) {
          taskUsed = true;
          const contentFrom = taskMarker && source[taskMarker.to] === ' ' ? taskMarker.to + 1 : (taskMarker?.to ?? task.from);
          const pseudo = { name: 'Paragraph', from: contentFrom, to: task.to, children: task.children.filter(node => node.name !== 'TaskMarker') };
          index = candidates.indexOf(task) + 1;
          const paragraphOwner = ctx.addOwner('paragraph', child, childPm, contentFrom, task.to);
          mapParagraph(child, childPm, pseudo, paragraphOwner, { from: contentFrom, to: task.to });
          continue;
        }
        markNodeUnmapped(child, childPm, ctx, 'List item paragraph has no structural source match');
        continue;
      }
      const match = candidates.slice(index).find(node => lezerBlockMatches(child.type.name, node, child));
      if (!match) { markNodeUnmapped(child, childPm, ctx, 'Nested list block has no structural source match'); continue; }
      index = candidates.indexOf(match) + 1;
      mapBlockNode(child, childPm, match, null);
    }
    aggregate(owner);
    if (owner.mismatch) {
      owner.confidence = 'partial'; owner.supported = false;
      ctx.addUnmapped(owner, owner.reason);
    }
  }

  function mapTable(pmNode, pmFrom, lezerNode, owner) {
    const rows = lezerNode.children.filter(child => child.name === 'TableHeader' || child.name === 'TableRow');
    let index = 0;
    pmNode.forEach((child, offset) => {
      const childPm = pmFrom + 1 + offset;
      if (child.type.name !== 'table_row') { markNodeUnmapped(child, childPm, ctx, 'Unexpected table child'); return; }
      const row = rows[index++];
      if (!row) { markNodeUnmapped(child, childPm, ctx, 'No source table row'); return; }
      mapTableRow(child, childPm, row);
    });
    if (index < rows.length) ctx.addHint(rows[index].from, lezerNode.to, 'unmapped');
    aggregate(owner);
  }

  function mapTableRow(pmNode, pmFrom, row) {
    const owner = ctx.addOwner('table_row', pmNode, pmFrom, row.from, row.to, 'exact');
    const delimiters = row.children.filter(child => child.name === 'TableDelimiter').sort((a, b) => a.from - b.from);
    const ranges = [];
    let start = row.from, index = 0;
    if (delimiters.length && delimiters[0].from === row.from) { start = delimiters[0].to; index = 1; }
    for (; index < delimiters.length; index++) {
      ranges.push({ from: start, to: delimiters[index].from });
      start = delimiters[index].to;
    }
    if (start < row.to) ranges.push({ from: start, to: row.to });
    if (!ranges.length) ranges.push({ from: row.from, to: row.to });

    const cells = [];
    pmNode.forEach((child, offset) => cells.push({ child, pmFrom: pmFrom + 1 + offset }));
    let mapped = 0;
    for (let i = 0; i < cells.length; i++) {
      const { child, pmFrom: cellPm } = cells[i];
      if (!['table_cell', 'table_header'].includes(child.type.name) || i >= ranges.length) {
        markNodeUnmapped(child, cellPm, ctx, 'Table cell has no structural source range');
        continue;
      }
      const range = trimSpace(source, ranges[i].from, ranges[i].to);
      mapTableCell(child, cellPm, range, row, range.from);
      mapped++;
    }
    if (cells.length !== ranges.length) {
      owner.confidence = 'partial'; owner.supported = false;
      owner.reason = `Table row has ${cells.length} rich cells but ${ranges.length} source cells`;
      ctx.addUnmapped(owner, owner.reason);
    }
    aggregate(owner);
  }

  function mapTableCell(pmNode, pmFrom, range, row) {
    const owner = ctx.addOwner(pmNode.type.name, pmNode, pmFrom, range.from, range.to);
    const sourceCell = row.children.find(child => child.name === 'TableCell' && child.from <= range.from && child.to >= range.to);
    let paragraphMapped = false;
    pmNode.forEach((child, offset) => {
      const childPm = pmFrom + 1 + offset;
      if (child.type.name === 'paragraph' && !paragraphMapped) {
        paragraphMapped = true;
        const paragraphOwner = ctx.addOwner('paragraph', child, childPm, range.from, range.to);
        const pseudo = {
          name: 'Paragraph', from: range.from, to: range.to,
          children: sourceCell ? sourceCell.children : []
        };
        mapParagraph(child, childPm, pseudo, paragraphOwner, range);
      } else {
        markNodeUnmapped(child, childPm, ctx, 'Unsupported table cell content');
      }
    });
    aggregate(owner);
  }

  function mapNode(pmNode, pmFrom, lezerNode, overrideRange) {
    const sourceFrom = overrideRange ? overrideRange.from : lezerNode.from;
    const sourceTo = overrideRange ? overrideRange.to : lezerNode.to;
    switch (pmNode.type.name) {
      case 'paragraph': {
        const owner = ctx.addOwner('paragraph', pmNode, pmFrom, sourceFrom, sourceTo);
        mapParagraph(pmNode, pmFrom, lezerNode, owner);
        return owner;
      }
      case 'heading': {
        const owner = ctx.addOwner('heading', pmNode, pmFrom, sourceFrom, sourceTo);
        mapHeading(pmNode, pmFrom, lezerNode, owner);
        return owner;
      }
      case 'code_block': {
        const owner = ctx.addOwner('code_block', pmNode, pmFrom, sourceFrom, sourceTo);
        mapCodeBlock(pmNode, pmFrom, lezerNode, owner, { from: sourceFrom, to: sourceTo });
        return owner;
      }
      case 'blockquote': {
        const owner = ctx.addOwner('blockquote', pmNode, pmFrom, sourceFrom, sourceTo);
        mapBlockquote(pmNode, pmFrom, lezerNode, owner);
        return owner;
      }
      case 'bullet_list':
      case 'ordered_list': {
        const owner = ctx.addOwner(pmNode.type.name, pmNode, pmFrom, sourceFrom, sourceTo);
        mapList(pmNode, pmFrom, lezerNode, owner);
        return owner;
      }
      case 'table': {
        const owner = ctx.addOwner('table', pmNode, pmFrom, sourceFrom, sourceTo);
        mapTable(pmNode, pmFrom, lezerNode, owner);
        return owner;
      }
      case 'horizontal_rule': {
        const owner = ctx.addOwner('horizontal_rule', pmNode, pmFrom, sourceFrom, sourceTo);
        ctx.addRun(owner, { kind: 'atom', text: '', sourceFrom, sourceTo }, pmFrom, pmFrom + 1);
        owner.confidence = 'exact'; owner.supported = true;
        return owner;
      }
      default:
        markNodeUnmapped(pmNode, pmFrom, ctx, `Unsupported rich block ${pmNode.type.name}`, sourceFrom, sourceTo);
    }
  }

  function mapBlockNode(pmNode, pmFrom, lezerNode, overrideRange) {
    if (!lezerNode) {
      markNodeUnmapped(pmNode, pmFrom, ctx, 'No structural source match');
      return null;
    }
    return mapNode(pmNode, pmFrom, lezerNode, overrideRange);
  }

  function markNodeUnmapped(pmNode, pmFrom, context, reason, sourceFrom = null, sourceTo = null) {
    const from = sourceFrom ?? pmFrom;
    const to = sourceTo ?? from;
    const owner = context.addOwner(pmNode.type.name, pmNode, pmFrom, from, to, 'unmapped', reason);
    context.addUnmapped(owner, reason, from, to);
    return owner;
  }

  function aggregate(owner) {
    const pool = Number.isInteger(owner.childStart) ? owners.slice(owner.childStart) : owners;
    const children = pool.filter(candidate => candidate.id !== owner.id && candidate.pmFrom >= owner.pmFrom && candidate.pmTo <= owner.pmTo);
    if (!children.length) {
      if (owner.confidence !== 'unmapped') owner.confidence = 'unmapped';
      owner.supported = false;
      if (!owner.reason) owner.reason = 'Container has no mapped content';
      return;
    }
    const exact = children.every(child => child.confidence === 'exact');
    const mappedAny = children.some(child => child.confidence !== 'unmapped');
    owner.confidence = exact ? 'exact' : mappedAny ? 'partial' : 'unmapped';
    owner.supported = owner.confidence !== 'unmapped';
    if (owner.confidence !== 'exact') {
      owner.reason = owner.reason || children.find(child => child.reason)?.reason || 'Some content in this container is unmapped';
    }
  }

  // ---- Pair blocks with document ----------------------------------------
  const count = Math.min(pmBlocks.length, blocks.length);
  for (let i = 0; i < count; i++) {
    const block = blocks[i], { node, pmFrom } = pmBlocks[i];
    if (block.empty) {
      // A transient empty paragraph has no Markdown token.  Anchor its PM
      // content at the trusted segment start (not global 0) so toggles stay in
      // place.  The segment's whitespace remains an exact gap.
      const anchor = block.sourceFrom ?? 0;
      const owner = ctx.addOwner(node.type.name, node, pmFrom, anchor, anchor);
      owner.pmContentFrom = owner.pmContentTo = pmFrom + 1;
      owner.contentFrom = owner.contentTo = anchor;
      ctx.addRun(owner, mappedLeaf('', anchor, anchor, [], []), pmFrom + 1, pmFrom + 1);
      owner.confidence = 'exact';
      owner.supported = true;
      continue;
    }
    if (block.missing) {
      markNodeUnmapped(node, pmFrom, ctx, `No tokenizer source block matches trusted segment for ${block.type}`, block.sourceFrom, block.sourceTo);
      continue;
    }
    const lezerNode = takeLezerBlock(block, node);
    if (block.type === 'raw_block') {
      const raw = source.slice(block.sourceFrom, block.sourceTo);
      const text = node.textContent;
      // raw_block is a literal code block.  The model parser trims at most one
      // trailing LF from the token content; accept the literal only when the
      // exact source slice (or that one-LF-trimmed slice) equals PM content.
      const candidates = [{ text: raw, from: block.sourceFrom, to: block.sourceTo }];
      if (raw.endsWith('\n')) candidates.push({ text: raw.slice(0, -1), from: block.sourceFrom, to: block.sourceTo - 1 });
      if (raw.endsWith('\r\n')) candidates.push({ text: raw.slice(0, -2), from: block.sourceFrom, to: block.sourceTo - 2 });
      const literal = candidates.find(candidate => candidate.text === text);
      if (!literal) {
        const owner = ctx.addOwner('raw_block', node, pmFrom, block.sourceFrom, block.sourceTo, 'unmapped', 'Raw block content cannot be verified against the exact source slice');
        ctx.addUnmapped(owner, owner.reason);
        continue;
      }
      const owner = ctx.addOwner('raw_block', node, pmFrom, block.sourceFrom, block.sourceTo);
      owner.pmContentFrom = pmFrom + 1;
      owner.pmContentTo = pmFrom + 1 + text.length;
      owner.contentFrom = literal.from;
      owner.contentTo = literal.to;
      ctx.addRun(owner, textLeaf(text, literal.from, []), pmFrom + 1, pmFrom + 1 + text.length);
      owner.confidence = 'exact';
      owner.supported = true;
      continue;
    }
    if (block.type === 'math_block') {
      const owner = ctx.addOwner('math_block', node, pmFrom, block.sourceFrom, block.sourceTo);
      ctx.addRun(owner, { kind: 'atom', text: node.attrs.tex ?? '', sourceFrom: block.sourceFrom, sourceTo: block.sourceTo }, pmFrom, pmFrom + 1);
      owner.confidence = 'exact'; owner.supported = true;
      continue;
    }
    if (!lezerNode) {
      markNodeUnmapped(node, pmFrom, ctx, `No structural source match for ${block.type}`, block.sourceFrom, block.sourceTo);
      continue;
    }
    if (!lezerBlockMatches(block.type, lezerNode, node)) {
      markNodeUnmapped(node, pmFrom, ctx, `Source parser and rich document disagree about ${block.type}`, block.sourceFrom, block.sourceTo);
      continue;
    }
    mapNode(node, pmFrom, lezerNode, { from: block.sourceFrom, to: block.sourceTo });
  }
  for (let i = count; i < pmBlocks.length; i++) {
    const { node, pmFrom } = pmBlocks[i];
    markNodeUnmapped(node, pmFrom, ctx, 'Rich block has no corresponding source block');
  }
  for (let i = count; i < blocks.length; i++) {
    ctx.addHint(blocks[i].sourceFrom, blocks[i].sourceTo, 'unmapped');
    errors.push({ kind: 'unowned-source-block', type: blocks[i].type, sourceFrom: blocks[i].sourceFrom, sourceTo: blocks[i].sourceTo });
  }

  // Reference definitions are deliberately outside the rich document.
  for (const node of topLevel) {
    if (node.name === 'LinkReference') ctx.addHint(node.from, node.to, 'reference');
  }

  // ---- Gaps --------------------------------------------------------------
  runs.sort((a, b) => a.sourceFrom - b.sourceFrom || a.sourceTo - b.sourceTo);
  const gapHints = hints.slice().sort((a, b) => a.from - b.from || a.to - b.to);
  const gaps = [];
  // Gaps are emitted in non-decreasing source order, so overlapping hints are
  // found with one advancing cursor instead of rescanning every hint for every
  // gap (that scan was quadratic and dominated the whole ledger build).
  let hintCursor = 0;
  const hintsAround = (from, to) => {
    while (hintCursor < gapHints.length && gapHints[hintCursor].to <= from) hintCursor++;
    const matched = [];
    for (let index = hintCursor; index < gapHints.length && gapHints[index].from < to; index++) {
      if (gapHints[index].to > from) matched.push(gapHints[index]);
    }
    return matched;
  };
  const hintAt = (from, to) => {
    let best = null;
    for (const hint of hintsAround(from, to)) {
      if (!best || hint.to - hint.from > best.to - best.from) best = hint;
    }
    return best;
  };
  const addGap = (from, to) => {
    if (to <= from) return;
    const points = new Set([from, to]);
    for (const hint of hintsAround(from, to)) {
      points.add(Math.max(from, hint.from));
      points.add(Math.min(to, hint.to));
    }
    const ordered = [...points].sort((a, b) => a - b);
    for (let i = 1; i < ordered.length; i++) {
      const gapFrom = ordered[i - 1], gapTo = ordered[i];
      if (gapTo <= gapFrom) continue;
      const text = source.slice(gapFrom, gapTo);
      let kind = 'syntax';
      if (isWhitespace(text)) kind = 'whitespace';
      else {
        const hint = hintAt(gapFrom, gapTo);
        if (hint) kind = hint.kind;
        else if (unmapped.some(entry => entry.sourceFrom <= gapFrom && entry.sourceTo >= gapTo)) kind = 'unsupported';
      }
      gaps.push({ sourceFrom: gapFrom, sourceTo: gapTo, text, kind });
    }
  };
  let cursor = 0;
  for (const run of runs) {
    if (run.sourceFrom > cursor) addGap(cursor, run.sourceFrom);
    cursor = Math.max(cursor, run.sourceTo);
  }
  if (cursor < source.length) addGap(cursor, source.length);

  // ---- Metadata ----------------------------------------------------------
  const exactOwners = owners.filter(owner => owner.confidence === 'exact').length;
  const partialOwners = owners.filter(owner => owner.confidence === 'partial').length;
  const unmappedOwners = owners.filter(owner => owner.confidence === 'unmapped').length;
  let covered = 0;
  for (const run of runs) covered += Math.max(0, run.sourceTo - run.sourceFrom);
  const metadata = {
    sourceLength: source.length,
    docSize: doc.content.size,
    owners: owners.length,
    runs: runs.length,
    gaps: gaps.length,
    exactOwners,
    partialOwners,
    unmappedOwners,
    coverage: source.length ? covered / source.length : 1,
    complete: unmappedOwners === 0 && partialOwners === 0 && errors.length === 0,
    unsupported: unmappedOwners > 0,
    partial: partialOwners > 0
  };

  return {
    source,
    doc,
    owners,
    ownerById: new Map(owners.map(owner => [owner.id, owner])),
    runs,
    gaps,
    errors,
    unmapped,
    metadata,
    supported: metadata.complete,
    complete: metadata.complete
  };
}

function findRunSource(runs, offset, bias) {
  let low = 0, high = runs.length - 1, last = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (runs[mid].sourceFrom <= offset) { last = mid; low = mid + 1; }
    else high = mid - 1;
  }
  const candidates = [];
  if (last >= 0) {
    for (let i = Math.max(0, last - 1); i <= Math.min(runs.length - 1, last + 1); i++) {
      if (runs[i].sourceFrom <= offset && runs[i].sourceTo >= offset) candidates.push(runs[i]);
    }
  }
  if (!candidates.length && last + 1 < runs.length && runs[last + 1].sourceFrom === offset) candidates.push(runs[last + 1]);
  if (!candidates.length) return null;
  const empty = candidates.find(run => run.sourceFrom === run.sourceTo && run.sourceFrom === offset);
  if (empty) return empty;
  const starting = candidates.filter(run => run.sourceFrom === offset);
  const ending = candidates.filter(run => run.sourceTo === offset);
  if (bias === 'left' && ending.length) return ending[0];
  if (starting.length) return bias === 'left' ? starting[starting.length - 1] : starting[0];
  if (ending.length) return bias === 'left' ? ending[0] : ending[ending.length - 1];
  return candidates[0];
}

function findRunRich(runs, position, bias) {
  // Runs are emitted in rich-document order and do not overlap except at
  // their endpoints. Find the last possible start, then inspect only touching
  // runs, retaining the existing affinity/tie-breaking rules below.
  let low = 0, high = runs.length - 1, last = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (runs[mid].pmFrom <= position) { last = mid; low = mid + 1; }
    else high = mid - 1;
  }
  const sorted = [];
  for (let i = last; i >= 0 && runs[i].pmTo >= position; i--) sorted.push(runs[i]);
  sorted.reverse();
  if (!sorted.length) return null;
  const empty = sorted.find(run => run.pmFrom === run.pmTo && run.pmFrom === position);
  if (empty) return empty;
  const starting = sorted.filter(run => run.pmFrom === position).sort((a, b) => a.pmTo - b.pmTo || a.sourceFrom - b.sourceFrom);
  const ending = sorted.filter(run => run.pmTo === position).sort((a, b) => b.pmFrom - a.pmFrom || a.sourceFrom - b.sourceFrom);
  if (bias === 'right' && starting.length) return starting[0];
  if (bias === 'left' && ending.length) return ending[0];
  if (starting.length) return starting[0];
  if (ending.length) return ending[0];
  sorted.sort((a, b) => (a.pmTo - a.pmFrom) - (b.pmTo - b.pmFrom));
  return sorted[0];
}

function ownerAtSource(owners, offset) {
  let best = null;
  for (const owner of owners) {
    if (owner.sourceFrom <= offset && owner.sourceTo >= offset) {
      if (!best || (owner.sourceTo - owner.sourceFrom) < (best.sourceTo - best.sourceFrom)) best = owner;
    }
  }
  return best;
}

function mapSourceInRun(run, offset, bias) {
  if (run.atom) {
    if (offset <= run.sourceFrom) return run.pmFrom;
    if (offset >= run.sourceTo) return run.pmTo;
    return bias === 'left' ? run.pmFrom : run.pmTo;
  }
  if (run.linear) return run.pmFrom + Math.max(0, Math.min(offset - run.sourceFrom, run.pmTo - run.pmFrom));
  if (offset <= run.sourceFrom) return run.pmFrom;
  if (offset >= run.sourceTo) return run.pmTo;
  const map = run.charMap || [];
  for (let i = 0; i < map.length; i++) {
    if (offset === map[i].from) return run.pmFrom + i;
    if (offset > map[i].from && offset < map[i].to) return bias === 'left' ? run.pmFrom + i : run.pmFrom + i + 1;
    if (offset === map[i].to) {
      if (i + 1 < map.length && map[i + 1].from === offset) return run.pmFrom + i + 1;
      if (i + 1 < map.length) return bias === 'left' ? run.pmFrom + i + 1 : run.pmFrom + i + 2;
      return run.pmTo;
    }
  }
  return bias === 'left' ? run.pmFrom : run.pmTo;
}

/**
 * Map an exact source offset to a rich position.
 *
 * Returns `{ pm, confidence, exact, owner, left, right }`.
 * `confidence` is `exact` inside/at a verified run, `gap` for syntax or
 * whitespace between runs, and `unmapped` inside an explicitly unsupported
 * owner.  Because source and rich positions are not bijective across Markdown
 * syntax, callers that need endpoint affinity should pass `{ bias: 'left' }`
 * or `{ bias: 'right' }` (default `right`, i.e. prefer the next visible text).
 * `left`/`right` expose the adjacent verified positions for gap offsets.
 */
export function mapSource(ledger, offset, options = {}) {
  if (!ledger || typeof ledger.source !== 'string') throw new TypeError('mapSource requires a ledger from buildLedger');
  const bias = options.bias === 'left' ? 'left' : 'right';
  const position = Math.max(0, Math.min(Number(offset) || 0, ledger.source.length));
  const run = findRunSource(ledger.runs, position, bias);
  if (run) {
    return {
      pm: mapSourceInRun(run, position, bias),
      confidence: 'exact', exact: true,
      owner: ledger.ownerById.get(run.ownerId) || null,
      source: position
    };
  }
  const previous = ledger.runs.filter(candidate => candidate.sourceTo <= position).sort((a, b) => b.sourceTo - a.sourceTo)[0] || null;
  const next = ledger.runs.filter(candidate => candidate.sourceFrom >= position).sort((a, b) => a.sourceFrom - b.sourceFrom)[0] || null;
  const owner = ownerAtSource(ledger.owners, position);
  if (owner && owner.confidence === 'unmapped') {
    return {
      pm: bias === 'left' ? owner.pmFrom : owner.pmTo,
      confidence: 'unmapped', exact: false, owner, source: position,
      left: previous?.pmTo ?? null, right: next?.pmFrom ?? null
    };
  }
  if (previous || next) {
    let pm;
    if (!previous) pm = owner && position === owner.sourceFrom ? owner.pmFrom : next.pmFrom;
    else if (!next) pm = owner && position === owner.sourceTo ? owner.pmTo : previous.pmTo;
    else pm = bias === 'left' ? previous.pmTo : next.pmFrom;
    return {
      pm, confidence: 'gap', exact: false, owner, source: position,
      left: previous?.pmTo ?? null, right: next?.pmFrom ?? null
    };
  }
  if (owner) {
    return {
      pm: position <= owner.sourceFrom ? owner.pmFrom : owner.pmTo,
      confidence: 'gap', exact: false, owner, source: position,
      left: null, right: null
    };
  }
  const fallback = ledger.doc.content.size;
  return {
    pm: position === 0 ? 0 : fallback,
    confidence: 'unmapped', exact: false, owner: null, source: position,
    left: null, right: null
  };
}

function mapRichInRun(run, position, bias) {
  if (run.atom) {
    if (position <= run.pmFrom) return run.sourceFrom;
    if (position >= run.pmTo) return run.sourceTo;
    return bias === 'right' ? run.sourceTo : run.sourceFrom;
  }
  if (run.linear) return run.sourceFrom + Math.max(0, Math.min(position - run.pmFrom, run.sourceTo - run.sourceFrom));
  if (position <= run.pmFrom) return run.sourceFrom;
  if (position >= run.pmTo) return run.sourceTo;
  const index = position - run.pmFrom;
  const map = run.charMap || [];
  if (index <= 0) return run.sourceFrom;
  if (index >= map.length) return run.sourceTo;
  const before = map[index - 1];
  const after = map[index];
  if (!before) return after?.from ?? run.sourceFrom;
  if (!after) return before?.to ?? run.sourceTo;
  if (before.to === after.from) return before.to;
  if (bias === 'right') return after.from;
  return before.to;
}

/**
 * Map an exact rich position to a source offset.
 *
 * Returns `{ source, confidence, exact, owner, left, right }`.
 * Default bias is `left` (prefer the text before a shared boundary).  At a
 * boundary with a syntax gap, source and rich positions are not one-to-one;
 * use `{ bias: 'right' }` for source-start affinity and inspect `left`/`right`.
 * A position inside an unmapped owner stays `unmapped` rather than jumping to
 * a nearby guessed block.
 */
export function mapRich(ledger, position, options = {}) {
  if (!ledger || typeof ledger.source !== 'string') throw new TypeError('mapRich requires a ledger from buildLedger');
  const bias = options.bias === 'right' ? 'right' : 'left';
  const pmPosition = Math.max(0, Math.min(Number(position) || 0, ledger.doc.content.size));
  const run = findRunRich(ledger.runs, pmPosition, bias);
  if (run) {
    return {
      source: mapRichInRun(run, pmPosition, bias),
      confidence: 'exact', exact: true,
      owner: ledger.ownerById.get(run.ownerId) || null,
      pm: pmPosition
    };
  }
  const previous = ledger.runs.filter(candidate => candidate.pmTo <= pmPosition).sort((a, b) => b.pmTo - a.pmTo)[0] || null;
  const next = ledger.runs.filter(candidate => candidate.pmFrom >= pmPosition).sort((a, b) => a.pmFrom - b.pmFrom)[0] || null;
  const owners = ledger.owners.filter(owner => owner.pmFrom <= pmPosition && owner.pmTo >= pmPosition);
  const unmappedOwner = owners.find(owner => owner.confidence === 'unmapped') || null;
  if (unmappedOwner) {
    return {
      source: bias === 'right' ? unmappedOwner.sourceTo : unmappedOwner.sourceFrom,
      confidence: 'unmapped', exact: false, owner: unmappedOwner, pm: pmPosition,
      left: previous?.sourceTo ?? null, right: next?.sourceFrom ?? null
    };
  }
  const starts = owners.filter(owner => owner.pmFrom === pmPosition).sort((a, b) => a.pmTo - b.pmTo);
  const ends = owners.filter(owner => owner.pmTo === pmPosition).sort((a, b) => b.pmFrom - a.pmFrom);
  if ((bias === 'right' && starts.length) || (bias === 'left' && !ends.length && starts.length)) {
    const owner = starts[0];
    return {
      source: owner.sourceFrom, confidence: 'gap', exact: false, owner, pm: pmPosition,
      left: previous?.sourceTo ?? null, right: next?.sourceFrom ?? null
    };
  }
  if (ends.length) {
    const owner = ends[0];
    return {
      source: owner.sourceTo, confidence: 'gap', exact: false, owner, pm: pmPosition,
      left: previous?.sourceTo ?? null, right: next?.sourceFrom ?? null
    };
  }
  if (previous || next) {
    return {
      source: bias === 'right' ? (next?.sourceFrom ?? previous.sourceTo) : (previous?.sourceTo ?? next.sourceFrom),
      confidence: 'gap', exact: false, owner: owners[0] || null, pm: pmPosition,
      left: previous?.sourceTo ?? null, right: next?.sourceFrom ?? null
    };
  }
  return {
    source: 0,
    confidence: 'unmapped', exact: false, owner: null, pm: pmPosition,
    left: null, right: null
  };
}

/**
 * Apply exact, pre-verified source-interval patches.
 *
 * Patches are `{ from, to, insert }` (or `sourceFrom`/`sourceTo`), optionally
 * with `expected` text and an `ownerId` that the interval must stay inside.
 * Invalid/overlapping/out-of-bounds patches throw instead of being clamped or
 * silently applied to a guessed range.  The original source is never rebuilt
 * from block serialization; untouched bytes are copied verbatim.
 */
export function applySourcePatches(ledgerOrSource, patches) {
  const source = typeof ledgerOrSource === 'string' ? ledgerOrSource : ledgerOrSource?.source;
  if (typeof source !== 'string') throw new TypeError('applySourcePatches requires a source string or a ledger');
  if (!Array.isArray(patches)) throw new TypeError('applySourcePatches requires an array of patches');
  const ledger = typeof ledgerOrSource === 'string' ? null : ledgerOrSource;
  const normalised = patches.map((patch, index) => {
    const from = patch.from ?? patch.sourceFrom;
    const to = patch.to ?? patch.sourceTo;
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error(`Patch ${index} has a non-integer interval`);
    if (from < 0 || to > source.length || from > to) throw new Error(`Patch ${index} interval [${from},${to}) is out of bounds`);
    if (typeof patch.insert !== 'string') throw new Error(`Patch ${index} insert must be a string`);
    if (patch.expected !== undefined && source.slice(from, to) !== patch.expected) {
      throw new Error(`Patch ${index} expected ${JSON.stringify(patch.expected)} but found ${JSON.stringify(source.slice(from, to))}`);
    }
    if (patch.ownerId !== undefined) {
      const owner = ledger?.owners?.find(candidate => candidate.id === patch.ownerId);
      if (!owner) throw new Error(`Patch ${index} references unknown owner ${patch.ownerId}`);
      if (from < owner.sourceFrom || to > owner.sourceTo) throw new Error(`Patch ${index} is outside owner ${patch.ownerId}`);
    }
    return { from, to, insert: patch.insert, expected: patch.expected, ownerId: patch.ownerId };
  }).sort((a, b) => a.from - b.from || a.to - b.to);

  for (let i = 1; i < normalised.length; i++) {
    if (normalised[i].from < normalised[i - 1].to) throw new Error(`Patches ${i - 1} and ${i} overlap`);
  }
  let output = source;
  for (let i = normalised.length - 1; i >= 0; i--) {
    const patch = normalised[i];
    output = output.slice(0, patch.from) + patch.insert + output.slice(patch.to);
  }
  return { source: output, applied: normalised.length, patches: normalised };
}
