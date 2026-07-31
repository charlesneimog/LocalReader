import { GardenRenderer } from "../rewards/gardenRenderer.js";
import { isTimestampInLocalPeriod } from "../rewards/rewardDefinitions.js";
import { getPlantDefinition, getPlantStage } from "../rewards/plantDefinitions.js";

const PERIOD_LABELS = Object.freeze({
    week: "this week",
    month: "this month",
    year: "this year",
});

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
    const cells = [];
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < columns; x++) cells.push({ x, y, depth: x + y });
    }
    cells.sort((left, right) => left.depth - right.depth || left.y - right.y || left.x - right.x);
    return {
        plot: { ...plot, rows, columns },
        plants: plants.map((plant, index) => ({
            ...plant,
            plotId: plot.id,
            cell: cells[index],
        })),
    };
}

export function reflectionTextForPlant(plant, reflections) {
    const reflection = (Array.isArray(reflections) ? reflections : []).find((entry) =>
        (plant?.reflectionId && entry.id === plant.reflectionId) ||
        (!plant?.reflectionId && plant?.sessionId && entry.sessionId === plant.sessionId),
    );
    return typeof reflection?.text === "string" ? reflection.text.trim() : "";
}

export class GardenDialog {
    constructor({ weekStartsOn = 1, minimumRows = 5, now = Date.now } = {}) {
        this.weekStartsOn = weekStartsOn;
        this.minimumRows = Math.max(1, Number(minimumRows) || 5);
        this.now = now;
        this.period = "week";
        this.dialog = document.createElement("dialog");
        this.dialog.className =
            "rewards-dialog garden-dialog w-[94vw] max-w-xl max-h-[88vh] p-0 rounded-xl " +
            "border border-slate-200 dark:border-slate-700 bg-background-light dark:bg-background-dark " +
            "text-slate-800 dark:text-slate-200 text-center shadow-2xl";
        this.dialog.innerHTML = `
            <section class="grid gap-3 p-4 overflow-y-auto max-h-[88vh]">
                <header class="flex items-start justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-700">
                    <div class="flex-1 text-center">
                        <h2 class="text-xl font-bold text-slate-900 dark:text-slate-100">Reading garden</h2>
                        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">One garden, shaped by focused reading.</p>
                    </div>
                    <button type="button" data-close aria-label="Close"
                        class="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10">
                        <span class="material-symbols-outlined" aria-hidden="true">close</span>
                    </button>
                </header>
                <div class="rounded-lg bg-primary/10 p-3 text-sm text-slate-700 dark:text-slate-200" data-summary></div>
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
        const projection = projectPlantsIntoGarden(periodPlants, {
            ...plot,
            rows: this.minimumRows,
        });
        projection.plants = projection.plants.map((plant) => ({
            ...plant,
            reflectionText: reflectionTextForPlant(plant, state.reflections),
        }));
        const occupied = state.plants.filter((plant) => plant.stage === "mature" && plant.cell).length;
        const unplaced = state.plants.filter((plant) => plant.stage === "mature" && !plant.cell).length;
        const periodLabel = PERIOD_LABELS[this.period];
        this.dialog.querySelector("[data-summary]").textContent =
            `${periodPlants.length} ${periodPlants.length === 1 ? "tree" : "trees"} ${periodLabel} · ` +
            `${summary.maturePlantCount} total · ${occupied} of ${plot.rows * plot.columns} cells occupied` +
            `${unplaced ? ` · ${unplaced} waiting for space` : ""}`;
        this.renderer.render(projection);
    }

    _showDetails(area) {
        const tooltip = this.dialog.querySelector("[data-tooltip]");
        const comment = this.dialog.querySelector("[data-comment]");
        if (!area.plant) {
            tooltip.textContent = `Cell ${area.cell.x + 1}, ${area.cell.y + 1} is available.`;
            comment.textContent = "";
            comment.classList.add("hidden");
            return;
        }
        tooltip.textContent = this._plantLabel(area.plant);
        comment.textContent = area.plant.reflectionText || "No reading note was saved for this tree.";
        comment.classList.remove("hidden");
    }

    _resetDetails() {
        const tooltip = this.dialog.querySelector("[data-tooltip]");
        const comment = this.dialog.querySelector("[data-comment]");
        tooltip.textContent = "Select a tree for details.";
        comment.textContent = "";
        comment.classList.add("hidden");
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
