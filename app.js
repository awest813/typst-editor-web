/**
 * LibrePDF — visual PDF document editor, static/browser version.
 * No server. Compiles Typst source via WASM worker, renders via PDF.js.
 */

// ── PDF.js (ESM) ────────────────────────────────────
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.9.155/build/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.9.155/build/pdf.worker.min.mjs';

// ── State ──────────────────────────────────────────
let source = '';
let filename = 'document.typ';
let parsed = { pages: [], elements: [] };
let selectedElement = null;
let revision = 0;
let currentPdfBytes = null;
let imageFiles = {};      // path → ArrayBuffer
let previewZoom = 1.0;
window.getLoadedImages = () => imageFiles;
window.getDocumentVars = () => parseDocumentVars(source);
let linkedDirHandle = null;
let galleryObjectUrls = [];   // tracked so we can revoke on rebuild

// Undo history
let sourceHistory = [];
const MAX_HISTORY = 20;

// Compiler worker (Typst WASM)
let worker = null;

// ── Document var helpers ────────────────────────────

function parseDocumentVars(src) {
  const vars = [];
  const colorPat = /^#let\s+([a-zA-Z][\w-]*)\s*=\s*rgb\("([^"]+)"\)/gm;
  let m;
  while ((m = colorPat.exec(src)) !== null) {
    vars.push({ name: m[1], type: 'color', value: m[2].startsWith('#') ? m[2] : '#' + m[2] });
  }
  const dimPat = /^#let\s+([a-zA-Z][\w-]*)\s*=\s*(\d+(?:\.\d+)?(?:pt|mm|cm|em|in))/gm;
  while ((m = dimPat.exec(src)) !== null) {
    vars.push({ name: m[1], type: 'dimension', value: m[2] });
  }
  const strPat = /^#let\s+([a-zA-Z][\w-]*)\s*=\s*"([^"]*)"/gm;
  while ((m = strPat.exec(src)) !== null) {
    vars.push({ name: m[1], type: 'string', value: m[2] });
  }
  return vars;
}

function applyDocumentVar(name, newValue, type) {
  pushHistory();
  const eName = name.replace(/[-]/g, '\\-');
  if (type === 'color') {
    const v = newValue.startsWith('#') ? newValue : '#' + newValue;
    source = source.replace(
      new RegExp(`(#let\\s+${eName}\\s*=\\s*rgb\\()"[^"]+"(\\))`, 'm'),
      `$1"${v}"$2`
    );
  } else if (type === 'dimension') {
    source = source.replace(
      new RegExp(`(#let\\s+${eName}\\s*=\\s*)\\d+(?:\\.\\d+)?(?:pt|mm|cm|em|in)`, 'm'),
      `$1${newValue}`
    );
  } else if (type === 'string') {
    const escaped = newValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    source = source.replace(
      new RegExp(`(#let\\s+${eName}\\s*=\\s*)"[^"]*"`, 'm'),
      `$1"${escaped}"`
    );
  }
  saveTextSession();
  revision++;
  parsed = TypstParser.parse(source);
  buildTree();
  triggerCompile();
}

// ── DOM refs ───────────────────────────────────────
const landingEl          = document.getElementById('landing');
const appEl              = document.getElementById('app');
const treeContainer      = document.getElementById('tree-container');
const svgContainer       = document.getElementById('svg-container');
const editContainer      = document.getElementById('edit-container');
const fileInput          = document.getElementById('file-input');
const imgInput           = document.getElementById('img-input');
const imgCount           = document.getElementById('img-count');
const dropZone           = document.getElementById('drop-zone');
const landingStatus      = document.getElementById('landing-status');
const fileInfo           = document.getElementById('file-info');
const compileBanner      = document.getElementById('compile-banner');
const compileStatus      = document.getElementById('compile-status');
const errorPanel         = document.getElementById('compile-error-panel');
const errorText          = document.getElementById('compile-error-text');
const previewPlaceholder = document.getElementById('preview-placeholder');
const previewPanel       = document.getElementById('preview-panel');
const btnDlTyp           = document.getElementById('btn-download-typ');
const btnDlPdf           = document.getElementById('btn-download-pdf');
const btnAddImages       = document.getElementById('btn-add-images');
const btnOpenFile        = document.getElementById('btn-open-file');
const dropOverlay        = document.getElementById('drop-overlay');
const btnZoomIn          = document.getElementById('btn-zoom-in');
const btnZoomOut         = document.getElementById('btn-zoom-out');
const btnZoomReset       = document.getElementById('btn-zoom-reset');
const zoomLevelEl        = document.getElementById('zoom-level');
const btnPresent         = document.getElementById('btn-present');
const storageIndicator   = document.getElementById('storage-indicator');
const pwaInstallBanner   = document.getElementById('pwa-install-banner');
const pwaUpdateBanner    = document.getElementById('pwa-update-banner');
const pwaInstallText     = document.getElementById('pwa-install-text');
const btnInstallApp      = document.getElementById('btn-install-app');
const btnClearCache      = document.getElementById('btn-clear-cache');
const btnApplyUpdate     = document.getElementById('btn-apply-update');

// ── Worker init ────────────────────────────────────

function initWorker() {
  worker = new Worker('./typst-worker.js?v=17', { type: 'module' });

  worker.onmessage = (e) => {
    const msg = e.data;

    if (msg.type === 'ready') {
      setCompileStatus('');
    }

    if (msg.type === 'progress') {
      setCompileStatus(msg.text);
    }

    if (msg.type === 'pdf-result') {
      currentPdfBytes = msg.pdf; // keep as ArrayBuffer — Uint8Array view is detached by PDF.js
      btnDlPdf.disabled = false;
      btnPresent.disabled = false;
      setCompileStatus('');
      compileBanner.style.display = 'none';
      errorPanel.style.display = 'none';
      renderPdfPages(currentPdfBytes).catch(err => {
        showToast('Render error: ' + err.message, 'error');
      });
      if (msg.placeholderCount > 0) {
        const n = msg.placeholderCount;
        showToast(`${n} missing image${n !== 1 ? 's' : ''} shown as placeholders — open Image Manager to load`, 'info');
      }
    }

    if (msg.type === 'error') {
      setCompileStatus('');
      compileBanner.style.display = 'none';
      if (previewPlaceholder) previewPlaceholder.style.display = 'none';
      errorPanel.style.display = '';
      console.error('Worker error:', msg.message);
      errorText.textContent = msg.message;
      showToast('Compile error — see error panel', 'error');
    }
  };

  worker.onerror = (e) => {
    showToast('Worker crashed: ' + e.message, 'error');
  };
}

function setCompileStatus(text) {
  if (text) {
    compileBanner.style.display = '';
    compileStatus.textContent = text;
  } else {
    compileBanner.style.display = 'none';
    compileStatus.textContent = '';
  }
}

// ── PWA shell / offline lifecycle ───────────────────

let swRegistration = null;
let deferredInstallPrompt = null;
let storageUpdateTimer = null;

function showInstallBanner(show, text = '') {
  if (!pwaInstallBanner) return;
  pwaInstallBanner.style.display = show ? '' : 'none';
  if (text) pwaInstallText.textContent = text;
}

function showUpdateBanner(show) {
  if (!pwaUpdateBanner) return;
  pwaUpdateBanner.style.display = show ? '' : 'none';
}

async function refreshStorageIndicator() {
  if (!storageIndicator) return;
  if (!navigator.storage?.estimate) {
    storageIndicator.textContent = '';
    storageIndicator.title = '';
    return;
  }

  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (!quota) {
      storageIndicator.textContent = '';
      storageIndicator.title = '';
      return;
    }
    const usedMB = usage / (1024 * 1024);
    const quotaMB = quota / (1024 * 1024);
    const pct = (usage / quota) * 100;
    storageIndicator.textContent = `Storage ${pct.toFixed(1)}%`;
    storageIndicator.title = `${usedMB.toFixed(1)} MB used of ${quotaMB.toFixed(1)} MB browser quota`;
  } catch (_) {
    storageIndicator.textContent = '';
    storageIndicator.title = '';
  }
}

async function clearOfflineCache() {
  try {
    if (!('caches' in window)) {
      showToast('Cache API is unavailable in this browser', 'error');
      return;
    }
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    showToast('Offline cache cleared', 'success');
    await refreshStorageIndicator();
  } catch (err) {
    showToast('Cache clear failed: ' + err.message, 'error');
  }
}

