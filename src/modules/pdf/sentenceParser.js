export class SentenceParser {
    constructor(app) {
        this.app = app;
    }

    buildSentences() {
        const { app } = this;
        const { config, state } = app;
        const abbreviations = ["Mr", "Mrs", "Ms", "Dr", "Prof", "Sr", "Jr", "e.g", "i.e.", "etc", "Fig", "p"];

        function isSentenceEnd(wordStr, nextWordStr) {
            const endings = config.SENTENCE_END.map((c) => `\\${c}`).join("");
            const sentenceEndRegex = new RegExp(`[${endings}]+$`);
            const w = wordStr.replace(sentenceEndRegex, "");
            if (abbreviations.includes(w)) return false;
            if (nextWordStr && /^[0-9)]/.test(nextWordStr)) return false;
            return sentenceEndRegex.test(wordStr);
        }

        state.sentences = [];
        state.pageSentencesIndex.clear();
        let sentenceIndex = 0;

        for (let p = 1; p <= state.pdf.numPages; p++) {
            const page = state.pagesCache.get(p);
            if (!page?.pageWords) continue;
            let buffer = [];
            let lastY = null,
                lastHeight = null;

            const flush = () => {
                if (!buffer.length) return;
                const bbox = this.combinedBBox(buffer);
                const text = buffer.map((w) => w.str).join(" ");
                const sentence = {
                    index: sentenceIndex++,
                    pageNumber: p,
                    words: [...buffer],
                    text,
                    bbox,
                    audioBlob: null,
                    wavBlob: null,
                    audioBuffer: null,
                    audioReady: false,
                    audioInProgress: false,
                    audioError: null,
                    lastVoice: null,
                    lastSpeed: null,
                    prefetchQueued: false,
                    normalizedText: null,
                    wordBoundaries: [],
                    playbackWordTimers: [],
                    layoutProcessed: false,
                    isTextToRead: false,
                };
                state.sentences.push(sentence);
                if (!state.pageSentencesIndex.has(p)) state.pageSentencesIndex.set(p, []);
                state.pageSentencesIndex.get(p).push(sentence.index);
                buffer = [];
            };

            for (let i = 0; i < page.pageWords.length; i++) {
                const w = page.pageWords[i];
                let gapBreak = false;

                // Check vertical gap (existing)
                if (config.SPLIT_ON_LINE_GAP && lastY !== null) {
                    const verticalDelta = Math.abs(lastY - w.y);
                    if (lastHeight && verticalDelta > lastHeight * config.LINE_GAP_THRESHOLD) gapBreak = true;
                }

                // Check horizontal gap
                if (!gapBreak && buffer.length > 0) {
                    const lastWord = buffer[buffer.length - 1];
                    const horizontalGap = w.x - (lastWord.x + lastWord.width);
                    if (horizontalGap > config.TOLERANCE) gapBreak = true;
                }

                if (gapBreak && buffer.length) flush();
                buffer.push(w);

                const nextWord = page.pageWords[i + 1]?.str || "";
                if (isSentenceEnd(w.str, nextWord) || (config.BREAK_ON_LINE && w.lineBreak)) flush();

                lastY = w.y;
                lastHeight = w.height;
            }

            flush();
        }
    }

    combinedBBox(words) {
        if (!words.length) return null;
        const xs = words.map((w) => w.x);
        const ysTop = words.map((w) => w.y - w.height);
        const ysBottom = words.map((w) => w.y);
        const ws = words.map((w) => w.x + w.width);
        const x1 = Math.min(...xs);
        const y1 = Math.min(...ysTop);
        const x2 = Math.max(...ws);
        const y2 = Math.max(...ysBottom);
        return {
            x: x1,
            y: y1,
            width: x2 - x1,
            height: y2 - y1,
            x1,
            y1,
            x2,
            y2,
            centerX: (x1 + x2) / 2,
            centerY: (y1 + y2) / 2,
        };
    }
}
