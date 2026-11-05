import MarkdownIt from 'markdown-it';
import { Schema, Fragment } from 'prosemirror-model';
import { schema as commonSchema, MarkdownParser, MarkdownSerializer, defaultMarkdownParser, defaultMarkdownSerializer } from 'prosemirror-markdown';
import { tableNodes } from 'prosemirror-tables';
import { buildLedger, mapSource as mapLedgerSource, mapRich as mapLedgerRich } from './source-ledger.js';

// Rich editing and source editing are projections of one Markdown buffer.
// Keep unchanged top-level source slices verbatim instead of round-tripping
// an entire file through a rich-text serializer after every keystroke.
let nodes = commonSchema.spec.nodes
  .update('heading', { ...commonSchema.spec.nodes.get('heading'), content: 'inline*' })
  .update('bullet_list', { ...commonSchema.spec.nodes.get('bullet_list'), attrs: { tight: { default: true }, bullet: { default: '-' } } })
  .update('list_item', { ...commonSchema.spec.nodes.get('list_item'), attrs: { checked: { default: null } } })
  .addToEnd('raw_block', { content: 'text*', group: 'block', code: true, marks: '', defining: true, attrs: { kind: { default: 'Markdown extension' } }, toDOM: () => ['pre', { class: 'source-block', 'data-source-fallback': '' }, 0] })
  .addToEnd('raw_inline', { inline: true, group: 'inline', atom: true, attrs: { source: {} }, toDOM: node => ['code', { class: 'source-inline' }, node.attrs.source] })
  .addToEnd('soft_break', { inline: true, group: 'inline', atom: true, selectable: false, attrs: {}, leafText: () => ' ', toDOM: () => ['span', { class: 'soft-break' }, ' '] })
  .addToEnd('math_inline', { inline: true, group: 'inline', atom: true, attrs: { tex: {}, delimiter: { default: '$' } }, toDOM: node => ['span', { class: 'math-source' }, node.attrs.delimiter === '\\(' ? `\\(${node.attrs.tex}\\)` : `$${node.attrs.tex}$`] })
  .addToEnd('math_block', { group: 'block', atom: true, attrs: { tex: {}, delimiter: { default: '$$' } }, toDOM: node => ['div', { class: 'math-source' }, node.attrs.delimiter === '\\[' ? `\\[\n${node.attrs.tex}\n\\]` : `$$\n${node.attrs.tex}\n$$`] });
nodes = nodes.append(tableNodes({ tableGroup: 'block', cellContent: 'block+', cellAttributes: { align: { default: null, getFromDOM: dom => dom.style.textAlign || null, setDOMAttr(value, attrs) { if (value) attrs.style = `text-align:${value}`; } } } }));
const links = commonSchema.spec.marks.get('link');
export const schema = new Schema({ nodes, marks: commonSchema.spec.marks.update('link', { ...links, toDOM(node) {
  const href = String(node.attrs.href || '');
  const safe = !/^[\u0000-\u0020]*(?:javascript|data|vbscript|file):/i.test(href) && !/[\u0000-\u001f]/.test(href);
  return ['a', { ...node.attrs, href: safe ? href : '#', rel: 'noreferrer' }, 0];
} }).addToEnd('strike', { parseDOM: [{ tag: 's' }, { tag: 'del' }], toDOM: () => ['s', 0] }) });