async function initPwaLifecycle() {
  if (!('serviceWorker' in navigator)) return;

  try {
    swRegistration = await navigator.serviceWorker.register('./sw.js');

    if (swRegistration.waiting) showUpdateBanner(true);

    swRegistration.addEventListener('updatefound', () => {
      const nw = swRegistration.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBanner(true);
        }
      });
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    });
  } catch (err) {
    console.warn('Service worker registration failed:', err);
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    showInstallBanner(true, 'Install for offline editing, PDF reading, and slideshow playback.');
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    showInstallBanner(false);
    showToast('LibrePDF installed', 'success');
  });

  window.addEventListener('online', () => showToast('Back online', 'success'));
  window.addEventListener('offline', () => showToast('Offline mode: cached files remain available', 'info'));

  if (btnInstallApp) {
    btnInstallApp.addEventListener('click', async () => {
      if (!deferredInstallPrompt) {
        showInstallBanner(true, 'Use your browser menu to install this app on this device.');
        return;
      }
      deferredInstallPrompt.prompt();
      try { await deferredInstallPrompt.userChoice; } catch (_) {}
      deferredInstallPrompt = null;
      showInstallBanner(false);
    });
  }

  if (btnClearCache) {
    btnClearCache.addEventListener('click', clearOfflineCache);
  }

  if (btnApplyUpdate) {
    btnApplyUpdate.addEventListener('click', () => {
      if (swRegistration?.waiting) {
        swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
      } else {
        window.location.reload();
      }
    });
  }

  await refreshStorageIndicator();
  if (!storageUpdateTimer) {
    storageUpdateTimer = setInterval(refreshStorageIndicator, 20000);
  }
}

// ── Landing ────────────────────────────────────────

function showSessionBannerIfNeeded() {
  const banner = document.getElementById('session-banner');
  const session = getTextSession();
  if (!session) {
    banner.style.display = 'none';
    return;
  }

  document.getElementById('session-filename').textContent = session.filename;
  document.getElementById('session-age').textContent = timeAgo(session.savedAt);
  const ic = session.imageCount || 0;
  document.getElementById('session-imgs').textContent =
    ic > 0 ? ` · ${ic} image${ic !== 1 ? 's' : ''}` : '';
  banner.style.display = '';

  // Clone buttons to remove any stale listeners from a previous call
  const btnResume  = document.getElementById('btn-resume-session');
  const btnDiscard = document.getElementById('btn-discard-session');
  const freshResume  = btnResume.cloneNode(true);
  const freshDiscard = btnDiscard.cloneNode(true);
  btnResume.replaceWith(freshResume);
  btnDiscard.replaceWith(freshDiscard);

  freshResume.addEventListener('click', async () => {
    banner.style.display = 'none';
    setLandingStatus('Restoring session…');
    const imgs = await loadImagesFromIDB();
    imageFiles = imgs;
    const uniqueCount = Object.keys(imageFiles).filter(k => !k.includes('/')).length;
    if (uniqueCount > 0) {
      imgCount.textContent = `${uniqueCount} image${uniqueCount !== 1 ? 's' : ''} loaded`;
    }
    enterEditor(session.source, session.filename);
    if (uniqueCount > 0) {
      showToast(`Session restored — ${uniqueCount} image${uniqueCount !== 1 ? 's' : ''} reloaded`, 'success');
    } else {
      showToast('Session restored', 'success');
    }
  });

  freshDiscard.addEventListener('click', () => {
    if (!confirm(
      `Permanently discard the saved session for "${session.filename}"?\n\nThis cannot be undone.`
    )) return;
    clearTextSession();
    clearIDB();
    banner.style.display = 'none';
  });
}

function setupLanding() {
  // Tab switching
  const tabOpen = document.getElementById('tab-open');
  const tabNew  = document.getElementById('tab-new');
  const panelOpen = document.getElementById('panel-open');
  const panelNew  = document.getElementById('panel-new');

  tabOpen.addEventListener('click', () => {
    tabOpen.classList.add('active'); tabNew.classList.remove('active');
    panelOpen.style.display = ''; panelNew.style.display = 'none';
    setLandingStatus('');
  });
  tabNew.addEventListener('click', () => {
    tabNew.classList.add('active'); tabOpen.classList.remove('active');
    panelNew.style.display = ''; panelOpen.style.display = 'none';
    setLandingStatus('');
  });

  // Session restore banner
  showSessionBannerIfNeeded();

  // Open existing: file load
  document.getElementById('btn-load-typ').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadTypFile(fileInput.files[0]);
  });

  imgInput.addEventListener('change', () => {
    loadImageFiles(imgInput.files);
  });

  // Open existing: drag-and-drop
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files);
    const typFile = files.find(f => f.name.endsWith('.typ'));
    const imgFiles = files.filter(f =>
      f.type.startsWith('image/') || /\.(png|jpe?g|gif|svg|webp|bmp)$/i.test(f.name)
    );
    if (typFile) {
      loadTypFile(typFile);
    } else if (imgFiles.length > 0) {
      loadImageFiles(imgFiles);
      setLandingStatus(`${imgFiles.length} image${imgFiles.length !== 1 ? 's' : ''} loaded. Now load or drop a .typ file.`);
    } else {
      setLandingStatus('Please drop a .typ file or image files.', true);
    }
  });

  // Template picker
  buildTemplatePicker();
}

// ── Template picker ────────────────────────────────

let selectedTemplateId = null;

function buildTemplatePicker() {
  const picker = document.getElementById('template-picker');
  picker.innerHTML = '';

  for (const tpl of Templates.TEMPLATES) {
    const card = document.createElement('div');
    card.className = 'tpl-card';
    card.dataset.id = tpl.id;
    card.innerHTML = `
      <div class="tpl-abbr">${tpl.abbr}</div>
      <div class="tpl-info">
        <div class="tpl-name">${tpl.name}</div>
        <div class="tpl-desc">${tpl.description}</div>
      </div>`;
    card.addEventListener('click', () => openTemplateForm(tpl.id));
    picker.appendChild(card);
  }
}

function openTemplateForm(templateId) {
  selectedTemplateId = templateId;
  const tpl = Templates.TEMPLATES.find(t => t.id === templateId);
  if (!tpl) return;

  document.getElementById('template-picker').style.display = 'none';
  const formWrap = document.getElementById('template-form-wrap');
  formWrap.style.display = '';

  const formEl = document.getElementById('template-form');
  formEl.innerHTML = `<div class="tpl-form-title">${tpl.name}</div>`;

  // Track input refs by field id
  const inputs = {};

  for (const field of tpl.fields) {
    if (field.type === 'section-list') continue; // rendered dynamically below

    const div = document.createElement('div');
    div.className = 'edit-field';
    div.innerHTML = `<label>${field.label}</label>`;

    if (field.type === 'color') {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center';
      const cp = document.createElement('input');
      cp.type = 'color'; cp.value = field.default || '#0071c0';
      cp.id = 'tpl-' + field.id;
      const hex = document.createElement('input');
      hex.type = 'text'; hex.value = field.default || '#0071c0';
      hex.style.cssText = 'width:100px;font-family:monospace';
      hex.maxLength = 7;
      cp.addEventListener('input', () => { hex.value = cp.value; });
      hex.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(hex.value)) cp.value = hex.value; });
      row.appendChild(cp); row.appendChild(hex);
      div.appendChild(row);
      inputs[field.id] = { getValue: () => cp.value };
    } else if (field.type === 'number') {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.value = field.default || '1';
      inp.min = field.min ?? 1;
      inp.max = field.max ?? 99;
      inp.style.width = '80px';
      inp.id = 'tpl-' + field.id;
      div.appendChild(inp);
      inputs[field.id] = { getValue: () => inp.value, el: inp };

      // If this field has a dependent section-list, wire the update
      const depField = tpl.fields.find(f => f.type === 'section-list' && f.dependsOn === field.id);
      if (depField) {
        inp.addEventListener('input', () => renderSectionList(formEl, inputs, depField, parseInt(inp.value) || 1));
      }
    } else {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = field.default || '';
      if (field.placeholder) inp.placeholder = field.placeholder;
      inp.id = 'tpl-' + field.id;
      div.appendChild(inp);
      inputs[field.id] = { getValue: () => inp.value };
    }

    formEl.appendChild(div);

    // Render initial section list if this field drives one
    const depField = tpl.fields.find(f => f.type === 'section-list' && f.dependsOn === field.id);
    if (depField) {
      renderSectionList(formEl, inputs, depField, parseInt(field.default) || 1);
    }
  }

  // Store inputs reference for "Create" button
  formEl._inputs = inputs;
  formEl._tplId  = templateId;

  document.getElementById('btn-back-picker').onclick = () => {
    formWrap.style.display = 'none';
    document.getElementById('template-picker').style.display = '';
    setLandingStatus('');
  };

  document.getElementById('btn-create-doc').onclick = () => createFromTemplate(formEl);
}

function renderSectionList(formEl, inputs, field, count) {
  const containerId = 'tpl-seclist-' + field.id;
  let container = formEl.querySelector('#' + containerId);
  if (!container) {
    container = document.createElement('div');
    container.id = containerId;
    formEl.appendChild(container);
  }
  container.innerHTML = `<div class="field-group-header">${field.label}</div>`;

  const nameInputs = [];
  for (let i = 0; i < count; i++) {
    const div = document.createElement('div');
    div.className = 'edit-field';
    div.innerHTML = `<label>Section ${i + 1}</label>`;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = `Section ${i + 1}`;
    inp.placeholder = `Section ${i + 1} name`;
    div.appendChild(inp);
    container.appendChild(div);
    nameInputs.push(inp);
  }

  inputs[field.id] = { getValue: () => nameInputs.map(i => i.value || i.placeholder) };
}

