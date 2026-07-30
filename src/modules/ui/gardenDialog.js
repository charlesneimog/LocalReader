import { GardenRenderer } from "../rewards/gardenRenderer.js";
import { getPlantDefinition, getPlantStage } from "../rewards/plantDefinitions.js";

export class GardenDialog {
    constructor({ onCreatePlot = null } = {}) {
        this.onCreatePlot = onCreatePlot;
        this.selectedPlotId = null;
        this.dialog = document.createElement("dialog");
        this.dialog.className =
            "rewards-dialog garden-dialog w-[94vw] max-w-2xl max-h-[88vh] p-0 rounded-xl " +
            "border border-slate-200 dark:border-slate-700 bg-background-light dark:bg-background-dark " +
            "text-slate-800 dark:text-slate-200 shadow-2xl";
        this.dialog.innerHTML = `
            <section class="grid gap-4 p-4 sm:p-6 overflow-y-auto max-h-[88vh]">
                <header class="flex items-start justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-700">
                    <div>
                        <h2 class="text-xl font-bold text-slate-900 dark:text-slate-100">Reading garden</h2>
                        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">A garden shaped by focused reading.</p>
                    </div>
                    <button type="button" data-close aria-label="Close"
                        class="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors">
                        <span class="material-symbols-outlined" aria-hidden="true">close</span>
                    </button>
                </header>
                <div class="rounded-lg bg-primary/10 p-3 text-sm text-slate-700 dark:text-slate-200" data-summary></div>
                <div class="flex items-center justify-between gap-3">
                    <label class="grid gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
                        Plot
                        <select data-plots class="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-slate-800 dark:text-slate-200 outline-none focus:ring-2 focus:ring-primary"></select>
                    </label>
                    <button type="button" data-new-plot
                        class="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary/90 transition-colors">Add garden plot</button>
                </div>
                <div class="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-white/50 dark:bg-black/20">
                    <canvas class="garden-canvas block w-full max-w-full bg-transparent" aria-label="Reading garden grid"></canvas>
                </div>
                <p class="rounded-lg bg-slate-100 dark:bg-slate-800 p-3 text-sm text-slate-600 dark:text-slate-300" data-tooltip aria-live="polite">Select a garden cell for details.</p>
                <details class="rounded-lg border border-slate-200 dark:border-slate-700 p-3 text-sm">
                    <summary class="font-semibold text-slate-700 dark:text-slate-200">Accessible garden list</summary>
                    <ol data-list class="mt-2 space-y-1 text-slate-600 dark:text-slate-300"></ol>
                </details>
                <details class="rounded-lg border border-slate-200 dark:border-slate-700 p-3 text-sm">
                    <summary class="font-semibold text-slate-700 dark:text-slate-200">Reward history</summary>
                    <div class="mt-2 overflow-y-auto font-mono text-xs text-slate-600 dark:text-slate-300" data-history></div>
                </details>
            </section>`;
        document.body.appendChild(this.dialog);
        this.dialog.querySelector("[data-close]").addEventListener("click", () => this.dialog.close());
        this.dialog.querySelector("[data-plots]").addEventListener("change", (event) => {
            this.selectedPlotId = event.target.value;
            this.update(this.state, this.summary);
        });
        this.dialog.querySelector("[data-new-plot]").addEventListener("click", async () => {
            const plot = await this.onCreatePlot?.();
            if (plot) this.selectedPlotId = plot.id;
        });
        this.renderer = new GardenRenderer(this.dialog.querySelector("canvas"), {
            onSelect: (area) => {
                this.dialog.querySelector("[data-tooltip]").textContent = area.plant
                    ? this._plantLabel(area.plant)
                    : `Cell ${area.cell.x + 1}, ${area.cell.y + 1} is available.`;
            },
        });
    }

    open(state, summary) {
        this.update(state, summary);
        this.dialog.showModal();
    }

    update(state, summary) {
        this.state = state;
        this.summary = summary;
        const plotSelect = this.dialog.querySelector("[data-plots]");
        const previous = this.selectedPlotId || plotSelect.value;
        plotSelect.replaceChildren();
        for (const candidate of state.gardenPlots) {
            const option = document.createElement("option");
            option.value = candidate.id;
            option.textContent = candidate.name;
            plotSelect.appendChild(option);
        }
        const plot = state.gardenPlots.find((candidate) => candidate.id === previous) || state.gardenPlots[0];
        if (!plot) return;
        this.selectedPlotId = plot.id;
        plotSelect.value = plot.id;
        const plotPlants = state.plants.filter((plant) => plant.plotId === plot.id);
        const occupied = plotPlants.filter((plant) => plant.cell).length;
        const unplaced = state.plants.filter((plant) => plant.stage === "mature" && !plant.cell).length;
        this.dialog.querySelector("[data-summary]").textContent =
            `${summary.maturePlantCount} mature plants · ${occupied} of ${plot.rows * plot.columns} cells occupied · ${summary.weeklyReadingDays} reading days this week${unplaced ? ` · ${unplaced} mature plant${unplaced === 1 ? "" : "s"} waiting for space` : ""}`;
        this.renderer.render({ plot, plants: plotPlants });
        const list = this.dialog.querySelector("[data-list]");
        list.replaceChildren();
        for (const plant of plotPlants.filter((candidate) => candidate.cell)) {
            const item = document.createElement("li");
            item.textContent = `${this._plantLabel(plant)} at column ${plant.cell.x + 1}, row ${plant.cell.y + 1}`;
            list.appendChild(item);
        }
        if (!list.children.length) list.innerHTML = "<li>No mature plants have been placed yet.</li>";
        const history = this.dialog.querySelector("[data-history]");
        history.replaceChildren();
        for (const transaction of [...state.rewardLedger].reverse()) {
            const row = document.createElement("div");
            row.className = "border-b border-slate-200 dark:border-slate-700 py-1";
            row.textContent = `${new Date(transaction.timestamp).toLocaleString()} · ${transaction.rewardType} · +${transaction.points}`;
            history.appendChild(row);
        }
        if (!history.children.length) history.textContent = "No reward transactions yet.";
    }

    _plantLabel(plant) {
        const definition = getPlantDefinition(plant.speciesId);
        const stage = getPlantStage(plant.speciesId, plant.pointsInvested);
        return `${definition.name}, ${stage.label}, ${stage.percent}% grown`;
    }
}
