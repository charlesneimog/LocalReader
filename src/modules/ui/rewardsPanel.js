export class RewardsPanel {
    constructor({ onSetup, onGarden }) {
        this.element = document.createElement("div");
        this.element.className = "fixed top-2 right-1 z-30 flex items-center gap-2";
        this.element.innerHTML = `
            <button type="button" data-session
                class="hidden sm:block rounded-lg border border-slate-200 dark:border-slate-700 bg-background-light/80 dark:bg-background-dark/80 px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200 shadow-lg backdrop-blur-md hover:bg-primary/10 dark:hover:bg-primary/20 transition-colors">
                Start garden session
            </button>
            <button type="button" data-garden aria-label="Open reading garden"
                class="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-background-light/80 dark:bg-background-dark/80 px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200 shadow-lg backdrop-blur-md hover:bg-primary/10 dark:hover:bg-primary/20 transition-colors">
                <span class="material-symbols-outlined text-xl text-primary" aria-hidden="true">local_florist</span>
                <span data-progress>Garden</span>
            </button>
            <div class="reward-visually-hidden" data-accessible></div>
            <div class="reward-visually-hidden" aria-live="polite" aria-atomic="true"></div>`;
        document.body.appendChild(this.element);
        this.element.querySelector("[data-session]").addEventListener("click", onSetup);
        this.element.querySelector("[data-garden]").addEventListener("click", onGarden);
        this.announced = new Set();
    }

    update({ documentOpen, session, summary, currentPlantStage }) {
        this.element.querySelector("[data-session]").disabled = !documentOpen || !!session;
        this.element.querySelector("[data-session]").textContent = session ? "Session in progress" : "Start garden session";
        this.element.querySelector("[data-progress]").textContent =
            currentPlantStage ? `${currentPlantStage.percent}%` : `${summary.maturePlantCount} plants`;
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
        ].join(" ");
    }

    announce(key, message) {
        if (this.announced.has(key)) return;
        this.announced.add(key);
        this.element.querySelector("[aria-live]").textContent = message;
    }
}