function createFromTemplate(formEl) {
  const tplId  = formEl._tplId;
  const inputs = formEl._inputs || {};

  const values = {};
  for (const [key, ctrl] of Object.entries(inputs)) {
    values[key] = ctrl.getValue();
  }

  let src;
  try {
    src = Templates.generate(tplId, values);
  } catch (e) {
    setLandingStatus('Template error: ' + e.message, true);
    return;
  }

  const fname = (values.filename || (tplId + '.typ')).replace(/\.typ$/, '') + '.typ';
  setLandingStatus('Starting compiler…');
  enterEditor(src, fname);
}

function setLandingStatus(text, isError) {
  landingStatus.textContent = text;
  landingStatus.className = 'landing-status' + (isError ? ' error' : '');
}

// ── File loading ───────────────────────────────────

async function enterEditor(src, fname) {
  filename = fname || 'document.typ';
  source = src;
  sourceHistory = [];
  parsed = TypstParser.parse(source);
  saveTextSession();
  showEditor();
  initWorker();
  await tryRestoreDirHandle();
  triggerCompile();
}

function loadTypFile(file) {
  filename = file.name;
  setLandingStatus('Reading file…');
  const reader = new FileReader();
  reader.onload = (e) => {
    setLandingStatus('Starting compiler…');
    enterEditor(e.target.result, file.name);
  };
  reader.onerror = () => setLandingStatus('Failed to read file.', true);
  reader.readAsText(file);
}

async function loadImageFiles(files) {
  const loaded = [];
  for (const f of files) {
    const buf = await f.arrayBuffer();
    const name = f.name;
    // Store at the absolute path used by #image("/images/foo.png"):
    imageFiles[`/images/${name}`] = buf;
    // Also store by bare filename for robustness
    imageFiles[name] = buf;
    loaded.push(name);
  }
  // Count unique files by bare filename (not path variants)
  const uniqueCount = Object.keys(imageFiles).filter(k => !k.includes('/')).length;
  imgCount.textContent = `${uniqueCount} image${uniqueCount !== 1 ? 's' : ''} loaded`;
  saveTextSession();
  saveImagesToIDB();
  if (appEl.style.display !== 'none') {
    showToast(`Loaded ${loaded.length} image${loaded.length !== 1 ? 's' : ''}`, 'success');
    triggerCompile();
    updateFileInfo();
    refreshImageManagerIfOpen();
  }
}

function updateFileInfo() {
  const { refs, missing } = imageRefStatus();
  const loadedCount = refs.length - missing.length;
  let text = `${filename} · ${parsed.elements.length} elements`;
  if (refs.length > 0) {
    text += ` · ${loadedCount}/${refs.length} images`;
    if (missing.length > 0) text += ' ⚠';
  }
  fileInfo.textContent = text;
  fileInfo.title = missing.length > 0
    ? `Missing: ${missing.map(r => r.split('/').pop()).join(', ')}`
    : refs.length > 0 ? 'All referenced images loaded' : '';
}

function showEditor() {
  landingEl.style.display = 'none';
  appEl.style.display = 'flex';
  svgContainer.innerHTML = '';
  buildTree();
  editContainer.innerHTML = '<p class="placeholder">Select an element from the tree to edit its properties.</p>';
  errorPanel.style.display = 'none';
  btnDlPdf.disabled = true;
  btnPresent.disabled = true;
  document.getElementById('zoom-bar').style.display = '';
  if (previewPlaceholder) previewPlaceholder.style.display = '';
}

function doCloseEditor() {
  if (worker) { worker.terminate(); worker = null; }
  source = '';
  filename = 'document.typ';
  parsed = { pages: [], elements: [] };
  selectedElement = null;
  currentPdfBytes = null;
  imageFiles = {};
  linkedDirHandle = null;
  sourceHistory = [];
  imgCount.textContent = '';
  btnDlPdf.disabled = true;
  fileInput.value = '';
  imgInput.value = '';
  appEl.style.display = 'none';
  landingEl.style.display = '';
  setLandingStatus('');
  showSessionBannerIfNeeded();
}

function openDifferentFile() {
  if (!source) { doCloseEditor(); return; }

  const modal = document.getElementById('unsaved-modal');
  document.getElementById('unsaved-modal-filename').textContent = filename;
  modal.style.display = 'flex';

  const btnDownload = document.getElementById('btn-modal-download');
  const btnContinue = document.getElementById('btn-modal-continue');
  const btnCancel   = document.getElementById('btn-modal-cancel');

  function close() { modal.style.display = 'none'; }

  // Clone to clear any stale listeners
  const freshDownload = btnDownload.cloneNode(true);
  const freshContinue = btnContinue.cloneNode(true);
  const freshCancel   = btnCancel.cloneNode(true);
  btnDownload.replaceWith(freshDownload);
  btnContinue.replaceWith(freshContinue);
  btnCancel.replaceWith(freshCancel);

  freshDownload.addEventListener('click', () => {
    close();
    downloadTyp();
    doCloseEditor();
  });
  freshContinue.addEventListener('click', () => { close(); doCloseEditor(); });
  freshCancel.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); }, { once: true });
}

// ── Compile ────────────────────────────────────────

let compileDebounceTimer = null;

function triggerCompile() {
  clearTimeout(compileDebounceTimer);
  compileDebounceTimer = setTimeout(doCompile, 300);
}

function doCompile() {
  if (!worker) return;
  setCompileStatus('Compiling…');
  compileBanner.style.display = '';

  // Copy ArrayBuffers — do NOT transfer them (would detach originals)
  const files = Object.entries(imageFiles).map(([path, data]) => ({
    path,
    data: data.slice(0),
  }));

  worker.postMessage({ type: 'compile', source, files });
}

// ── PDF.js page rendering ──────────────────────────

let _renderSeq = 0; // incremented on every render; stale renders self-abort

async function renderPdfPages(pdfBytes) {
  const seq = ++_renderSeq;

  // PDF.js uses 72pt/inch. A4 = 595pt wide. Base scale ~500px, multiplied by zoom.
  const SCALE = (500 / 595) * previewZoom;

  // Remember where we are before wiping the container
  const returnToPage = selectedElement?.page ?? null;
  const savedScrollTop = previewPanel.scrollTop;

  // PDF.js transfers the ArrayBuffer to its internal worker — always pass a copy
  // so our stored currentPdfBytes stays intact for subsequent zoom re-renders.
  const loadTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBytes instanceof ArrayBuffer ? pdfBytes : pdfBytes.buffer).slice(),
    disableRange: true,
    disableStream: true,
  });
  const pdf = await loadTask.promise;
  if (seq !== _renderSeq) { pdf.destroy(); return; } // superseded

  svgContainer.innerHTML = '';
  if (previewPlaceholder) previewPlaceholder.style.display = 'none';

  for (let i = 1; i <= pdf.numPages; i++) {
    if (seq !== _renderSeq) { pdf.destroy(); return; } // superseded mid-render

    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: SCALE });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.display = 'block';

    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    page.cleanup();

    if (seq !== _renderSeq) { pdf.destroy(); return; } // superseded after render

    const pageDiv = document.createElement('div');
    pageDiv.className = 'svg-page';
    pageDiv.dataset.page = i;
    pageDiv.appendChild(canvas);

    const label = document.createElement('div');
    label.className = 'svg-page-label';
    const pageSec = parsed.pages[i - 1];
    label.textContent = `Page ${i}` + (pageSec ? ` — ${pageSec.sectionName}` : '');
    pageDiv.appendChild(label);

    pageDiv.addEventListener('click', (e) => handlePageClick(i, e, pageDiv));
    svgContainer.appendChild(pageDiv);
  }

  // Restore position after render
  if (returnToPage !== null) {
    const pageDiv = svgContainer.querySelector(`.svg-page[data-page="${returnToPage}"]`);
    if (pageDiv) {
      pageDiv.classList.add('active');
      pageDiv.scrollIntoView({ behavior: 'instant', block: 'start' });
    }
  } else {
    previewPanel.scrollTop = savedScrollTop;
  }
}

