export const EVENTS = {
    PDF_LOADED: 'pdf:loaded',
    PDF_RENDERED: 'pdf:rendered',
    SENTENCES_PARSED: 'sentences:parsed',

    TTS_SYNTHESIS_START: 'tts:synthesis:start',
    TTS_SYNTHESIS_COMPLETE: 'tts:synthesis:complete',
    TTS_SYNTHESIS_ERROR: 'tts:synthesis:error',

    AUDIO_PLAYBACK_START: 'audio:playback:start',
    AUDIO_PLAYBACK_END: 'audio:playback:end',
    AUDIO_PLAYBACK_PAUSE: 'audio:playback:pause',

    SENTENCE_CHANGED: 'sentence:changed',
    VIEW_MODE_CHANGED: 'view:mode:changed',
    HIGHLIGHT_ADDED: 'highlight:added',
    HIGHLIGHT_REMOVED: 'highlight:removed',

    SENTENCE_HOVER: 'sentence:hover',
    SENTENCE_CLICK: 'sentence:click'
};