export class ReflectionDialog {
    constructor({ minimumCharacters, onSave }) {
        this.minimumCharacters = minimumCharacters;
        this.onSave = onSave;
        this.session = null;
        this.dialog = document.createElement("aside");
        this.dialog.className =
            "hidden fixed bottom-4 right-4 z-40 w-[94vw] max-w-sm rounded-xl border " +
            "border-slate-200 dark:border-slate-700 bg-background-light dark:bg-background-dark " +
            "p-4 text-left text-slate-800 dark:text-slate-200 shadow-lg";
        this.dialog.setAttribute("role", "dialog");
        this.dialog.setAttribute("aria-modal", "false");
        this.dialog.setAttribute("aria-labelledby", "reading-note-title");
        this.dialog.innerHTML = `
            <form class="grid gap-3">
                <header class="flex items-start gap-3">
                    <span class="material-symbols-outlined mt-1 text-primary" aria-hidden="true">park</span>
                    <div class="min-w-0 flex-1">
                        <h2 id="reading-note-title" class="text-sm font-bold text-slate-900 dark:text-slate-100">Tree planted</h2>
                        <p data-summary class="mt-1 text-xs text-slate-500 dark:text-slate-400"></p>
                    </div>
                    <button type="button" data-close aria-label="Not now"
                        class="flex h-9 w-9 items-center justify-center rounded-md text-slate-500 hover:bg-primary/10 dark:text-slate-400">
                        <span class="material-symbols-outlined text-lg" aria-hidden="true">close</span>
                    </button>
                </header>
                <label class="grid gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                    A small note about what you were reading
                    <textarea rows="3" data-text placeholder="Optional reading note…"
                        class="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-slate-800 dark:text-slate-200 outline-none focus:ring-2 focus:ring-primary"></textarea>
                </label>
                <p class="text-xs text-slate-500 dark:text-slate-400">
                    Write at least ${this.minimumCharacters} non-space characters to save.
                </p>
                <footer class="flex justify-end gap-2">
                    <button type="button" data-skip
                        class="rounded-md px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10">Not now</button>
                    <button type="submit" data-save disabled
                        class="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-white">Save note</button>
                </footer>
            </form>`;
        document.body.appendChild(this.dialog);

        const form = this.dialog.querySelector("form");
        const area = this.dialog.querySelector("[data-text]");
        const save = this.dialog.querySelector("[data-save]");
        area.addEventListener("input", () => {
            save.disabled = area.value.replace(/\s/g, "").length < this.minimumCharacters;
        });
        for (const selector of ["[data-close]", "[data-skip]"]) {
            this.dialog.querySelector(selector).addEventListener("click", () => this.close());
        }
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (save.disabled) return;
            save.disabled = true;
            try {
                await this.onSave(this.session, area.value);
                this.close();
            } finally {
                save.disabled = area.value.replace(/\s/g, "").length < this.minimumCharacters;
            }
        });
    }

    isOpen() {
        return !this.dialog.classList.contains("hidden");
    }

    open(session, summary = "") {
        if (!session || this.isOpen()) return false;
        this.session = session;
        this.dialog.querySelector("[data-summary]").textContent = summary;
        const area = this.dialog.querySelector("[data-text]");
        area.value = "";
        area.dispatchEvent(new Event("input"));
        this.dialog.classList.remove("hidden");
        return true;
    }

    close() {
        this.dialog.classList.add("hidden");
        this.session = null;
    }
}