// ── Tree building ──────────────────────────────────
function buildTree() {
  treeContainer.innerHTML = '';

  // Document Settings item — always shown at top
  const docItem = document.createElement('div');
  docItem.className = 'tree-item tree-item-doc';
  const docBadge = document.createElement('span');
  docBadge.className = 'type-badge badge-doc';
  docBadge.textContent = 'doc';
  const docLabel = document.createElement('span');
  docLabel.textContent = 'Document Settings';
  docItem.appendChild(docBadge);
  docItem.appendChild(docLabel);
  docItem.addEventListener('click', () => showDocumentSettings());
  treeContainer.appendChild(docItem);

  // Images item
  const imgTreeItem = document.createElement('div');
  imgTreeItem.className = 'tree-item tree-item-img';
  const imgBadge = document.createElement('span');
  imgBadge.className = 'type-badge badge-img';
  imgBadge.textContent = 'img';
  const imgLabel = document.createElement('span');
  imgLabel.textContent = 'Images';
  imgTreeItem.appendChild(imgBadge);
  imgTreeItem.appendChild(imgLabel);
  const { refs: imgRefs, missing: imgMissing } = imageRefStatus();
  if (imgRefs.length > 0) {
    const countBadge = document.createElement('span');
    countBadge.className = 'img-count-badge ' + (imgMissing.length > 0 ? 'img-count-warn' : 'img-count-ok');
    countBadge.textContent = `${imgRefs.length - imgMissing.length}/${imgRefs.length}`;
    imgTreeItem.appendChild(countBadge);
  }
  imgTreeItem.addEventListener('click', () => showImageManager());
  treeContainer.appendChild(imgTreeItem);

  const sections = new Map();
  for (const page of parsed.pages) {
    const key = `p${page.pageNum}`;
    if (!sections.has(key)) {
      sections.set(key, { name: page.sectionName, pageNum: page.pageNum, elements: [] });
    }
  }

  for (const el of parsed.elements) {
    const key = `p${el.page}`;
    if (sections.has(key)) {
      sections.get(key).elements.push(el);
    } else {
      sections.set(key, { name: `Page ${el.page}`, pageNum: el.page, elements: [el] });
    }
  }

  for (const [, sec] of sections) {
    const sectionDiv = document.createElement('div');
    sectionDiv.className = 'tree-section';

    const header = document.createElement('div');
    header.className = 'tree-section-header';

    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '▼';
    arrow.title = 'Collapse/expand';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = sec.name;

    const sortedPages = [...parsed.pages].sort((a, b) => a.pageNum - b.pageNum);
    const secIdx = sortedPages.findIndex(p => p.pageNum === sec.pageNum);
    const secMoveGroup = document.createElement('span');
    secMoveGroup.className = 'tree-move-btns';
    const secUp = document.createElement('button');
    secUp.type = 'button'; secUp.className = 'tree-move-btn'; secUp.textContent = '↑';
    secUp.title = 'Move section up'; secUp.disabled = secIdx <= 0;
    secUp.addEventListener('click', e => { e.stopPropagation(); moveSectionInSource(sec.pageNum, -1); });
    const secDown = document.createElement('button');
    secDown.type = 'button'; secDown.className = 'tree-move-btn'; secDown.textContent = '↓';
    secDown.title = 'Move section down'; secDown.disabled = secIdx >= sortedPages.length - 1;
    secDown.addEventListener('click', e => { e.stopPropagation(); moveSectionInSource(sec.pageNum, 1); });
    secMoveGroup.appendChild(secUp);
    secMoveGroup.appendChild(secDown);

    header.appendChild(arrow);
    header.appendChild(nameSpan);
    header.appendChild(secMoveGroup);

    // Arrow click → toggle collapse only
    arrow.addEventListener('click', (e) => {
      e.stopPropagation();
      header.classList.toggle('collapsed');
    });
    // Header (section name) click → scroll to page only
    header.addEventListener('click', () => {
      scrollToPage(sec.pageNum);
    });

    sectionDiv.appendChild(header);

    const items = document.createElement('div');
    items.className = 'tree-section-items';

    for (let ei = 0; ei < sec.elements.length; ei++) {
      const el = sec.elements[ei];
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.dataset.lineStart = el.lineStart;

      const badge = document.createElement('span');
      badge.className = 'type-badge' + (el.type === 'page-block' ? ' badge-page' : '');
      badge.textContent = el.type === 'page-block' ? 'cover' : el.type;
      item.appendChild(badge);

      const name = document.createElement('span');
      name.textContent = el.title || `(line ${el.lineStart})`;
      name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0';
      item.title = el.title || el.type;
      item.appendChild(name);

      const moveGroup = document.createElement('span');
      moveGroup.className = 'tree-move-btns';
      const upBtn = document.createElement('button');
      upBtn.type = 'button'; upBtn.className = 'tree-move-btn'; upBtn.textContent = '↑';
      upBtn.title = 'Move element up'; upBtn.disabled = ei === 0;
      upBtn.addEventListener('click', e => { e.stopPropagation(); moveElementInSource(el, -1); });
      const downBtn = document.createElement('button');
      downBtn.type = 'button'; downBtn.className = 'tree-move-btn'; downBtn.textContent = '↓';
      downBtn.title = 'Move element down'; downBtn.disabled = ei === sec.elements.length - 1;
      downBtn.addEventListener('click', e => { e.stopPropagation(); moveElementInSource(el, 1); });
      moveGroup.appendChild(upBtn);
      moveGroup.appendChild(downBtn);
      item.appendChild(moveGroup);

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        selectElement(el, item);
      });
      items.appendChild(item);
    }

    const addItem = document.createElement('div');
    addItem.className = 'tree-item tree-item-add';
    addItem.textContent = '+ Add element';
    addItem.addEventListener('click', (e) => {
      e.stopPropagation();
      showInsertForm(sec.pageNum);
    });
    items.appendChild(addItem);

    sectionDiv.appendChild(items);
    treeContainer.appendChild(sectionDiv);
  }
  updateFileInfo();
}

function showInsertForm(pageNum) {
  treeContainer.querySelectorAll('.tree-item.selected').forEach(i => i.classList.remove('selected'));
  editContainer.innerHTML = '';
  const form = EditorPanel.buildInsertForm(pageNum, insertElement);
  editContainer.appendChild(form);
  scrollToPage(pageNum);
}

function showDocumentSettings() {
  treeContainer.querySelectorAll('.tree-item.selected').forEach(i => i.classList.remove('selected'));
  treeContainer.querySelectorAll('.tree-item-doc').forEach(i => i.classList.add('selected'));
  selectedElement = null;
  editContainer.innerHTML = '';
  const vars = parseDocumentVars(source);
  const form = EditorPanel.buildDocumentSettingsForm(vars, applyDocumentVar);
  editContainer.appendChild(form);
}

