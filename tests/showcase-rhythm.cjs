const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

const source = `# Showcase

> A callout-like quote that should share the rounded card language.

## 5. Mathematics

$$
(a+b)^2 = a^2 + 2ab + b^2
$$

## 6. Mermaid Diagrams

## 6.1 Flowchart

\`\`\`mermaid
flowchart TD
    A([Start]) --> B[End]
\`\`\`

## 6.2 Sequence diagram

\`\`\`mermaid
sequenceDiagram
    A->>B: Hello
\`\`\`

## 6.3 Class diagram

Text.
`;

(async () => {
  const session = await openEditor(source, { width: 1000, height: 900 });
  try {
    const { page, errors } = session;
    await page.waitForFunction(() => document.querySelectorAll('.mermaid-host svg').length === 2 && document.querySelector('.math-block .katex'));
    const rhythm = await page.evaluate(() => {
      const style = selector => getComputedStyle(document.querySelector(selector));
      const quote = style('#preview blockquote'), math = style('.math-block'), diagram = style('.mermaid-host');
      return {
        quoteRadius: parseFloat(quote.borderTopLeftRadius),
        quoteBorder: parseFloat(quote.borderLeftWidth),
        mathTop: parseFloat(math.paddingTop),
        mathBottom: parseFloat(math.paddingBottom),
        diagramTop: parseFloat(diagram.paddingTop),
        diagramBottom: parseFloat(diagram.paddingBottom)
      };
    });
    assert.ok(rhythm.quoteRadius >= 10, 'the callout uses the same rounded cards as math blocks');
    assert.equal(rhythm.quoteBorder, 3, 'the callout keeps its accent edge');
    assert.ok(rhythm.mathTop <= 10 && rhythm.mathBottom <= 10, 'math blocks use denser vertical padding');
    assert.ok(rhythm.diagramTop >= 10 && rhythm.diagramBottom > rhythm.diagramTop, 'diagrams get deliberate vertical breathing room');

    // The all-documents control is used to open the palette and receives focus
    // back when it closes. Its focus indication should be a hairline, not a
    // thick accent frame that stays around a previously used icon.
    await page.click('#all-documents');
    await page.waitForSelector('#command-dialog[open]');
    await page.keyboard.press('Escape');
    const focus = await page.evaluate(() => {
      const button = document.getElementById('all-documents');
      const style = getComputedStyle(button), base = document.createElement('span');
      base.style.background = 'var(--hover)'; document.body.append(base);
      const hover = getComputedStyle(base).backgroundColor; base.remove();
      return { focused: document.activeElement === button, visible: button.matches(':focus-visible'), outline: style.outlineStyle, background: style.backgroundColor, hover };
    });
    assert.equal(focus.focused, true, 'closing the palette returns focus to its trigger');
    assert.ok(focus.visible, 'the trigger receives visible keyboard focus');
    assert.equal(focus.outline, 'none', 'a previously used control does not keep a colored border');
    assert.notEqual(focus.background, 'rgba(0, 0, 0, 0)', 'keyboard focus is still marked with a quiet fill');
    assert.deepEqual(errors, []);
    console.log('PASS: callouts, math density, diagram rhythm, and quiet focus rings are consistent.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
