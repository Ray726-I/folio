const assert=require('node:assert/strict');
const fs=require('node:fs');

const theme=fs.readFileSync('ui/theme.js','utf8');
const mermaid=fs.readFileSync('ui/vendor/mermaid/mermaid.min.js','utf8');
const functionSource=theme.match(/function mermaidThemeCSS\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(functionSource,'Mermaid theme CSS helper exists');
const css=Function('diagramSurface',`${functionSource}; return mermaidThemeCSS();`)(()=>({cardSoft:'#292929'}));
const selector=css.match(/^([^{}]+)\s*\{/ )?.[1];
assert.ok(selector,'ER theme patch has a selector');

// Mermaid 11 assigns IDs like entity-CUSTOMER-0 to ER entities.
assert.ok(mermaid.includes('id:`entity-${t}-${this.entities.size}`'),'pinned Mermaid version uses the expected ER entity ID format');
const entityId='entity-CUSTOMER-0';
const idPrefix=selector.match(/\[id\^="([^"]+)"\]/)?.[1];
assert.ok(idPrefix&&entityId.startsWith(idPrefix),`ER theme selector matches generated entity ID ${entityId}`);
assert.match(selector,/path\[fill\^="hsl\("\]/,'ER theme selector targets generated attribute row paths');
console.log('PASS: ER theme patch targets Mermaid entity IDs');