function showAddSectionForm() {
  treeContainer.querySelectorAll('.tree-item.selected').forEach(i => i.classList.remove('selected'));
  selectedElement = null;
  editContainer.innerHTML = '';
  const form = EditorPanel.buildAddSectionForm(parsed.pages.length, (code) => {
    pushHistory();
    source = source.trimEnd() + '\n' + code;

    // Sync TOC if the document has one
    const nameMatch = code.match(/#fsec\.update\("([^"]*)"\)/);
    if (nameMatch) {
      source = insertTocEntry(source, nameMatch[1]);
    }

    saveTextSession();
    revision++;
    parsed = TypstParser.parse(source);
    showToast('Section added', 'success');
    buildTree();
    triggerCompile();
    scrollToPage(parsed.pages.length);
  });
  editContainer.appendChild(form);
}

// ── Element selection ──────────────────────────────
function selectElement(el, treeItem) {
  treeContainer.querySelectorAll('.tree-item.selected').forEach(i => i.classList.remove('selected'));
  svgContainer.querySelectorAll('.svg-page.active').forEach(p => p.classList.remove('active'));

  if (treeItem) treeItem.classList.add('selected');
  selectedElement = el;

  const pageDiv = svgContainer.querySelector(`.svg-page[data-page="${el.page}"]`);
  if (pageDiv) {
    pageDiv.classList.add('active');
    pageDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const srcLines = source.split('\n');
  el._srcLines = {
    before: el.lineStart > 1 ? srcLines[el.lineStart - 2] : '',
    after: el.lineEnd < srcLines.length ? srcLines[el.lineEnd] : '',
  };

  editContainer.innerHTML = '';
  const pageElements = parsed.elements.filter(e => e.page === el.page);
  const sectionName = parsed.pages.find(p => p.pageNum === el.page)?.sectionName;
  const form = EditorPanel.buildForm(el, applyEdit, pageElements, sectionName);
  editContainer.appendChild(form);
}

function scrollToPage(pageNum) {
  const pageDiv = svgContainer.querySelector(`.svg-page[data-page="${pageNum}"]`);
  if (pageDiv) pageDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function handlePageClick(pageNum, event, pageDiv) {
  svgContainer.querySelectorAll('.svg-page.active').forEach(p => p.classList.remove('active'));
  pageDiv.classList.add('active');
}

// ── Undo history ───────────────────────────────────

function pushHistory() {
  sourceHistory.push(source);
  if (sourceHistory.length > MAX_HISTORY) sourceHistory.shift();
}

function undoEdit() {
  if (sourceHistory.length === 0) {
    showToast('Nothing to undo', 'info');
    return;
  }
  source = sourceHistory.pop();
  revision++;
  saveTextSession();
  parsed = TypstParser.parse(source);
  buildTree();
  triggerCompile();
  editContainer.innerHTML = '<p class="placeholder">Undone. Select an element to continue editing.</p>';
  showToast(`Undone (${sourceHistory.length} step${sourceHistory.length !== 1 ? 's' : ''} remaining)`, 'success');
}

// ── Reorder: move element within its page ──────────
function moveElementInSource(el, dir) {
  const pageEls = parsed.elements
    .filter(e => e.page === el.page)
    .sort((a, b) => a.lineStart - b.lineStart);
  const idx = pageEls.findIndex(e => e.lineStart === el.lineStart);
  const swapIdx = idx + dir;
  if (swapIdx < 0 || swapIdx >= pageEls.length) return;

  const A = pageEls[Math.min(idx, swapIdx)];
  const B = pageEls[Math.max(idx, swapIdx)];
  const lines = source.split('\n');
  const linesA   = lines.slice(A.lineStart - 1, A.lineEnd);
  const linesB   = lines.slice(B.lineStart - 1, B.lineEnd);
  const between  = lines.slice(A.lineEnd, B.lineStart - 1);
  const before   = lines.slice(0, A.lineStart - 1);
  const after    = lines.slice(B.lineEnd);

  pushHistory();
  source = [...before, ...linesB, ...between, ...linesA, ...after].join('\n');
  revision++;
  saveTextSession();
  parsed = TypstParser.parse(source);
  buildTree();
  triggerCompile();
}

// ── Reorder: move entire section (page) up or down ─
function moveSectionInSource(pageNum, dir) {
  const sortedPages = [...parsed.pages].sort((a, b) => a.pageNum - b.pageNum);
  const idx = sortedPages.findIndex(p => p.pageNum === pageNum);
  const swapIdx = idx + dir;
  if (swapIdx < 0 || swapIdx >= sortedPages.length) return;

  const aIdx = Math.min(idx, swapIdx);
  const bIdx = Math.max(idx, swapIdx);
  const A = sortedPages[aIdx];
  const B = sortedPages[bIdx];
  const C = sortedPages[bIdx + 1]; // may be undefined

  const lines = source.split('\n');

  // Block start: include the #pagebreak() line for all pages except the first
  const aStart = A.pageNum === 1 ? 0 : A.lineStart - 2;   // 0-based
  const bStart = B.pageNum === 1 ? 0 : B.lineStart - 2;   // 0-based
  const aEnd   = bStart - 1;                               // 0-based inclusive
  const bEnd   = C ? C.lineStart - 3 : lines.length - 1;  // 0-based inclusive

  const linesA  = lines.slice(aStart, aEnd + 1);
  const linesB  = lines.slice(bStart, bEnd + 1);
  const before  = lines.slice(0, aStart);
  const after   = lines.slice(bEnd + 1);

  pushHistory();
  source = [...before, ...linesB, ...linesA, ...after].join('\n');
  revision++;
  saveTextSession();
  parsed = TypstParser.parse(source);
  buildTree();
  triggerCompile();
}

// ── Apply edit ─────────────────────────────────────
function applyEdit(el, changes) {
  let newText;
  let lineStart = el.lineStart;
  let lineEnd = el.lineEnd;

  const spacingDirty = 'v_space_before' in changes || 'v_space_after' in changes;
  if (spacingDirty) {
    const srcLines = source.split('\n');
    const vPat = /^\s*#?v\([^)]+\),?\s*$/;
    if (lineStart > 1 && vPat.test(srcLines[lineStart - 2])) lineStart--;
    if (lineEnd < srcLines.length && vPat.test(srcLines[lineEnd]))  lineEnd++;
  }

  if (changes.__delete) {
    newText = '';
  } else if (changes.__raw) {
    newText = changes.__raw;
  } else {
    if (Object.keys(changes).length === 0) {
      return;
    }
    try {
      newText = buildNewSource(el, changes, lineStart, lineEnd);
    } catch (e) {
      showToast('Error building edit: ' + e.message, 'error');
      return;
    }
  }

  pushHistory();

  const lines = source.split('\n');
  const before = lines.slice(0, lineStart - 1);
  const after  = lines.slice(lineEnd);
  const replacement = newText !== '' ? newText.split('\n') : [];
  source = [...before, ...replacement, ...after].join('\n');
  revision++;
  saveTextSession();

  // If a ptitle title changed, sync the matching #fsec.update() and TOC entries
  let syncedExtra = false;
  if (el.type === 'ptitle' && '_title' in changes && el.title !== changes._title) {
    const oldT = el.title;
    const newT = changes._title;

    // 1. Update all #fsec.update("old title") occurrences globally (drives footer)
    const fsecPat = new RegExp('#fsec\\.update\\("' + escRx(oldT) + '"\\)', 'g');
    source = source.replace(fsecPat, `#fsec.update("${escTyp(newT)}")`);

    // 2. Update TOC text: replace "old title" as a string literal in every line
    //    that appears before this element's original position (TOC is always earlier)
    const srcLines = source.split('\n');
    const quotedOld = `"${escTyp(oldT)}"`;
    const quotedNew = `"${escTyp(newT)}"`;
    for (let i = 0; i < el.lineStart - 1; i++) {
      if (srcLines[i].includes(quotedOld)) {
        srcLines[i] = srcLines[i].replaceAll(quotedOld, quotedNew);
        syncedExtra = true;
      }
    }
    source = srcLines.join('\n');
  }

  parsed = TypstParser.parse(source);
  const toastMsg = changes.__delete
    ? 'Element deleted'
    : syncedExtra
      ? 'Applied — TOC and footer updated to match'
      : 'Applied successfully';
  showToast(toastMsg, 'success');

  buildTree();
  triggerCompile();

  if (!changes.__delete) {
    // Re-select by type + proximity (line numbers may shift slightly after edits)
    const newEl = parsed.elements.find(e =>
      e.type === el.type && Math.abs(e.lineStart - el.lineStart) <= 5
    );
    if (newEl) {
      const treeItem = treeContainer.querySelector(`.tree-item[data-line-start="${newEl.lineStart}"]`);
      selectElement(newEl, treeItem);
    }
  } else {
    editContainer.innerHTML = '<p class="placeholder">Element deleted. Select another from the tree.</p>';
  }
}

async function insertElement(pageNum, position, code) {
  const pageEls = parsed.elements.filter(e => e.page === pageNum);
  let insertLine;
  if (position === 'page-end') {
    // Insert after this page's entire content (outside the grid),
    // i.e. just before the next page's #pagebreak() or at end of file.
    const nextPage = parsed.pages.find(p => p.pageNum === pageNum + 1);
    if (nextPage) {
      insertLine = nextPage.lineStart - 1;
    } else {
      insertLine = source.split('\n').length;
    }
  } else if (pageEls.length > 0) {
    insertLine = pageEls[pageEls.length - 1].lineEnd;
  } else {
    const page = parsed.pages[pageNum - 1];
    insertLine = page ? page.lineStart + 2 : 1;
  }

  pushHistory();

  const lines = source.split('\n');
  lines.splice(insertLine, 0, ...code.split('\n'));
  source = lines.join('\n');
  revision++;
  saveTextSession();

  parsed = TypstParser.parse(source);
  showToast('Element inserted', 'success');
  buildTree();
  triggerCompile();
}

// ── Source rebuilding ──────────────────────────────

function buildNewSource(el, changes, lineStart, lineEnd) {
  const lines = source.split('\n');
  let result = lines.slice(lineStart - 1, lineEnd).join('\n');

  if ('v_space_before' in changes || 'v_space_after' in changes) {
    const vLinePat = /^\s*#?v\([^)]+\),?\s*$/;
    result = result.split('\n').filter(l => !vLinePat.test(l)).join('\n');
  }

  if (changes._title !== undefined && changes._title !== el.title) {
    if (el.type === 'ptitle') {
      result = result.replace(/(#?ptitle\s*\(\s*")([^"]*)(")/, `$1${escTyp(changes._title)}$3`);
    } else if (el.type === 'sintro') {
      result = result.replace(/(sintro\s*\(\s*")([^"]*)(")/, `$1${escTyp(changes._title)}$3`);
    }
  }

  const helperCallPat = new RegExp(`(${escRx(el.type)}\\s*\\()`);
  const helperMatch = result.match(helperCallPat);
  if (helperMatch) {
    const callStart = helperMatch.index;
    const parenStart = callStart + helperMatch[0].length - 1;
    const parenEnd = TypstParser.balancedEnd(result, parenStart, '(', ')');
    if (parenEnd !== -1) {
      let argSection = result.slice(parenStart + 1, parenEnd);
      const before = result.slice(0, parenStart + 1);
      const after  = result.slice(parenEnd);

      const NAMED_ARGS = ['num','title','inset','type','label','colspan','path'];
      const allArgKeys = new Set([...NAMED_ARGS, ...Object.keys(el.args || {})]);

      for (const argName of allArgKeys) {
        if (!(argName in changes)) continue;
        const newVal = changes[argName];
        const oldVal = el.args[argName];
        if (newVal === oldVal) continue;
        if (newVal === '' && !oldVal) continue;

        const formatted = fmtArg(argName, newVal);
        const strPat  = new RegExp(`(${escRx(argName)}:\\s*)"[^"]*"`);
        const barePat = new RegExp(`(${escRx(argName)}:\\s*)([^,)\\]\\n]+)`);

        if (strPat.test(argSection)) {
          argSection = argSection.replace(strPat, `$1${formatted}`);
        } else if (barePat.test(argSection)) {
          argSection = argSection.replace(barePat, `$1${formatted}`);
        } else if (newVal && newVal !== '' && newVal !== 'none' && argName !== 'num') {
          argSection = argSection.trimEnd() + `, ${argName}: ${formatted}`;
        }
      }

      result = before + argSection + after;
    }
  }

  if (changes.path !== undefined && el.type === 'image') {
    result = result.replace(/(#image\s*\(\s*")([^"]*)(")/, `$1${changes.path}$3`);
  }

  if (changes.__body !== undefined && changes.__body !== el.body) {
    result = replaceBody(result, changes.__body);
  }

  const inCode = !result.trimStart().startsWith('#');
  if (!inCode) {
    if (changes.v_space_before && changes.v_space_before !== '') {
      const indent = result.match(/^(\s*)/)[1];
      result = `${indent}#v(${changes.v_space_before})\n` + result;
    }
    if (changes.v_space_after && changes.v_space_after !== '') {
      const indent = result.match(/^(\s*)/)[1];
      result = result + `\n${indent}#v(${changes.v_space_after})`;
    }
  }

  return result;
}

function fmtArg(name, val) {
  if (name === 'num' || name === 'colspan') return val === 'none' ? 'none' : val;
  if (name === 'label') {
    if (val === 'auto') return 'auto';
    if (val === 'none') return 'none';
    return val.startsWith('"') ? val : `"${val}"`;
  }
  if (name === 'type' || name === 'title') return `"${escTyp(val)}"`;
  if (name === 'path') return `"${val}"`;
  return val;
}

function escRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function escTyp(str) { return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

// Insert a TOC row after the last entry in a // TABLE OF CONTENTS block.
// Returns src unchanged if no TOC block is found.
function insertTocEntry(src, sectionName) {
  const tocMarker = '// TABLE OF CONTENTS';
  const tocIdx = src.indexOf(tocMarker);
  if (tocIdx === -1) return src;

  // TOC block ends at the first #pagebreak() that follows the marker
  const pbIdx = src.indexOf('#pagebreak()', tocIdx);
  if (pbIdx === -1) return src;

  const tocBlock = src.slice(tocIdx, pbIdx);
  const lastV = tocBlock.lastIndexOf('#v(2mm)');
  if (lastV === -1) return src;

  // Count existing entries to determine the next section number
  const existingCount = (tocBlock.match(/#v\(2mm\)/g) || []).length;
  const sectionNum = String(existingCount + 1);

  const insertAt = tocIdx + lastV + '#v(2mm)'.length;
  const newEntry =
    `\n#grid(\n  columns: (16pt, 1fr, auto),\n  gutter: 4mm,\n  align: horizon,\n` +
    `  text(fill: primary, weight: "bold", "${sectionNum}"),\n` +
    `  line(stroke: 0.5pt + lc),\n` +
    `  text(fill: muted, "${escTyp(sectionName)}")\n)\n#v(2mm)`;

  return src.slice(0, insertAt) + newEntry + src.slice(insertAt);
}

function replaceBody(slice, newBody) {
  for (let i = slice.length - 1; i >= 0; i--) {
    if (slice[i] === ']') {
      let j = i - 1, d = 1;
      while (j >= 0 && d > 0) {
        if (slice[j] === ']') d++;
        else if (slice[j] === '[') d--;
        j--;
      }
      const lastBracketStart = j + 1;
      const before = slice.slice(0, lastBracketStart + 1);
      const after  = slice.slice(i);
      return before + '\n' + newBody + '\n' + after;
    }
  }
  return slice;
}

// ── Downloads ──────────────────────────────────────

function downloadTyp() {
  const blob = new Blob([source], { type: 'text/plain' });
  dlBlob(blob, filename || 'document.typ');
  showToast('Downloaded .typ source', 'success');
}

function downloadPdf() {
  if (!currentPdfBytes) {
    showToast('No PDF available yet — compile first', 'error');
    return;
  }
  const blob = new Blob([currentPdfBytes], { type: 'application/pdf' });
  const pdfName = (filename || 'document.typ').replace(/\.typ$/, '.pdf');
  dlBlob(blob, pdfName);
  showToast('Downloaded PDF', 'success');
}

function dlBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Session persistence ────────────────────────────
// Source + filename → localStorage  (fast, text-only)
// Images            → IndexedDB     (handles binary, larger quota)

const SESSION_KEY        = 'librepdf-session';
const SESSION_KEY_LEGACY = 'typst-editor-session'; // kept for one-time migration
let idb = null;

async function openIDB() {
  if (idb) return idb;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('librepdf', 2);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('images')) d.createObjectStore('images');
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings');
    };
    req.onsuccess  = (e) => { idb = e.target.result; resolve(idb); };
    req.onerror    = ()  => reject(req.error);
  });
}

function saveTextSession() {
  try {
    const imageNames = Object.keys(imageFiles).filter(k => !k.includes('/'));
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      source, filename, savedAt: Date.now(), imageCount: imageNames.length,
    }));
    refreshStorageIndicator();
  } catch (e) {
    if (e?.name === 'QuotaExceededError') showToast('Auto-save failed: browser storage full. Download your .typ to avoid losing work.', 'error');
  }
}

async function saveImagesToIDB() {
  try {
    const d = await openIDB();
    const tx = d.transaction('images', 'readwrite');
    const store = tx.objectStore('images');
    store.clear();
    for (const [path, buf] of Object.entries(imageFiles)) store.put(buf, path);
    refreshStorageIndicator();
  } catch (_) {}
}

async function loadImagesFromIDB() {
  try {
    const d = await openIDB();
    const result = await new Promise((resolve) => {
      const tx = d.transaction('images', 'readonly');
      const r = {};
      const req = tx.objectStore('images').openCursor();
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur) { r[cur.key] = cur.value; cur.continue(); }
        else resolve(r);
      };
      req.onerror = () => resolve({});
    });

    // If the new DB is empty, attempt a one-time migration from the legacy DB.
    if (Object.keys(result).length === 0) {
      const legacy = await loadImagesFromLegacyIDB();
      if (Object.keys(legacy).length > 0) {
        // Persist migrated data into the new DB so future loads are instant.
        try {
          const tx = d.transaction('images', 'readwrite');
          const store = tx.objectStore('images');
          for (const [path, buf] of Object.entries(legacy)) store.put(buf, path);
        } catch (_) {}
        // Best-effort cleanup of the old database.
        try { indexedDB.deleteDatabase('typst-editor'); } catch (_) {}
        return legacy;
      }
    }

    return result;
  } catch (_) { return {}; }
}

// One-time migration helper: reads image data from the legacy 'typst-editor' IDB.
async function loadImagesFromLegacyIDB() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('typst-editor', 2);
      req.onsuccess = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('images')) { d.close(); resolve({}); return; }
        const r = {};
        const tx = d.transaction('images', 'readonly');
        const cur = tx.objectStore('images').openCursor();
        cur.onsuccess = (ev) => {
          const c = ev.target.result;
          if (c) { r[c.key] = c.value; c.continue(); }
          else { d.close(); resolve(r); }
        };
        cur.onerror = () => { d.close(); resolve({}); };
      };
      req.onerror = () => resolve({});
    } catch (_) { resolve({}); }
  });
}

