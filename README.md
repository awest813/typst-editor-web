# LibrePDF

A browser-only visual editor for [Typst](https://typst.app/) documents that generates PDF output — no server, no install, no account required.

---

## What it does

LibrePDF lets you:

- **Open** an existing `.typ` source file and edit its structured elements (cards, section intros, info boxes, page titles, images) via a GUI.
- **Create** new documents from built-in templates (blank, service manual, quick reference, simple report).
- **Compile** the document to PDF entirely in-browser using the Typst WebAssembly compiler.
- **Preview** the rendered PDF live, page by page.
- **Download** the modified `.typ` source or the compiled PDF.
- **Recover** interrupted sessions via auto-save to `localStorage` and `IndexedDB`.

---

## Architecture

```
index.html          ← entry point; layout and DOM skeleton
app.css             ← all styles (single file, CSS custom properties)
app.js              ← main module: state, UI, session persistence, PDF rendering
  ├─ parser.js      ← Typst source parser (bracket-balanced element extraction)
  ├─ editor-panel.js← property editor UI for all element types
  └─ templates.js   ← document template definitions and source generators
typst-worker.js     ← Web Worker: Typst WASM compiler + font loading
sw.js               ← Service Worker: offline shell + runtime CDN caching
manifest.webmanifest← PWA manifest (install metadata and icons)
icons/*.svg         ← App icons used by the PWA manifest
```

### Key flows

| Action | Flow |
|--------|------|
| Open file | `loadTypFile` → `enterEditor` → `TypstParser.parse` → `buildTree` → `triggerCompile` |
| Edit element | `EditorPanel.buildForm` → `applyChangesToSource` → `triggerCompile` |
| Compile | `doCompile` → `worker.postMessage` → `typst-worker.js` → PDF bytes → `renderPdfPages` |
| Session save | `saveTextSession` (localStorage) + `saveImagesToIDB` (IndexedDB) |
| Session restore | `getTextSession` (localStorage) + `loadImagesFromIDB` (IndexedDB, with legacy migration) |

### CDN dependencies

| Library | Location | Version |
|---------|----------|---------|
| PDF.js | `app.js` top | `pdfjs-dist@4.9.155` |
| Typst TS compiler | `typst-worker.js` | `@myriaddreamin/typst-ts-web-compiler@0.7.0-rc2` |
| Typst bundled fonts | `typst-worker.js` | `typst-assets@v0.13.0` |
| Source Sans 3 | `typst-worker.js` | `@fontsource/source-sans-3@5.0.3` |
| Noto Sans | `typst-worker.js` | `@fontsource/noto-sans@5.0.12` |

To upgrade a dependency, update its version string in the file listed above.

---

## Parsed element types

The parser (`parser.js`) recognises these Typst helper calls as editable elements:

| Typst call | Editor type | Description |
|-----------|-------------|-------------|
| `#ptitle("…")` | `ptitle` | Page title with accent bar |
| `#sintro("…")[…]` | `sintro` | Full-width section intro box |
| `#tcard(…)[…]` | `tcard` | Numbered or plain task card |
| `#ibox(…)[…]` | `ibox` | Note / warning / success / danger box |
| `#image("…")` | `image` | Standalone image |

---

## Running locally

No build step is required — open `index.html` directly in a browser that supports ES modules and Web Workers.

```bash
# Simple dev server (Python)
python3 -m http.server 8080

# Or Node
npx serve .
```

Then visit `http://localhost:8080`.

> **Note:** The first compile downloads ~15 MB of fonts from CDN and takes 20–40 s. Subsequent compiles are fast because fonts are cached in the worker's memory for the session.
> **PWA note:** Service worker and install prompt behavior require serving over `http://localhost` or `https` (not `file://`).

---

## PWA / offline behavior

- LibrePDF now exposes an install prompt when supported (`beforeinstallprompt`).
- `sw.js` caches the app shell for offline startup and keeps CDN dependencies in a runtime cache.
- Update handling uses a refresh prompt when a new service worker is waiting.
- Storage usage is surfaced in the editor header via the `Storage x%` indicator.
- The landing install banner includes a **Clear cache** action to recover quota pressure.

---

## CI checks

GitHub Actions runs a lightweight baseline validation workflow:

- Manifest JSON validation (`python3 -m json.tool manifest.webmanifest`)
- JavaScript syntax checks (`node --check ...`)

You can run the same locally:

```bash
python3 -m json.tool manifest.webmanifest >/dev/null
node --check app.js
node --check parser.js
node --check editor-panel.js
node --check templates.js
node --check typst-worker.js
node --check sw.js
```

---

## Manual test checklist

Run through this list before merging a PR that touches app logic:

- [ ] Landing screen loads; both "Open existing" and "New from template" tabs work.
- [ ] Drag-and-drop a `.typ` file onto the drop zone opens the editor.
- [ ] Creating a document from each template compiles without errors.
- [ ] Session recovery banner appears on reload when a document is open; "Recover" restores source and images.
- [ ] "Discard" clears the session and hides the banner.
- [ ] Editing a `tcard` title via the Properties panel updates the preview.
- [ ] Adding an image via the Image Manager and referencing it in source displays it in the PDF.
- [ ] Zoom in/out and reset work via buttons and Ctrl+scroll.
- [ ] Ctrl+Z undoes the last edit.
- [ ] ⬇ .typ and ⬇ PDF downloads produce valid files.
- [ ] "Switch File…" modal offers download before discarding unsaved work.
- [ ] Tab-only keyboard navigation reaches all interactive controls.
- [ ] Install banner appears on supported browsers; install or dismiss behavior works.
- [ ] Reload works offline after one successful online load.
- [ ] Update banner appears after a service worker update and refresh applies it.

---

## Rebrand / storage migration notes

The product was originally named "Typst Element Editor". It was renamed to **LibrePDF** in May 2026.

**Storage keys changed:**

| Storage | Old key | New key |
|---------|---------|---------|
| `localStorage` | `typst-editor-session` | `librepdf-session` |
| `IndexedDB` database | `typst-editor` | `librepdf` |

Existing users are migrated automatically and transparently on their next page load:

1. `getTextSession()` checks `librepdf-session`; if absent it reads `typst-editor-session`, writes it to the new key, and removes the old one.
2. `loadImagesFromIDB()` opens `librepdf`; if it is empty it reads from `typst-editor`, saves the data into `librepdf`, and requests deletion of the old database.

The legacy `typst-editor` database deletion is best-effort (some browsers require the page to have no open connections).

---

## Contributing

1. Fork the repo and create a feature branch.
2. Make changes — keep PRs small and focused.
3. Run through the manual test checklist above.
4. Open a pull request with a clear description of what changed and why.

There is currently no automated test suite. Contributions that add tests (parser unit tests, template generation tests, or browser smoke tests) are especially welcome.
