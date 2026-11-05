const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Author <progress>/<meter> markup is rendered as a real bar instead of an
// inline-code chip. Only the bar's own numeric attributes survive; handlers,
// styles and arbitrary attributes stay dropped, and the source round-trips.
const source = `# Bars

Progress: <progress value="72" max="100" onclick="alert(1)" style="color:red" class="x"> 72% </progress>

Meter: <meter min="0" max="100" value="64"> 64% </meter>

Unknown: <progress value="oops" max="100"> oops </progress>
`;

const read = page => page.evaluate(() => {
  const progress = [...document.querySelectorAll('#preview progress')];
  const meter = document.querySelector('#preview meter');
  return {
    progress: progress.map(node => ({
      value: node.getAttribute('value'),
      max: node.getAttribute('max'),
      onclick: node.getAttribute('onclick'),
      style: node.getAttribute('style'),
      className: node.getAttribute('class'),
      width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height,
    })),
    meter: meter ? { value: meter.getAttribute('value'), min: meter.getAttribute('min'), max: meter.getAttribute('max') } : null,
    chips: document.querySelectorAll('#preview .html-inline code').length,
    content: typeof current === 'undefined' ? null : current.content,
  };
});

(async () => {
  for (const reading of [false, true]) {
    const session = await openEditor(source, undefined, { reading });
    const { page } = session;
    try {
      await page.waitForFunction(() => document.querySelector('#preview progress'));
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(200);
      const state = await read(page);
      const mode = reading ? 'reading' : 'edit';

      assert.equal(state.progress.length, 2, `${mode}: both progress elements render`);
      assert.deepEqual(
        { value: state.progress[0].value, max: state.progress[0].max },
        { value: '72', max: '100' },
        `${mode}: the bar keeps its numeric attributes`,
      );
      assert.equal(state.progress[0].onclick, null, `${mode}: event handlers are dropped`);
      assert.equal(state.progress[0].style, null, `${mode}: inline styles are dropped`);
      assert.equal(state.progress[0].className, null, `${mode}: arbitrary attributes are dropped`);
      assert.ok(state.progress[0].width > 40 && state.progress[0].height <= 20, `${mode}: the bar is a slim inline track, got ${state.progress[0].width}x${state.progress[0].height}`);
      assert.equal(state.progress[1].value, null, `${mode}: a non-numeric value is dropped rather than guessed`);
      assert.equal(state.chips, 0, `${mode}: the bar is not an inline-code chip`);
      assert.deepEqual(state.meter, { value: '64', min: '0', max: '100' }, `${mode}: the meter keeps its numeric attributes`);
      if (!reading) assert.equal(state.content, source, 'rendering the bars leaves the Markdown untouched');
      assert.deepEqual(session.errors, []);
    } finally { await session.close(); }
  }
  console.log('PASS: progress and meter render as themed bars in both modes, with only numeric attributes and an unchanged source.');
})().catch(error => { console.error(error); process.exitCode = 1; });