async function clearIDB() {
  try {
    const d = await openIDB();
    d.transaction('images', 'readwrite').objectStore('images').clear();
    refreshStorageIndicator();
  } catch (_) {}
}

function getTextSession() {
  try {
    // Try the current key first; fall back to legacy key and migrate transparently.
    let raw = localStorage.getItem(SESSION_KEY);
    if (!raw) {
      raw = localStorage.getItem(SESSION_KEY_LEGACY);
      if (raw) {
        localStorage.setItem(SESSION_KEY, raw);
        localStorage.removeItem(SESSION_KEY_LEGACY);
      }
    }
    if (!raw) return null;
    const s = JSON.parse(raw);
    return (s?.source && s?.filename) ? s : null;
  } catch (_) { return null; }
}

function clearTextSession() {
  localStorage.removeItem(SESSION_KEY);
  refreshStorageIndicator();
}

function timeAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)  return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} day(s) ago`;
}

// ── Image reference parsing ─────────────────────────

function parseImageRefs(src) {
  const refs = new Set();
  const imgPat = /#image\("([^"]+)"/g;
  let m;
  while ((m = imgPat.exec(src)) !== null) refs.add(m[1]);
  // tabimg("name") constructs "/images/" + name
  const tabPat = /\btabimg\("([^"]+)"\)/g;
  while ((m = tabPat.exec(src)) !== null) refs.add('/images/' + m[1]);
  return [...refs];
}

function isImageLoaded(ref) {
  const name = ref.split('/').pop();
  return !!(imageFiles[name] || imageFiles[ref.replace(/^\.\.\//, '/')]);
}

function imageRefStatus() {
  const refs = parseImageRefs(source);
  const missing = refs.filter(r => !isImageLoaded(r));
  const loaded  = refs.filter(r =>  isImageLoaded(r));
  return { refs, loaded, missing };
}

function refreshImageManagerIfOpen() {
  if (editContainer.querySelector('.img-manager-panel')) {
    editContainer.innerHTML = '';
    editContainer.appendChild(buildImageManagerPanel());
  }
}

// ── Image Manager panel ─────────────────────────────

function showImageManager() {
  treeContainer.querySelectorAll('.tree-item.selected').forEach(i => i.classList.remove('selected'));
  treeContainer.querySelectorAll('.tree-item-img').forEach(i => i.classList.add('selected'));
  selectedElement = null;
  editContainer.innerHTML = '';
  editContainer.appendChild(buildImageManagerPanel());
}

function buildImageManagerPanel() {
  // Revoke any blob URLs from a previous gallery render
  galleryObjectUrls.forEach(u => URL.revokeObjectURL(u));
  galleryObjectUrls = [];

  const wrap = document.createElement('div');
  wrap.className = 'img-manager-panel';

  const header = document.createElement('div');
  header.className = 'edit-section-title';
  header.textContent = 'IMAGE MANAGER';
  wrap.appendChild(header);

  const { refs, loaded, missing } = imageRefStatus();

  const summary = document.createElement('div');
  summary.className = 'line-info';
  summary.textContent = refs.length === 0
    ? 'No image references found in document.'
    : `${loaded.length} of ${refs.length} referenced images loaded.`;
  if (refs.length > 0 && missing.length === 0) {
    summary.style.color = 'var(--success)';
  }
  wrap.appendChild(summary);

  // Inline drop zone
  const zone = document.createElement('div');
  zone.className = 'img-drop-zone';
  zone.textContent = 'Drop images here — or use the buttons below';
  zone.addEventListener('dragover',  (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('drag-active'); });
  zone.addEventListener('dragleave', (e) => { e.stopPropagation(); zone.classList.remove('drag-active'); });
  zone.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    zone.classList.remove('drag-active');
    const imgs = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
    if (imgs.length) await loadImageFiles(imgs);
  });
  wrap.appendChild(zone);

  // Action buttons
  const btnRow = document.createElement('div');
  btnRow.className = 'btn-row';
  btnRow.style.marginTop = '0';

  if (window.showDirectoryPicker) {
    const linkBtn = document.createElement('button');
    linkBtn.className = 'btn btn-primary';
    linkBtn.style.cssText = 'font-size:11px;padding:5px 12px';
    linkBtn.textContent = linkedDirHandle ? '↺ Re-link folder' : '📁 Link folder…';
    linkBtn.title = 'Pick your images folder — loads all images automatically on every session';
    linkBtn.addEventListener('click', linkImageFolder);
    btnRow.appendChild(linkBtn);
  }

  const loadBtn = document.createElement('button');
  loadBtn.className = 'btn btn-secondary';
  loadBtn.style.cssText = 'font-size:11px;padding:5px 12px';
  loadBtn.textContent = 'Load files…';
  loadBtn.addEventListener('click', () => imgInput.click());
  btnRow.appendChild(loadBtn);

  const uniqueLoaded = Object.keys(imageFiles).filter(k => !k.includes('/')).length;
  if (uniqueLoaded > 0) {
    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn btn-secondary';
    clearBtn.style.cssText = 'font-size:11px;padding:5px 12px;color:var(--danger);border-color:var(--danger)';
    clearBtn.textContent = 'Clear all';
    clearBtn.addEventListener('click', async () => {
      imageFiles = {};
      linkedDirHandle = null;
      await clearIDB();
      await saveDirHandle(null);
      showToast('Images cleared', 'info');
      triggerCompile();
      updateFileInfo();
      buildTree();
      editContainer.innerHTML = '';
      editContainer.appendChild(buildImageManagerPanel());
    });
    btnRow.appendChild(clearBtn);
  }

  wrap.appendChild(btnRow);

  if (linkedDirHandle) {
    const linked = document.createElement('div');
    linked.style.cssText = 'font-size:10px;color:var(--success);margin-top:6px;';
    linked.textContent = `✓ Linked folder: ${linkedDirHandle.name}`;
    wrap.appendChild(linked);
  } else if (window.showDirectoryPicker) {
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:10px;color:var(--muted);margin-top:6px;font-style:italic;line-height:1.5';
    hint.textContent = 'Tip: link a folder to auto-load all images every session — or just drop them above.';
    wrap.appendChild(hint);
  }

  // Gallery — referenced images
  if (refs.length > 0) {
    const gh = document.createElement('div');
    gh.className = 'img-gallery-header';
    gh.textContent = `In document (${refs.length})`;
    wrap.appendChild(gh);

    const grid = document.createElement('div');
    grid.className = 'img-gallery';
    for (const ref of refs) {
      grid.appendChild(buildImageCard(ref, isImageLoaded(ref)));
    }
    wrap.appendChild(grid);
  }

  // Extra loaded images (not referenced in doc — e.g. pasted)
  const referencedNames = new Set(refs.map(r => r.split('/').pop()));
  const extraNames = Object.keys(imageFiles).filter(k => !k.includes('/') && !referencedNames.has(k));
  if (extraNames.length > 0) {
    const gh = document.createElement('div');
    gh.className = 'img-gallery-header';
    gh.textContent = `Extra loaded (${extraNames.length})`;
    wrap.appendChild(gh);

    const grid = document.createElement('div');
    grid.className = 'img-gallery';
    for (const name of extraNames) {
      grid.appendChild(buildImageCard(name, true, true));
    }
    wrap.appendChild(grid);
  }

  return wrap;
}

function buildImageCard(ref, isLoaded, isExtra) {
  const name = typeof ref === 'string' ? ref.split('/').pop() : ref;
  const card = document.createElement('div');
  card.className = 'img-card ' + (isLoaded ? 'is-loaded' : 'is-missing');
  card.title = isLoaded ? `Click to copy snippet for ${name}` : `Missing: ${name}`;

  // Thumbnail
  const thumb = document.createElement('div');
  thumb.className = 'img-card-thumb';
  if (isLoaded) {
    const imgKey = imageFiles[name] ? name : (typeof ref === 'string' ? ref.replace(/^\.\.\//, '/') : name);
    const buf = imageFiles[imgKey];
    if (buf) {
      const img = document.createElement('img');
      const url = URL.createObjectURL(new Blob([buf]));
      galleryObjectUrls.push(url);
      img.src = url;
      img.alt = name;
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = '<div class="img-card-placeholder">🖼</div>';
    }
  } else {
    thumb.innerHTML = '<div class="img-card-placeholder">?</div>';
  }
  card.appendChild(thumb);

  // Info row
  const info = document.createElement('div');
  info.className = 'img-card-info';
  const nameEl = document.createElement('div');
  nameEl.className = 'img-card-name';
  nameEl.textContent = name;
  nameEl.title = typeof ref === 'string' ? ref : name;
  info.appendChild(nameEl);
  const badge = document.createElement('span');
  badge.className = 'img-badge ' + (isLoaded ? 'img-badge-ok' : 'img-badge-missing');
  badge.textContent = isLoaded ? 'loaded' : 'missing';
  info.appendChild(badge);
  card.appendChild(info);

  // Click to copy snippet
  if (isLoaded) {
    const snippetPath = `/images/${name}`;
    card.addEventListener('click', () => {
      const snippet = `#image("${snippetPath}", width: 100%)`;
      navigator.clipboard.writeText(snippet).then(() => {
        showToast(`Copied snippet for ${name}`, 'success');
      }).catch(() => {
        showToast(`${snippet}`, 'info');
      });
    });
  }

  return card;
}

