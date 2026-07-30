import { getPlantDefinition, getPlantStage } from "../rewards/plantDefinitions.js";

const formatDuration = (milliseconds) => {
    const seconds = Math.floor((Number(milliseconds) || 0) / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

export class SessionProgressWidget {
    constructor({ onPause, onResume, onFinish, onQuestion }) {
        this.handlers = { onPause, onResume, onFinish, onQuestion };
        this.element = document.createElement("aside");
        this.element.className =
            "hidden fixed bottom-20 left-1/2 -translate-x-1/2 z-30 w-[94vw] max-w-xl " +
            "rounded-lg border border-slate-200 dark:border-slate-700 bg-background-light/90 " +
            "dark:bg-background-dark/90 p-2 shadow-lg backdrop-blur-md";
        this.element.setAttribute("aria-label", "Reading session");
        this.element.innerHTML = `
            <div class="flex items-center gap-2">
                <button type="button" data-open-garden aria-label="Open reading garden"
                    class="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary hover:bg-primary/10 transition-colors">
                    <span class="material-symbols-outlined" aria-hidden="true">potted_plant</span>
                </button>
                <div class="min-w-0 flex-1">
                    <div class="flex items-center justify-between gap-2 text-xs">
                        <strong data-plant class="truncate text-slate-800 dark:text-slate-100">Reading plant</strong>
                        <span data-time class="font-mono text-slate-600 dark:text-slate-300">00:00 / 00:00</span>
                    </div>
                    <div class="mt-1 flex items-center gap-2">
                        <span data-state class="min-w-[84px] text-xs capitalize text-slate-500 dark:text-slate-400">Idle</span>
                        <div class="h-2 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
                            role="progressbar" data-growth aria-label="Plant growth" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                            <div data-growth-bar class="h-2 bg-primary transition-all"></div>
                        </div>
                    </div>
                </div>
                <div class="flex items-center gap-1">
                    <button type="button" data-pause
                        class="rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-2 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-primary/10 dark:hover:bg-primary/20 transition-colors">Pause</button>
                    <button type="button" data-question title="Save a reading question" aria-label="Save a reading question"
                        class="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 dark:border-slate-700 bg-transparent text-slate-600 dark:text-slate-300 hover:bg-primary/10 dark:hover:bg-primary/20 transition-colors">
                        <span class="material-symbols-outlined text-lg" aria-hidden="true">help</span>
                    </button>
                    <button type="button" data-finish
                        class="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-primary/90 transition-colors">Finish</button>
                </div>
            </div>`;
        document.body.appendChild(this.element);
        this.element.querySelector("[data-pause]").addEventListener("click", () => {
            const paused = this.element.dataset.state === "paused" || this.element.dataset.state === "idle-timeout";
            return paused ? this.handlers.onResume() : this.handlers.onPause();
        });
        this.element.querySelector("[data-finish]").addEventListener("click", () => this.handlers.onFinish());
        this.element.querySelector("[data-question]").addEventListener("click", () => this.handlers.onQuestion());
        this.lastMilestone = 0;
    }

    update(session, plant) {
        if (!session) {
            this.element.classList.add("hidden");
            return;
        }
        this.element.classList.remove("hidden");
        this.element.dataset.state = session.state;
        const definition = getPlantDefinition(plant?.speciesId);
        const stage = getPlantStage(plant?.speciesId, plant?.pointsInvested);
        this.element.querySelector("[data-plant]").textContent = `${definition.name} · ${stage.label}`;
        this.element.querySelector("[data-time]").textContent =
            `${formatDuration(session.activeReadingMs)} / ${formatDuration(session.goalMs)}`;
        this.element.querySelector("[data-state]").textContent = session.state.replace("-", " ");
        const growth = this.element.querySelector("[data-growth]");
        growth.setAttribute("aria-valuenow", String(stage.percent));
        this.element.querySelector("[data-growth-bar]").style.width = `${stage.percent}%`;
        const pause = this.element.querySelector("[data-pause]");
        pause.textContent = ["paused", "idle-timeout"].includes(session.state) ? "Resume" : "Pause";
        const finish = this.element.querySelector("[data-finish]");
        finish.textContent = session.activeReadingMs >= session.goalMs ? "Complete" : "End";
        finish.title = session.activeReadingMs >= session.goalMs ? "Complete session" : "End session without goal bonus";
    }

    setGardenHandler(handler) {
        this.element.querySelector("[data-open-garden]").addEventListener("click", handler);
    }
}
