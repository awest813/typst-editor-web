/**
 * Edit panel — full property control for all element types.
 * Web/static version: measurement panel removed (no server).
 */

const EditorPanel = (() => {

  // ── Full property definitions per element type ──
  const PROPS = {
    tcard: {
      _args: {
        num:       { label: 'Number',    type: 'num-or-none', default: 'none' },
        title:     { label: 'Title',     type: 'text',        default: '' },
        inset:     { label: 'Inset',     type: 'dimension',   default: '6mm' },
        colspan:   { label: 'Colspan',   type: 'select',      default: '1', options: [{v:'1',l:'1 (single column)'},{v:'2',l:'2 (full width)'}] },
      },
      _layout: {
        v_space_before:{ label: 'Space Before',  type: 'dimension', default: '' },
        v_space_after: { label: 'Space After',   type: 'dimension', default: '' },
      },
    },
    ibox: {
      _args: {
        type:    { label: 'Type',    type: 'select', default: 'note', options: [{v:'note',l:'Note'},{v:'warning',l:'Warning'},{v:'danger',l:'Danger'},{v:'success',l:'Success'}] },
        label:   { label: 'Label',   type: 'label-radio', default: 'auto' },
        colspan: { label: 'Colspan', type: 'select', default: '2', options: [{v:'1',l:'1 (single column)'},{v:'2',l:'2 (full width)'},{v:'3',l:'3 (Quick Ref)'}] },
      },
      _layout: {
        v_space_before:{ label: 'Space Before',  type: 'dimension', default: '' },
        v_space_after: { label: 'Space After',   type: 'dimension', default: '' },
      },
    },
    sintro: {
      _args: {
        _title:  { label: 'Title',   type: 'text',   default: '' },
        colspan: { label: 'Colspan', type: 'select', default: '2', options: [{v:'1',l:'1 (single column)'},{v:'2',l:'2 (full width)'}] },
      },
      _layout: {
        v_space_before:{ label: 'Space Before',  type: 'dimension', default: '' },
        v_space_after: { label: 'Space After',   type: 'dimension', default: '' },
      },
    },
    ptitle: {
      _args: {
        _title: { label: 'Title', type: 'text', default: '' },
      },
      _text: {
        size:   { label: 'Font Size', type: 'dimension', default: '20pt' },
        weight: { label: 'Weight',    type: 'text',      default: 'bold', hint: 'bold, semibold, 300, etc.' },
      },
      _layout: {
        v_space_after: { label: 'Space After', type: 'dimension', default: '' },
      },
    },
    image: {
      _args: {
        path:   { label: 'Path',   type: 'text',      default: '' },
        width:  { label: 'Width',  type: 'dimension', default: '' },
        height: { label: 'Height', type: 'dimension', default: '' },
      },
      _layout: {
        v_space_before:{ label: 'Space Before', type: 'dimension', default: '' },
        v_space_after: { label: 'Space After',  type: 'dimension', default: '' },
      },
    },
  };

  const GROUP_LABELS = {
    _args: 'Arguments',
    _block: 'Block Properties',
    _text: 'Text Properties',
    _layout: 'Layout & Spacing',
  };

  // ── Build form ──

  function buildForm(el, onApply, pageElements, sectionName) {
    const wrap = document.createElement('div');

    const header = document.createElement('div');
    header.className = 'edit-section-title';
    header.textContent = el.type === 'page-block' ? 'COVER PAGE' : el.type.toUpperCase();
    wrap.appendChild(header);

    const info = document.createElement('div');
    info.className = 'line-info';
    info.textContent = `Lines ${el.lineStart}–${el.lineEnd} · Page ${el.page}` + (sectionName ? ` · ${sectionName}` : '');
    wrap.appendChild(info);

    // Tabs
    const tabBar = document.createElement('div');
    tabBar.className = 'tab-bar';
    const tabProps  = mkTab('Properties', true);
    const tabSource = mkTab('Source', false);
    tabBar.appendChild(tabProps);
    tabBar.appendChild(tabSource);
    wrap.appendChild(tabBar);

    // Properties panel
    const propsPanel = document.createElement('div');
    propsPanel.className = 'tab-panel';
    const fields = buildPropertyFields(el, propsPanel);
    wrap.appendChild(propsPanel);

    // Source panel
    const sourcePanel = document.createElement('div');
    sourcePanel.className = 'tab-panel hidden';
    const sourceTa = document.createElement('textarea');
    sourceTa.className = 'source-editor';
    sourceTa.value = el.sourceSlice;
    sourceTa.spellcheck = false;
    sourcePanel.appendChild(sourceTa);
    wrap.appendChild(sourcePanel);

    tabProps.addEventListener('click',  () => activate(tabProps, tabSource, propsPanel, sourcePanel));
    tabSource.addEventListener('click', () => activate(tabSource, tabProps, sourcePanel, propsPanel));

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.className = 'btn-row';

    btnRow.appendChild(mkBtn('Apply', 'btn-primary', () => {
      if (!sourcePanel.classList.contains('hidden')) {
        onApply(el, { __raw: sourceTa.value });
      } else if (fields.__generateRaw) {
        onApply(el, { __raw: fields.__generateRaw.getValue() });
      } else {
        const changes = {};
        for (const [k, f] of Object.entries(fields)) {
          if (f.isDirty()) changes[k] = f.getValue();
        }
        onApply(el, changes);
      }
    }));
    btnRow.appendChild(mkBtn('Reset', 'btn-secondary', () => {
      sourceTa.value = el.sourceSlice;
      for (const f of Object.values(fields)) f.reset();
    }));
    const deleteBtn = mkBtn('Delete', 'btn-danger', () => {
      btnRow.innerHTML = '';
      const confirmMsg = document.createElement('span');
      confirmMsg.style.cssText = 'font-size:11px;color:var(--muted);align-self:center';
      confirmMsg.textContent = 'Delete this element?';
      btnRow.appendChild(confirmMsg);
      btnRow.appendChild(mkBtn('Confirm', 'btn-danger', () => onApply(el, { __delete: true })));
      btnRow.appendChild(mkBtn('Cancel', 'btn-secondary', () => {
        btnRow.innerHTML = '';
        btnRow.appendChild(applyBtn);
        btnRow.appendChild(resetBtn);
        btnRow.appendChild(deleteBtn);
      }));
    });
    const applyBtn = btnRow.querySelector('.btn-primary');
    const resetBtn = btnRow.querySelector('.btn-secondary');
    btnRow.appendChild(deleteBtn);

    wrap.appendChild(btnRow);
    return wrap;
  }

  // ── Cover page helpers ──

  function parseCoverFields(src) {
    const titleM    = src.match(/upper\s*\(\s*"([^"]*)"\s*\)/);
    const title     = titleM ? titleM[1] : '';

    const titleSzM  = src.match(/text\s*\(\s*size:\s*([^,]+),\s*weight:\s*"bold"/);
    const titleSize = titleSzM ? titleSzM[1].trim() : '28pt';

    // Collect all text(size: Xpt, fill: muted, "...") lines (subtitle, author)
    let subtitle = '', subtitleSize = '14pt', author = '', authorSize = '11pt';
    const mutedPat = /text\s*\(\s*size:\s*(\d+pt),\s*fill:\s*muted,\s*"([^"]*)"\s*\)/g;
    let mm;
    while ((mm = mutedPat.exec(src)) !== null) {
      const sz = parseInt(mm[1]);
      if (sz >= 13) { subtitle = mm[2]; subtitleSize = mm[1]; }
      else          { author   = mm[2]; authorSize   = mm[1]; }
    }

    const barM    = src.match(/rect\s*\(\s*width:\s*([^,)]+)/);
    const barWidth = barM ? barM[1].trim() : '60mm';

    return { title, titleSize, subtitle, subtitleSize, author, authorSize, barWidth };
  }

  function regenerateCover(f) {
    const e = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return (
      `#page(\n  paper: "a4",\n  margin: (top: 22mm, bottom: 26mm, left: 26mm, right: 26mm),\n` +
      `  background: rect(width: 100%, height: 100%, stroke: 2pt + lc, fill: white),\n  footer: none,\n)[\n` +
      `  #v(1fr)\n  #align(center)[\n` +
      `    #text(size: ${f.titleSize}, weight: "bold", fill: primary, upper("${e(f.title)}"))\n` +
      (f.subtitle ? `    #v(4mm)\n    #text(size: ${f.subtitleSize}, fill: muted, "${e(f.subtitle)}")\n` : '') +
      (f.author   ? `    #v(3mm)\n    #text(size: ${f.authorSize}, fill: muted, "${e(f.author)}")\n`   : '') +
      `    #v(8mm)\n    #rect(width: ${f.barWidth}, height: 2pt, fill: primary)\n  ]\n  #v(1fr)\n]`
    );
  }

  function buildCoverPropertyFields(el, container) {
    const f = parseCoverFields(el.sourceSlice);

    const warning = document.createElement('div');
    warning.style.cssText = 'font-size:11px;color:#a06000;background:#fffbf0;border:1px solid #f0c060;border-radius:4px;padding:6px 8px;margin-bottom:8px;';
    warning.textContent = 'Applying will regenerate the standard cover layout. Custom page attributes outside Title/Subtitle/Author/Bar Width will be reset.';
    container.appendChild(warning);

    const mkGH = text => {
      const gh = document.createElement('div');
      gh.className = 'field-group-header';
      gh.textContent = text;
      container.appendChild(gh);
    };

    mkGH('Content');
    const fTitle = addTextField(container, 'Title',             f.title,    '');
    const fSub   = addTextField(container, 'Subtitle',          f.subtitle, 'Optional — leave blank to hide');
    const fAuth  = addTextField(container, 'Author / Company',  f.author,   'Optional — leave blank to hide');

    mkGH('Style');
    const fTSize = addTextField(container, 'Title Font Size',   f.titleSize,  'e.g. 28pt');
    const fBar   = addTextField(container, 'Accent Bar Width',  f.barWidth,   'e.g. 60mm');

    const getVals = () => ({
      title:       fTitle.getValue(),
      subtitle:    fSub.getValue(),
      author:      fAuth.getValue(),
      titleSize:   fTSize.getValue() || f.titleSize,
      subtitleSize: f.subtitleSize,
      authorSize:   f.authorSize,
      barWidth:    fBar.getValue() || f.barWidth,
    });

    return {
      _coverTitle: fTitle,
      _coverSub:   fSub,
      _coverAuth:  fAuth,
      _coverTSize: fTSize,
      _coverBar:   fBar,
      __generateRaw: {
        getValue: () => regenerateCover(getVals()),
        isDirty:  () => true,
        reset:    () => {},
      },
    };
  }

  function buildPropertyFields(el, container) {
    if (el.type === 'page-block') return buildCoverPropertyFields(el, container);

    const propDef = PROPS[el.type];
    if (!propDef) {
      container.innerHTML = '<p class="placeholder">No properties defined for this type. Use Source tab.</p>';
      return {};
    }

    const fields = {};
    const currentVals = extractCurrentValues(el);

    for (const [groupKey, groupProps] of Object.entries(propDef)) {
      const groupLabel = GROUP_LABELS[groupKey] || groupKey;
      const gh = document.createElement('div');
      gh.className = 'field-group-header';
      gh.textContent = groupLabel;
      container.appendChild(gh);

      const inGrid = !el.sourceSlice.trimStart().startsWith('#');

      for (const [propKey, propSpec] of Object.entries(groupProps)) {
        if (inGrid && (propKey === 'v_space_before' || propKey === 'v_space_after')) continue;

        const currentVal = currentVals[propKey] ?? '';
        const displayVal = currentVal || propSpec.default || '';
        const isDefault = !currentVal;

        fields[propKey] = buildField(container, propSpec, propKey, displayVal, isDefault);
      }

      if (inGrid && groupKey === '_layout') {
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:10px;color:var(--muted);margin-bottom:6px;font-style:italic';
        hint.textContent = 'Spacing between grid items is controlled by the grid\'s gutter property. Use Source tab to adjust.';
        container.appendChild(hint);
      }
    }

    if (el.body !== undefined && el.type !== 'ptitle' && el.type !== 'image') {
      const bh = document.createElement('div');
      bh.className = 'field-group-header';
      bh.textContent = 'Body Content';
      container.appendChild(bh);
      fields['__body'] = addTextArea(container, 'body', el.body);
    }

    const ref = document.createElement('div');
    ref.className = 'field-hint-block';
    ref.innerHTML = `<strong>Units:</strong> mm, pt, cm, em, % · <strong>Colors:</strong> primary, muted, lc, ink, warn-c, ok-c, dng-c · <strong>Spacing:</strong> use Space Before/After fields, or #v()/#h() in body`;
    container.appendChild(ref);

    return fields;
  }

  function extractCurrentValues(el) {
    const vals = {};
    for (const [k, v] of Object.entries(el.args || {})) vals[k] = v;
    if (el.type === 'ptitle' || el.type === 'sintro') vals['_title'] = el.title;
    if (el._srcLines) {
      const vBefore = (el._srcLines.before || '').match(/#?v\(([^)]+)\)/);
      const vAfter  = (el._srcLines.after  || '').match(/#?v\(([^)]+)\)/);
      if (vBefore) vals['v_space_before'] = vBefore[1];
      if (vAfter)  vals['v_space_after']  = vAfter[1];
    }
    return vals;
  }

  // ── Field builders ──

  function buildField(parent, spec, key, value, isDefault) {
    switch (spec.type) {
      case 'text':       return addTextField(parent, spec.label, value, spec.hint, isDefault);
      case 'dimension':  return addTextField(parent, spec.label, value, spec.hint || 'e.g. 6mm, 10pt, 50%', isDefault);
      case 'num-or-none':return addNumField(parent, spec.label, value);
      case 'bool':       return addBoolField(parent, spec.label, value);
      case 'select':     return addSelectField(parent, spec.label, value, spec.options);
      case 'label-radio':return addLabelField(parent, spec.label, value);
      case 'textarea':   return addTextArea(parent, spec.label, value);
      default:           return addTextField(parent, spec.label, value, spec.hint, isDefault);
    }
  }

  function addTextField(parent, label, value, hint, isDefault) {
    const div = document.createElement('div');
    div.className = 'edit-field';
    div.innerHTML = `<label>${esc(label)}${isDefault ? ' <span class="default-tag">default</span>' : ''}</label>`;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    if (hint) input.placeholder = hint;
    if (isDefault) input.classList.add('field-default');
    input.addEventListener('input', () => input.classList.remove('field-default'));
    const original = value || '';
    div.appendChild(input);
    parent.appendChild(div);
    return { getValue: () => input.value, isDirty: () => input.value !== original, reset: () => { input.value = original; } };
  }

  function addTextArea(parent, label, value) {
    const div = document.createElement('div');
    div.className = 'edit-field';
    div.innerHTML = `<label>${esc(label)}</label>`;
    const ta = document.createElement('textarea');
    ta.value = value;
    const original = value;
    attachToolbar(div, ta);
    div.appendChild(ta);
    parent.appendChild(div);
    return { getValue: () => ta.value, isDirty: () => ta.value !== original, reset: () => { ta.value = original; } };
  }

  // ── Formatting toolbar ──

  function attachToolbar(container, ta) {
    const toolbar = document.createElement('div');
    toolbar.className = 'text-toolbar';

    function wrap(before, after, placeholder) {
      const s = ta.selectionStart, e = ta.selectionEnd;
      const sel = ta.value.slice(s, e) || placeholder || 'text';
      ta.setRangeText(before + sel + after, s, e, 'select');
      if (!ta.value.slice(s, e)) {
        ta.setSelectionRange(s + before.length, s + before.length + sel.length);
      } else {
        ta.setSelectionRange(s + before.length, s + before.length + sel.length);
      }
      ta.focus();
    }

    function prefixLines(prefix) {
      const s = ta.selectionStart, e = ta.selectionEnd;
      const text = ta.value;
      const lineStart = text.lastIndexOf('\n', s - 1) + 1;
      let lineEnd = text.indexOf('\n', e);
      if (lineEnd === -1) lineEnd = text.length;
      const before = text.slice(0, lineStart);
      const chunk  = text.slice(lineStart, lineEnd);
      const after  = text.slice(lineEnd);
      const lineCount = (chunk.match(/\n/g) || []).length + 1;
      ta.value = before + chunk.split('\n').map(l => prefix + l).join('\n') + after;
      ta.setSelectionRange(s + prefix.length, e + prefix.length * lineCount);
      ta.focus();
    }

    function insertBlock(text) {
      const s = ta.selectionStart;
      const before = ta.value.slice(0, s);
      const lineStart = before.endsWith('\n') || before === '' ? '' : '\n';
      const insert = lineStart + text + '\n';
      ta.setRangeText(insert, s, s, 'end');
      ta.focus();
    }

    const BTNS = [
      { l: 'B',   title: 'Bold',             css: 'font-weight:700',                  fn: () => wrap('*', '*') },
      { l: 'I',   title: 'Italic',            css: 'font-style:italic',                fn: () => wrap('_', '_') },
      { l: 'U',   title: 'Underline',         css: 'text-decoration:underline',        fn: () => wrap('#underline[', ']') },
      { l: 'S',   title: 'Strikethrough',     css: 'text-decoration:line-through',     fn: () => wrap('#strike[', ']') },
      { sep: true },
      { l: '`',   title: 'Inline code',       css: 'font-family:monospace;font-size:13px', fn: () => wrap('`', '`') },
      { l: '⌨',  title: 'Code block',        css: '',                                 fn: () => wrap('```\n', '\n```') },
      { sep: true },
      { l: '•',   title: 'Bullet list item',  css: '',                                 fn: () => prefixLines('- ') },
      { l: '1.',  title: 'Numbered list item',css: 'font-size:10px',                   fn: () => prefixLines('+ ') },
      { l: '  →', title: 'Indent',            css: 'font-size:10px;letter-spacing:-1px',fn: () => prefixLines('  ') },
      { sep: true },
      { l: 'x²',  title: 'Superscript',       css: 'font-size:10px',                   fn: () => wrap('#super[', ']') },
      { l: 'x₂',  title: 'Subscript',         css: 'font-size:10px',                   fn: () => wrap('#sub[', ']') },
      { l: '🔗',  title: 'Link',              css: '',                                  fn: () => wrap('#link("url")[', ']', 'link text') },
      { sep: true },
      { l: '―',   title: 'Horizontal rule',   css: 'font-size:16px;line-height:1',     fn: () => insertBlock('#line(length: 100%, stroke: 0.5pt + lc)') },
    ];

    for (const b of BTNS) {
      if (b.sep) {
        const s = document.createElement('span');
        s.className = 'toolbar-sep';
        toolbar.appendChild(s);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toolbar-btn';
      btn.title = b.title;
      btn.textContent = b.l;
      if (b.css) btn.style.cssText = b.css;
      btn.addEventListener('mousedown', e => { e.preventDefault(); b.fn(); });
      toolbar.appendChild(btn);
    }

    // Image picker button
    const imgSep = document.createElement('span');
    imgSep.className = 'toolbar-sep';
    toolbar.appendChild(imgSep);

    const imgBtn = document.createElement('button');
    imgBtn.type = 'button';
    imgBtn.className = 'toolbar-btn';
    imgBtn.title = 'Insert image';
    imgBtn.textContent = '🖼';
    imgBtn.addEventListener('mousedown', e => { e.preventDefault(); showImagePicker(ta, imgBtn); });
    toolbar.appendChild(imgBtn);

    function showImagePicker(ta, anchorBtn) {
      const existing = document.getElementById('img-picker-popup');
      if (existing) { existing._revoke?.(); existing.remove(); return; }

      const images = (typeof window.getLoadedImages === 'function') ? window.getLoadedImages() : {};
      const popup = document.createElement('div');
      popup.id = 'img-picker-popup';
      popup.className = 'img-picker-popup';

      const keys = Object.keys(images);
      if (keys.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'img-picker-empty';
        empty.textContent = 'No images loaded. Open the Image Manager (🖼 in the sidebar) to load images first.';
        popup.appendChild(empty);
      } else {
        // Read image-radius from document settings
        const docVars = (typeof window.getDocumentVars === 'function') ? window.getDocumentVars() : [];
        const radiusVar = docVars.find(v => v.name === 'image-radius');
        const radiusVal = radiusVar ? parseFloat(radiusVar.value) : 0;
        const radiusStr = radiusVar ? radiusVar.value : '0pt';

        const getSnippet = path => radiusVal > 0
          ? `#box(radius: ${radiusStr}, clip: true, image("${path}", width: 100%))`
          : `#image("${path}", width: 100%)`;

        if (radiusVal > 0) {
          const hint = document.createElement('p');
          hint.className = 'img-picker-hint';
          hint.textContent = `Corner radius: ${radiusStr} (set in Document Settings)`;
          popup.appendChild(hint);
        }

        const grid = document.createElement('div');
        grid.className = 'img-picker-grid';
        const blobUrls = [];

        for (const key of keys) {
          const buf = images[key];
          const name = key.split('/').pop();
          const snippetPath = key.startsWith('/') ? '..' + key : key;

          const card = document.createElement('div');
          card.className = 'img-picker-card';
          card.title = name;

          const thumb = document.createElement('img');
          thumb.className = 'img-picker-thumb';
          try {
            const blob = new Blob([buf]);
            const url = URL.createObjectURL(blob);
            blobUrls.push(url);
            thumb.src = url;
          } catch (_) { thumb.alt = name; }

          const label = document.createElement('span');
          label.className = 'img-picker-label';
          label.textContent = name;

          card.appendChild(thumb);
          card.appendChild(label);
          card.addEventListener('mousedown', e => {
            e.preventDefault();
            insertBlock(getSnippet(snippetPath));
            blobUrls.forEach(u => URL.revokeObjectURL(u));
            popup.remove();
            document.removeEventListener('mousedown', outsideHandler);
          });
          grid.appendChild(card);
        }

        popup._revoke = () => blobUrls.forEach(u => URL.revokeObjectURL(u));
        popup.appendChild(grid);
      }

      document.body.appendChild(popup);
      const rect = anchorBtn.getBoundingClientRect();
      const pw = popup.offsetWidth || 260;
      popup.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - pw - 8)) + 'px';
      popup.style.top = (rect.bottom + window.scrollY + 4) + 'px';

      const outsideHandler = e => {
        if (!popup.contains(e.target) && e.target !== anchorBtn) {
          popup._revoke?.();
          popup.remove();
          document.removeEventListener('mousedown', outsideHandler);
        }
      };
      setTimeout(() => document.addEventListener('mousedown', outsideHandler), 0);
    }

    container.appendChild(toolbar);
  }

  function addNumField(parent, label, value) {
    const isNone = value === 'none' || value === '';
    const div = document.createElement('div');
    div.className = 'edit-field';
    div.innerHTML = `<label>${esc(label)}</label>`;
    const row = document.createElement('div');
    row.className = 'checkbox-row';
    const input = document.createElement('input');
    input.type = 'number';
    input.value = isNone ? '' : value;
    input.style.width = '80px';
    input.disabled = isNone;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = isNone;
    cb.id = 'n-' + rnd();
    const cbl = document.createElement('label');
    cbl.htmlFor = cb.id;
    cbl.textContent = 'none';
    cbl.style.cssText = 'text-transform:none;font-weight:normal;color:var(--ink);cursor:pointer;display:inline';
    cb.addEventListener('change', () => { input.disabled = cb.checked; if (cb.checked) input.value = ''; });
    row.appendChild(input); row.appendChild(cb); row.appendChild(cbl);
    div.appendChild(row);
    parent.appendChild(div);
    const ov = value;
    const origGet = () => cb.checked ? 'none' : input.value;
    const origVal = ov === 'none' || ov === '' ? 'none' : ov;
    return {
      getValue: origGet,
      isDirty: () => origGet() !== origVal,
      reset: () => { const n = ov === 'none' || ov === ''; cb.checked = n; input.disabled = n; input.value = n ? '' : ov; },
    };
  }

  function addBoolField(parent, label, value) {
    const div = document.createElement('div');
    div.className = 'edit-field';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = value === 'true';
    cb.id = 'b-' + rnd();
    const lbl = document.createElement('label');
    lbl.htmlFor = cb.id;
    lbl.textContent = ` ${label}`;
    lbl.style.cssText = 'display:inline;cursor:pointer';
    div.appendChild(cb); div.appendChild(lbl);
    parent.appendChild(div);
    const ov = value === 'true';
    return { getValue: () => cb.checked ? 'true' : 'false', isDirty: () => cb.checked !== ov, reset: () => { cb.checked = ov; } };
  }

  function addSelectField(parent, label, value, options) {
    const div = document.createElement('div');
    div.className = 'edit-field';
    div.innerHTML = `<label>${esc(label)}</label>`;
    const sel = document.createElement('select');
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.v; opt.textContent = o.l;
      if (o.v === value) opt.selected = true;
      sel.appendChild(opt);
    }
    const orig = value;
    div.appendChild(sel);
    parent.appendChild(div);
    return { getValue: () => sel.value, isDirty: () => sel.value !== orig, reset: () => { sel.value = orig; } };
  }

  function addLabelField(parent, label, value) {
    const div = document.createElement('div');
    div.className = 'edit-field';
    div.innerHTML = `<label>${esc(label)}</label>`;
    const group = document.createElement('div');
    group.className = 'radio-group';
    const name = 'l-' + rnd();
    let mode = 'auto', custom = '';
    if (value === 'auto') mode = 'auto';
    else if (value === 'none') mode = 'none';
    else { mode = 'custom'; custom = value.replace(/^"|"$/g, ''); }
    const ci = document.createElement('input');
    ci.type = 'text'; ci.value = custom;
    ci.style.cssText = 'width:140px;margin-left:4px';
    ci.disabled = mode !== 'custom';
    for (const m of [{v:'auto',l:'Auto (from type)'},{v:'none',l:'None (hidden)'},{v:'custom',l:'Custom:'}]) {
      const lbl = document.createElement('label');
      const r = document.createElement('input');
      r.type = 'radio'; r.name = name; r.value = m.v;
      r.checked = m.v === mode;
      r.addEventListener('change', () => { ci.disabled = r.value !== 'custom'; });
      lbl.appendChild(r);
      lbl.appendChild(document.createTextNode(' ' + m.l));
      if (m.v === 'custom') lbl.appendChild(ci);
      group.appendChild(lbl);
    }
    div.appendChild(group);
    parent.appendChild(div);
    const om = mode, oc = custom;
    const origLabel = mode === 'auto' ? 'auto' : mode === 'none' ? 'none' : `"${custom}"`;
    const getVal = () => { const c = group.querySelector(`input[name="${name}"]:checked`).value; return c === 'auto' ? 'auto' : c === 'none' ? 'none' : `"${ci.value || ''}"`;};
    return {
      getValue: getVal,
      isDirty: () => getVal() !== origLabel,
      reset: () => { group.querySelector(`input[value="${om}"]`).checked = true; ci.value = oc; ci.disabled = om !== 'custom'; },
    };
  }

  // ── Insert form ──

  function buildInsertForm(pageNum, onInsert) {
    const wrap = document.createElement('div');
    const header = document.createElement('div');
    header.className = 'edit-section-title';
    header.textContent = 'INSERT NEW ELEMENT';
    wrap.appendChild(header);

    const info = document.createElement('div');
    info.className = 'line-info';
    info.textContent = `Will insert on page ${pageNum}`;
    wrap.appendChild(info);

    const typeSelect = document.createElement('select');
    typeSelect.innerHTML = `
      <option value="tcard">Task Card (tcard)</option>
      <option value="ibox">Info Box (ibox)</option>
      <option value="sintro">Section Intro (sintro)</option>
      <option value="ptitle">Page Title (ptitle)</option>
      <option value="image">Image</option>
      <option value="pagebreak">Page Break + New Section</option>
      <option value="custom">Custom (raw Typst)</option>`;
    addFieldTo(wrap, 'Element Type', () => typeSelect);

    const ta = document.createElement('textarea');
    ta.className = 'source-editor';
    ta.spellcheck = false;
    attachToolbar(wrap, ta);
    wrap.appendChild(ta);

    function update() { ta.value = getTemplate(typeSelect.value); }
    typeSelect.addEventListener('change', update);
    update();

    const colDiv = document.createElement('div');
    colDiv.className = 'edit-field';
    const colCb = document.createElement('input');
    colCb.type = 'checkbox'; colCb.id = 'csc';
    const colLbl = document.createElement('label');
    colLbl.htmlFor = 'csc';
    colLbl.textContent = ' Add colspan: 2 (full width)';
    colLbl.style.cssText = 'text-transform:none;font-weight:normal;display:inline;cursor:pointer';
    colDiv.appendChild(colCb); colDiv.appendChild(colLbl);
    wrap.appendChild(colDiv);

    const btnRow = document.createElement('div');
    btnRow.className = 'btn-row';
    btnRow.appendChild(mkBtn('Insert', 'btn-primary', () => {
      let code = ta.value;
      if (colCb.checked) code = code.replace(/(\w+\s*\()/, '$1colspan: 2, ');
      const position = typeSelect.value === 'pagebreak' ? 'page-end' : 'end';
      onInsert(pageNum, position, code);
    }));
    wrap.appendChild(btnRow);
    return wrap;
  }

  function getTemplate(type) {
    const T = {
      tcard: `  tcard(num: 1, title: "New Card")[
    Content goes here.
  ],`,
      ibox: `  ibox(type: "note")[
    Note content here.
  ],`,
      sintro: `  sintro("Section Title")[
    Introduction text here.
  ],`,
      ptitle: `#ptitle("Page Title")`,
      image: `  #image("/images/filename.png",
         width: 100%)`,
      pagebreak: `#pagebreak()
#fsec.update("Section N: Title")

#ptitle("Section N: Title")

#grid(
  columns: (1fr, 1fr),
  gutter: 5mm,
  align: top,
  tcard(num: 1, title: "First Card")[
    Add content here.
  ],
  tcard(num: 2, title: "Second Card")[
    Add content here.
  ],
)`,
      custom: `  // Your Typst code here`,
    };
    return T[type] || '';
  }

  // ── Helpers ──

  function mkTab(text, active) {
    const b = document.createElement('button');
    b.className = 'tab' + (active ? ' active' : '');
    b.textContent = text;
    return b;
  }
  function mkBtn(text, cls, fn) {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = text;
    b.addEventListener('click', fn);
    return b;
  }
  function activate(on, off, showPanel, hidePanel) {
    on.classList.add('active'); off.classList.remove('active');
    showPanel.classList.remove('hidden'); hidePanel.classList.add('hidden');
  }
  function addFieldTo(parent, label, mkEl) {
    const d = document.createElement('div');
    d.className = 'edit-field';
    d.innerHTML = `<label>${esc(label)}</label>`;
    d.appendChild(mkEl());
    parent.appendChild(d);
  }
  function esc(s) { return s.replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function rnd() { return Math.random().toString(36).slice(2, 6); }

  // ── Document Settings form ──

  const FRIENDLY = {
    'primary': 'Primary Color', 'muted': 'Muted Text', 'ink': 'Text Color',
    'lc': 'Light Accent', 'tint': 'Card Tint', 'tint2': 'Card Tint Alt',
    'warn-bg': 'Warning Background', 'warn-c': 'Warning Color',
    'ok-bg': 'Success Background', 'ok-c': 'Success Color',
    'dng-bg': 'Danger Background', 'dng-c': 'Danger Color',
    'card-stroke-top': 'Card Top Border', 'card-stroke-rest': 'Card Border',
    'card-inset': 'Card Padding', 'card-radius': 'Corner Radius',
    'title-bar-w': 'Title Bar Width',
    'footer-center': 'Footer Center Text',
  };
  function friendlyName(n) {
    return FRIENDLY[n] || n.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  function ensureHash(v) { return v.startsWith('#') ? v : '#' + v; }

  function buildDocumentSettingsForm(vars, onApplyVar) {
    const wrap = document.createElement('div');

    const header = document.createElement('div');
    header.className = 'edit-section-title';
    header.textContent = 'DOCUMENT SETTINGS';
    wrap.appendChild(header);

    if (!vars || vars.length === 0) {
      const p = document.createElement('p');
      p.className = 'placeholder';
      p.textContent = 'No editable variables found. Add #let varname = rgb("#hex") or #let varname = 5mm to expose settings here.';
      wrap.appendChild(p);
      return wrap;
    }

    const colors = vars.filter(v => v.type === 'color');
    const dims   = vars.filter(v => v.type === 'dimension');
    const strs   = vars.filter(v => v.type === 'string');

    if (colors.length > 0) {
      const gh = document.createElement('div');
      gh.className = 'edit-group-header';
      gh.textContent = 'Colors';
      wrap.appendChild(gh);

      for (const v of colors) {
        const div = document.createElement('div');
        div.className = 'edit-field';
        const lbl = document.createElement('label');
        lbl.textContent = friendlyName(v.name);
        div.appendChild(lbl);

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;align-items:center';

        const cp = document.createElement('input');
        cp.type = 'color';
        cp.value = ensureHash(v.value);

        const hexInput = document.createElement('input');
        hexInput.type = 'text';
        hexInput.style.cssText = 'width:90px;font-family:monospace';
        hexInput.maxLength = 7;
        hexInput.value = ensureHash(v.value);

        cp.addEventListener('input', () => { hexInput.value = cp.value; });
        hexInput.addEventListener('input', () => {
          const val = hexInput.value.startsWith('#') ? hexInput.value : '#' + hexInput.value;
          if (/^#[0-9a-fA-F]{6}$/.test(val)) cp.value = val;
        });

        const applyBtn = document.createElement('button');
        applyBtn.className = 'btn btn-primary';
        applyBtn.textContent = 'Apply';
        applyBtn.style.cssText = 'padding:4px 10px';
        applyBtn.addEventListener('click', () => {
          onApplyVar(v.name, hexInput.value, 'color');
        });

        row.appendChild(cp);
        row.appendChild(hexInput);
        row.appendChild(applyBtn);
        div.appendChild(row);
        wrap.appendChild(div);
      }
    }

    if (dims.length > 0) {
      const gh = document.createElement('div');
      gh.className = 'edit-group-header';
      gh.textContent = 'Style';
      wrap.appendChild(gh);

      for (const v of dims) {
        const div = document.createElement('div');
        div.className = 'edit-field';
        const lbl = document.createElement('label');
        lbl.textContent = friendlyName(v.name);
        div.appendChild(lbl);

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;align-items:center';

        const inp = document.createElement('input');
        inp.type = 'text';
        inp.style.width = '90px';
        inp.value = v.value;

        const applyBtn = document.createElement('button');
        applyBtn.className = 'btn btn-primary';
        applyBtn.textContent = 'Apply';
        applyBtn.style.cssText = 'padding:4px 10px';
        applyBtn.addEventListener('click', () => {
          onApplyVar(v.name, inp.value, 'dimension');
        });

        row.appendChild(inp);
        row.appendChild(applyBtn);
        div.appendChild(row);
        wrap.appendChild(div);
      }
    }

    if (strs.length > 0) {
      const gh = document.createElement('div');
      gh.className = 'edit-group-header';
      gh.textContent = 'Footer';
      wrap.appendChild(gh);

      for (const v of strs) {
        const div = document.createElement('div');
        div.className = 'edit-field';
        const lbl = document.createElement('label');
        lbl.textContent = friendlyName(v.name);
        div.appendChild(lbl);

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;align-items:center';

        const inp = document.createElement('input');
        inp.type = 'text';
        inp.style.flex = '1';
        inp.value = v.value;
        inp.placeholder = 'Leave blank to hide';

        const applyBtn = document.createElement('button');
        applyBtn.className = 'btn btn-primary';
        applyBtn.textContent = 'Apply';
        applyBtn.style.cssText = 'padding:4px 10px';
        applyBtn.addEventListener('click', () => {
          onApplyVar(v.name, inp.value, 'string');
        });

        row.appendChild(inp);
        row.appendChild(applyBtn);
        div.appendChild(row);
        wrap.appendChild(div);
      }
    }

    return wrap;
  }

  // ── Add Section form ──

  function genSectionCode(name, type, pageNum) {
    const esc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const n = pageNum;
    const header = `\n// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n// ${name.toUpperCase()}\n// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n#pagebreak()\n#fsec.update("${esc(name)}")\n\n#ptitle("${esc(name)}")\n`;
    if (type === 'standard') return header + `\n#grid(\n  columns: (1fr, 1fr),\n  gutter: 5mm,\n  align: top,\n  sintro("Overview")[\n    Describe this section.\n  ],\n  tcard(num: 1, title: "First Point")[\n    - Item one\n    - Item two\n    - Item three\n  ],\n  tcard(num: 2, title: "Second Point")[\n    - Item one\n    - Item two\n    - Item three\n  ],\n  ibox(type: "note")[\n    Notes for this section.\n  ],\n)\n`;
    if (type === 'quickref') return header + `\n#grid(\n  columns: (1fr, 1fr, 1fr),\n  gutter: 5mm,\n  align: top,\n  tcard(num: none, title: "Topic 1")[\n    - Item one\n    - Item two\n    - Item three\n  ],\n  tcard(num: none, title: "Topic 2")[\n    - Item one\n    - Item two\n    - Item three\n  ],\n  tcard(num: none, title: "Topic 3")[\n    - Item one\n    - Item two\n    - Item three\n  ],\n)\n`;
    if (type === 'fullwidth') return header + `\n#grid(\n  columns: (1fr, 1fr),\n  gutter: 5mm,\n  align: top,\n  sintro("Overview")[\n    Add your content here.\n  ],\n  ibox(type: "note")[\n    Important notes.\n  ],\n)\n`;
    return header + `\n// Add content here\n`;
  }

  function buildAddSectionForm(pageCount, onInsert) {
    const wrap = document.createElement('div');

    const header = document.createElement('div');
    header.className = 'edit-section-title';
    header.textContent = 'ADD NEW SECTION';
    wrap.appendChild(header);

    const nameDiv = document.createElement('div');
    nameDiv.className = 'edit-field';
    nameDiv.innerHTML = '<label>Section Name</label>';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'add-sec-name';
    nameInput.value = 'New Section';
    nameDiv.appendChild(nameInput);
    wrap.appendChild(nameDiv);

    const typeDiv = document.createElement('div');
    typeDiv.className = 'edit-field';
    typeDiv.innerHTML = '<label>Layout</label>';
    const typeSelect = document.createElement('select');
    typeSelect.id = 'add-sec-type';
    typeSelect.innerHTML = `
      <option value="standard">Standard (2-column with cards)</option>
      <option value="quickref">Quick Reference (3-column)</option>
      <option value="fullwidth">Full-width notes</option>
      <option value="blank">Blank page</option>`;
    typeDiv.appendChild(typeSelect);
    wrap.appendChild(typeDiv);

    const previewDiv = document.createElement('div');
    previewDiv.className = 'edit-field';
    previewDiv.innerHTML = '<label>Preview / Edit</label>';
    const ta = document.createElement('textarea');
    ta.className = 'source-editor';
    ta.spellcheck = false;
    ta.rows = 18;
    attachToolbar(previewDiv, ta);
    previewDiv.appendChild(ta);
    wrap.appendChild(previewDiv);

    function updatePreview() {
      ta.value = genSectionCode(nameInput.value, typeSelect.value, pageCount + 1);
    }
    nameInput.addEventListener('input', updatePreview);
    typeSelect.addEventListener('change', updatePreview);
    updatePreview();

    const btnRow = document.createElement('div');
    btnRow.className = 'btn-row';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-primary';
    addBtn.textContent = 'Add Section';
    addBtn.addEventListener('click', () => onInsert(ta.value));
    btnRow.appendChild(addBtn);
    wrap.appendChild(btnRow);

    return wrap;
  }

  return { buildForm, buildInsertForm, buildDocumentSettingsForm, buildAddSectionForm };
})();