// ── Directory handle (folder link) ──────────────────

async function linkImageFolder() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    linkedDirHandle = handle;
    const count = await loadFromDirHandle(handle);
    await saveDirHandle(handle);
    saveTextSession();
    saveImagesToIDB();
    showToast(`Loaded ${count} images from folder`, 'success');
    updateFileInfo();
    buildTree();
    triggerCompile();
    refreshImageManagerIfOpen();
  } catch (e) {
    if (e.name !== 'AbortError') showToast('Could not open folder: ' + e.message, 'error');
  }
}

async function loadFromDirHandle(handle) {
  let count = 0;
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind !== 'file') continue;
    if (!/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(name)) continue;
    try {
      const buf = await (await entry.getFile()).arrayBuffer();
      imageFiles[`/images/${name}`] = buf;
      imageFiles[name] = buf;
      count++;
    } catch (_) {}
  }
  return count;
}

async function saveDirHandle(handle) {
  try {
    const d = await openIDB();
    const tx = d.transaction('settings', 'readwrite');
    if (handle) tx.objectStore('settings').put(handle, 'dir-handle');
    else        tx.objectStore('settings').delete('dir-handle');
  } catch (_) {}
}

async function loadDirHandle() {
  try {
    const d = await openIDB();
    return await new Promise(resolve => {
      const req = d.transaction('settings', 'readonly').objectStore('settings').get('dir-handle');
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => resolve(null);
    });
  } catch (_) { return null; }
}

