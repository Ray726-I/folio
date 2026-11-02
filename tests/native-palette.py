#!/usr/bin/python3
"""Linux-only real WebKit first-layout palette regression; run via npm script."""
import json
import sys
from pathlib import Path
import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib

zoom = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
repo = Path(__file__).resolve().parents[1]
manager = WebKit2.UserContentManager()
script = '''
window.paletteErrors=[];
window.addEventListener('error',event=>window.paletteErrors.push(event.message));
window.addEventListener('unhandledrejection',event=>window.paletteErrors.push(String(event.reason)));
localStorage.setItem('folio.theme','"graphite"');
localStorage.setItem('folio.readingFont','"sans"');
localStorage.setItem('folio.fontSize','17');
localStorage.setItem('folio.outlineVisible','false');
localStorage.setItem('folio.windowZoom',JSON.stringify(ZOOM));
window.__TAURI__ = {
 core:{invoke:async(command)=>{
  if(command==='bootstrap')return {paths:['/tmp/palette.md'],platform:'linux',theme:null};
  if(command==='open_document')return {path:'/tmp/palette.md',name:'palette.md',content:'# Palette\\n\\nBody text with **strong text** and a [link](https://example.com).\\n',writable:true};
  return null;
 }},
 event:{listen:async()=>()=>{}},
 webview:{getCurrentWebview:()=>({onDragDropEvent:async()=>()=>{}})}
};
'''.replace('ZOOM', str(zoom))
manager.add_script(WebKit2.UserScript.new(script, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
view = WebKit2.WebView(web_context=WebKit2.WebContext.new_ephemeral(), user_content_manager=manager)
view.get_settings().set_allow_file_access_from_file_urls(True)
view.set_zoom_level(zoom)
window = Gtk.Window()
window.set_default_size(1100, 800)
window.add(view)
window.show_all()
state = {'ok': False}


def complete(widget, result, *_):
    try:
        report = json.loads(view.evaluate_javascript_finish(result).to_string())
        for appearance in ['dark', 'light']:
            colors = report[appearance]
            assert colors['body'] == colors['foreground'], colors
            assert colors['contrast'] >= 7, colors
            assert colors['shadow'] == 'none', colors
        assert report['headerSelection'] == '', 'toolbar text must not be selectable: ' + repr(report['headerSelection'])
        assert 'Body text' in report['documentSelection'], 'document text must remain selectable'
        assert not report['errors'], report['errors']
        print('PASS: native WebKit startup palette at ' + str(zoom) + ' zoom: ' + json.dumps(report), flush=True)
        state['ok'] = True
    except Exception as error:
        print('FAIL: native palette: ' + str(error), flush=True)
    Gtk.main_quit()


def ready(widget, result, *_):
    try:
        if not view.evaluate_javascript_finish(result).to_boolean():
            GLib.timeout_add(75, poll)
            return
        view.evaluate_javascript('''JSON.stringify((()=>{
          const sample=()=>({foreground:cssVarColor('--fg'),body:cssVarColor('--read-body'),contrast:colorContrast(cssVarColor('--read-body'),cssVarColor('--bg')),shadow:getComputedStyle(document.querySelector('#preview p')).textShadow});
          const dark=sample();applyTheme('paper',false);const light=sample();
          // Native WebKit requires the prefixed user-select property. A range
          // covering the title otherwise paints GTK's inactive black selection
          // across the filename and the full path row after a header drag.
          const selectedText=node=>{const range=document.createRange();range.selectNode(node);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);const text=selection.toString();selection.removeAllRanges();return text;};
          const headerSelection=selectedText(document.querySelector('.window-title'));
          const documentSelection=selectedText(document.querySelector('#preview p'));
          return {dark,light,headerSelection,documentSelection,errors:window.paletteErrors||[]};
        })())''', -1, None, None, None, complete, None)
    except Exception as error:
        print('FAIL: native palette readiness: ' + str(error), flush=True)
        Gtk.main_quit()


def poll():
    view.evaluate_javascript("Boolean(typeof editor!=='undefined' && editor && !busy && /^#[0-9a-f]{6}$/i.test(root.style.getPropertyValue('--read-body')) && !paletteFrame && document.fonts.check('17px Inter'))", -1, None, None, None, ready, None)
    return False


view.connect('load-changed', lambda widget, event: GLib.timeout_add(75, poll) if event == WebKit2.LoadEvent.FINISHED else None)
GLib.timeout_add_seconds(20, lambda: (print('FAIL: native palette timed out', flush=True), Gtk.main_quit(), False)[-1])
view.load_uri((repo / 'ui/index.html').as_uri())
Gtk.main()
window.destroy()
sys.exit(0 if state['ok'] else 1)
