export class CacheManager {
    constructor(state) {
        this.state = state;
    }

    clearAll() {
        this.state.pagesCache.clear();
        this.state.viewportDisplayByPage.clear();
        this.state.fullPageRenderCache.clear();
        this.state.audioCache.clear();
        if (this.state.chapterCache?.clear) this.state.chapterCache.clear();
        if (this.state.prefetchedChapters?.clear) this.state.prefetchedChapters.clear();
    }
    clearAllAudioCache() {
        this.state.audioCache.clear();
        for (let i = index; i < this.state.sentences.length; i++) {
            s.audioBlob = null;
            s.wavBlob = null;
            s.audioBuffer = null;
            s.audioReady = false;
            s.audioError = null;
            s.audioInProgress = false;
            s.prefetchQueued = false;
            s.lastVoice = null;
            s.lastSpeed = null;
            s.normalizedText = null;
            s.wordBoundaries = [];
            s.playbackWordTimers = [];
        }
    }

    clearAudioFrom(index) {
        for (let i = index; i < this.state.sentences.length; i++) {
            const s = this.state.sentences[i];
            if (!s) continue;
            s.audioBlob = null;
            s.wavBlob = null;
            s.audioBuffer = null;
            s.audioReady = false;
            s.audioError = null;
            s.audioInProgress = false;
            s.prefetchQueued = false;
            s.lastVoice = null;
            s.lastSpeed = null;
            s.normalizedText = null;
            s.wordBoundaries = [];
            s.playbackWordTimers = [];
        }
    }
}

