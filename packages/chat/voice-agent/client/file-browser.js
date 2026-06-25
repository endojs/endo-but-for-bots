import { h } from 'preact';
import { Btn, Breadcrumb, EmptyState, Spinner, IconBtn, SegmentedControl, List, Banner } from './ui-kit.js';

// ── FileBrowser island — a confined, STATELESS file browser for the power folders.
// The HOST owns the cap + all state (root / path / entries / open file) and does the
// fetching (the /files/* endpoints); this component only renders the listing + a text
// preview and calls back through handler props. No DOM, cap, fs, or network access —
// cap-hygiene by construction (it's only ever handed render-safe data).
//
// Props:
//   roots:    [{ key, label }]                  — the named power folders
//   root:     string                            — active root key
//   path:     string                            — current folder, root-relative ('' = root)
//   entries:  [{ name, isDir, size, mtime }]    — current folder contents
//   file:     { name, text, size } | null       — the open file's preview (text=null ⇒ binary)
//   busy:     boolean   error: string
//   editing:  boolean                            — text file open in EDIT mode (textarea) vs VIEW (pre)
//   draft:    string                             — the editable buffer (host-owned; may be live-synced)
//   dirty:    boolean                            — draft differs from disk (enables Save)
//   live:     boolean                            — this edit is real-time/collaborative (a sync badge)
// Handlers: onRoot onOpen onCrumb onAdd onDownload onRemove onCloseFile onToggleEdit onEdit(text) onSave
const fmtBytes = n => !n ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export const FileBrowser = (props = {}) => {
  const { roots = [], root = '', path = '', entries = [], file = null, busy = false, error = '',
    editing = false, draft = '', dirty = false, live = false,
    onRoot, onOpen, onCrumb, onAdd, onDownload, onRemove, onCloseFile, onToggleEdit, onEdit, onSave } = props;
  const segs = String(path || '').split('/').filter(Boolean);
  const crumbs = [{ label: '⌂', onClick: () => onCrumb && onCrumb(-1) }, ...segs.map((s, i) => ({ label: s, onClick: () => onCrumb && onCrumb(i) }))];
  return h('div', { class: 'fb' }, [
    roots.length > 1 ? h('div', { style: 'margin-bottom:6px' }, SegmentedControl({ value: root, options: roots.map(r => ({ value: r.key, label: r.label })), onChange: k => onRoot && onRoot(k) })) : null,
    h('div', { class: 'kit-rowx', style: 'justify-content:space-between;align-items:center;gap:8px;margin:6px 0' }, [
      Breadcrumb({ items: crumbs }),
      h('span', { class: 'kit-rowx', style: 'gap:5px;flex:0 0 auto' }, [busy ? Spinner({}) : null, Btn({ label: '+ Add file', onClick: () => onAdd && onAdd() })]),
    ]),
    error ? Banner({ kind: 'bad', icon: '⚠️', children: String(error) }) : null,
    file
      ? h('div', { class: 'fb-view' }, [
        h('div', { class: 'kit-rowx', style: 'justify-content:space-between;align-items:center;margin-bottom:4px' }, [
          h('b', { style: 'min-width:0;overflow:hidden;text-overflow:ellipsis' }, [`📄 ${file.name}`, live && editing ? h('span', { style: 'color:var(--ok,#3fb950);font-size:10px;font-weight:600;margin-left:6px' }, '● live') : null]),
          h('span', { class: 'kit-rowx', style: 'gap:5px;flex:0 0 auto' }, [
            file.text != null && !editing ? Btn({ label: '✎ Edit', onClick: () => onToggleEdit && onToggleEdit() }) : null,
            editing ? Btn({ label: dirty ? '✓ Save' : 'Saved', variant: dirty ? 'acc' : undefined, onClick: () => dirty && onSave && onSave() }) : null,
            editing ? Btn({ label: 'Done', onClick: () => onToggleEdit && onToggleEdit() }) : null,
            Btn({ label: 'Download', onClick: () => onDownload && onDownload(file.name) }),
            !editing ? Btn({ label: 'Delete', variant: 'bad', onClick: () => onRemove && onRemove(file.name) }) : null,
            IconBtn({ glyph: '✕', title: 'close', onClick: () => onCloseFile && onCloseFile() }),
          ]),
        ]),
        file.text == null
          ? h('div', { class: 'pill' }, `binary file · ${fmtBytes(file.size)} — download to view`)
          : editing
            ? h('textarea', {
              value: draft,
              spellcheck: false,
              oninput: e => onEdit && onEdit(e.target.value),
              style: 'width:100%;box-sizing:border-box;min-height:40vh;max-height:60vh;background:var(--panel);border:1px solid var(--edge);border-radius:7px;padding:8px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;color:var(--ink);resize:vertical',
            })
            : h('pre', { style: 'white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto;background:var(--panel);border:1px solid var(--edge);border-radius:7px;padding:8px;font-size:12px;margin:0' }, file.text),
      ])
      : (entries.length
        ? List({ items: entries.map(e => ({ icon: e.isDir ? '📁' : '📄', label: e.name, sub: e.isDir ? 'folder' : fmtBytes(e.size) })), onSelect: i => { const e = entries[i]; if (e) onOpen && onOpen(e.name, e.isDir); } })
        : EmptyState({ text: busy ? 'loading…' : 'empty folder' })),
  ]);
};
