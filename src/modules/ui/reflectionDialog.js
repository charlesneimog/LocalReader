export class ReflectionDialog {
    constructor({ minimumCharacters, onSave, onSaved }) {
        this.minimumCharacters = minimumCharacters;
        this.onSave = onSave;
        this.onSaved = onSaved;
        this.session = null;
        this.dialog = document.createElement("dialog");
        this.dialog.className =
            "rewards-dialog w-[94vw] max-w-sm rounded-xl border " +
            "border-slate-200 dark:border-slate-700 bg-background-light dark:bg-background-dark " +
            "p-4 text-left text-slate-800 dark:text-slate-200 shadow-lg";
        this.dialog.setAttribute("aria-labelledby", "reading-note-title");
        this.dialog.innerHTML = `
            <form class="grid gap-3">
                <header class="flex items-start gap-3">
                    <span class="material-symbols-outlined mt-1 text-primary" aria-hidden="true">park</span>
                    <div class="min-w-0 flex-1">
                        <h2 id="reading-note-title" class="text-sm font-bold text-slate-900 dark:text-slate-100">Tree planted</h2>
                        <p data-summary class="mt-1 text-xs text-slate-500 dark:text-slate-400"></p>
                    </div>
                </header>
                <label class="grid gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                    Write what you were reading
                    <textarea rows="4" data-text required placeholder="What did you read during these five minutes?"
                        class="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-slate-800 dark:text-slate-200 outline-none focus:ring-2 focus:ring-primary"></textarea>
                </label>
                <p class="text-xs text-slate-500 dark:text-slate-400">
                    This paragraph is required. Write at least ${this.minimumCharacters} non-space characters to continue reading.
                </p>
                <footer class="flex justify-end gap-2">
                    <button type="submit" data-save disabled
                        class="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-white">Save and continue</button>
                </footer>
            </form>`;
        document.body.appendChild(this.dialog);
        this.dialog.addEventListener("cancel", (event) => event.preventDefault());

        const form = this.dialog.querySelector("form");
        const area = this.dialog.querySelector("[data-text]");
        const save = this.dialog.querySelector("[data-save]");
        area.addEventListener("input", () => {
            save.disabled = area.value.replace(/\s/g, "").length < this.minimumCharacters;
        });
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (save.disabled) return;
            save.disabled = true;
            try {
                const session = this.session;
                const saved = await this.onSave(session, area.value);
                if (!saved) return;
                this.close();
                await this.onSaved?.(session, saved);
            } finally {
                save.disabled = area.value.replace(/\s/g, "").length < this.minimumCharacters;
            }
        });
    }

    isOpen() {
        return this.dialog.open;
    }

    open(session, summary = "") {
        if (!session || this.isOpen()) return false;
        this.session = session;
        this.dialog.querySelector("[data-summary]").textContent = summary;
        const area = this.dialog.querySelector("[data-text]");
        area.value = "";
        area.dispatchEvent(new Event("input"));
        this.dialog.showModal();
        area.focus();
        return true;
    }

    close() {
        if (this.dialog.open) this.dialog.close();
        this.session = null;
    }
}
