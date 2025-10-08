// Worker script: hosts the WASM module so the UI thread stays responsive.
// Load the generated Emscripten module (pipertts.js + pipertts.wasm must be served).
importScripts('pipertts.js');

let ModulePromise = PiperTTS();
let synthInstance = null;

function wlog(msg) {
  postMessage({ type: 'log', message: msg });
}

onmessage = async (e) => {
  const data = e.data;
  const mod = await ModulePromise;

  if (!synthInstance) {
    synthInstance = new mod.PiperSynthesizer();
  }

  switch (data.type) {
    case 'loadVoice': {
      const { voiceKey, onnx, json } = data;
      try {
        if (!onnx || !json) {
          postMessage({ type: 'error', message: 'Missing buffers' });
          return;
        }

        // Write ONNX (binary)
        const onnxBytes = new Uint8Array(onnx);
        mod.FS.writeFile(`${voiceKey}.onnx`, onnxBytes);

        // Write JSON (decode to UTF-8 text)
        const jsonBytes = new Uint8Array(json);
        // Simple UTF-8 decode (assumes it's valid UTF-8)
        const jsonText = new TextDecoder('utf-8').decode(jsonBytes);
        mod.FS.writeFile(`${voiceKey}.onnx.json`, jsonText);

        // Register & init
        synthInstance.registerVoice(voiceKey,
                                    `${voiceKey}.onnx`,
                                    `${voiceKey}.onnx.json`);
        if (!synthInstance.initVoice(voiceKey)) {
            postMessage({ type: 'error', message: 'piper_create/init failed' });
            return;
        }

        wlog(`Worker: voice '${voiceKey}' initialized.`);
        postMessage({ type: 'loaded', voiceKey });
      } catch (err) {
        postMessage({ type: 'error', message: String(err) });
      }
      break;
    }

    case 'synthesize': {
      const { text, voiceKey } = data;
      if (!synthInstance) {
        postMessage({ type: 'error', message: 'Synth not ready' });
        return;
      }
      try {
        wlog(`Worker: synthesizing (${text.length} chars)...`);
        const vec = synthInstance.synthesize(text);
        const n = vec.size();
        const samples = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          samples[i] = vec.get(i);
        }
        const sr = synthInstance.getLastSampleRate() || 22050;
        // Transfer the underlying buffer for efficiency
        postMessage({ type: 'audio', samples, sampleRate: sr }, [samples.buffer]);
      } catch (err) {
        postMessage({ type: 'error', message: String(err) });
      }
      break;
    }

    default:
      postMessage({ type: 'error', message: 'Unknown message type: ' + data.type });
  }
};
