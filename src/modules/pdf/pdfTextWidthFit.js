export const TEXT_WIDTH_FIT_PADDING_PX = 5;

function wordBox(word) {
    if (
        word?.bbox &&
        Number.isFinite(word.bbox.x1) &&
        Number.isFinite(word.bbox.x2) &&
        Number.isFinite(word.bbox.y1) &&
        Number.isFinite(word.bbox.y2)
    ) {
        return {
            x1: word.bbox.x1,
            y1: word.bbox.y1,
            x2: word.bbox.x2,
            y2: word.bbox.y2,
        };
    }

    const x1 = Number(word?.x);
    const y2 = Number(word?.y);
    const width = Number(word?.width);
    const height = Number(word?.height);
    if (![x1, y2, width, height].every(Number.isFinite)) return null;
    return { x1, y1: y2 - height, x2: x1 + width, y2 };
}

function overlaps(a, b) {
    return Math.min(a.x2, b.x2) > Math.max(a.x1, b.x1) && Math.min(a.y2, b.y2) > Math.max(a.y1, b.y1);
}

export function getFocusedReadableWords(words, readableBoxes, focusBlockKey) {
    const readableWords = (words || []).filter((word) => word?.isReadable === true && wordBox(word));
    const match = /^readable:(\d+)$/.exec(String(focusBlockKey || ""));
    const block = match ? readableBoxes?.[Number(match[1])] : null;
    if (!block) return readableWords;

    const focusedWords = readableWords.filter((word) => overlaps(wordBox(word), block));
    return focusedWords.length ? focusedWords : readableWords;
}

export function calculateHorizontalTextFit(
    words,
    viewportWidth,
    containerWidth,
    paddingPx = TEXT_WIDTH_FIT_PADDING_PX,
) {
    const boxes = (words || []).map(wordBox).filter(Boolean);
    if (!boxes.length || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return null;

    const left = Math.min(...boxes.map((box) => box.x1));
    const right = Math.max(...boxes.map((box) => box.x2));
    const textWidth = right - left;
    const safePadding = Math.max(0, Number(paddingPx) || 0);
    const availableWidth = Math.max(1, (Number(containerWidth) || 0) - safePadding * 2);
    if (!Number.isFinite(textWidth) || textWidth <= 0 || availableWidth <= 0) return null;

    const scale = availableWidth / textWidth;
    return {
        left,
        right,
        scale,
        pageWidth: viewportWidth * scale,
        offsetLeft: safePadding - left * scale,
        fittedTextLeft: left * scale,
        fittedTextRight: right * scale,
        fittedTextWidth: textWidth * scale,
        padding: safePadding,
    };
}
