import { GardenRenderer } from "../rewards/gardenRenderer.js";
import { deterministicAvailableCell } from "../rewards/gardenManager.js";
import { isTimestampInLocalPeriod } from "../rewards/rewardDefinitions.js";
import { getPlantDefinition, getPlantStage } from "../rewards/plantDefinitions.js";

export function gardenPlantsForPeriod(
    plants,
    period,
    timestamp = Date.now(),
    weekStartsOn = 1,
) {
    return (Array.isArray(plants) ? plants : [])
        .filter(
            (plant) =>
                plant?.stage === "mature" &&
                !plant.deletedAt &&
                isTimestampInLocalPeriod(
                    plant.completedAt || plant.plantedAt,
                    period,
                    timestamp,
                    weekStartsOn,
                ),
        )
        .sort(
            (left, right) =>
                Number(left.completedAt || left.plantedAt || 0) -
                    Number(right.completedAt || right.plantedAt || 0) ||
                String(left.id).localeCompare(String(right.id)),
        );
}

export function projectPlantsIntoGarden(plants, plot) {
    const columns = Math.max(1, Number(plot.columns) || 1);
    const rows = Math.max(
        1,
        Number(plot.rows) || 1,
        Math.ceil(plants.length / columns),
    );
    const projectedPlot = { ...plot, rows, columns };
    const positioned = [];
    for (const plant of plants) {
        const cell = deterministicAvailableCell(
            projectedPlot,
            positioned,
            gardenPositionSeedForPlant(plant),
        );
        positioned.push({
            ...plant,
            plotId: projectedPlot.id,
            cell,
        });
    }
    return {
        plot: projectedPlot,
        plants: positioned,
    };
}

export function gardenPositionSeedForPlant(plant) {
    const phrase = typeof plant?.reflectionText === "string"
        ? plant.reflectionText.trim()
        : "";
    return `${phrase || "tree"}:${plant?.id || "unknown"}`;
}

export function reflectionTextForPlant(plant, reflections) {
    const reflection = (Array.isArray(reflections) ? reflections : []).find((entry) =>
        (plant?.reflectionId && entry.id === plant.reflectionId) ||
        (!plant?.reflectionId && plant?.sessionId && entry.sessionId === plant.sessionId),
    );
    return typeof reflection?.text === "string" ? reflection.text.trim() : "";
}

export class GardenDialog {
    constructor({ weekStartsOn = 1, minimumRows = 5, now = Date.now, onRemove = null } = {}) {
        this.weekStartsOn = weekStartsOn;
        this.minimumRows = Math.max(1, Number(minimumRows) || 5);
        this.now = now;
        this.onRemove = typeof onRemove === "function" ? onRemove : null;
        this.selectedPlantId = null;
        this.period = "week";
        this.dialog = document.createElement("dialog");
        this.dialog.className =
            "rewards-dialog garden-dialog w-[94vw] max-w-xl max-h-[88vh] p-0 rounded-xl " +
            "border border-slate-200 dark:border-slate-700 bg-background-light dark:bg-background-dark " +
            "text-slate-800 dark:text-slate-200 text-center shadow-2xl";
        this.dialog.innerHTML = `
            <section class="grid gap-2 px-3 pb-3 pt-2 overflow-y-auto max-h-[88vh]">
                <header class="flex items-center justify-between gap-3">
                    <h2 class="pl-1 text-base font-semibold text-slate-900 dark:text-slate-100">Reading garden</h2>
                    <button type="button" data-close aria-label="Close"
                        class="flex h-8 w-8 items-center justify-center rounded-md bg-transparent text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10">
                        <span class="material-symbols-outlined" aria-hidden="true">close</span>
                    </button>
                </header>
                <div class="flex justify-center gap-2" role="group" aria-label="Garden time period">
                    <button type="button" data-period="week" aria-pressed="true">Week</button>
                    <button type="button" data-period="month" aria-pressed="false">Month</button>
                    <button type="button" data-period="year" aria-pressed="false">Year</button>
                </div>
                <div class="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-white/50 dark:bg-black/20">
                    <canvas class="garden-canvas block w-full max-w-full bg-transparent" aria-label="Reading garden grid"></canvas>
                </div>
                <div class="rounded-lg bg-slate-100 dark:bg-slate-800 p-3 text-sm text-slate-600 dark:text-slate-300" aria-live="polite">
                    <p data-tooltip>Select a tree for details.</p>
                    <blockquote data-comment class="hidden mt-2 border-l-2 border-primary/50 pl-3 text-left italic whitespace-pre-wrap"></blockquote>
                    <button type="button" data-remove class="hidden mt-3 ml-auto items-center gap-1 rounded-md border border-red-300 px-3 py-2 pt-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/30">
                        <span class="material-symbols-outlined text-base" aria-hidden="true">delete</span>
                        Remove tree
                    </button>
                </div>
            </section>`;
        document.body.appendChild(this.dialog);
        this.dialog.querySelector("[data-close]").addEventListener("click", () => this.dialog.close());
        this.dialog.querySelectorAll("[data-period]").forEach((button) => {
            button.addEventListener("click", () => {
                this.period = button.dataset.period;
                this.renderer.selectedIndex = -1;
                this._resetDetails();
                this.update(this.state, this.summary);
            });
        });
        this.dialog.querySelector("[data-remove]").addEventListener("click", () => {
            this._removeSelectedTree().catch((error) => {
                console.error("[GardenDialog] Failed to remove tree", error);
            });
        });
        this.renderer = new GardenRenderer(this.dialog.querySelector("canvas"), {
            onSelect: (area) => {
                this._showDetails(area);
            },
        });
    }

