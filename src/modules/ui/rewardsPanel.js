import { getPlantDefinition } from "../rewards/plantDefinitions.js";

export function getReadingProgressPercent(session) {
    const activeReadingMs = Math.max(0, Number(session?.activeReadingMs) || 0);
    const goalMs = Math.max(0, Number(session?.goalMs) || 0);
    if (!goalMs) return 0;
    return Math.max(0, Math.min(100, (activeReadingMs / goalMs) * 100));
}

export function formatReadingProgressTime(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export class RewardsPanel {
    constructor({ onGarden }) {
        this.element = document.createElement("div");
        this.element.className = "hidden fixed top-2 right-1 z-30 items-center gap-2";
        this.element.innerHTML = `
            <button type="button" data-garden aria-label="Open reading garden"
                class="flex items-center justify-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-background-light/90 dark:bg-background-dark/90 p-2 text-sm font-semibold text-slate-700 dark:text-slate-200 backdrop-blur-md hover:bg-primary/10 dark:hover:bg-primary/20 transition-colors">
                <span data-reading-progress class="reward-reading-progress hidden" aria-hidden="true">
                    <svg viewBox="0 0 40 40" focusable="false">
                        <rect class="reward-reading-progress__track" x="2" y="2" width="36" height="36" rx="8" pathLength="100"></rect>
                        <rect data-progress-border class="reward-reading-progress__value" x="2" y="2" width="36" height="36" rx="8" pathLength="100"></rect>
                    </svg>
                </span>
                <span data-tree-status class="hidden flex-col items-center self-stretch">
                    <img data-current-tree class="h-8" alt="">
                    <span data-counting-dot class="reward-counting-dot reward-counting-dot--inactive" aria-hidden="true"></span>
                </span>
                <span data-progress class="reward-visually-hidden">Garden</span>
            </button>
            <div class="reward-visually-hidden" data-accessible></div>
            <div class="reward-visually-hidden" aria-live="polite" aria-atomic="true"></div>`;
        document.body.appendChild(this.element);
        this.element.querySelector("[data-garden]").addEventListener("click", onGarden);
        this.announced = new Set();
    }

    update({ documentOpen, session, summary, currentPlantStage, activelyCounting = false }) {
        this.element.classList.toggle("hidden", !documentOpen);
        this.element.classList.toggle("flex", !!documentOpen);
        const gardenButton = this.element.querySelector("[data-garden]");
        gardenButton.disabled = !summary;
        gardenButton.classList.toggle("reward-garden-button--reading", !!documentOpen);
        const currentDefinition = summary.currentPlant
            ? getPlantDefinition(summary.currentPlant.speciesId)
            : null;
        const image = this.element.querySelector("[data-current-tree]");
        const showTree = !!documentOpen && !!currentDefinition?.image;
        this.element.querySelector("[data-tree-status]").classList.toggle("hidden", !showTree);
        this.element.querySelector("[data-tree-status]").classList.toggle("flex", showTree);
        if (image.getAttribute("src") !== (currentDefinition?.image || "")) {
            image.src = currentDefinition?.image || "";
        }
        image.alt = currentDefinition ? `${currentDefinition.name} being grown` : "";
        const readingProgress = this.element.querySelector("[data-reading-progress]");
        readingProgress.classList.toggle("hidden", !documentOpen);
        const progressPercent = getReadingProgressPercent(session);
        this.element.querySelector("[data-progress-border]").style.strokeDasharray =
            `${progressPercent} 100`;
        const countingDot = this.element.querySelector("[data-counting-dot]");
        countingDot.classList.toggle("reward-counting-dot--active", activelyCounting);
        countingDot.classList.toggle("reward-counting-dot--inactive", !activelyCounting);
        countingDot.title = activelyCounting ? "Reading time is counting" : "Reading time is not counting";
        const elapsed = formatReadingProgressTime(session?.activeReadingMs);
        const goal = formatReadingProgressTime(session?.goalMs);
        gardenButton.setAttribute(
            "aria-label",
            documentOpen
                ? `Open reading garden. Tree time ${elapsed} of ${goal}. Reading time is ${activelyCounting ? "counting" : "not counting"}.`
                : "Open reading garden.",
        );
        gardenButton.title = documentOpen
            ? `Tree time: ${elapsed} / ${goal}`
            : "Open reading garden";
        this.element.querySelector("[data-progress]").textContent =
            currentDefinition
                ? currentDefinition.name
                : `${summary.maturePlantCount} ${summary.maturePlantCount === 1 ? "tree" : "trees"}`;
        this.element.querySelector("[data-accessible]").textContent = [
            `Current plant: ${summary.currentPlant?.speciesId || "none"}.`,
            `Current growth: ${currentPlantStage?.percent || 0} percent.`,
            `Active session time: ${session?.activeReadingMs || 0} milliseconds.`,
            `Session target: ${session?.goalMs || 0} milliseconds.`,
            `Earned points: ${summary.totalPoints}.`,
            `Mature plant count: ${summary.maturePlantCount}.`,
            `Weekly reading days: ${summary.weeklyReadingDays}.`,
            `Next unlock: ${summary.nextUnlock?.name || "all unlocked"}.`,
            `Garden occupancy: ${summary.gardenOccupancy.occupied} of ${summary.gardenOccupancy.capacity}.`,
            `Automatic tree level: ${summary.treeTier?.definition?.name || "Reading Sapling"}.`,
        ].join(" ");
    }

    announce(key, message) {
        if (this.announced.has(key)) return;
        this.announced.add(key);
        this.element.querySelector("[aria-live]").textContent = message;
    }
}
