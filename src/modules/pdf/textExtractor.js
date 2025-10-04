export function computePdfKeyFromSource(source) {
    if (!source) return null;
    if (source.type === "url") return `url::${source.name}`;
    if (source.type === "file") {
        const { name, size = 0, lastModified = 0 } = source;
        return `file::${name}::${size}::${lastModified}`;
    }
    return null;
}