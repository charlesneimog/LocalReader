#include <vector>
#include <string>
#include <unordered_map>
#include <fstream>
#include <piper.h>
#include <emscripten.h>
#include <emscripten/bind.h>

class PiperSynthesizer {
  public:
    PiperSynthesizer() = default;
    ~PiperSynthesizer() {
        cleanup();
    }

    void dispose() {
        cleanup();
    }

    // Register a voice by giving existing FS filenames.
    // (Files must already be written into the virtual FS from JS.)
    void registerVoice(const std::string &voice_key, const std::string &modelFilename,
                       const std::string &jsonFilename) {
        if (voice_key.empty()) {
            emscripten_log(EM_LOG_ERROR, "registerVoice: empty key");
            return;
        }
        if (!fileExists(modelFilename)) {
            emscripten_log(EM_LOG_ERROR, "registerVoice: model missing '%s'",
                           modelFilename.c_str());
            return;
        }
        if (!fileExists(jsonFilename)) {
            emscripten_log(EM_LOG_ERROR, "registerVoice: json missing '%s'", jsonFilename.c_str());
            return;
        }
        voices_[voice_key] = {modelFilename, jsonFilename};
        emscripten_log(EM_LOG_CONSOLE, "registerVoice: '%s' -> (%s, %s)", voice_key.c_str(),
                       modelFilename.c_str(), jsonFilename.c_str());
    }

    bool initVoice(const std::string &voice_key) {
        auto it = voices_.find(voice_key);
        if (it == voices_.end()) {
            emscripten_log(EM_LOG_ERROR, "initVoice: voice '%s' not registered", voice_key.c_str());
            return false;
        }

        cleanup();

        const std::string &model = it->second.first;
        const std::string &json = it->second.second;

        synth_ = piper_create(model.c_str(), json.c_str(), "./espeak-ng-data");
        if (!synth_) {
            emscripten_log(EM_LOG_ERROR, "initVoice: piper_create failed");
            return false;
        }
        currentVoice_ = voice_key;
        lastSampleRate_ = 0;
        emscripten_log(EM_LOG_CONSOLE, "initVoice: voice '%s' ready", voice_key.c_str());
        return true;
    }

    std::vector<float> synthesize(const std::string &text) {
        std::vector<float> audio;
        if (!synth_) {
            emscripten_log(EM_LOG_ERROR, "synthesize: no active synthesizer");
            return audio;
        }
        if (text.empty()) {
            emscripten_log(EM_LOG_WARN, "synthesize: empty text");
            return audio;
        }

        piper_synthesize_options options = piper_default_synthesize_options(synth_);
        if (piper_synthesize_start(synth_, text.c_str(), &options) != PIPER_OK) {
            emscripten_log(EM_LOG_ERROR, "synthesize: start failed");
            return audio;
        }

        piper_audio_chunk chunk;
        while (true) {
            int rc = piper_synthesize_next(synth_, &chunk);
            if (rc != PIPER_OK && rc != PIPER_DONE) {
                emscripten_log(EM_LOG_ERROR, "synthesize: next error rc=%d", rc);
                break;
            }
            if (chunk.samples && chunk.num_samples > 0) {
                if (lastSampleRate_ == 0) {
                    lastSampleRate_ = chunk.sample_rate;
                }
                audio.insert(audio.end(), chunk.samples, chunk.samples + chunk.num_samples);
            }
            if (rc == PIPER_DONE || chunk.is_last) {
                break;
            }
        }

        emscripten_log(EM_LOG_CONSOLE, "synthesize: produced %zu samples @ %d Hz", audio.size(),
                       lastSampleRate_);
        return audio;
    }

    int getLastSampleRate() const {
        return lastSampleRate_;
    }

    std::vector<std::string> listVoices() const {
        std::vector<std::string> out;
        out.reserve(voices_.size());
        for (auto &kv : voices_) {
            out.push_back(kv.first);
        }
        return out;
    }

  private:
    piper_synthesizer *synth_ = nullptr;
    std::unordered_map<std::string, std::pair<std::string, std::string>> voices_;
    std::string currentVoice_;
    int lastSampleRate_ = 0;

    void cleanup() {
        if (synth_) {
            piper_free(synth_);
            synth_ = nullptr;
            lastSampleRate_ = 0;
            emscripten_log(EM_LOG_CONSOLE, "cleanup: freed synthesizer");
        }
    }

    static bool fileExists(const std::string &path) {
        std::ifstream f(path, std::ios::binary);
        return (bool)f;
    }
};

// Embind bindings
EMSCRIPTEN_BINDINGS(piper_module) {
    emscripten::class_<PiperSynthesizer>("PiperSynthesizer")
        .constructor<>()
        .function("registerVoice", &PiperSynthesizer::registerVoice)
        .function("initVoice", &PiperSynthesizer::initVoice)
        .function("synthesize", &PiperSynthesizer::synthesize)
        .function("dispose", &PiperSynthesizer::dispose)
        .function("listVoices", &PiperSynthesizer::listVoices)
        .function("getLastSampleRate", &PiperSynthesizer::getLastSampleRate);

    emscripten::register_vector<float>("VectorFloat");
    emscripten::register_vector<std::string>("VectorString");
}
