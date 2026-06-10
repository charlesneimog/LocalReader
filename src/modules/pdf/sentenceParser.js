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
                await app.getPdfHeaderFooterDetector().detectHeadersAndFooters(pageNum);
            }

            await this.parsePageWords(pageNum, page);
        }
    }

    async parsePageWords(pageNumber, page) {
        const { app } = this;
        const { config, state } = app;
        const abbreviations = ["Mr", "Mrs", "Ms", "Dr", "Prof", "Sr", "Jr", "e.g", "i.e.", "etc", "Fig", "p", "al"];
        let sentenceIndex = state.sentences.length; // Continue from existing sentences

        const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const sentenceEndings = Array.isArray(config.SENTENCE_END)
            ? config.SENTENCE_END.filter(Boolean)
            : [".", "?", "!"];
        const explicitAlt = sentenceEndings.length ? sentenceEndings.map(escapeRegExp).join("|") : "";
        const closingPunct = "[\\\"'”’»›\\)\\]\\}]";
        const genericEnd = `(?:[.!?…]+(?:${closingPunct}+)?|[:;]+(?:${closingPunct}+))`;
        const sentenceEndRegex = explicitAlt
            ? new RegExp(`(?:${explicitAlt}|${genericEnd})$`)
            : new RegExp(`(?:${genericEnd})$`);
        const abbreviationSet = new Set(
            abbreviations
                .map((a) =>
                    String(a)
                        .replace(/[.!?…]+$/g, "")
                        .trim()
                        .toLowerCase(),
                )
                .filter(Boolean),
        );

        const getCanonicalGeom = (w) => {
            // Prefer canonical base geometry (unscaled PDF units) to keep thresholds consistent
            // across different display scales/device widths.
            const x = Number.isFinite(w?._baseX) ? w._baseX : w?.x;
            const y = Number.isFinite(w?._baseYDisplay) ? w._baseYDisplay : w?.y;
            const width = Number.isFinite(w?._baseWidth) ? w._baseWidth : w?.width;
            const height = Number.isFinite(w?._baseHeight) ? w._baseHeight : w?.height;
            return { x, y, width, height };
        };

        function isSentenceEnd(wordStr, nextWordStr, currentBufferLength = 0) {
            const token = String(wordStr || "").trim();
            const w = token.replace(sentenceEndRegex, "");
            const bare = String(w)
                .replace(/[.!?…:;]+$/g, "")
                .trim();

            // Avoid splitting structural prefixes such as "1.", "1.2.", or "A." from
            // the first text that follows them on a block/header line.
            if (
                currentBufferLength <= 2 &&
                nextWordStr &&
                (/^\(?\d+(?:\.\d+)*\)?$/u.test(bare) || /^[A-Z]$/u.test(bare))
            ) {
                return false;
            }

            // Short lead-in labels at the beginning of a block ("Abstract:", "Note:")
            // should stay attached to the phrase that follows.
            if (currentBufferLength <= 3 && nextWordStr && /[:;]["'”’»›\)\]\}]*$/u.test(token)) {
                return false;
            }

            if (
                abbreviationSet.has(
                    String(w)
                        .replace(/[.!?…]+$/g, "")
                        .trim()
                        .toLowerCase(),
                )
            )
                return false;
            if (nextWordStr && /^[0-9)]/.test(nextWordStr)) return false;
            return sentenceEndRegex.test(token);
        }

        // Keep sentence boundaries text-based. Layout filtering is applied later for PDF readability,
        // and layout-block phrase splitting happens only in the TTS renderer.
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
            const originalText = this.joinWords(allWords);
            const readableText = initialReadableWords.length ? originalText : "";
            const text = fallbackWords === allWords ? originalText : this.joinWords(fallbackWords);
            const sentence = {
                index: sentenceIndex++,
                pageNumber: pageNumber,
                words: allWords,
                originalWords: allWords,
                originalText,
                readableWords: [...initialReadableWords],
                readableText,
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
                ttsPhraseTimings: [],
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
            if (config.SPLIT_ON_WORD_GAP && !gapBreak && buffer.length > 0) {
                const lastWord = buffer[buffer.length - 1];
                const { x: lastX, width: lastWidth, height: lastH } = getCanonicalGeom(lastWord);
                const horizontalGap = canonX - (lastX + lastWidth);
                const em = lastH || canonHeight || 0;
                const wordGapThresholdEm = Number.isFinite(config.WORD_GAP_THRESHOLD_EM)
                    ? config.WORD_GAP_THRESHOLD_EM
                    : 2.5;
                const gapThreshold = em > 0 ? em * wordGapThresholdEm : config.TOLERANCE;

                if (horizontalGap > gapThreshold) {
                    gapBreak = true;
                }
            }

            if (gapBreak && buffer.length) flush();

            buffer.push(w);

            const nextWord = wordsToProcess[i + 1]?.str || "";
            if (isSentenceEnd(w.str, nextWord, buffer.length) || (config.BREAK_ON_LINE && w.lineBreak)) {
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
        let x1 = Infinity;
        let y1 = Infinity;
        let x2 = -Infinity;
        let y2 = -Infinity;
        for (const w of words) {
            x1 = Math.min(x1, w.x);
            y1 = Math.min(y1, w.y - w.height);
            x2 = Math.max(x2, w.x + w.width);
            y2 = Math.max(y2, w.y);
        }
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
