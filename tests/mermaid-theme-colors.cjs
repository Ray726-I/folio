const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {openEditor}=require('./editor-browser.cjs');
(async()=>{
 const s=await openEditor('# Theme\n');
 try {
  const app=s.page, renderer=await s.browser.newPage();
  await renderer.goto(pathToFileURL(path.resolve('ui/mermaid-renderer.html')).href);
  await renderer.waitForFunction(()=>window.FolioMermaidRenderer&&window.mermaid);
  const diagrams={flow:'flowchart TD\n A[Start] --> B[Finish]',sequence:'sequenceDiagram\n Alice->>Bob: Hello',class:'classDiagram\n class Animal\n Animal : +String name',er:'erDiagram\n CUSTOMER ||--o{ ORDER : places',state:'stateDiagram-v2\n [*] --> Idle\n Idle --> Done',git:'gitGraph\n commit\n branch feature\n checkout feature\n commit\n checkout main\n merge feature',gantt:'gantt\n dateFormat YYYY-MM-DD\n section Work\n Build :2026-01-01, 3d',pie:'pie\n "Work" : 3\n "Rest" : 2',mindmap:'mindmap\n root((Root))\n   One\n   Two'};
  for(const theme of ['paper','graphite']) {
   const vars=await app.evaluate(theme=>{applyTheme(theme,false);return mermaidThemeVariables();},theme);
   assert.notEqual(vars.primaryColor,await app.evaluate(()=>cssVarColor('--diagram-node')),`${theme}: ordinary nodes have a colored fill`);
   assert.ok(vars.git0&&vars.git1&&vars.git0!==vars.git1,`${theme}: git branches have distinct colors`);
   assert.ok(await app.evaluate(v=>colorContrast(v.primaryTextColor,v.primaryColor)>=4.5,vars),`${theme}: node text has readable contrast`);
   for(const [name,source] of Object.entries(diagrams)) {
    const result=await renderer.evaluate(async({source,vars})=>window.FolioMermaidRenderer.renderRequest({source,theme:{variables:vars}}),{source,vars});
    assert.ok(result.svg?.startsWith('<svg'),`${theme} ${name} renders`);
    const colors=name==='git'?[vars.git0,vars.git1]:name==='gantt'?[vars.taskBkgColor,vars.doneTaskBkgColor]:name==='pie'?[vars.pie1,vars.pie2]:name==='mindmap'?[vars.cScale0,vars.cScale1]:[vars.primaryColor,vars.mainBkg,vars.actorBkg];
    assert.ok(colors.some(color=>result.svg.toLowerCase().includes(color.toLowerCase())),`${theme} ${name} carries theme colors`);
   }
   const custom=await renderer.evaluate(async vars=>window.FolioMermaidRenderer.renderRequest({source:'flowchart TD\n A[Custom] --> B\n style A fill:#ff0000,stroke:#aa0000',theme:{variables:vars}}),vars);
   assert.ok(custom.svg.includes('#ff0000'),'authored styles remain intact');
   const css=await app.evaluate(()=>mermaidThemeCSS());
   const erPatch=await renderer.evaluate(async({vars,css})=>window.FolioMermaidRenderer.renderRequest({source:'erDiagram\n CUSTOMER {\n int id PK\n string name\n }',theme:{variables:vars,css}}),{vars,css});
   assert.ok(erPatch.svg.includes('path[fill^="hsl("]')&&erPatch.svg.includes('!important'),`${theme}: ER attribute rows keep the theme surface`);
   const erCoverage=await renderer.evaluate(({svg,css})=>{
    const document=new DOMParser().parseFromString(svg,'image/svg+xml');
    const selector=css.match(/^([^{}]+)\s*\{/)[1];
    return {matched:document.querySelectorAll(selector).length,rows:document.querySelectorAll('.row-rect-odd path[fill^="hsl("], .row-rect-even path[fill^="hsl("]').length};
   },{svg:erPatch.svg,css});
   assert.ok(erCoverage.rows>0,`${theme}: Mermaid ER entities expose attribute row paths`);
   assert.equal(erCoverage.matched,erCoverage.rows,`${theme}: ER theme patch matches every attribute row`);
  }
  await renderer.close();assert.deepEqual(s.errors,[]);console.log('PASS: Mermaid diagrams receive readable theme colors and preserve authored styles');
 }finally{await s.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