export const tokenizer = new MarkdownIt({ html: true, linkify: true, typographer: false });
// markdown-it has no footnote extension, so it parses `[^1]: Definition.` as a
// link reference definition and consumes it without emitting a token. The
// definition then only survives in source gaps and never appears in the rich
// view. Comrak (the native renderer) does support footnotes, so leave these
// lines in the block stream for the extension fallback instead.
const referenceRule = tokenizer.block.ruler.__rules__.find(rule => rule.name === 'reference');
const parseReference = referenceRule.fn;
tokenizer.block.ruler.at('reference', (state, start, end, silent) => {
  const line = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
  if (/^\[\^[^\]\n]+\]:/.test(line)) return false;
  return parseReference(state, start, end, silent);
}, { alt: referenceRule.alt });
tokenizer.block.ruler.before('fence', 'folio_frontmatter', (state, start, end, silent) => {
  if (start !== 0 || state.src.slice(state.bMarks[0], state.eMarks[0]).trim() !== '---') return false;
  let next = start + 1;
  while (next < end && state.src.slice(state.bMarks[next], state.eMarks[next]).trim() !== '---') next++;
  if (next === end) return false;
  if (!silent) { const token = state.push('raw_block', '', 0); token.content = state.getLines(start, next + 1, 0, false); token.map = [start, next + 1]; state.line = next + 1; }
  return true;
});
tokenizer.block.ruler.before('fence', 'folio_math', (state, start, end, silent) => {
  const line = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
  const bracket = line.startsWith('\\[');
  if (!bracket && (!line.startsWith('$$') || line.startsWith('$$$'))) return false;
  const close = bracket ? '\\]' : '$$';
  let next = start, tex = '';
  if (line.length > 3 && line.endsWith(close)) tex = line.slice(2, -2);
  else {
    next++;
    while (next < end && state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]).trim() !== close) next++;
    if (next === end) return false;
    tex = (line.slice(2) + '\n' + state.getLines(start + 1, next, state.blkIndent, false)).trim();
  }
  if (!silent) { const token = state.push('math_block', '', 0); token.content = tex; token.meta = { delimiter: bracket ? '\\[' : '$$' }; token.map = [start, next + 1]; state.line = next + 1; }
  return true;
});
tokenizer.inline.ruler.before('escape', 'folio_tex_math', (state, silent) => {
  const from = state.pos;
  if (state.src.slice(from, from + 2) !== '\\(') return false;
  let to = from + 2;
  for (; to < state.posMax; to++) {
    if (state.src[to] === '\n') return false;
    if (state.src[to] === '\\') {
      if (state.src[to + 1] === ')') break;
      to++;
    }
  }
  if (to >= state.posMax || to === from + 2) return false;
  if (!silent) { const token = state.push('math_inline', '', 0); token.content = state.src.slice(from + 2, to); token.meta = { delimiter: '\\(' }; }
  state.pos = to + 2; return true;
});
tokenizer.inline.ruler.after('escape', 'folio_math', (state, silent) => {
  const from = state.pos;
  if (state.src[from] !== '$' || state.src[from + 1] === '$' || /\s/.test(state.src[from + 1] || ' ')) return false;
  let to = from + 1;
  for (; to < state.posMax; to++) {
    if (state.src[to] === '\\') { to++; continue; }
    if (state.src[to] === '\n') return false;
    if (state.src[to] === '$') break;
  }
  // A digit-leading span that closes on a price separator (`$5-`) is currency,
  // not TeX. Without this, `I paid $5-$x for it` yields a bogus math node.
  const currency = /\d/.test(state.src[from + 1] || '') && /[-.,]/.test(state.src[to - 1] || '');
  if (to >= state.posMax || /\s/.test(state.src[to - 1]) || /\d/.test(state.src[to + 1] || '') || currency) return false;
  if (!silent) { const token = state.push('math_inline', '', 0); token.content = state.src.slice(from + 1, to); }
  state.pos = to + 1; return true;
});
// Author span-level HTML that the rich view renders as real sanitized elements
// (keyboard keys, variables, sample output...). A balanced open..close pair
// for an allowlisted tag becomes ONE html_inline token carrying the exact
// source, so the document keeps a single raw_inline atom with a verbatim
// round-trip. Anything else falls through to the default single-tag
// tokenization below, which keeps the previous code-chip rendering.
export const INLINE_HTML_SPAN_TAGS = ['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'del', 'dfn', 'em', 'i', 'ins', 'kbd', 'mark', 'meter', 'progress', 'q', 'ruby', 'rp', 'rt', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'u', 'var', 'wbr'];
tokenizer.inline.ruler.before('html_inline', 'folio_html_span', (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x3C /* < */) return false;
  const rest = state.src.slice(state.pos, state.posMax);
  const open = /^<([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?)*)\s*(\/?)>/.exec(rest);
  if (!open || open[3]) return false;
  const name = open[1].toLowerCase();
  if (!INLINE_HTML_SPAN_TAGS.includes(name)) return false;
  // Balanced close: the first `</name>` at nesting depth zero. Inner markup
  // of any kind is preserved verbatim as part of the pair's exact source.
  let depth = 1, cursor = open[0].length;
  while (depth > 0) {
    const next = rest.indexOf('<', cursor);
    if (next < 0) return false;
    const tag = /^<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?)*)\s*(\/?)>/.exec(rest.slice(next));
    if (!tag || tag[1] !== '/') {
      if (tag && !tag[1] && !tag[4] && tag[2].toLowerCase() === name) depth++;
      cursor = next + 1;
      continue;
    }
    if (tag[2].toLowerCase() !== name) { cursor = next + 1; continue; }
    depth--;
    cursor = next + tag[0].length;
    if (depth === 0) {
      if (!silent) {
        const token = state.push('html_inline', '', 0);
        token.content = rest.slice(0, cursor);
      }
      state.pos += cursor;
      return true;
    }
  }
  return false;
});
tokenizer.core.ruler.after('inline', 'folio_structure', state => {
  const expanded = [];
  for (let i = 0; i < state.tokens.length; i++) {
    const token = state.tokens[i];
    if (token.type === 'inline') for (const child of token.children || []) if (child.type === 'html_inline' && /^<br\s*\/?>$/i.test(child.content)) child.type = 'hardbreak';
    if (token.type === 'list_item_open') {
      const inline = state.tokens[i + 2];
      const match = inline?.type === 'inline' && /^\[([ xX])\](?: |$)/.exec(inline.content);
      if (match && inline.children?.[0]?.type === 'text') {
        token.meta = { checked: match[1] !== ' ' };
        inline.content = inline.content.slice(match[0].length); inline.children[0].content = inline.children[0].content.slice(match[0].length);
      }
    }
    if (token.type === 'td_close' || token.type === 'th_close') expanded.push(new state.Token('paragraph_close', 'p', -1));
    expanded.push(token);
    if (token.type === 'td_open' || token.type === 'th_open') expanded.push(new state.Token('paragraph_open', 'p', 1));
  }
  // Comrak extensions that are not represented by the rich schema retain a
  // native-sanitized projection plus their exact, editable source. Never
  // serialize unknown syntax as escaped ordinary prose after a nearby edit.
  const offsets = [0]; for (let i = 0; i < state.src.length; i++) if (state.src[i] === '\n') offsets.push(i + 1);
  const result = [];
  for (let i = 0; i < expanded.length; i++) {
    const token = expanded[i];
    if (token.level === 0 && token.map && token.nesting !== -1 && !['fence', 'code_block', 'math_block', 'raw_block', 'html_block'].includes(token.type)) {
      const raw = state.src.slice(offsets[token.map[0]], offsets[token.map[1]] ?? state.src.length);
      // A shortcode needs at least one non-hyphen character.  Otherwise the
      // delimiter row of a center-aligned GFM table (`|:---:|`) is mistaken
      // for `:emoji:` syntax and the table is replaced by a raw block.
      // Only balanced extension delimiters qualify. A plain comparison
      // (`x == y`), a clock time (`12:30:`) or a setext underline (`=====`)
      // must stay ordinary Markdown, not become a raw read-only block.
      // Inline math already has a rich node. Do not mistake its TeX exponent
      // or tilde characters for unsupported superscript/subscript syntax.
      // Mask only the same bounded, single-line dollar spans accepted by the
      // inline rule above; retain line breaks and never mutate the source.
      const extensionCandidate = raw.replace(/(?<![\\$])\$(?![$\s])(?:[^$\\\n]|\\.)*?(?<!\s)\$(?!\d)/g, match => {
        if (/^\$\d/.test(match) && /[-.,]\$$/.test(match)) return match;
        return ' '.repeat(match.length);
      });
      if (/\[\^[^\]]+\]|\[\[[^\]]*\]\]|==(?=\S)(?:(?!==)[^\n])+?(?<=\S)==|(?<![+\p{L}\p{N}_])\+\+(?=\S)(?:(?!\+\+)[^\n])+?(?<=\S)\+\+(?![+\p{L}\p{N}_])|(?:^|\n)\s*:\s|(?:^|\n)>\s*\[!|\^[^\s^]+\^|(?<!~)~[^~\n]+~(?!~)|(?<!\\):[a-z_][a-z0-9_+-]*:/iu.test(extensionCandidate)) {
        const fallback = new state.Token('raw_block', '', 0); fallback.content = raw; fallback.map = token.map;
        result.push(fallback);
        // Skip the whole original block by nesting depth.  Synthetic level-0
        // paragraph tokens inside table cells are balanced, so they cannot
        // terminate this scan early (their level is not their real depth).
        if (token.nesting === 1) {
          let depth = 1;
          while (i + 1 < expanded.length && depth > 0) {
            const next = expanded[++i];
            if (next.nesting === 1) depth++;
            else if (next.nesting === -1) depth--;
          }
        }
        continue;
      }
    }
    result.push(token);
  }
  state.tokens = result;
});

