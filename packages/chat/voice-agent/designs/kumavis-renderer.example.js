(endowments, props) => {
  const { h, useState, useEffect } = endowments;
  const [msg, setMsg] = useState('');
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const loadInbox = async () => { try { const d = await props.call('inbox', []); setMessages(Array.isArray(d) ? d : d ? [d] : []); } catch (e) {} };
  useEffect(() => { loadInbox(); }, []);
  const send = async () => { const text = msg.trim(); if (!text || busy) return; setBusy(true); setMsg(''); try { await props.call('send', [text]); await loadInbox(); } catch (e) {} finally { setBusy(false); } };
  const v = props.value || {};
  const row = (m, i) => {
    const o = (m && typeof m === 'object') ? m : { text: String(m) };
    const who = o.from || o.sender || o.author || 'peer';
    const mine = o.mine === true || who === 'me' || who === 'self';
    return h('div', { key: i, class: 'kit-stack', style: 'gap:2px;align-items:' + (mine ? 'flex-end' : 'flex-start') }, [
      h('span', { style: 'font-size:11px;color:var(--mut)' }, mine ? 'You' : String(who)),
      h('div', { style: 'max-width:80%;padding:6px 10px;border-radius:10px;background:' + (mine ? 'var(--acc)' : 'var(--panel)') + ';color:var(--ink);border:1px solid var(--edge);white-space:pre-wrap;word-break:break-word' }, String(o.text || o.body || o.message || '')),
    ]);
  };
  return h('div', { class: 'ncard kit-stack', style: 'gap:10px' }, [
    h('div', { class: 'kit-rowx', style: 'justify-content:space-between;align-items:center' }, [
      h('strong', { style: 'font-size:15px' }, v.name || 'Peer'),
      h('span', { class: 'pill' }, 'endo-peer'),
    ]),
    v.summary ? h('div', { style: 'font-size:12px;color:var(--mut)' }, String(v.summary)) : null,
    h('hr', { class: 'kit-divider' }),
    h('div', { class: 'kit-stack', style: 'gap:8px;max-height:300px;overflow:auto' },
      messages.length ? messages.map(row) : [h('div', { class: 'pill' }, 'No messages yet — say hello')]),
    h('div', { class: 'kit-rowx', style: 'gap:6px;align-items:center' }, [
      h('input', { class: 'kit-in', style: 'flex:1', value: msg, placeholder: 'Type a message…', onInput: e => setMsg(e.target.value), onKeyDown: e => { if (e.key === 'Enter') send(); } }),
      h('button', { class: 'mini primary', disabled: busy || !msg.trim(), onClick: send }, busy ? 'Sending…' : 'Send'),
      h('button', { class: 'mini', onClick: loadInbox, title: 'refresh' }, '⟳'),
    ]),
  ]);
}
