'use strict';
// Shell affordances stay outside the editor's source ledger and copied content.
function fuzzyFileScore(query, value) {
  if (!query) return 0;
  const text=value.toLocaleLowerCase(); let cursor=0, score=0, previous=-2;
  for(const character of query) {
    const at=text.indexOf(character,cursor); if(at<0)return -1;
    score+=at===previous+1?8:1; if(at===0||/[\s/\\._-]/.test(text[at-1]))score+=5;
    previous=at;cursor=at+1;
  }
  return score-text.length/1000;
}
function quickOpenCommands() {
  const rows=new Map();
  for(const doc of documents.values())rows.set(pathKey(doc.path||doc.documentId),{label:doc.name,detail:doc.path||'Unsaved document',icon:'file',action:()=>enqueue(()=>activateDocument(doc))});
  for(const entry of folderEntries)if(!entry.directory&&!rows.has(pathKey(entry.path)))rows.set(pathKey(entry.path),{label:entry.name,detail:entry.path,icon:'file',action:()=>requestOpen(entry.path)});
  return [...rows.values()];
}
function initializeTabScrolling() {
  const list=$('tab-list');
  const buttons=[];
  for(const [id,label,direction] of [['tab-scroll-previous','Scroll tabs left',-1],['tab-scroll-next','Scroll tabs right',1]]) {
    const button=document.createElement('button');button.id=id;button.className='icon-button tab-scroll';button.type='button';button.textContent=direction<0?'‹':'›';button.title=label;button.setAttribute('aria-label',label);
    button.onclick=()=>list.scrollBy({left:direction*Math.max(120,list.clientWidth*.7),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    direction<0?list.before(button):list.after(button);buttons.push(button);
  }
  const update=()=>{const overflow=list.scrollWidth>list.clientWidth+1;buttons.forEach(button=>button.hidden=!overflow);buttons[0].disabled=list.scrollLeft<=1;buttons[1].disabled=list.scrollLeft+list.clientWidth>=list.scrollWidth-1;};
  list.addEventListener('scroll',update,{passive:true});new ResizeObserver(update).observe(list);new MutationObserver(()=>requestAnimationFrame(update)).observe(list,{childList:true});update();
}
function initializeDocumentAffordances() {
  const bubble=document.createElement('div');bubble.className='selection-format';bubble.role='toolbar';bubble.setAttribute('aria-label','Format selection');bubble.hidden=true;
  for(const [label,command,text] of [['Bold','bold','B'],['Italic','italic','I'],['Link','link','Link'],['Inline code','code','<>']]) {
    const button=document.createElement('button');button.type='button';button.textContent=text;button.title=label;button.setAttribute('aria-label',label);
    button.onpointerdown=event=>{event.preventDefault();editor?.captureSelection?.();};
    button.onclick=()=>{if(documentMode==='edit'&&documentWritable())editor?.command(command);bubble.hidden=true;};bubble.append(button);
  }
  document.body.append(bubble);
  let bubbleFrame=0;
  const updateBubble=()=>{
    bubbleFrame=0;const selection=getSelection();
    if(bubble.contains(document.activeElement))return;
    if(documentMode!=='edit'||!documentWritable()||!selection||selection.isCollapsed||!$('preview').contains(selection.anchorNode)||!$('preview').contains(selection.focusNode)||selection.anchorNode.parentElement?.closest('pre,.code-container,.folio-source-edit')){bubble.hidden=true;return;}
    const rect=selection.getRangeAt(0).getBoundingClientRect();if(!rect.width||rect.bottom<0||rect.top>innerHeight){bubble.hidden=true;return;}
    bubble.hidden=false;const readerBounds=$('reader-scroll').getBoundingClientRect();bubble.style.left=`${Math.max(readerBounds.left+8,Math.min(readerBounds.right-bubble.offsetWidth-8,rect.left+(rect.width-bubble.offsetWidth)/2))}px`;bubble.style.top=`${Math.max(4,rect.top-bubble.offsetHeight-8)}px`;
  };
  const schedule=()=>{if(!bubbleFrame)bubbleFrame=requestAnimationFrame(updateBubble);};
  document.addEventListener('selectionchange',schedule);window.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule);
  new MutationObserver(schedule).observe(root,{attributes:true,attributeFilter:['data-document-mode']});
  bubble.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();bubble.hidden=true;editor?.focus();}};
  const copy=document.createElement('button');copy.className='code-copy';copy.type='button';copy.hidden=true;copy.setAttribute('aria-label','Copy code');copy.title='Copy code';copy.append(icon('copy'));document.body.append(copy);
  let codeBlock=null, copyTimer, copyFeedbackTimer;
  const setCopyState=copied=>{copy.querySelector('use').setAttribute('href',copied?'#i-check':'#i-copy');copy.setAttribute('aria-label',copied?'Code copied':'Copy code');copy.title=copied?'Copied':'Copy code';copy.classList.toggle('copied',copied);};
  const placeCopy=block=>{
    if(!block?.isConnected){copy.hidden=true;codeBlock=null;return;}
    if(codeBlock!==block){clearTimeout(copyFeedbackTimer);setCopyState(false);}
    codeBlock=block;const rect=block.getBoundingClientRect();copy.hidden=false;const width=copy.offsetWidth;copy.style.left=`${Math.max(8,Math.min(innerWidth-width-8,rect.right-width-8))}px`;copy.style.top=`${Math.max(0,rect.top+5)}px`;
  };
  document.addEventListener('pointerover',event=>{if(copy.contains(event.target))return;const block=event.target.closest?.('.code-container,pre');if(block&&!block.closest('.folio-source-edit')&&block.closest('#preview,#companion-preview')){clearTimeout(copyTimer);placeCopy(block);}else copyTimer=setTimeout(()=>{if(document.activeElement!==copy&&!copy.matches(':hover'))copy.hidden=true;},150);});
  document.addEventListener('focusin',event=>{const block=event.target.closest?.('.code-container,pre');if(block&&!block.closest('.folio-source-edit')&&block.closest('#preview,#companion-preview'))placeCopy(block);else if(event.target!==copy)copy.hidden=true;});
  copy.onpointerenter=()=>clearTimeout(copyTimer);
  copy.onclick=async()=>{const code=codeBlock?.querySelector('.code-surface code,pre code,code');if(!code)return;try{await navigator.clipboard.writeText(code.textContent);setCopyState(true);clearTimeout(copyFeedbackTimer);copyFeedbackTimer=setTimeout(()=>setCopyState(false),1800);}catch(error){toast(errorMessage(error));}};
  window.addEventListener('scroll',()=>{if(document.activeElement!==copy)copy.hidden=true;else placeCopy(codeBlock);},true);
  const makeCodeFocusable=node=>{
    if(!(node instanceof Element))return;
    for(const block of [node,...node.querySelectorAll('.code-container,pre')]) {
      const eligible=block.matches('.code-container')&&block.closest('#preview')||block.matches('pre')&&block.closest('#companion-preview');
      if(!eligible||block.closest('[aria-hidden="true"]'))continue;
      if(!block.hasAttribute('tabindex'))block.tabIndex=0;
    }
  };
  document.addEventListener('keydown',event=>{
    if(event.key!=='Tab')return;
    const block=event.target.closest?.('.code-container,pre');
    if(block&&block===codeBlock&&!event.shiftKey){event.preventDefault();placeCopy(block);copy.focus();}
    else if(event.target===copy&&event.shiftKey&&codeBlock?.isConnected){event.preventDefault();codeBlock.focus();}
    else if(event.target===copy&&codeBlock?.isConnected){
      const focusables=[...document.querySelectorAll('button,input,textarea,select,a[href],[tabindex]')].filter(el=>el.tabIndex>=0&&!el.disabled&&el.getClientRects().length);
      const next=focusables.slice(focusables.indexOf(codeBlock)+1).find(el=>el!==copy&&!codeBlock.contains(el));
      if(next){event.preventDefault();copy.hidden=true;next.focus();}
    }
  });
  for(const id of ['preview','companion-preview']) {
    new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)makeCodeFocusable(node);}).observe($(id),{childList:true,subtree:true});
    makeCodeFocusable($(id));
  }
  const progress=document.createElement('span');progress.id='reading-progress';progress.setAttribute('aria-label','Reading progress');$('statusbar').querySelector('.status-start').append(progress);
  const updateProgress=()=>{const scroller=$(focusedPane==='companion'?'companion-scroll':'reader-scroll'),range=scroller.scrollHeight-scroller.clientHeight;progress.hidden=!current.active||documentMode==='source'||range<scroller.clientHeight;progress.textContent=` · ${Math.round(range>0?100*scroller.scrollTop/range:100)}%`;};
  for(const id of ['reader-scroll','companion-scroll'])$(id).addEventListener('scroll',updateProgress,{passive:true});new ResizeObserver(updateProgress).observe($('preview'));updateProgress();
  // Chrome is never part of document selection. During cross-pane drags the
  // other reading surface is excluded as well, then restored at gesture end.
  let selectionOwner=null, selectionPoint=null;
  const constrainSelection=()=>{
    const selection=getSelection(),owner=selectionOwner;
    if(!owner?.isConnected||!selection?.anchorNode||!owner.contains(selection.anchorNode)||owner.contains(selection.focusNode))return;
    const scroll=owner.closest('#reader-scroll,#companion-scroll'),box=scroll.getBoundingClientRect();
    const x=Math.max(box.left+2,Math.min(box.right-18,selectionPoint?.x??box.right-18));
    const y=Math.max(box.top+2,Math.min(box.bottom-2,selectionPoint?.y??box.bottom-2));
    let caret=document.caretRangeFromPoint?.(x,y);
    if(!caret&&document.caretPositionFromPoint){const position=document.caretPositionFromPoint(x,y);if(position){caret=document.createRange();caret.setStart(position.offsetNode,position.offset);}}
    if(!caret||!owner.contains(caret.startContainer)){caret=document.createRange();caret.selectNodeContents(owner);caret.collapse((selectionPoint?.y??0)<box.top);}
    selection.setBaseAndExtent(selection.anchorNode,selection.anchorOffset,caret.startContainer,caret.startOffset);
  };
  document.addEventListener('pointerdown',event=>{
    if(event.button!==0||event.target.closest?.('input,textarea,button,select'))return;
    const owner=event.target.closest?.('#preview,#companion-preview');
    if(owner){selectionOwner=owner;selectionPoint={x:event.clientX,y:event.clientY};document.body.dataset.selectionPane=owner.closest('#reader-scroll,#companion-scroll').id;}
  },true);
  document.addEventListener('pointermove',event=>{if(selectionOwner){selectionPoint={x:event.clientX,y:event.clientY};constrainSelection();}},{passive:true});
  document.addEventListener('selectionchange',constrainSelection);
  const endSelection=()=>{constrainSelection();selectionOwner=null;selectionPoint=null;delete document.body.dataset.selectionPane;};
  window.addEventListener('pointerup',endSelection);window.addEventListener('pointercancel',endSelection);window.addEventListener('blur',endSelection);
}
function initializeSearchOptions() {
  const options=document.createElement('div');options.className='find-options';options.setAttribute('role','group');options.setAttribute('aria-label','Find options');
  for(const [id,label,text] of [['find-case','Match case','Aa'],['find-word','Match whole word','W'],['find-regex','Use regular expression','.*']]) {
    const button=document.createElement('button');button.id=id;button.type='button';button.className='find-option';button.textContent=text;button.title=label;button.setAttribute('aria-label',label);button.setAttribute('aria-pressed','false');
    button.onclick=()=>{button.setAttribute('aria-pressed',String(button.getAttribute('aria-pressed')!=='true'));updateFind();};options.append(button);
  }
  $('find-input').after(options);
}
function parseFolderSearch(input) {
  const include=[], exclude=[]; let hasFilters=false;
  const text=input.replace(/(^|\s)(-?in:)(?:"([^"]*)"|(\S+))/gi, (match,space,operator,quoted,bare)=>{
    const value=quoted ?? bare;
    if(!value)return match;
    (operator[0]==='-'?exclude:include).push(value); hasFilters=true;
    return '';
  });
  return {query:hasFilters?text.trim():text,include:include.join(','),exclude:exclude.join(',')};
}
function folderPathAllowed(path, folder, options=parseFolderSearch($('folder-search-input').value)) {
  const relative=path.slice(folder.length).replace(/^[/\\]/,'').replaceAll('\\','/');
  const match=pattern=>{const escaped=pattern.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replaceAll('*','.*');return new RegExp(escaped,'i').test(relative);};
  const includes=options.include.split(',').map(s=>s.trim()).filter(Boolean),excludes=options.exclude.split(',').map(s=>s.trim()).filter(Boolean);
  return (!includes.length||includes.some(match))&&!excludes.some(match);
}

initializeSearchOptions();
initializeTabScrolling();
initializeDocumentAffordances();

// Keep table guides visual only: never touch the Markdown or selection.
function initializeTableColumnGuides() {
  let paintedTable = null;
  const syncCaret = () => {
    const focus = document.activeElement, anchor = getSelection()?.anchorNode;
    const element = anchor instanceof Element ? anchor : anchor?.parentElement;
    const table = focus?.closest?.('#preview .ProseMirror[contenteditable="true"]') ? element?.closest('table') : null;
    const next = table?.closest('#preview') && table.isConnected ? table : null;
    if (paintedTable === next) return;
    paintedTable?.classList.remove('folio-column-guides');
    paintedTable = next;
    paintedTable?.classList.add('folio-column-guides');
  };
  document.addEventListener('selectionchange', syncCaret);
  document.addEventListener('focusin', syncCaret);
  document.addEventListener('focusout', () => requestAnimationFrame(syncCaret));
}
initializeTableColumnGuides();
