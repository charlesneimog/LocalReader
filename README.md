# PDF Sentence Highlighter + Piper TTS

A modern, **progressive web app (PWA)** for reading and listening to PDFs in your browser.  
Highlights sentences in PDF documents, enables navigation by sentence or page, and uses local [Piper TTS](https://github.com/rhasspy/piper) for fast, private audio playback.  
Works offline, remembers your position in each PDF, and is optimized for desktop and mobile.

---

## Features

- **PDF Sentence Highlighting:** See which sentence is being read aloud.
- **Local TTS (Piper):** All text-to-speech runs in your browser, no data leaves your device.
- **Multi-PDF Resume:** Remembers your progress for each PDF (even local files).
- **Full Document Mode:** Render the whole PDF at once for context, or just the current page.
- **Modern Toolbar:** Font Awesome icons, responsive controls.
- **Prefetch & Fast Audio:** Sentences are pre-generated for smooth playback.
- **Offline Capable:** Install as a PWA and use offline.
- **Mobile Friendly:** UI adapts for touch and small screens.
- **Drag & Drop:** Open PDFs by dropping files onto the app.
- **Dark/Light Theme:** Follows your system preference.

---

## Getting Started

1. **Clone or Download:**
   ```
   git clone https://github.com/<your-username>/<your-repo>.git
   cd <your-repo>
   ```

2. **Install Dependencies:**
   - No build needed. All libraries are loaded via CDN or included in `thirdparty/`.

3. **Run Locally:**
   - Serve the directory with any static server, e.g.:
     ```
     npx serve .
     ```
   - Or just open `index.html` in your browser (some browsers require HTTPS for TTS and PWA features).

4. **Open Your PDF:**
   - Click "Open" or drag and drop a PDF file.
   - Use navigation controls to move by sentence or page.
   - Click play to listen via Piper TTS.

---

## Usage

- **Install as App:**  
  On Chrome/Edge/Safari, click the install icon in the address bar, or use browser menu to "Add to Home Screen."
- **Mobile:**  
  App auto-adjusts layout, buttons are larger, PDF pages scale to fit.  
  You can scroll, tap, and listen just as on desktop.
- **Resume Anywhere:**  
  Your position in each PDF (by file name & size) is remembered automatically.

---

## PWA / Offline

- The app uses a service worker to cache:
  - The shell (HTML, CSS, JS, icons)
  - PDF.js and Piper TTS libraries
  - Recently accessed PDFs
- If offline, you can still listen to cached PDFs and use TTS features.

---

## Tech Stack

- **JavaScript (ES6 modules)**
- **PDF.js** - Parsing and rendering PDFs
- **Piper TTS (WebAssembly)** - Fast, local text-to-speech
- **Font Awesome** - Icons
- **Service Worker / Manifest** - For PWA features

---

## Customization

- **Add voices:**  
  Update `PIPER_VOICES` in `render.js` to add more Piper voice models.
- **Change accent color:**  
  Edit `theme_color` in `manifest.webmanifest` and CSS vars in `index.html`.

---

## Accessibility

- Keyboard navigation (space, arrows, 'p' for play/pause)
- ARIA live regions for screen readers
- Responsive design for mobile/touch users

---

## Contributing

Pull requests and issues welcome!  
Please open issues for bugs, feature requests, or suggestions for mobile improvements.

---

## License

MIT License.  
See [LICENSE](LICENSE).

---

## Credits

- [PDF.js](https://github.com/mozilla/pdf.js)
- [Piper TTS](https://github.com/rhasspy/piper)
- [Font Awesome](https://fontawesome.com/)

---

## Screenshots

> _Add your screenshots here!_

---

## TODO / Roadmap

- [ ] Add search within PDF
- [ ] Support for bookmarks and annotations
- [ ] More TTS voices and languages
- [ ] Virtualized rendering for very large PDFs
- [ ] User settings for cache management and privacy

---

## Contact

Questions or feedback?  
Open an issue or email: [your-email@example.com](mailto:your-email@example.com)
