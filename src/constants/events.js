export const EVENTS = {
    PDF_LOADED: 'pdf:loaded',
    EPUB_LOADED: 'epub:loaded',
    EPUB_LOCATION_CHANGED: "epub:location:changed",
    PDF_RENDERED: 'pdf:rendered',
    SENTENCES_PARSED: 'sentences:parsed',

    TTS_SYNTHESIS_START: 'tts:synthesis:start',
    TTS_SYNTHESIS_COMPLETE: 'tts:synthesis:complete',
    TTS_SYNTHESIS_ERROR: 'tts:synthesis:error',

    AUDIO_PLAYBACK_START: 'audio:playback:start',
    AUDIO_PHRASE_CHANGE: 'audio:phrase:change',
    AUDIO_PLAYBACK_END: 'audio:playback:end',
    AUDIO_PLAYBACK_PAUSE: 'audio:playback:pause',

    SENTENCE_CHANGED: 'sentence:changed',
    VIEW_MODE_CHANGED: 'view:mode:changed',
    HIGHLIGHT_ADDED: 'highlight:added',
    HIGHLIGHT_REMOVED: 'highlight:removed',

    SENTENCE_HOVER: 'sentence:hover',
    SENTENCE_CLICK: "sentence:click",

    // Reading event adapter owns document/activity events. Reward modules own
    // session, reward, plant, garden, weekly, and reflection events.
    READING_DOCUMENT_OPENED: "reading:document:opened",
    READING_DOCUMENT_CLOSED: "reading:document:closed",
    READING_ACTIVITY: "reading:activity",
    READING_SESSION_STARTED: "reading:session:started",
    READING_SESSION_PAUSED: "reading:session:paused",
    READING_SESSION_RESUMED: "reading:session:resumed",
    READING_SESSION_IDLE: "reading:session:idle",
    READING_SESSION_RESET: "reading:session:reset",
    READING_SESSION_PROGRESS: "reading:session:progress",
    READING_SESSION_GOAL_REACHED: "reading:session:goal-reached",
    READING_SESSION_COMPLETED: "reading:session:completed",
    READING_SESSION_ABANDONED: "reading:session:abandoned",
    REWARD_GRANTED: "rewards:granted",
    REWARD_DAILY_LIMIT_REACHED: "rewards:daily-limit-reached",
    PLANT_SELECTED: "rewards:plant:selected",
    PLANT_STAGE_CHANGED: "rewards:plant:stage-changed",
    PLANT_MATURED: "rewards:plant:matured",
    GARDEN_UPDATED: "rewards:garden:updated",
    WEEKLY_GOAL_REACHED: "rewards:weekly-goal-reached",
    REFLECTION_SAVED: "rewards:reflection:saved",
    REWARDS_SYNC_REQUESTED: "rewards:sync-requested",
    REWARDS_UPDATED: "rewards:updated",
};
