/* Docker Template Editor - front-end (vanilla JS, no build step). */
(function () {
  'use strict';

  const CFG = window.DTE_CONFIG || {};
  const TYPES = ['Variable', 'Path', 'Port', 'Label', 'Device'];
  const TYPE_KEY_LABEL = { Variable: 'Key', Path: 'Container path', Port: 'Container port', Label: 'Label key', Device: 'Device' };
  const TYPE_VALUE_LABEL = { Variable: 'Value', Path: 'Host path', Port: 'Host port', Label: 'Value', Device: 'Host device' };
  const MODES = { Path: ['rw', 'ro', 'rw,slave', 'ro,slave', 'rw,shared', 'ro,shared'], Port: ['tcp', 'udp'] };
  const GENERAL_ORDER = ['Name', 'Repository', 'Registry', 'Network', 'MyIP', 'Shell', 'Privileged', 'WebUI', 'Icon',
    'ExtraParams', 'PostArgs', 'CPUset', 'Support', 'Project', 'Overview', 'Category', 'TemplateURL', 'Requires'];
  const LONG_FIELDS = ['Overview', 'ExtraParams', 'PostArgs', 'Requires', 'Description'];

  const root = document.getElementById('dte');
  applyThemeColors();
  let S = {
    view: 'list', list: [], listFilter: '',
    t: null, orig: null, tab: 'config', typeFilter: 'All', search: '', expanded: {}, showMasked: {},
    bulk: { selected: {}, kind: 'replace', preview: null },
  };
  let nextId = 1;

  /* ------------------------------------------------------------ utilities */

  /** Borrow background/text colours from the Unraid theme so modals match light and dark themes. */
  function applyThemeColors() {
    const clear = (c) => !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)';
    let bg = '';
    for (let el = root.parentElement; el && clear(bg); el = el.parentElement) bg = getComputedStyle(el).backgroundColor;
    if (clear(bg)) bg = '#fff';
    // Read the text colour from the parent: #dte itself is coloured by our own stylesheet.
    const fg = getComputedStyle(root.parentElement || document.body).color;
    const style = document.createElement('style');
    // Extra specificity so this wins over editor.css, which loads later in the page.
    style.textContent = `html body #dte, html body .dte-modal-wrap, html body .dte-toast { --dte-bg: ${bg}; --dte-fg: ${fg}; }`;
    document.head.appendChild(style);
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const strip = (c) => ({ attrs: c.attrs, value: c.value });

  async function api(action, params = {}) {
    const q = new URLSearchParams({ action, ...params });
    const r = await fetch(`${CFG.api}?${q}`, { credentials: 'same-origin' });
    return handle(r);
  }

  async function post(action, payload) {
    const body = new URLSearchParams({ action, csrf_token: CFG.csrf || '', payload: JSON.stringify(payload) });
    const r = await fetch(CFG.api, { method: 'POST', credentials: 'same-origin', body });
    return handle(r);
  }

  async function handle(r) {
    let data;
    try { data = await r.json(); } catch (e) { throw new Error(`Server returned ${r.status} ${r.statusText}`); }
    if (!r.ok && !data.problems) throw new Error(data.error || `HTTP ${r.status}`);
    data._status = r.status;
    return data;
  }

  function toast(msg, kind = 'ok') {
    const el = document.createElement('div');
    el.className = `dte-toast dte-toast-${kind}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('dte-hide'), 3500);
    setTimeout(() => el.remove(), 4000);
  }

  function modal(title, bodyHtml, buttons = [{ label: 'Close' }]) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'dte-modal-wrap';
      wrap.innerHTML = `<div class="dte-modal" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3><div class="dte-modal-body">${bodyHtml}</div>
        <div class="dte-modal-actions">${buttons.map((b, i) => `<button type="button" data-i="${i}" class="${b.primary ? 'dte-primary' : ''} ${b.danger ? 'dte-danger' : ''}">${esc(b.label)}</button>`).join('')}</div></div>`;
      const close = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') close(undefined); };
      wrap.addEventListener('click', (e) => {
        if (e.target === wrap) return close(undefined);
        const b = e.target.closest('button[data-i]');
        if (b) close(buttons[+b.dataset.i].value);
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(wrap);
    });
  }

  const confirmBox = (title, html, okLabel = 'Continue', danger = false) =>
    modal(title, html, [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: !danger, danger }]);

  function isDirty() {
    if (!S.t) return false;
    return JSON.stringify(payloadModel(S.t)) !== JSON.stringify(payloadModel(S.orig));
  }

  const payloadModel = (t) => ({ fields: t.fields, configs: t.configs.map(strip) });

  function nativeEditUrl(file) {
    return `/Docker/UpdateContainer?xmlTemplate=edit:${encodeURIComponent(`${CFG.templateDir}/${file}`)}`;
  }

  /* --------------------------------------------------------------- list */

  async function loadList() {
    S.view = 'list';
    S.t = null;
    render();
    try {
      const d = await api('list');
      S.list = d.templates;
      render();
    } catch (e) {
      root.innerHTML = `<p class="dte-error">Could not load templates: ${esc(e.message)}</p>`;
    }
  }

  function renderList() {
    const f = S.listFilter.toLowerCase();
    const rows = S.list.filter((t) => !f || `${t.name} ${t.repository}`.toLowerCase().includes(f));
    const count = (t, k) => (t.counts && t.counts[k]) || 0;
    return `
      <div class="dte-bar">
        <input type="search" class="dte-search" data-bind="listFilter" placeholder="Filter containers…" value="${esc(S.listFilter)}">
        <span class="dte-spacer"></span>
        <button type="button" data-act="bulk-open"><i class="fa fa-magic"></i> Bulk edit across containers</button>
        <button type="button" data-act="reload"><i class="fa fa-refresh"></i> Refresh</button>
      </div>
      ${S.list.length ? '' : `<p class="dte-muted">No user templates found in <code>${esc(CFG.templateDir)}</code>.</p>`}
      <table class="dte-table dte-list">
        <thead><tr><th></th><th>Container</th><th>Image</th><th>State</th><th title="Variables">Vars</th><th title="Paths">Paths</th><th title="Ports">Ports</th><th title="Labels / Devices">Other</th><th>Modified</th></tr></thead>
        <tbody>${rows.map((t) => `
          <tr data-act="open" data-file="${esc(t.file)}" tabindex="0">
            <td class="dte-icon-cell">${t.icon ? `<img src="${esc(t.icon)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ''}</td>
            <td><strong>${esc(t.name)}</strong>${t.error ? `<div class="dte-error">${esc(t.error)}</div>` : ''}${t.legacy ? ' <span class="dte-badge">legacy</span>' : ''}</td>
            <td class="dte-mono dte-trunc" title="${esc(t.repository)}">${esc(t.repository)}</td>
            <td><span class="dte-state dte-state-${esc(t.state).replace(/\s/g, '-')}">${esc(t.state)}</span></td>
            <td>${count(t, 'Variable')}</td><td>${count(t, 'Path')}</td><td>${count(t, 'Port')}</td>
            <td>${count(t, 'Label') + count(t, 'Device')}</td>
            <td class="dte-muted">${new Date(t.mtime * 1000).toLocaleString()}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  /* -------------------------------------------------------------- editor */

  async function openTemplate(file) {
    try {
      const t = await api('get', { file });
      setTemplate(t);
      S.view = 'edit';
      S.tab = t.legacy ? 'xml' : 'config';
      S.typeFilter = 'All';
      S.search = '';
      S.expanded = {};
      render();
      window.scrollTo(0, 0);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function setTemplate(t) {
    t.configs.forEach((c) => { c._id = nextId++; });
    S.t = t;
    S.orig = clone(t);
  }

  function renderEditor() {
    const t = S.t;
    const dirty = isDirty();
    const tabs = [['config', `Config (${t.configs.length})`], ['env', 'Bulk .env'], ['general', 'General'], ['xml', 'Raw XML'], ['history', 'History']];
    return `
      <div class="dte-bar dte-sticky">
        <button type="button" data-act="back"><i class="fa fa-arrow-left"></i> All containers</button>
        <h2 class="dte-title">${esc(t.fields.Name || t.file)} <span class="dte-muted dte-mono">${esc(t.file)}</span>
          ${dirty ? '<span class="dte-badge dte-badge-warn">unsaved changes</span>' : ''}</h2>
        <span class="dte-spacer"></span>
        <button type="button" data-act="revert" ${dirty ? '' : 'disabled'}>Revert</button>
        <button type="button" class="dte-primary" data-act="save" ${dirty ? '' : 'disabled'} title="Ctrl+S"><i class="fa fa-save"></i> Save template</button>
        <a class="dte-btn" href="${esc(nativeEditUrl(t.file))}" title="Open the saved template in Unraid's native editor and press Apply there">Apply in Unraid <i class="fa fa-external-link"></i></a>
        <button type="button" data-act="recreate" title="Stop, remove and recreate the container from the saved template"><i class="fa fa-repeat"></i> Recreate</button>
      </div>
      ${t.legacy ? '<p class="dte-warn">This template uses the legacy (pre version 2) format; only raw XML editing is available.</p>' : ''}
      <nav class="dte-tabs">${tabs.map(([k, l]) => `<button type="button" data-act="tab" data-tab="${k}" class="${S.tab === k ? 'dte-active' : ''}" ${t.legacy && !['xml', 'history'].includes(k) ? 'disabled' : ''}>${l}</button>`).join('')}</nav>
      <div class="dte-panel">${{ config: renderConfig, env: renderEnv, general: renderGeneral, xml: renderXml, history: renderHistory }[S.tab]()}</div>`;
  }

  function origById(id) { return S.orig.configs.find((c) => c._id === id); }

  function rowState(c) {
    const o = origById(c._id);
    if (!o) return 'new';
    return JSON.stringify(strip(o)) === JSON.stringify(strip(c)) ? '' : 'changed';
  }

  function renderConfig() {
    const t = S.t;
    const counts = { All: t.configs.length };
    t.configs.forEach((c) => { const k = c.attrs.Type || 'Variable'; counts[k] = (counts[k] || 0) + 1; });
    const q = S.search.toLowerCase();
    const visible = t.configs.filter((c) =>
      (S.typeFilter === 'All' || c.attrs.Type === S.typeFilter) &&
      (!q || [c.attrs.Name, c.attrs.Target, c.value, c.attrs.Description].join('\n').toLowerCase().includes(q)));
    const removed = S.orig.configs.filter((o) => !t.configs.some((c) => c._id === o._id));
    return `
      <div class="dte-bar">
        <div class="dte-chips">${['All', ...TYPES].map((k) => `<button type="button" data-act="type-filter" data-type="${k}" class="${S.typeFilter === k ? 'dte-active' : ''}">${k}${k === 'All' ? '' : 's'} <span>${counts[k] || 0}</span></button>`).join('')}</div>
        <input type="search" class="dte-search" data-bind="search" placeholder="Search name, key, value…" value="${esc(S.search)}">
        <span class="dte-spacer"></span>
        <select data-act="add-type" aria-label="Add entry of type">${TYPES.map((k) => `<option ${k === (S.typeFilter === 'All' ? 'Variable' : S.typeFilter) ? 'selected' : ''}>${k}</option>`).join('')}</select>
        <button type="button" data-act="add"><i class="fa fa-plus"></i> Add</button>
      </div>
      <table class="dte-table dte-grid">
        <thead><tr><th class="dte-col-move"></th><th class="dte-col-type">Type</th><th>Name</th><th>Key / target</th><th>Value</th><th class="dte-col-act"></th></tr></thead>
        <tbody>${visible.map(renderRow).join('') || `<tr><td colspan="6" class="dte-muted">Nothing matches.</td></tr>`}</tbody>
      </table>
      ${removed.length ? `<p class="dte-muted">Removed (on save): ${removed.map((o) => `<span class="dte-removed">${esc(o.attrs.Type)} ${esc(o.attrs.Target)}</span>`).join(' ')}</p>` : ''}`;
  }

  function renderRow(c) {
    const a = c.attrs;
    const id = c._id;
    const type = a.Type || 'Variable';
    const st = rowState(c);
    const masked = a.Mask === 'true' && !S.showMasked[id];
    const open = !!S.expanded[id];
    const inp = (attr, extra = '') => `<input type="text" data-id="${id}" data-attr="${attr}" value="${esc(a[attr] ?? '')}" ${extra}>`;
    let valueInput;
    if (type === 'Path' || type === 'Device') {
      valueInput = `<input type="text" class="dte-mono" data-id="${id}" data-attr="=value" value="${esc(c.value)}" placeholder="${TYPE_VALUE_LABEL[type]}">`;
    } else {
      valueInput = `<input type="${masked ? 'password' : 'text'}" class="dte-mono" data-id="${id}" data-attr="=value" value="${esc(c.value)}" placeholder="${esc(a.Default ? `default: ${a.Default}` : TYPE_VALUE_LABEL[type])}" autocomplete="off">`;
    }
    const defaultHint = a.Default !== undefined && a.Default !== '' && a.Default !== c.value
      ? `<button type="button" class="dte-link" data-act="use-default" data-id="${id}" title="Reset to default">↺ ${esc(a.Default.length > 30 ? a.Default.slice(0, 30) + '…' : a.Default)}</button>` : '';
    return `
      <tr class="dte-row ${st ? `dte-row-${st}` : ''}" data-row="${id}">
        <td class="dte-col-move"><button type="button" class="dte-icon" data-act="up" data-id="${id}" title="Move up">▲</button><button type="button" class="dte-icon" data-act="down" data-id="${id}" title="Move down">▼</button></td>
        <td class="dte-col-type"><select data-id="${id}" data-attr="Type">${TYPES.map((k) => `<option ${k === type ? 'selected' : ''}>${k}</option>`).join('')}</select></td>
        <td>${inp('Name', 'placeholder="Display name"')}</td>
        <td>${inp('Target', `class="dte-mono" placeholder="${TYPE_KEY_LABEL[type]}"`)}</td>
        <td><div class="dte-value">${valueInput}${a.Mask === 'true' ? `<button type="button" class="dte-icon" data-act="toggle-mask" data-id="${id}" title="Show / hide">${masked ? '👁' : '🙈'}</button>` : ''}</div>${defaultHint}</td>
        <td class="dte-col-act">
          <button type="button" class="dte-icon ${open ? 'dte-active' : ''}" data-act="expand" data-id="${id}" title="More options">⋯</button>
          <button type="button" class="dte-icon" data-act="dup" data-id="${id}" title="Duplicate">⧉</button>
          <button type="button" class="dte-icon dte-danger" data-act="del" data-id="${id}" title="Delete">✕</button>
        </td>
      </tr>
      ${open ? `<tr class="dte-details"><td></td><td colspan="5"><div class="dte-detail-grid">
        <label>Default ${inp('Default', 'class="dte-mono"')}</label>
        <label>Mode ${MODES[type] ? `<select data-id="${id}" data-attr="Mode">${['', ...MODES[type]].map((m) => `<option ${m === (a.Mode || '') ? 'selected' : ''}>${m}</option>`).join('')}${a.Mode && !MODES[type].includes(a.Mode) ? `<option selected>${esc(a.Mode)}</option>` : ''}</select>` : inp('Mode')}</label>
        <label>Display <select data-id="${id}" data-attr="Display">${['always', 'always-hide', 'advanced', 'advanced-hide'].map((m) => `<option ${m === (a.Display || 'always') ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label class="dte-check"><input type="checkbox" data-id="${id}" data-attr="Required" ${a.Required === 'true' ? 'checked' : ''}> Required</label>
        <label class="dte-check"><input type="checkbox" data-id="${id}" data-attr="Mask" ${a.Mask === 'true' ? 'checked' : ''}> Mask value</label>
        <label class="dte-wide">Description <textarea data-id="${id}" data-attr="Description" rows="2">${esc(a.Description || '')}</textarea></label>
      </div></td></tr>` : ''}`;
  }

  function newConfig(type, key = '', value = '') {
    return {
      _id: nextId++, value,
      attrs: { Name: key, Target: key, Default: '', Mode: type === 'Port' ? 'tcp' : type === 'Path' ? 'rw' : '', Description: '', Type: type, Display: 'always', Required: 'false', Mask: 'false' },
    };
  }

  /* ------------------------------------------------------------ bulk .env */

  const ENV_KEY = /^[^=\s#]+$/;

  function envText() {
    return S.t.configs.filter((c) => c.attrs.Type === 'Variable').map((c) => `${c.attrs.Target}=${c.value}`).join('\n');
  }

  function parseEnv(text) {
    const out = [];
    const errors = [];
    text.split(/\r?\n/).forEach((raw, i) => {
      let line = raw.trim();
      if (!line || line.startsWith('#')) return;
      line = line.replace(/^-\s+/, '').replace(/^export\s+/, '');
      let m = line.match(/^([^=:\s]+)\s*=(.*)$/) || line.match(/^([^=:\s]+)\s*:\s(.*)$/) || line.match(/^([^=:\s]+)\s*:$/);
      if (!m || !ENV_KEY.test(m[1])) { errors.push(`Line ${i + 1}: cannot parse "${raw.trim()}"`); return; }
      let v = (m[2] ?? '').trim();
      if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
      out.push([m[1], v]);
    });
    return { vars: out, errors };
  }

  function diffEnv(text, removeMissing) {
    const { vars, errors } = parseEnv(text);
    const current = S.t.configs.filter((c) => c.attrs.Type === 'Variable');
    const byKey = new Map(current.map((c) => [c.attrs.Target, c]));
    const seen = new Set();
    const changes = { update: [], add: [], remove: [], errors };
    vars.forEach(([k, v]) => {
      if (seen.has(k)) errors.push(`Duplicate key ${k}: last value wins`);
      seen.add(k);
      const c = byKey.get(k);
      if (!c) changes.add.push([k, v]);
      else if (c.value !== v) changes.update.push([k, c.value, v]);
    });
    // Collapse duplicates so the last value wins.
    const last = (arr) => [...new Map(arr.map((x) => [x[0], x])).values()];
    changes.add = last(changes.add);
    changes.update = last(changes.update);
    if (removeMissing) current.forEach((c) => { if (!seen.has(c.attrs.Target)) changes.remove.push([c.attrs.Target, c.value]); });
    return changes;
  }

  function renderEnv() {
    const draft = S.envDraft ?? envText();
    return `
      <p class="dte-muted">Edit every variable at once as <code>KEY=value</code> lines. You can paste a <code>.env</code> file or a docker-compose
        <code>environment:</code> block (<code>- KEY=value</code> or <code>KEY: value</code>). Changes are applied to the editor; press <em>Save template</em> to write them.</p>
      <textarea class="dte-code" id="dte-env" rows="${Math.min(30, Math.max(10, draft.split('\n').length + 2))}" spellcheck="false">${esc(draft)}</textarea>
      <div class="dte-bar">
        <label class="dte-check"><input type="checkbox" id="dte-env-remove" ${S.envRemove ? 'checked' : ''}> Remove variables that are not in the list</label>
        <span class="dte-spacer"></span>
        <button type="button" data-act="env-reset">Reset from editor</button>
        <button type="button" data-act="env-copy"><i class="fa fa-copy"></i> Copy</button>
        <button type="button" class="dte-primary" data-act="env-apply">Preview &amp; apply to editor</button>
      </div>`;
  }

  async function applyEnv() {
    const text = document.getElementById('dte-env').value;
    S.envDraft = text;
    S.envRemove = document.getElementById('dte-env-remove').checked;
    const d = diffEnv(text, S.envRemove);
    const total = d.add.length + d.update.length + d.remove.length;
    const row = (cls, k, a, b) => `<tr class="${cls}"><td class="dte-mono">${esc(k)}</td><td class="dte-mono">${a === null ? '' : esc(a)}</td><td class="dte-mono">${b === null ? '' : esc(b)}</td></tr>`;
    const html = `
      ${d.errors.length ? `<ul class="dte-warn">${d.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
      ${total ? `<table class="dte-table dte-diff"><thead><tr><th>Key</th><th>Current</th><th>New</th></tr></thead><tbody>
        ${d.update.map(([k, a, b]) => row('dte-row-changed', k, a, b)).join('')}
        ${d.add.map(([k, v]) => row('dte-row-new', k, '(new)', v)).join('')}
        ${d.remove.map(([k, v]) => row('dte-row-removed', k, v, '(removed)')).join('')}
      </tbody></table>` : '<p>No changes.</p>'}`;
    const ok = await modal(`${d.update.length} changed, ${d.add.length} added, ${d.remove.length} removed`, html,
      total ? [{ label: 'Cancel', value: false }, { label: 'Apply to editor', value: true, primary: true }] : [{ label: 'Close' }]);
    if (!ok) return;
    const byKey = new Map(S.t.configs.filter((c) => c.attrs.Type === 'Variable').map((c) => [c.attrs.Target, c]));
    d.update.forEach(([k, , v]) => { byKey.get(k).value = v; });
    d.add.forEach(([k, v]) => S.t.configs.push(newConfig('Variable', k, v)));
    const rm = new Set(d.remove.map(([k]) => k));
    S.t.configs = S.t.configs.filter((c) => !(c.attrs.Type === 'Variable' && rm.has(c.attrs.Target)));
    S.envDraft = null;
    S.tab = 'config';
    S.typeFilter = 'Variable';
    render();
    toast(`Applied ${total} change(s) — remember to save.`);
  }

  /* ------------------------------------------------------------- general */

  function renderGeneral() {
    const f = S.t.fields;
    const keys = [...GENERAL_ORDER.filter((k) => k in f), ...Object.keys(f).filter((k) => !GENERAL_ORDER.includes(k))];
    return `
      <div class="dte-form">${keys.map((k) => {
        const v = f[k];
        const input = k === 'Privileged'
          ? `<select data-field="${esc(k)}">${['false', 'true'].map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`
          : LONG_FIELDS.includes(k) || v.length > 80
            ? `<textarea data-field="${esc(k)}" rows="${k === 'Overview' ? 5 : 2}" class="${k === 'Overview' ? '' : 'dte-mono'}">${esc(v)}</textarea>`
            : `<input type="text" data-field="${esc(k)}" value="${esc(v)}" class="${['Name', 'Overview'].includes(k) ? '' : 'dte-mono'}">`;
        return `<label><span>${esc(k)}</span>${input}</label>`;
      }).join('')}</div>
      ${S.t.complex.length ? `<p class="dte-muted">Also kept unchanged: ${S.t.complex.map((c) => `<code>&lt;${esc(c)}&gt;</code>`).join(' ')}</p>` : ''}`;
  }

  /* ----------------------------------------------------------------- xml */

  function renderXml() {
    return `
      <p class="dte-muted">Edit the template file directly. ${isDirty() ? '<strong>Unsaved changes from the other tabs are not shown here — save or revert them first.</strong>' : ''}</p>
      <textarea class="dte-code" id="dte-xml" rows="30" spellcheck="false">${esc(S.t.xml)}</textarea>
      <div class="dte-bar"><span class="dte-spacer"></span>
        <button type="button" data-act="xml-download"><i class="fa fa-download"></i> Download</button>
        <button type="button" class="dte-primary" data-act="xml-save"><i class="fa fa-save"></i> Save raw XML</button></div>`;
  }

  /* ------------------------------------------------------------- history */

  function renderHistory() {
    if (!S.backups) {
      api('backups', { file: S.t.file }).then((d) => { S.backups = d.backups; render(); }).catch((e) => toast(e.message, 'err'));
      return '<p class="dte-muted">Loading…</p>';
    }
    if (!S.backups.length) return '<p class="dte-muted">No backups yet. A backup of the previous version is kept every time you save.</p>';
    return `<table class="dte-table"><thead><tr><th>Saved</th><th>Size</th><th></th></tr></thead><tbody>
      ${S.backups.map((b) => `<tr><td>${new Date(b.mtime * 1000).toLocaleString()}</td><td>${(b.size / 1024).toFixed(1)} KB</td>
        <td class="dte-right"><button type="button" data-act="bk-view" data-id="${esc(b.id)}">View changes</button>
        <button type="button" data-act="bk-restore" data-id="${esc(b.id)}">Restore</button></td></tr>`).join('')}
      </tbody></table>`;
  }

  function lineDiff(a, b) {
    // Small LCS line diff, fine for template sized files.
    const A = a.split('\n'); const B = b.split('\n');
    const n = A.length; const m = B.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = []; let i = 0; let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push([' ', A[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(['-', A[i++]]); else out.push(['+', B[j++]]);
    }
    while (i < n) out.push(['-', A[i++]]);
    while (j < m) out.push(['+', B[j++]]);
    return out.map(([s, l]) => `<div class="dte-d${s === ' ' ? 'same' : s === '+' ? 'add' : 'del'}">${s} ${esc(l)}</div>`).join('');
  }

  /* ---------------------------------------------------------------- save */

  async function save(force = false) {
    const t = S.t;
    try {
      const d = await post('save', { file: t.file, hash: t.hash, force, ...payloadModel(t) });
      if (d._status === 422) {
        const ok = await confirmBox('Please check these problems', `<ul class="dte-warn">${d.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`, 'Save anyway', true);
        if (ok) return save(true);
        return;
      }
      afterSave(d);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function afterSave(d) {
    const keepTab = S.tab;
    setTemplate(d.template);
    S.tab = keepTab;
    S.backups = null;
    render();
    if (!d.changed) { toast('Nothing to save.'); return; }
    if (CFG.afterSave === 'recreate') return recreate();
    if (CFG.afterSave === 'native') { location.href = nativeEditUrl(S.t.file); return; }
    if (CFG.afterSave === 'nothing') { toast('Template saved. Recreate the container to use it.'); return; }
    const state = (S.list.find((x) => x.file === S.t.file) || {}).state;
    const next = !state || state === 'not created'
      ? 'The container has not been created yet. Create it now?'
      : `The container (currently <strong>${esc(state)}</strong>) still uses the old settings until it is recreated. Apply them now?`;
    modal('Template saved', `<p>The previous version was backed up (see <em>History</em>).</p><p>${next}</p>`, [
      { label: 'Later', value: null },
      { label: 'Open in Unraid & Apply', value: 'native' },
      { label: 'Recreate now', value: 'recreate', primary: true },
    ]).then((v) => {
      if (v === 'native') location.href = nativeEditUrl(S.t.file);
      if (v === 'recreate') recreate(true);
    });
  }

  async function recreate(skipConfirm = false) {
    if (isDirty()) { toast('Save your changes first.', 'err'); return; }
    if (!skipConfirm && CFG.confirmRecreate !== false) {
      const ok = await confirmBox('Recreate container?', `<p>This stops and removes <strong>${esc(S.t.fields.Name)}</strong>, then creates it again from the saved template (like pressing Apply in Unraid). Data in mapped paths is kept.</p>`, 'Recreate', true);
      if (!ok) return;
    }
    const w = document.createElement('div');
    w.className = 'dte-modal-wrap';
    w.innerHTML = '<div class="dte-modal"><h3>Recreating…</h3><p class="dte-muted">This can take a while if the image must be pulled.</p></div>';
    document.body.appendChild(w);
    try {
      const d = await post('recreate', { file: S.t.file });
      w.remove();
      await modal(d.ok ? 'Container recreated' : 'Recreate failed', `<pre class="dte-code dte-log">${esc(d.log.join('\n'))}</pre>`);
    } catch (e) {
      w.remove();
      toast(e.message, 'err');
    }
  }

  /* ---------------------------------------------------------------- bulk */

  function renderBulk() {
    const B = S.bulk;
    const selCount = Object.values(B.selected).filter(Boolean).length;
    const kinds = { replace: 'Find & replace', setvar: 'Set a value', delvar: 'Remove an entry' };
    const typeOpts = (name, sel) => `<select id="${name}">${TYPES.map((k) => `<option ${k === sel ? 'selected' : ''}>${k}</option>`).join('')}</select>`;
    const form = {
      replace: `
        <label>Find <input type="text" id="b-find" class="dte-mono" value="${esc(B.find || '')}" placeholder="/mnt/cache/appdata"></label>
        <label>Replace with <input type="text" id="b-replace" class="dte-mono" value="${esc(B.replace || '')}" placeholder="/mnt/user/appdata"></label>
        <label class="dte-check"><input type="checkbox" id="b-regex" ${B.regex ? 'checked' : ''}> Regular expression</label>
        <label class="dte-check"><input type="checkbox" id="b-scope" ${B.scope === 'all' ? 'checked' : ''}> Also defaults, keys, ExtraParams, PostArgs, WebUI</label>
        <div class="dte-chips">In: ${TYPES.map((k) => `<label class="dte-check"><input type="checkbox" class="b-type" value="${k}" ${!B.types || B.types.includes(k) ? 'checked' : ''}> ${k}s</label>`).join('')}</div>`,
      setvar: `
        <label>Type ${typeOpts('b-type', B.type || 'Variable')}</label>
        <label>Key <input type="text" id="b-key" class="dte-mono" value="${esc(B.key || '')}" placeholder="TZ"></label>
        <label>Value <input type="text" id="b-value" class="dte-mono" value="${esc(B.value || '')}" placeholder="Europe/Paris"></label>
        <label class="dte-check"><input type="checkbox" id="b-add" ${B.add ? 'checked' : ''}> Add it to containers that don't have it</label>`,
      delvar: `
        <label>Type ${typeOpts('b-type', B.type || 'Variable')}</label>
        <label>Key <input type="text" id="b-key" class="dte-mono" value="${esc(B.key || '')}"></label>`,
    }[B.kind];
    return `
      <div class="dte-bar dte-sticky">
        <button type="button" data-act="back"><i class="fa fa-arrow-left"></i> All containers</button>
        <h2 class="dte-title">Bulk edit</h2>
      </div>
      <div class="dte-bulk">
        <section>
          <h3>1. Containers <span class="dte-muted">(${selCount} selected)</span></h3>
          <div class="dte-bar"><button type="button" data-act="b-all">All</button><button type="button" data-act="b-none">None</button></div>
          <div class="dte-pick">${S.list.filter((t) => !t.error && !t.legacy).map((t) => `
            <label class="dte-check"><input type="checkbox" class="b-file" value="${esc(t.file)}" ${B.selected[t.file] ? 'checked' : ''}> ${esc(t.name)}</label>`).join('')}</div>
        </section>
        <section>
          <h3>2. Change</h3>
          <nav class="dte-tabs">${Object.entries(kinds).map(([k, l]) => `<button type="button" data-act="b-kind" data-kind="${k}" class="${B.kind === k ? 'dte-active' : ''}">${l}</button>`).join('')}</nav>
          <div class="dte-form dte-form-inline">${form}</div>
          <div class="dte-bar"><span class="dte-spacer"></span><button type="button" class="dte-primary" data-act="b-preview" ${selCount ? '' : 'disabled'}>Preview changes</button></div>
        </section>
        ${B.preview ? renderBulkPreview(B.preview) : ''}
      </div>`;
  }

  function renderBulkPreview(results) {
    const changed = results.filter((r) => r.changes && r.changes.length);
    const n = changed.reduce((s, r) => s + r.changes.length, 0);
    return `<section><h3>3. Preview <span class="dte-muted">${n} change(s) in ${changed.length} container(s)</span></h3>
      ${results.filter((r) => r.skipped).map((r) => `<p class="dte-warn">${esc(r.file)}: skipped (${esc(r.skipped)})</p>`).join('')}
      ${changed.length ? `<table class="dte-table dte-diff"><thead><tr><th>Container</th><th>Entry</th><th>Current</th><th>New</th></tr></thead><tbody>
        ${changed.map((r) => r.changes.map((c, i) => `<tr>${i === 0 ? `<td rowspan="${r.changes.length}"><strong>${esc(r.name)}</strong></td>` : ''}
          <td class="dte-mono">${esc(c.where)}</td><td class="dte-mono dte-ddel">${esc(c.old)}</td><td class="dte-mono dte-dadd">${esc(c.new)}</td></tr>`).join('')).join('')}
      </tbody></table>
      <div class="dte-bar"><span class="dte-spacer"></span><button type="button" class="dte-primary" data-act="b-apply">Save ${changed.length} template(s)</button></div>` : '<p>No changes.</p>'}
      </section>`;
  }

  function readBulkForm() {
    const B = S.bulk;
    const v = (id) => { const el = document.getElementById(id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined; };
    if (B.kind === 'replace') {
      Object.assign(B, { find: v('b-find'), replace: v('b-replace'), regex: v('b-regex'), scope: v('b-scope') ? 'all' : 'values', types: [...root.querySelectorAll('.b-type:checked')].map((e) => e.value) });
      return { kind: 'replace', find: B.find, replace: B.replace, regex: B.regex, scope: B.scope, types: B.types };
    }
    Object.assign(B, { type: v('b-type'), key: v('b-key') });
    if (B.kind === 'setvar') {
      Object.assign(B, { value: v('b-value'), add: v('b-add') });
      return { kind: 'setvar', type: B.type, key: B.key, value: B.value, add: B.add };
    }
    return { kind: 'delvar', type: B.type, key: B.key };
  }

  async function bulkRun(apply) {
    const op = readBulkForm();
    const files = Object.keys(S.bulk.selected).filter((f) => S.bulk.selected[f]);
    try {
      const d = await post('bulk', { files, op, apply });
      if (apply) {
        const written = d.results.filter((r) => r.written).length;
        toast(`Saved ${written} template(s). Recreate or Apply the containers to use the new settings.`);
        S.bulk.preview = null;
        const l = await api('list'); S.list = l.templates;
      } else {
        S.bulk.preview = d.results;
      }
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  /* --------------------------------------------------------------- render */

  function render() {
    const active = document.activeElement;
    const focusKey = active && active.id;
    if (S.view === 'list') root.innerHTML = renderList();
    else if (S.view === 'bulk') root.innerHTML = renderBulk();
    else if (S.t) root.innerHTML = renderEditor();
    if (focusKey) { const el = document.getElementById(focusKey); if (el) el.focus(); }
    attachAce();
  }

  /* ----------------------------------------------------------------- ace */

  let aceEditors = [];
  const ACE_MODES = { 'dte-xml': 'ace/mode/xml', 'dte-env': 'ace/mode/sh' };

  /**
   * Upgrade the raw XML / .env text areas to Ace when Unraid provides it (7.0+).
   * The text area stays in the DOM, hidden and kept in sync, so the rest of the
   * code keeps reading its value.
   */
  function attachAce() {
    aceEditors.forEach((e) => e.destroy());
    aceEditors = [];
    if (!window.ace || !CFG.aceBasePath) return;
    ace.config.set('basePath', CFG.aceBasePath);
    Object.keys(ACE_MODES).forEach((id) => {
      const ta = document.getElementById(id);
      if (!ta) return;
      const host = document.createElement('div');
      host.className = 'dte-ace';
      host.style.height = `${Math.max(240, Math.min(ta.rows, 40) * 18)}px`;
      ta.after(host);
      ta.hidden = true;
      const ed = ace.edit(host, {
        value: ta.value, mode: ACE_MODES[id], theme: CFG.aceTheme || 'ace/theme/tomorrow',
        fontSize: 13, showPrintMargin: false, useWorker: false, tabSize: 2, useSoftTabs: true, wrap: id === 'dte-env',
      });
      ed.session.on('change', () => { ta.value = ed.getValue(); });
      ed.commands.addCommand({
        name: 'save', bindKey: { win: 'Ctrl-S', mac: 'Command-S' },
        exec: () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true })),
      });
      aceEditors.push(ed);
    });
  }

  /** Refresh only dirty markers after an in-place edit so the focused input is not replaced. */
  function refreshMarkers(id) {
    const tr = root.querySelector(`tr[data-row="${id}"]`);
    const c = S.t.configs.find((x) => x._id === id);
    if (tr && c) {
      tr.classList.remove('dte-row-new', 'dte-row-changed');
      const st = rowState(c);
      if (st) tr.classList.add(`dte-row-${st}`);
    }
    const dirty = isDirty();
    root.querySelectorAll('[data-act="save"],[data-act="revert"]').forEach((b) => { b.disabled = !dirty; });
    const title = root.querySelector('.dte-title');
    if (title) {
      const badge = title.querySelector('.dte-badge-warn');
      if (dirty && !badge) title.insertAdjacentHTML('beforeend', '<span class="dte-badge dte-badge-warn">unsaved changes</span>');
      if (!dirty && badge) badge.remove();
    }
  }

  const findConfig = (id) => S.t.configs.find((c) => c._id === +id);

  root.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.bind) {
      S[el.dataset.bind] = el.value;
      const pos = el.selectionStart;
      render();
      const again = root.querySelector(`[data-bind="${el.dataset.bind}"]`);
      if (again) { again.focus(); again.setSelectionRange(pos, pos); }
      return;
    }
    if (el.dataset.field !== undefined) {
      S.t.fields[el.dataset.field] = el.value;
      refreshMarkers();
      return;
    }
    if (el.dataset.id && el.dataset.attr && el.type !== 'checkbox' && el.tagName !== 'SELECT') {
      const c = findConfig(el.dataset.id);
      if (el.dataset.attr === '=value') c.value = el.value; else c.attrs[el.dataset.attr] = el.value;
      refreshMarkers(c._id);
    }
  });

  root.addEventListener('change', (e) => {
    const el = e.target;
    if (el.classList.contains('b-file')) { S.bulk.selected[el.value] = el.checked; S.bulk.preview = null; render(); return; }
    if (el.dataset.field !== undefined && el.tagName === 'SELECT') { S.t.fields[el.dataset.field] = el.value; refreshMarkers(); return; }
    if (!el.dataset.id || !el.dataset.attr) return;
    const c = findConfig(el.dataset.id);
    if (el.type === 'checkbox') c.attrs[el.dataset.attr] = el.checked ? 'true' : 'false';
    else if (el.tagName === 'SELECT') {
      c.attrs[el.dataset.attr] = el.value;
      if (el.dataset.attr === 'Type') {
        const def = { Port: 'tcp', Path: 'rw' }[el.value] || '';
        if (!(MODES[el.value] || ['']).includes(c.attrs.Mode || '')) c.attrs.Mode = def;
      }
    }
    render();
  });

  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled || el.tagName === 'SELECT') return;
    const act = el.dataset.act;
    const id = el.dataset.id ? +el.dataset.id : null;
    const t = S.t;
    const idx = id ? t.configs.findIndex((c) => c._id === id) : -1;
    switch (act) {
      case 'reload': return loadList();
      case 'open': return openTemplate(el.dataset.file);
      case 'back':
        if (S.view === 'edit' && isDirty() && !(await confirmBox('Discard changes?', '<p>You have unsaved changes.</p>', 'Discard', true))) return;
        S.backups = null; S.envDraft = null;
        return loadList();
      case 'tab':
        if (S.tab === 'env') S.envDraft = document.getElementById('dte-env')?.value ?? S.envDraft;
        S.tab = el.dataset.tab; return render();
      case 'type-filter': S.typeFilter = el.dataset.type; return render();
      case 'add': {
        const type = root.querySelector('[data-act="add-type"]').value;
        const c = newConfig(type);
        t.configs.push(c);
        if (S.typeFilter !== 'All' && S.typeFilter !== type) S.typeFilter = type;
        S.search = '';
        render();
        const inp = root.querySelector(`input[data-id="${c._id}"][data-attr="Target"]`);
        if (inp) { inp.scrollIntoView({ block: 'center' }); inp.focus(); }
        return;
      }
      case 'up': case 'down': {
        // Move past the neighbouring row that is currently visible.
        const vis = [...root.querySelectorAll('tr[data-row]')].map((r) => +r.dataset.row);
        const vi = vis.indexOf(id);
        const other = vis[act === 'up' ? vi - 1 : vi + 1];
        if (other === undefined) return;
        const oi = t.configs.findIndex((c) => c._id === other);
        const [item] = t.configs.splice(idx, 1);
        t.configs.splice(oi, 0, item);
        return render();
      }
      case 'dup': {
        const c = clone(t.configs[idx]);
        c._id = nextId++;
        t.configs.splice(idx + 1, 0, c);
        return render();
      }
      case 'del': t.configs.splice(idx, 1); return render();
      case 'expand': S.expanded[id] = !S.expanded[id]; return render();
      case 'toggle-mask': S.showMasked[id] = !S.showMasked[id]; return render();
      case 'use-default': t.configs[idx].value = t.configs[idx].attrs.Default; return render();
      case 'revert':
        if (await confirmBox('Revert changes?', '<p>Discard all unsaved changes?</p>', 'Revert', true)) {
          S.t = clone(S.orig); S.envDraft = null; render();
        }
        return;
      case 'save': return save();
      case 'recreate': return recreate();
      case 'env-apply': return applyEnv();
      case 'env-reset': S.envDraft = null; return render();
      case 'env-copy': {
        const ta = document.getElementById('dte-env');
        try { await navigator.clipboard.writeText(ta.value); toast('Copied.'); } catch (_) { ta.select(); document.execCommand('copy'); toast('Copied.'); }
        return;
      }
      case 'xml-save': {
        try {
          const d = await post('saveRaw', { file: t.file, hash: t.hash, xml: document.getElementById('dte-xml').value });
          afterSave(d);
        } catch (err) { toast(err.message, 'err'); }
        return;
      }
      case 'xml-download': {
        const blob = new Blob([document.getElementById('dte-xml').value], { type: 'application/xml' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = t.file; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        return;
      }
      case 'bk-view': case 'bk-restore': {
        try {
          const d = await api('backup', { file: t.file, id: el.dataset.id });
          if (act === 'bk-view') {
            await modal(`Changes since ${el.dataset.id}`, `<p class="dte-muted"><span class="dte-dadd">+ current</span> <span class="dte-ddel">- backup</span></p><div class="dte-code dte-difftext">${lineDiff(d.xml, t.xml)}</div>`);
          } else if (await confirmBox('Restore backup?', '<p>The current version is backed up first, so you can undo this.</p>', 'Restore')) {
            afterSave(await post('saveRaw', { file: t.file, hash: t.hash, xml: d.xml }));
          }
        } catch (err) { toast(err.message, 'err'); }
        return;
      }
      case 'bulk-open': S.view = 'bulk'; S.bulk.preview = null; return render();
      case 'b-all': S.list.forEach((x) => { if (!x.error && !x.legacy) S.bulk.selected[x.file] = true; }); S.bulk.preview = null; return render();
      case 'b-none': S.bulk.selected = {}; S.bulk.preview = null; return render();
      case 'b-kind': readBulkForm(); S.bulk.kind = el.dataset.kind; S.bulk.preview = null; return render();
      case 'b-preview': return bulkRun(false);
      case 'b-apply': return bulkRun(true);
    }
  });

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('tr[data-act="open"]')) openTemplate(e.target.dataset.file);
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's' && S.view === 'edit') {
      e.preventDefault();
      if (S.tab === 'xml') root.querySelector('[data-act="xml-save"]').click();
      else if (isDirty()) save();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (S.view === 'edit' && isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  loadList();
})();