tokenizer.core.ruler.push('folio_source_tokens', state => { state.env.folioSourceTokens = state.tokens; });
const tableAttrs = token => ({ align: /text-align:(left|right|center)/.exec(token.attrGet('style') || '')?.[1] || null });
export const parser = new MarkdownParser(schema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  bullet_list: { block: 'bullet_list', getAttrs: token => ({ tight: true, bullet: token.markup || '-' }) },
  list_item: { block: 'list_item', getAttrs: token => ({ checked: token.meta?.checked ?? null }) },
  table: { block: 'table' }, thead: { ignore: true }, tbody: { ignore: true }, tr: { block: 'table_row' },
  th: { block: 'table_header', getAttrs: tableAttrs }, td: { block: 'table_cell', getAttrs: tableAttrs },
  s: { mark: 'strike' }, raw_block: { block: 'raw_block', noCloseToken: true }, html_block: { block: 'raw_block', noCloseToken: true },
  html_inline: { node: 'raw_inline', getAttrs: token => ({ source: token.content }) },
  math_inline: { node: 'math_inline', getAttrs: token => ({ tex: token.content, delimiter: token.meta?.delimiter || '$' }) },
  softbreak: { node: 'soft_break' },
  math_block: { node: 'math_block', getAttrs: token => ({ tex: token.content, delimiter: token.meta?.delimiter || '$$' }) }
});

