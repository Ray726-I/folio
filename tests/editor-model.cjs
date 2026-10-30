const assert = require('node:assert/strict');
const path = require('node:path');
require('esbuild').buildSync({ entryPoints: ['ui/editor/model.js'], bundle: true, platform: 'node', format: 'cjs', outfile: 'target/editor-model.cjs', logLevel: 'silent' });
const { parseSource, updateSource, schema, sourceToRich, richToSource } = require(path.resolve('target/editor-model.cjs'));
const original = '---\ntitle: preserved\n---\n\n# Heading\n\nText **bold** café 😀.\n\n| A | B |\n|:--|--:|\n| **one** | $x^2$ |\n\n- [ ] Task\n\n<!-- exact  spaces -->\n';
const model = parseSource(original);
assert.equal(updateSource(model.doc, model).source, original);
assert.deepEqual(model.doc.content.content.map(node => node.type.name), ['raw_block', 'heading', 'paragraph', 'table', 'bullet_list', 'raw_block']);
assert.equal(model.doc.child(3).firstChild.firstChild.type.name, 'table_header');
assert.equal(model.doc.child(3).child(1).child(1).firstChild.firstChild.type.name, 'math_inline');
assert.equal(model.doc.child(4).firstChild.attrs.checked, false);
const children = model.doc.content.content.slice();
children[1] = schema.nodes.heading.create({ level: 1 }, schema.text('Heading edited'));
const changed = updateSource(schema.nodes.doc.create(null, children), model);
assert.equal(changed.source, original.replace('# Heading\n', '# Heading edited\n'));
for (const needle of ['Heading', 'Text', 'café', 'one', 'Task']) {
  const offset = original.indexOf(needle) + 2;
  const pos = sourceToRich(model, offset);
  assert.ok(Math.abs(richToSource(model, pos) - offset) <= 1, `selection mapping for ${needle}: ${pos} -> ${richToSource(model, pos)} expected ${offset}`);
}

// GFM table cells must serialize hard_break as a real <br>, not a backslash
// followed by a newline that becomes literal escaped text on reopen.
const hardBreakSource = '| A | B |\n|---|---|\n| he<br>llo | 2 |\n';
const hardBreakModel = parseSource(hardBreakSource);
let hardBreaks = 0;
hardBreakModel.doc.descendants(node => { if (node.type.name === 'hard_break') hardBreaks++; });
assert.equal(hardBreaks, 1, 'source parses to one hard_break node');
const tableNode = hardBreakModel.doc.child(0);
const rebuiltTableDoc = schema.nodes.doc.create(null, [tableNode.copy(tableNode.content)]);
const rebuiltTable = updateSource(rebuiltTableDoc, hardBreakModel);
assert.match(rebuiltTable.source, /he<br>llo/, 'table cell hard break serializes as <br>');
assert.doesNotMatch(rebuiltTable.source, /\\<br>/, 'no escaped backslash remains before <br>');
const reparsedTable = parseSource(rebuiltTable.source);
assert.ok(reparsedTable.doc.eq(rebuiltTable.doc), 'rebuilt table source reparses to the same doc');
let reparsedBreaks = 0;
reparsedTable.doc.descendants(node => { if (node.type.name === 'hard_break') reparsedBreaks++; });
assert.equal(reparsedBreaks, 1, 'reopened table keeps one real hard_break');

// Center-aligned delimiter rows (`|:---:|`) are GFM table syntax, not an
// emoji shortcode.  Opening such a table must not throw or degrade to source.
const centeredSource = '| A | B |\n|:---:|:---:|\n| one | two |\n';
const centeredModel = parseSource(centeredSource);
assert.deepEqual(centeredModel.doc.content.content.map(node => node.type.name), ['table']);
assert.equal(centeredModel.doc.child(0).firstChild.firstChild.attrs.align, 'center');
assert.equal(centeredModel.doc.child(0).child(1).firstChild.attrs.align, 'center');
assert.equal(updateSource(centeredModel.doc, centeredModel).source, centeredSource);

// A table that genuinely contains extension syntax becomes one raw block; its
// nested table tokens are skipped by nesting depth, not by synthetic levels.
const extensionTableSource = '| A |\n|:---:|\n| :smile: |\n';
const extensionTableModel = parseSource(extensionTableSource);
assert.deepEqual(extensionTableModel.doc.content.content.map(node => node.type.name), ['raw_block']);
assert.equal(updateSource(extensionTableModel.doc, extensionTableModel).source, extensionTableSource);

// A Comrak footnote definition (`[^1]:`) is not a Markdown link reference
// definition. It must stay visible as an extension block instead of being
// consumed by markdown-it's link-reference parser and disappearing from the
// rich view (while only the reference paragraph remained).
const footnoteSource = 'Reference[^1].\n\n[^1]: Definition.\n';
const footnoteModel = parseSource(footnoteSource);
assert.deepEqual(footnoteModel.doc.content.content.map(node => node.type.name), ['raw_block', 'raw_block']);
assert.equal(footnoteModel.doc.child(1).textContent, '[^1]: Definition.');
assert.equal(updateSource(footnoteModel.doc, footnoteModel).source, footnoteSource);

// Currency amounts are prose, not inline math. A digit-leading `$...$` whose
// content ends in a price separator (`$5-$`) must not spawn math nodes, and
// the surrounding currency string must round-trip verbatim.
for (const currencySource of ['$5-$\n', 'I paid $5-$x for it\n']) {
  const currencyModel = parseSource(currencySource);
  let mathNodes = 0;
  currencyModel.doc.descendants(node => { if (node.type.name === 'math_inline') mathNodes++; });
  assert.equal(mathNodes, 0, `currency is not math: ${currencySource.trim()}`);
  assert.equal(updateSource(currencyModel.doc, currencyModel).source, currencySource);
}

// Digit-leading math with an ordinary expression/operand stays math.
for (const mathSource of ['$2+2$\n', '$5$']) {
  const digitMathModel = parseSource(mathSource);
  assert.equal(digitMathModel.doc.firstChild.firstChild.type.name, 'math_inline', `digit math still parses: ${mathSource}`);
}

const empty = parseSource(''); assert.equal(updateSource(empty.doc, empty).source, '');
console.log('PASS: source slices, unchanged extensions, GFM table/task/math model, table hard-break reparse, centered-alignment open and cross-projection position mapping.');
