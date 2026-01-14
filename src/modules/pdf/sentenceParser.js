export class SentenceParser {
    constructor(app) {
        this.app = app;
    }

    joinWords(words) {
        if (!Array.isArray(words) || !words.length) return "";
        return words
            .map((w) => (w?.str ? String(w.str).trim() : ""))
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
    }

    async buildSentences(startPageNumber = 1) {
        const { app } = this;
        const { state } = app;

        state.sentences = [];
        state.pageSentencesIndex.clear();
        for (let pageNum = 1; pageNum <= state.pdf.numPages; pageNum++) {
            const page = state.pagesCache.get(pageNum);
            if (!page?.pageWords) {
                console.warn(`[SentenceParser] No words found for page ${pageNum}`);
                continue;
            }
            if (state.generationEnabled) {
                await app.pdfHeaderFooterDetector.detectHeadersAndFooters(pageNum);
            }

            await this.parsePageWords(pageNum, page);
        }
    }

    async parsePageWords(pageNumber, page) {
        const { app } = this;
        const { config, state } = app;
        const abbreviations = ["Mr", "Mrs", "Ms", "Dr", "Prof", "Sr", "Jr", "e.g", "i.e.", "etc", "Fig", "p", "al"];
        let sentenceIndex = state.sentences.length; // Continue from existing sentences

        const getCanonicalGeom = (w) => {
            // Prefer canonical base geometry (unscaled PDF units) to keep thresholds consistent
            // across different display scales/device widths.
            const x = Number.isFinite(w?._baseX) ? w._baseX : w?.x;
            const y = Number.isFinite(w?._baseYDisplay) ? w._baseYDisplay : w?.y;
            const width = Number.isFinite(w?._baseWidth) ? w._baseWidth : w?.width;
            const height = Number.isFinite(w?._baseHeight) ? w._baseHeight : w?.height;
            return { x, y, width, height };
        };

        function isSentenceEnd(wordStr, nextWordStr) {
            const endings = config.SENTENCE_END.map((c) => `\\${c}`).join("");
            const sentenceEndRegex = new RegExp(`[${endings}]+$`);
            const w = wordStr.replace(sentenceEndRegex, "");
            if (abbreviations.includes(w)) return false;
            if (nextWordStr && /^[0-9)]/.test(nextWordStr)) return false;
            return sentenceEndRegex.test(wordStr);
        }

        // CRITICAL: Filter words by layout BEFORE creating sentences
        const wordsToProcess = page.pageWords;
        if (!wordsToProcess || wordsToProcess.length === 0) {
            return;
        }

        let buffer = [];
        let lastY = null;
        let lastHeight = null;

        const flush = () => {
            if (!buffer.length) return;
            const bbox = this.combinedBBox(buffer);
            const allWords = [...buffer];
            const layoutActive = state.generationEnabled;
            const initialReadableWords = layoutActive ? [] : allWords;
            const fallbackWords = initialReadableWords.length ? initialReadableWords : allWords;
            const sentence = {
                index: sentenceIndex++,
                pageNumber: pageNumber,
                words: allWords,
                originalWords: allWords,
                originalText: this.joinWords(allWords),
                readableWords: [...initialReadableWords],
                readableText: this.joinWords(initialReadableWords),
                text: this.joinWords(fallbackWords),
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
                layoutProcessed: !layoutActive,
                isTextToRead: !layoutActive,
                layoutProcessingPromise: null,
            };
            state.sentences.push(sentence);
            if (!state.pageSentencesIndex.has(pageNumber)) {
                state.pageSentencesIndex.set(pageNumber, []);
            }
            state.pageSentencesIndex.get(pageNumber).push(sentence.index);
            buffer = [];
        };

        for (let i = 0; i < wordsToProcess.length; i++) {
            const w = wordsToProcess[i];
            let gapBreak = false;

            const { x: canonX, y: canonY, width: canonWidth, height: canonHeight } = getCanonicalGeom(w);

            // Check vertical gap
            if (config.SPLIT_ON_LINE_GAP && lastY !== null) {
                const verticalDelta = Math.abs(lastY - canonY);
                if (lastHeight && verticalDelta > lastHeight * config.LINE_GAP_THRESHOLD) {
                    gapBreak = true;
                }
            }

            // Check horizontal gap
            if (!gapBreak && buffer.length > 0) {
                const lastWord = buffer[buffer.length - 1];
                const { x: lastX, width: lastWidth, height: lastH } = getCanonicalGeom(lastWord);
                const horizontalGap = canonX - (lastX + lastWidth);
                const em = lastH || canonHeight || 0;
                const wordGapThresholdEm = Number.isFinite(config.WORD_GAP_THRESHOLD_EM) ? config.WORD_GAP_THRESHOLD_EM : 2.5;
                const gapThreshold = em > 0 ? em * wordGapThresholdEm : config.TOLERANCE;

                if (horizontalGap > gapThreshold) {
                    gapBreak = true;
                }
            }

            if (gapBreak && buffer.length) flush();

            buffer.push(w);

            const nextWord = wordsToProcess[i + 1]?.str || "";
            if (isSentenceEnd(w.str, nextWord) || (config.BREAK_ON_LINE && w.lineBreak)) {
                flush();
            }

            lastY = canonY;
            lastHeight = canonHeight;
        }

        flush(); // Flush any remaining words
    }

    applyLayoutFilteringToPage(pageNumber) {
        const { state } = this.app;
        const indices = state.pageSentencesIndex.get(pageNumber);
        if (!indices || !indices.length) return;

        for (const idx of indices) {
            const sentence = state.sentences[idx];
            if (!sentence) continue;

            const words = Array.isArray(sentence.words) ? sentence.words : [];
            const readableWords = words.filter((w) => w?.isReadable);
            sentence.readableWords = readableWords;
            sentence.readableText = this.joinWords(readableWords);
            sentence.text = readableWords.length ? sentence.readableText : this.joinWords(words);
            sentence.layoutProcessed = true;
            sentence.isTextToRead = readableWords.length > 0;
            sentence.bboxReadable = readableWords.length ? this.combinedBBox(readableWords) : null;
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
