export function splitSegmentsOnSemicolons(text, segments) {
    const phrases = [];
    const append = (start, end) => {
        while (start < end && /\s/u.test(text[start])) start++;
        while (end > start && /\s/u.test(text[end - 1])) end--;
        if (end <= start) return;
        phrases.push({
            text: text.slice(start, end).replace(/\s+/g, " ").trim(),
            start,
            end,
        });
    };

    for (const segment of segments) {
        let start = segment.start;
        const source = text.slice(segment.start, segment.end);
        const separator = /;["'”’»›\)\]\}]*/gu;
        let match;
        while ((match = separator.exec(source))) {
            const end = segment.start + match.index + match[0].length;
            append(start, end);
            start = end;
        }
        append(start, segment.end);
    }
    return phrases;
}
