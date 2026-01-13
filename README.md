<p align="center">
  <h1 align="center">LocalReader</h1>
  <p align="center">
    <a href="https://charlesneimog.github.io/LocalReader">
      <img src="assets/icons/icon.svg" width="10%" alt="Logo">
    </a>
  </p>
</p>

**LocalReader** is a privacy-focused, offline PDF & EPUB reader with natural-sounding text-to-speech using **Piper**.  
It runs entirely in your browser and can be installed as a **Progressive Web App (PWA)** for desktop or mobile.

---

## Features

- Open and read local **PDF** and **EPUB** files directly in the browser.  
- **Local TTS** using *Piper* (on-device / WASM builds) for natural speech.  
- **Offline-first:** works fully offline once models are loaded.  
- **Word and sentence-level highlights** with persistent storage (IndexedDB).  
- **Document gallery** with progressive thumbnails and resume support.  
- **EPUB** rendering via *Foliate-view* (annotations, CFIs).  
- **PDF** rendering via *PDF.js* with sentence extraction and layout cleanup.  
- **Accessible UI**, keyboard navigation, and per-sentence playback control.  
- **No remote services or telemetry.**

## Usage

1. Click **Open Document** to choose a PDF or EPUB file.
2. Use the floating toolbar for playback and highlight controls.
3. Press **Home** to access the saved documents gallery.
4. Your progress, highlights, and files persist locally in IndexedDB.

**Keyboard shortcuts:**

| Key     | Action                     |
| ------- | -------------------------- |
| `Space` | Play / Pause TTS           |
| `h`     | Highlight current sentence |
| `t`     | Translate current sentence |
| `f`     | Toggle fullscreen          |

---

## Architecture Overview

* `index.html` — App shell and main UI
* `sw.js`, `manifest.webmanifest` — PWA configuration
* `src/`

  * `app.js` — Main orchestrator (global `app` instance)
  * `core/` — State, cache, and event management
  * `modules/`

    * `pdf/` — PDF.js integration, sentence parsing, highlight overlays
    * `epub/` — EPUB loader using *Foliate-view*
    * `tts/` — Piper TTS, audio synthesis queue, WebAudio engine
    * `storage/` — IndexedDB persistence for progress/highlights/files
    * `ui/` — Toolbar, highlighting, and controls
* `thirdparty/` — Vendor libraries (PDF.js, Foliate, Piper builds)

Built with **WebAssembly**, **ONNX**, **Piper-TTS**, and **Foliate-JS**.

---

## Development

* Static web app, no bundler needed for development.
* Serve locally (see Quick Start) and edit directly under `src/`.
* Debug via browser console — most runtime messages appear in the UI info box.
* Selfhost server (save pdf files, highlights, and current reading position).

---

## Contributing

Contributions are welcome!
Please:

1. Open an issue describing your proposal or bug.
2. Create a feature branch for your work.
3. Keep pull requests focused and include a brief test description.

---

## Privacy

* 100% client-side; no network requests or remote analytics.
* Documents, highlights, and progress are stored locally (IndexedDB).
* Users have full control of their data.
* Selfhosted

---

## How to Selfhost

```
docker-compose build --no-cache
docker-compose up -d
```

If you will host the site in another domain than [charlesneimog.github.io](charlesneimog.github.io), add this domain in `ALLOWED_ORIGINS`, multiple domains can be used using commas.

You can configure the target translation language (used by `t`) with `TRANSLATE_TARGET_LANG` in `compose.yml` (example: `pt`, `es`, `fr`).

Put the domain where the selfhost will be accessible in the `Server Link` in the `LocalReader` configuration.

---

### Credits

Created by **Charles K. Neimog**

With appreciation to the creators of **Piper**, **Foliate-JS**, **PDF.js**, and the open-source community.

---

### Links

* [Demo (GitHub Pages)](https://charlesneimog.github.io/LocalReader/)
* [Source Repository](https://github.com/charlesneimog/LocalReader)
