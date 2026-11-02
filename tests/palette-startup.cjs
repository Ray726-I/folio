const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async()=>{
 const s=await openEditor('# Heading\n\nBody text and **strong text**.\n');
 try{
  const result=await s.page.evaluate(()=>{
   const original=window.getComputedStyle;
   // Native WebKit can report transparent for the off-screen probe before
   // its first layout. Root theme variables are already available.
   window.getComputedStyle=(element,...args)=>{
    const style=original.call(window,element,...args);
    if(element!==cssProbe)return style;
    return new Proxy(style,{get(target,key){return key==='backgroundColor'?'rgba(0, 0, 0, 0)':Reflect.get(target,key,target)}});
   };
   try{
    applyTheme('graphite',false);
    const dark={fg:original(root).getPropertyValue('--fg').trim(),body:root.style.getPropertyValue('--read-body'),accent:root.style.getPropertyValue('--read-accent')};
    applyTheme('paper',false);
    const light={fg:original(root).getPropertyValue('--fg').trim(),body:root.style.getPropertyValue('--read-body')};
    return {dark,light};
   }finally{window.getComputedStyle=original;}
  });
  assert.equal(result.dark.body,result.dark.fg,'startup preserves real dark-theme foreground');
  assert.equal(result.light.body,result.light.fg,'light-theme text is not faded toward its background');
  assert.equal(await s.page.evaluate(()=>normalizeColor('rgba(0, 0, 0, 0)')),'transparent','transparent must never be interpreted as black');
  assert.equal(await s.page.evaluate(()=>normalizeColor('rgb(255, 0, 0)')), '#ff0000', 'zero blue channel is not transparent alpha');
  const pending=await s.page.evaluate(()=>{
   const original=window.getComputedStyle;
   window.getComputedStyle=(element,...args)=>{
    const style=original.call(window,element,...args);
    if(element===root)return new Proxy(style,{get(target,key){return key==='getPropertyValue'?name=>name.startsWith('--')?'':target.getPropertyValue(name):Reflect.get(target,key,target)}});
    if(element===cssProbe)return new Proxy(style,{get(target,key){return key==='backgroundColor'?'rgba(0, 0, 0, 0)':Reflect.get(target,key,target)}});
    return style;
   };
   try { applyTheme('graphite',false); return root.style.getPropertyValue('--read-body'); }
   finally { window.getComputedStyle=original; }
  });
  assert.doesNotMatch(pending,/NaN/i,'missing first-frame tokens never produce an invalid palette');
  await s.page.waitForFunction(()=>/^#[0-9a-f]{6}$/i.test(root.style.getPropertyValue('--read-body')));
  assert.equal(await s.page.evaluate(()=>root.style.getPropertyValue('--read-body')),'#eeeeec','palette retries once layout is available');
  assert.deepEqual(s.errors,[]);
  console.log('PASS: native-style pre-layout color sampling, strong light/dark text and transparent handling');
 }finally{await s.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
