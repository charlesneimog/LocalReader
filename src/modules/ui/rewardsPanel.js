import { getPlantDefinition } from "../rewards/plantDefinitions.js";

export class RewardsPanel {
    constructor({ onGarden }) {
        this.element = document.createElement("div");
        this.element.className = "fixed top-2 right-1 z-30 flex items-center gap-2";
        this.element.innerHTML = `
            <button type="button" data-garden aria-label="Open reading garden"
                class="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-background-light/80 dark:bg-background-dark/80 px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200 shadow-lg backdrop-blur-md hover:bg-primary/10 dark:hover:bg-primary/20 transition-colors">
                <img data-current-tree class="hidden h-8" alt="">
                <span data-progress>Garden</span>
            </button>
            <div class="reward-visually-hidden" data-accessible></div>
            <div class="reward-visually-hidden" aria-live="polite" aria-atomic="true"></div>`;
        document.body.appendChild(this.element);
        this.element.querySelector("[data-garden]").addEventListener("click", onGarden);
        this.announced = new Set();
    }

    update({ documentOpen, session, summary, currentPlantStage }) {
        this.element.querySelector("[data-garden]").disabled = !summary;
        const currentDefinition = summary.currentPlant
            ? getPlantDefinition(summary.currentPlant.speciesId)
            : null;
        const image = this.element.querySelector("[data-current-tree]");
        image.classList.toggle("hidden", !currentDefinition?.image);
        if (image.getAttribute("src") !== (currentDefinition?.image || "")) {
            image.src = currentDefinition?.image || "";
        }
        image.alt = currentDefinition ? `${currentDefinition.name} being grown` : "";
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
