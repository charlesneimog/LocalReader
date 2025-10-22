# GitHub Pages Deployment Configuration

## Important: Choose Your Deployment Path

Your app can be deployed in two ways:

### Option 1: Root Domain (e.g., pdfcastia.com)
- ✅ Currently configured for this
- Manifest: `scope: "/"`
- Service Worker: Uses root paths

### Option 2: GitHub Pages Subdirectory (e.g., username.github.io/pdf-tts-reader/)

If you're deploying to a subdirectory, you MUST update these files:

#### 1. manifest.webmanifest
```json
{
    "id": "/pdf-tts-reader/",
    "start_url": "/pdf-tts-reader/",
    "scope": "/pdf-tts-reader/"
}
```

#### 2. sw.js
The service worker already has dynamic path detection:
```javascript
const getBasePath = () => {
  const path = self.location.pathname;
  if (path.includes('/pdf-tts-reader/')) {
    return '/pdf-tts-reader';
  }
  return '';
};
```

This should work automatically, but verify by:
```javascript
console.log('BASE_PATH:', BASE_PATH); // Should log '/pdf-tts-reader'
```

#### 3. index.html
All asset paths should be relative or use the correct base:
```html
<!-- ✅ Correct (relative) -->
<script src="./thirdparty/pdf/pdf.js"></script>

<!-- ❌ Wrong (absolute without base) -->
<script src="/thirdparty/pdf/pdf.js"></script>

<!-- ✅ Correct (with base tag) -->
<head>
    <base href="/pdf-tts-reader/">
    <script src="thirdparty/pdf/pdf.js"></script>
</head>
```

## Testing Locally

### With Python
```bash
python -m http.server 8000
# Visit: http://localhost:8000
```

### With Node.js (serve)
```bash
npx serve -p 8000
# Visit: http://localhost:8000
```

### Simulate Subdirectory
```bash
# Create subdirectory structure
mkdir -p test-deploy/pdf-tts-reader
cp -r * test-deploy/pdf-tts-reader/
cd test-deploy
python -m http.server 8000
# Visit: http://localhost:8000/pdf-tts-reader/
```

## GitHub Pages Setup

### 1. Enable GitHub Pages
- Go to repository Settings → Pages
- Source: Deploy from branch
- Branch: main (or gh-pages)
- Folder: / (root)

### 2. Update Repository Settings
If deploying to subdirectory, set:
```
https://<username>.github.io/pdf-tts-reader/
```

### 3. Verify Deployment
After deployment, check:
```
1. https://<username>.github.io/pdf-tts-reader/manifest.webmanifest
   - Should return JSON with correct scope

2. https://<username>.github.io/pdf-tts-reader/sw.js
   - Should return JavaScript

3. DevTools → Application → Manifest
   - Should show correct start_url and scope
```

## Common Issues

### Issue 1: "Unable to access this site" on mobile
**Cause:** Manifest scope doesn't match actual URL path

**Fix:**
```javascript
// In sw.js, add logging
console.log('SW Location:', self.location);
console.log('BASE_PATH:', BASE_PATH);

// Should match your deployment URL structure
```

### Issue 2: Service Worker not registering
**Cause:** HTTPS required (except localhost)

**Fix:** GitHub Pages provides HTTPS automatically. Ensure you're using:
```
https://username.github.io/pdf-tts-reader/
NOT http://
```

### Issue 3: Assets not caching
**Cause:** Wrong paths in staticFiles array

**Fix:**
```javascript
// sw.js should resolve paths correctly
const resolvedStaticFiles = staticFiles.map(resolvePath);
// Check console logs to verify paths
```

### Issue 4: Fonts not loading offline
**Cause:** Google Fonts not cached

**Fix:** Already implemented in updated sw.js:
```javascript
const externalResources = [
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap",
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined"
];
```

## Debugging on Mobile

### iOS Safari
1. On Mac: Safari → Develop → [Your iPhone]
2. Or use Web Inspector on device: Settings → Safari → Advanced → Web Inspector

### Android Chrome
1. chrome://inspect on desktop
2. Connect device via USB
3. Enable USB debugging on phone

### Check Service Worker on Mobile
Add this debug info to your app:
```javascript
// Add to index.html
window.addEventListener('load', async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const debugInfo = {
        swState: reg?.active?.state,
        scope: reg?.scope,
        updateViaCache: reg?.updateViaCache,
        online: navigator.onLine
    };
    console.log('PWA Debug:', debugInfo);
    
    // Show on screen for mobile testing
    document.body.insertAdjacentHTML('beforeend', 
        `<pre style="position:fixed;top:0;left:0;background:black;color:lime;padding:10px;font-size:10px;z-index:9999;max-width:100%;">
            ${JSON.stringify(debugInfo, null, 2)}
        </pre>`
    );
});
```

## Performance Testing

### Lighthouse (DevTools)
1. Open DevTools → Lighthouse
2. Select "Progressive Web App"
3. Run audit

Should pass:
- ✅ Registers a service worker
- ✅ Responds with 200 when offline
- ✅ Has a web app manifest
- ✅ Provides a valid icon
- ✅ Sets a theme color

### Manual Offline Test
1. Open app online
2. DevTools → Application → Service Workers → Check "Offline"
3. Reload page
4. Should load instantly from cache
5. All features should work

## Deployment Checklist

Before deploying:
- [ ] Update APP_VERSION in sw.js
- [ ] Verify manifest.webmanifest scope matches deployment URL
- [ ] Test locally with correct path structure
- [ ] Check all asset paths (relative vs absolute)
- [ ] Test offline mode in DevTools
- [ ] Test on actual mobile device
- [ ] Verify HTTPS certificate
- [ ] Check cache size (should be < 50MB for Cache API)
- [ ] Test service worker update mechanism

After deploying:
- [ ] Visit site and install PWA
- [ ] Enable airplane mode
- [ ] Try to use app
- [ ] Check console for errors
- [ ] Verify all assets load from cache
- [ ] Test on iOS and Android

## File Size Considerations

Cache API limits (varies by browser):
- Chrome: ~80-100MB per origin
- Safari: ~50MB per origin
- Firefox: ~100MB per origin

Current app size estimate:
```
- HTML/CSS/JS: ~2MB
- PDF.js library: ~2MB
- Piper TTS: ~5MB
- Icons/Images: ~1MB
- Third-party libs: ~3MB
Total: ~13MB (before models)
```

TTS Models (loaded dynamically):
- Medium quality: ~20-30MB per voice
- High quality: ~50-70MB per voice

**Recommendation:** Cache 1-2 voices maximum, let user choose in settings.
