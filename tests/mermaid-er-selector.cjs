const assert=require('node:assert/strict');
const fs=require('node:fs');

const theme=fs.readFileSync('ui/theme.js','utf8');
const mermaid=fs.readFileSync('ui/vendor/mermaid/mermaid.min.js','utf8');
const functionSource=theme.match(/function mermaidThemeCSS\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(functionSource,'Mermaid theme CSS helper exists');
const css=Function('diagramSurface',`${functionSource}; return mermaidThemeCSS();`)(()=>({cardSoft:'#292929'}));
const selector=css.match(/^([^{}]+)\s*\{/ )?.[1];
assert.ok(selector,'ER theme patch has a selector');

// Mermaid 11 renders ER attribute rows as .row-rect-odd/.row-rect-even
// groups whose fill paths carry an inline hsl() colour.
assert.ok(mermaid.includes('row-rect-'),'pinned Mermaid version uses ER row classes');
assert.ok(selector.includes('.erDiagram .row-rect-odd')&&selector.includes('.erDiagram .row-rect-even'),'ER theme selector targets generated attribute rows');
assert.match(selector,/path\[fill\^="hsl\("\]/,'ER theme selector targets generated attribute row paths');
console.log('PASS: ER theme patch targets Mermaid attribute row classes');