async function tryRestoreDirHandle() {
  const handle = await loadDirHandle();
  if (!handle) return;
  try {
    const perm = await handle.queryPermission({ mode: 'read' });
    if (perm === 'granted') {
      linkedDirHandle = handle;
      await loadFromDirHandle(handle);
      updateFileInfo();
    }
    // If perm === 'prompt': user will see "Re-link folder" in Image Manager
  } catch (_) {}
}

// ── Toast ──────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => toast.remove());
  toast.appendChild(closeBtn);
  container.appendChild(toast);
  if (type !== 'error') {
    setTimeout(() => toast.remove(), 4000);
  }
}

// ── Presentation / Slideshow mode ─────────────────

let presPageIndex   = 0;   // 0-based current slide index
let presPages       = [];  // cached rendered canvases
let presRendering   = false;

const presOverlay   = document.getElementById('presentation-overlay');
const presCanvas    = document.getElementById('presentation-canvas');
const presCounter   = document.getElementById('pres-page-counter');
const btnPresPrev   = document.getElementById('btn-pres-prev');
const btnPresNext   = document.getElementById('btn-pres-next');
const btnPresExit   = document.getElementById('btn-pres-exit');
const btnPresFs     = document.getElementById('btn-pres-fullscreen');

async function enterPresentationMode() {
  if (!currentPdfBytes || presRendering) return;
  presRendering = true;
  presPages = [];

  // High-DPI aware scale: target ~90% of the smaller viewport dimension per slide
  const vw = window.screen.width || window.innerWidth;
  const vh = window.screen.height || window.innerHeight;
  const dpr = window.devicePixelRatio || 1;

  try {
    const loadTask = pdfjsLib.getDocument({
      data: new Uint8Array(
        currentPdfBytes instanceof ArrayBuffer
          ? currentPdfBytes
          : currentPdfBytes.buffer
      ).slice(),
      disableRange: true,
      disableStream: true,
    });
    const pdf = await loadTask.promise;

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      // Scale so the page fits inside vw × vh at 90% utilisation
      const vp0 = page.getViewport({ scale: 1 });
      const scale = Math.min((vw * 0.90) / vp0.width, (vh * 0.88) / vp0.height) * dpr;
      const vp = page.getViewport({ scale });

      const c = document.createElement('canvas');
      c.width  = vp.width;
      c.height = vp.height;
      c.style.width  = (vp.width  / dpr) + 'px';
      c.style.height = (vp.height / dpr) + 'px';
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      page.cleanup();
      presPages.push(c);
    }
    pdf.destroy();
  } catch (err) {
    showToast('Presentation render error: ' + err.message, 'error');
    presRendering = false;
    return;
  }

  presRendering = false;
  presPageIndex = 0;
  presOverlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  presShowSlide(0);
}

function presShowSlide(idx) {
  if (presPages.length === 0) return;
  presPageIndex = Math.max(0, Math.min(idx, presPages.length - 1));

  // Swap canvas content
  const src = presPages[presPageIndex];
  presCanvas.width  = src.width;
  presCanvas.height = src.height;
  presCanvas.style.width  = src.style.width;
  presCanvas.style.height = src.style.height;
  presCanvas.getContext('2d').drawImage(src, 0, 0);

  presCounter.textContent = `${presPageIndex + 1} / ${presPages.length}`;
  btnPresPrev.disabled = presPageIndex === 0;
  btnPresNext.disabled = presPageIndex === presPages.length - 1;
}

function exitPresentationMode() {
  presOverlay.style.display = 'none';
  document.body.style.overflow = '';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

btnPresPrev.addEventListener('click', () => presShowSlide(presPageIndex - 1));
btnPresNext.addEventListener('click', () => presShowSlide(presPageIndex + 1));
btnPresExit.addEventListener('click', exitPresentationMode);

btnPresFs.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    presOverlay.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
});

// Update fullscreen icon
document.addEventListener('fullscreenchange', () => {
  btnPresFs.title = document.fullscreenElement
    ? 'Exit fullscreen (F)'
    : 'Toggle fullscreen (F)';
  btnPresFs.textContent = document.fullscreenElement ? '⊡' : '⛶';
});

document.addEventListener('keydown', (e) => {
  if (presOverlay.style.display === 'none') return;
  // Don't hijack Space if a button inside the overlay has focus (allow native click)
  const spaceOnButton = e.key === ' ' && document.activeElement?.tagName === 'BUTTON';
  if (e.key === 'ArrowRight' || (!spaceOnButton && e.key === ' ') || e.key === 'ArrowDown') {
    e.preventDefault();
    presShowSlide(presPageIndex + 1);
  } else if (e.key === 'ArrowLeft' || e.key === 'Backspace' || e.key === 'ArrowUp') {
    e.preventDefault();
    presShowSlide(presPageIndex - 1);
  } else if (e.key === 'Escape') {
    exitPresentationMode();
  } else if (e.key === 'f' || e.key === 'F') {
    btnPresFs.click();
  } else if (e.key === 'Home') {
    e.preventDefault();
    presShowSlide(0);
  } else if (e.key === 'End') {
    e.preventDefault();
    presShowSlide(presPages.length - 1);
  }
});

btnPresent.addEventListener('click', enterPresentationMode);

// ── Zoom controls ──────────────────────────────────
function setZoom(z) {
  previewZoom = Math.max(0.25, Math.min(3.0, z));
  zoomLevelEl.textContent = Math.round(previewZoom * 100) + '%';
  btnZoomOut.disabled = previewZoom <= 0.25;
  btnZoomIn.disabled  = previewZoom >= 3.0;
  if (currentPdfBytes) renderPdfPages(currentPdfBytes).catch(err => showToast('Zoom error: ' + err.message, 'error'));
}

btnZoomIn.addEventListener('click',    () => setZoom(previewZoom + 0.25));
btnZoomOut.addEventListener('click',   () => setZoom(previewZoom - 0.25));
btnZoomReset.addEventListener('click', () => setZoom(1.0));

previewPanel.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    setZoom(previewZoom + (e.deltaY < 0 ? 0.25 : -0.25));
  }
}, { passive: false });

// ── Keyboard shortcuts ─────────────────────────────
document.addEventListener('keydown', (e) => {
  if (appEl.style.display === 'none') return;
  if (presOverlay.style.display !== 'none') return; // let presentation handler take over
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undoEdit();
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
    e.preventDefault(); setZoom(previewZoom + 0.25);
  }
  if ((e.ctrlKey || e.metaKey) && e.key === '-') {
    e.preventDefault(); setZoom(previewZoom - 0.25);
  }
  if ((e.ctrlKey || e.metaKey) && e.key === '0') {
    e.preventDefault(); setZoom(1.0);
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
    e.preventDefault();
    if (!btnPresent.disabled) enterPresentationMode();
  }
});

// ── Init ───────────────────────────────────────────
initPwaLifecycle();
setupLanding();
btnDlTyp.addEventListener('click', downloadTyp);
btnDlPdf.addEventListener('click', downloadPdf);
btnAddImages.addEventListener('click', () => imgInput.click());
btnOpenFile.addEventListener('click', openDifferentFile);
document.getElementById('btn-add-section').addEventListener('click', showAddSectionForm);
document.getElementById('btn-dismiss-error').addEventListener('click', () => {
  errorPanel.style.display = 'none';
});
btnDlPdf.disabled = true;
btnPresent.disabled = true;

// ── Drag & drop images onto the app ────────────────
let dragCounter = 0;

appEl.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  dragCounter++;
  if (dragCounter === 1) {
    dropOverlay.style.display = 'flex';
    e.preventDefault();
  }
});

appEl.addEventListener('dragover', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

appEl.addEventListener('dragleave', () => {
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) dropOverlay.style.display = 'none';
});

appEl.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.style.display = 'none';
  const imgs = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
  if (imgs.length) await loadImageFiles(imgs);
});

// ── Paste images from clipboard ─────────────────────
document.addEventListener('paste', async (e) => {
  if (appEl.style.display === 'none') return;
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  const items = [...e.clipboardData.items].filter(i => i.kind === 'file' && i.type.startsWith('image/'));
  if (!items.length) return;
  e.preventDefault();
  const files = items.map(item => {
    const blob = item.getAsFile();
    const ext  = item.type === 'image/jpeg' ? '.jpg' : item.type === 'image/gif' ? '.gif' : '.png';
    return new File([blob], `pasted-${Date.now()}${ext}`, { type: item.type });
  });
  await loadImageFiles(files);
});

// Warn before closing/refreshing the tab while a document is open
window.addEventListener('beforeunload', (e) => {
  if (source) {
    e.preventDefault();
    e.returnValue = 'You have unsaved changes. Download the .typ file before leaving.';
  }
});