const serializerNodes = {
  ...defaultMarkdownSerializer.nodes,
  list_item(state, node) { if (node.attrs.checked !== null) state.write(node.attrs.checked ? '[x] ' : '[ ] '); state.renderContent(node); },
  raw_block(state, node) { state.write(node.textContent); state.closeBlock(node); },
  raw_inline(state, node) { state.write(node.attrs.source); },
  soft_break(state) { state.write('\n'); },
  math_inline(state, node) { state.write(node.attrs.delimiter === '\\(' ? `\\(${node.attrs.tex}\\)` : `$${node.attrs.tex}$`); },
  math_block(state, node) { state.write(node.attrs.delimiter === '\\[' ? `\\[\n${node.attrs.tex}\n\\]` : `$$\n${node.attrs.tex}\n$$`); state.closeBlock(node); },
  table(state, node) {
    const rows = [];
    node.forEach(row => {
      const cells = [];
      row.forEach(cell => cells.push(serializeTableCell(cell)));
      rows.push(cells);
    });
    if (!rows.length) return;
    state.write('| ' + rows[0].join(' | ') + ' |\n');
    const alignment = []; node.firstChild.forEach(cell => alignment.push(cell.attrs.align === 'right' ? '---:' : cell.attrs.align === 'center' ? ':---:' : cell.attrs.align === 'left' ? ':---' : '---'));
    state.write('| ' + alignment.join(' | ') + ' |');
    for (const row of rows.slice(1)) state.write('\n| ' + row.join(' | ') + ' |');
    state.closeBlock(node);
  }
};
const serializerMarks = { ...defaultMarkdownSerializer.marks, strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true } };
export const serializer = new MarkdownSerializer(serializerNodes, serializerMarks);