    open(state, summary) {
        this.renderer.selectedIndex = -1;
        this._resetDetails();
        this.update(state, summary);
        this.dialog.showModal();
    }

    update(state, summary) {
        this.state = state;
        this.summary = summary;
        const plot = state.gardenPlots[0];
        if (!plot) return;
        this._updatePeriodButtons();

        const timestamp = this.now();
        const periodPlants = gardenPlantsForPeriod(
            state.plants,
            this.period,
            timestamp,
            this.weekStartsOn,
        );
        const positionablePlants = periodPlants.map((plant) => ({
            ...plant,
            reflectionText: reflectionTextForPlant(plant, state.reflections),
        }));
        const projection = projectPlantsIntoGarden(positionablePlants, {
            ...plot,
            rows: this.minimumRows,
        });
        this.renderer.render(projection);
    }

    _showDetails(area) {
        const tooltip = this.dialog.querySelector("[data-tooltip]");
        const comment = this.dialog.querySelector("[data-comment]");
        const remove = this.dialog.querySelector("[data-remove]");
        if (!area.plant) {
            this.selectedPlantId = null;
            tooltip.textContent = `Cell ${area.cell.x + 1}, ${area.cell.y + 1} is available.`;
            comment.textContent = "";
            comment.classList.add("hidden");
            remove.classList.add("hidden");
            remove.classList.remove("flex");
            return;
        }
        this.selectedPlantId = area.plant.id;
        tooltip.textContent = this._plantLabel(area.plant);
        comment.textContent = area.plant.reflectionText || "No reading note was saved for this tree.";
        comment.classList.remove("hidden");
        remove.classList.remove("hidden");
        remove.classList.add("flex");
    }

    _resetDetails() {
        const tooltip = this.dialog.querySelector("[data-tooltip]");
        const comment = this.dialog.querySelector("[data-comment]");
        const remove = this.dialog.querySelector("[data-remove]");
        this.selectedPlantId = null;
        tooltip.textContent = "Select a tree for details.";
        comment.textContent = "";
        comment.classList.add("hidden");
        remove.classList.add("hidden");
        remove.classList.remove("flex");
    }

    async _removeSelectedTree() {
        const plantId = this.selectedPlantId;
        if (!plantId || !this.onRemove) return false;
        const plant = this.state?.plants?.find((candidate) => candidate.id === plantId);
        if (!plant) return false;
        const definition = getPlantDefinition(plant.speciesId);
        const confirmed = globalThis.confirm?.(
            `Remove ${definition.name} from your garden? Your reading time and earned points will be kept.`,
        );
        if (!confirmed) return false;

        const button = this.dialog.querySelector("[data-remove]");
        button.disabled = true;
        try {
            const removed = await this.onRemove(plantId);
            if (!removed) return false;
            this.renderer.selectedIndex = -1;
            this._resetDetails();
            return true;
        } finally {
            button.disabled = false;
        }
    }

    _updatePeriodButtons() {
        this.dialog.querySelectorAll("[data-period]").forEach((button) => {
            const active = button.dataset.period === this.period;
            button.className = active
                ? "rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white"
                : "rounded-md border border-slate-200 dark:border-slate-700 px-4 py-2 text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-primary/10";
            button.setAttribute("aria-pressed", String(active));
        });
    }

    _plantLabel(plant) {
        const definition = getPlantDefinition(plant.speciesId);
        const stage = getPlantStage(plant.speciesId, plant.pointsInvested, plant.growthProgress);
        return `${definition.name}, ${stage.label}`;
    }
}
