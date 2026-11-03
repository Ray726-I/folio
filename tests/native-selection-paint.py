#!/usr/bin/env python3
"""Selection paint regression in the system WebKitGTK used by Tauri.
Run under a private display: dbus-run-session -- xvfb-run -a python3 tests/native-selection-paint.py
"""
import json
from pathlib import Path
import gi
gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib
root = Path(__file__).resolve().parents[1]
source = '## Rich cells\n\n| Feature | Example |\n| --- | --- |\n| Formula | $E=mc^2$ |\n| Text | Last cell |\n\n$$\nE=mc^2\n$$\n\n```mermaid\ngraph TD;\nA-->B;\n```\n\n## Next table\n\n| A | B |\n| --- | --- |\n| One | Two |\n\nAfter.\n'
window = Gtk.Window()
window.set_default_size(900, 950)
view = WebKit2.WebView()
view.get_settings().set_allow_file_access_from_file_urls(True)
window.add(view)
window.show_all()
status = 1
html = '''<!doctype html><html data-theme="graphite"><head>
<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="vendor/editor/editor.css">
<link rel="stylesheet" href="vendor/katex/katex.min.css">
<style>body{display:block;overflow:auto;padding:32px}.markdown{max-width:800px}</style>
</head><body><main id="preview" class="markdown"></main>
<script src="vendor/katex/katex.min.js"></script><script src="vendor/editor/editor.js"></script>
<script>window.probeErrors=[];window.onerror=e=>probeErrors.push(String(e));
window.editor=FolioEditor.create({content:SOURCE,richParent:document.querySelector('#preview'),
loadKatex:async()=>katex,themeRevision:()=>0,renderDiagram:async()=>({ok:true,sanitized:true,svg:'<svg xmlns="http://www.w3.org/2000/svg" width="180" height="40"><text x="10" y="25">A to B</text></svg>'}),onChange:()=>{},message:console.log,openLink:()=>{},remoteImages:()=>false});
</script></body></html>'''.replace('SOURCE', json.dumps(source))
probe = '''(() => {
const root=document.querySelector('.ProseMirror');
if(!root?.querySelector('.katex-html'))return null;
const range=document.createRange();range.setStart(root.querySelector('h2').firstChild,1);
const last=root.querySelectorAll('table')[1].querySelector('td').firstChild.firstChild;
range.setEnd(last,last.length);window.getSelection().removeAllRanges();window.getSelection().addRange(range);
document.dispatchEvent(new Event('selectionchange'));
const ranges=[...CSS.highlights.get('folio-selection')];
const clipboard=new DataTransfer();root.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:clipboard}));
const copied=clipboard.getData('text/plain');
return JSON.stringify({formula:ranges.some(r=>r.startContainer.parentElement.closest('.katex-html')),
rootBackground:getComputedStyle(root,'::selection').backgroundColor,
fragments:ranges.every(r=>r.startContainer===r.endContainer&&r.startContainer.nodeType===3),
sourceUnchanged:editor.getText()===SOURCE,diagramSelected:!!root.querySelector('.mermaid-host.folio-rendered-selected'),markdownCopied:copied.includes('```mermaid\\ngraph TD;\\nA-->B;\\n```')&&copied.includes('$$\\nE=mc^2\\n$$'),errors:probeErrors});})()'''.replace('SOURCE',json.dumps(source))
def snapshot_done(webview, result):
    global status
    try:
        surface = webview.get_snapshot_finish(result)
        surface.write_to_png('/tmp/folio-table-selection-native-webkit.png')
        status = 0
        print('PASS: native WebKitGTK table selection includes formula glyphs and clears root paint')
    finally:
        Gtk.main_quit()
def result_done(webview, result):
    try:
        value = webview.evaluate_javascript_finish(result)
        if value.is_null():
            GLib.timeout_add(100, poll)
            return
        data = json.loads(value.to_string())
        assert data['formula'] and data['fragments'] and data['sourceUnchanged'] and data['diagramSelected'] and data['markdownCopied'], data
        assert data['rootBackground'] == 'rgba(0, 0, 0, 0)' and not data['errors'], data
        GLib.timeout_add(200, take_snapshot)
    except Exception as error:
        print('FAIL:', error)
        Gtk.main_quit()
def take_snapshot():
    view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, snapshot_done)
    return False
def poll():
    view.evaluate_javascript(probe, -1, None, None, None, result_done)
    return False
def loaded(webview, event):
    if event == WebKit2.LoadEvent.FINISHED:
        GLib.timeout_add(200, poll)
view.connect('load-changed', loaded)
view.load_html(html, (root/'ui/index.html').as_uri())
def timeout():
    print('FAIL: native WebKitGTK probe timed out')
    Gtk.main_quit()
    return False
GLib.timeout_add_seconds(20, timeout)
Gtk.main()
raise SystemExit(status)