// Table cells are GFM inline content.  A hard break must be written as a real
// <br>, not the normal block serializer's backslash+newline (which a blind
// newline replacement would leave as "\<br>" and reopen as literal text).
const tableCellSerializer = new MarkdownSerializer({
  ...serializerNodes,
  hard_break(state) { state.write('<br>'); }
}, serializerMarks);

function serializeTableCell(cell) {
  return tableCellSerializer.serialize(schema.nodes.doc.create(null, cell.content))
    .trim()
    .replace(/\n+/g, '<br>')
    .replace(/(?<!\\)\|/g, '\\|');
}

function blockText(node) { return serializer.serialize(schema.nodes.doc.create(null, Fragment.from(node))); }

function serializedBlock(node, oldRaw = '', hasFollowing = false) {
  let text = blockText(node);
  // An empty paragraph can own a whitespace-only raw slice (a blank separator
  // between blocks). Once it gains text it is a real block and must keep a
  // blank line before the following block; otherwise the next paragraph joins
  // it as a soft break. At EOF no extra trailing blank line is needed.
  if (hasFollowing && oldRaw && !/\S/.test(oldRaw) && !text.endsWith('\n\n') && !text.endsWith('\r\n\r\n')) {
    const newline = oldRaw.includes('\r\n') ? '\r\n' : '\n';
    return text.replace(/[\r\n]+$/, '') + newline + newline;
  }
  if (text.endsWith('\n')) return text;
  if (oldRaw) {
    const ending = /[\r\n]+$/.exec(oldRaw)?.[0];
    if (ending) text += ending;
    return text;
  }
  return text + '\n';
}

function sourceGaps(previous) {
  const segments = previous.segments || [];
  const source = previous.source || '';
  if (Array.isArray(previous.gaps) && previous.gaps.length === segments.length + 1) return previous.gaps;
  const gaps = new Array(segments.length + 1).fill('');
  if (!segments.length) { gaps[0] = source; return gaps; }
  gaps[0] = source.slice(0, segments[0].from ?? 0);
  for (let i = 0; i < segments.length; i++) {
    const to = i + 1 < segments.length ? (segments[i + 1].from ?? segments[i].to ?? source.length) : source.length;
    gaps[i + 1] = source.slice(segments[i].to ?? 0, to);
  }
  return gaps;
}

let sourceParseCount = 0, sourceParseBytes = 0;
export function resetEditorStats() { sourceParseCount = 0; sourceParseBytes = 0; }
export function editorStats() { return { sourceParses: sourceParseCount, sourceParseBytes }; }
export function parseSource(source, sourceEdit = null) {
  sourceParseCount++; sourceParseBytes += source.length;
  const environment = {};
  let doc = parser.parse(source, environment);
  const tokens = environment.folioSourceTokens;
  const offsets = [0]; for (let i = 0; i < source.length; i++) if (source[i] === '\n') offsets.push(i + 1);
  const blocks = [];
  for (const token of tokens) {
    if (token.level !== 0 || !token.map || token.nesting === -1) continue;
    blocks.push({ from: offsets[token.map[0]] ?? 0, to: offsets[token.map[1]] ?? source.length });
  }

  const segments = [], gaps = [];
  let cursor = 0;
  if (!blocks.length) {
    // An empty/whitespace-only file is represented by one empty paragraph.
    const node = doc.firstChild;
    if (doc.childCount === 1 && node && node.type.name === 'paragraph' && !node.content.size) {
      gaps.push('', source);
      segments.push({ node, from: 0, to: 0, raw: '' });
    } else {
      gaps.push(source);
    }
  } else {
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      gaps.push(source.slice(cursor, block.from));
      const node = index < doc.childCount ? doc.child(index) : null;
      if (!node) continue;
      const raw = source.slice(block.from, block.to);
      segments.push({ node, from: block.from, to: block.to, raw });
      cursor = block.to;
    }
    gaps.push(source.slice(cursor));
  }
  if (sourceEdit) {
    const first = segments.findIndex(segment => segment.to > sourceEdit.from || segment.from === sourceEdit.from);
    let last = first;
    while (last + 1 < segments.length && segments[last + 1].from < sourceEdit.to) last++;
    if (first >= 0) {
      const from = segments[first].from, to = segments[last].to;
      const raw = source.slice(from, to);
      const text = raw.replace(/\r?\n$/, '');
      const node = schema.nodes.raw_block.create({ kind: 'source-edit' }, text ? schema.text(text) : null);
      segments.splice(first, last - first + 1, { node, from, to, raw });
      doc = schema.nodes.doc.create(null, segments.map(segment => segment.node));
      sourceEdit = { from, to };
      // Projection can merge several parsed blocks; its gap ledger must
      // describe those displayed segments too (composition uses this path).
      gaps.length = 0; cursor = 0;
      for (const segment of segments) { gaps.push(source.slice(cursor, segment.from)); cursor = segment.to; }
      gaps.push(source.slice(cursor));
    }
  }
  return { doc, source, sourceEdit, prefix: gaps[0] ?? '', segments, gaps,
    syntaxFacts: { hasReferences: Object.keys(environment.references || {}).length > 0 },
    ledger: buildLedger(source, doc, { tokens, segments }) };
}

export function updateSource(doc, previous) {
  const oldSegments = previous.segments || [];
  const oldGaps = sourceGaps(previous);
  const oldCount = oldSegments.length;
  const newCount = doc.childCount;
  const segments = [], gaps = [];
  let source = '';
  let pendingGap = oldCount ? (oldGaps[0] ?? '') : '';
  source += pendingGap;
  const newline = /\r\n/.test(previous.source || source) ? '\r\n' : '\n';

  const addGapText = text => {
    if (!text) return;
    source += text;
    pendingGap += text;
  };
  const appendGapText = text => {
    if (!text) return;
    if (pendingGap) {
      const units = newline === '\r\n' ? ['\r\n\r\n', '\r\n'] : ['\n\n', '\n'];
      if (pendingGap.endsWith(units[0]) && text.startsWith(units[1])) text = text.slice(units[1].length);
    }
    addGapText(text);
  };
  const addSegment = (node, raw) => {
    const from = source.length;
    source += raw;
    segments.push({ node, from, to: source.length, raw });
    gaps.push(pendingGap);
    pendingGap = '';
  };
  const addSeparator = () => {
    if (!source) return;
    if (source.endsWith(newline + newline)) return;
    addGapText(source.endsWith(newline) ? newline : newline + newline);
  };
  let deletedAtStart = false;
  let changedBefore = false;
  const emitHunk = (newStart, newEnd, oldStart, oldEnd) => {
    const replacing = oldEnd > oldStart;
    const deleting = replacing && newEnd === newStart;
    if (replacing && oldStart > 0) {
      const gap = oldGaps[oldStart] ?? '';
      // A whitespace-only separator belongs to the removed block.  Keep a
      // non-whitespace leading gap so reference definitions/comments are not
      // silently dropped.
      if (!deleting || /\S/.test(gap)) appendGapText(gap);
    }
    if (deleting && oldStart === 0) deletedAtStart = true;
    for (let index = newStart; index < newEnd; index++) {
      if (index === newStart) {
        // A genuinely inserted block needs a separating boundary.  A
        // replacement already sits where its old leading gap was emitted.
        if (!replacing) addSeparator();
      } else addSeparator();
      const node = doc.child(index);
      const template = replacing ? (oldSegments[oldStart]?.raw ?? '') : '';
      addSegment(node, serializedBlock(node, template, index < newEnd - 1 || newEnd < newCount));
    }
    if (oldEnd > oldStart || newEnd > newStart) changedBefore = true;
  };

  // Unchanged node identity is the only allowed anchor.  Rich nodes are
  // immutable, so unchanged blocks remain the same object across transactions;
  // edited/split/joined nodes do not.  We never compare rendered text or use
  // node equality to relocate a later block (and its attached gaps).
  const oldIndices = new Map();
  oldSegments.forEach((segment, index) => {
    if (!oldIndices.has(segment.node)) oldIndices.set(segment.node, []);
    oldIndices.get(segment.node).push(index);
  });
  const anchors = [];
  let lastOld = -1;
  for (let index = 0; index < newCount; index++) {
    const indices = oldIndices.get(doc.child(index));
    if (!indices) continue;
    const oldIndex = indices.find(candidate => candidate > lastOld);
    if (oldIndex === undefined) continue;
    anchors.push({ newIndex: index, oldIndex });
    lastOld = oldIndex;
  }

  let newCursor = 0, oldCursor = 0;
  for (const anchor of anchors) {
    emitHunk(newCursor, anchor.newIndex, oldCursor, anchor.oldIndex);
    // gap[0] is the prefix and was emitted before any content.  If blocks
    // were inserted at the very start, the old first block still needs a real
    // separator from the new block (the prefix is not a separator).
    if (anchor.oldIndex === 0 && segments.length > 0) addSeparator();
    if (anchor.oldIndex > 0) {
      let gap = oldGaps[anchor.oldIndex] ?? '';
      // Deleting the first block must not leave its trailing blank separator
      // as a new leading blank line.  Reference-bearing gaps are retained.
      if (deletedAtStart && segments.length === 0 && !/\S/.test(gap)) gap = '';
      // A changed/inserted/deleted hunk may have consumed the separator that
      // used to sit between blocks.  Restore a blank-line boundary before the
      // next unchanged block rather than letting paragraphs merge on reparse.
      const boundaryBlank = source.endsWith(newline + newline) ||
        (source.endsWith(newline) && gap.startsWith(newline));
      if (changedBefore && !boundaryBlank) addSeparator();
      appendGapText(gap);
    }
    deletedAtStart = false;
    changedBefore = false;
    const old = oldSegments[anchor.oldIndex];
    addSegment(old.node, old.raw);
    newCursor = anchor.newIndex + 1;
    oldCursor = anchor.oldIndex + 1;
  }
  emitHunk(newCursor, newCount, oldCursor, oldCount);
  appendGapText(oldGaps[oldCount] ?? '');
  gaps.push(pendingGap);

  return {
    doc, source,
    prefix: gaps[0] ?? previous.prefix ?? '',
    segments, gaps, ledger: null
  };
}

function ledgerFor(model) {
  if (!model.ledger) model.ledger = buildLedger(model.source, model.doc, { segments: model.segments });
  return model.ledger;
}

// The legacy APIs keep returning a number.  Callers that must not commit an
// edit through an unsupported/fuzzy translation should use these full mapping
// objects and inspect `exact`/`confidence` first.
export function sourceMapping(model, position, options = {}) {
  return mapLedgerSource(ledgerFor(model), position, { bias: 'right', ...options });
}
export function richMapping(model, position, options = {}) {
  return mapLedgerRich(ledgerFor(model), position, { bias: 'right', ...options });
}
export function sourceToRich(model, position) { return sourceMapping(model, position).pm; }
export function richToSource(model, position) { return richMapping(model, position).source; }
