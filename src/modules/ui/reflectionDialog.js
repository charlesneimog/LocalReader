export class ReflectionDialog {
    constructor({ minimumCharacters, onSave }) {
        this.minimumCharacters = minimumCharacters;
        this.onSave = onSave;
        this.session = null;
        this.dialog = document.createElement("dialog");
        this.dialog.className =
            "rewards-dialog w-[94vw] max-w-xl max-h-[88vh] p-0 rounded-xl border border-slate-200 " +
            "dark:border-slate-700 bg-background-light dark:bg-background-dark text-slate-800 " +
            "dark:text-slate-200 shadow-2xl";
        this.dialog.innerHTML = `
            <form method="dialog" class="grid gap-4 p-4 sm:p-6 overflow-y-auto max-h-[88vh]">
                <header class="flex items-start justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-700">
                    <div>
                        <h2 class="text-xl font-bold text-slate-900 dark:text-slate-100">Reading reflection</h2>
                        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">A short optional note for this session.</p>
                    </div>
                    <button value="cancel" aria-label="Close"
                        class="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors">
                        <span class="material-symbols-outlined" aria-hidden="true">close</span>
                    </button>
                </header>
                <div class="rounded-lg bg-primary/10 p-3 text-sm text-slate-700 dark:text-slate-200" data-summary></div>
                <p class="text-sm text-slate-600 dark:text-slate-300">Optional: capture one useful thought from this session.</p>
                <label class="grid gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                    Reflection
                    <textarea rows="6" data-text
                        class="w-full min-h-[96px] rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-gray-900 px-3 py-2 text-slate-800 dark:text-slate-200 outline-none focus:ring-2 focus:ring-primary"></textarea>
                </label>
                <small data-count class="text-xs text-slate-500 dark:text-slate-400"></small>
                <footer class="flex items-center justify-end gap-2">
                    <button value="cancel"
                        class="rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/5 transition-colors">Not now</button>
                    <button type="button" data-save
                        class="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary/90 transition-colors">Save reflection</button>
                </footer>
            </form>`;
        document.body.appendChild(this.dialog);
        const area = this.dialog.querySelector("[data-text]");
        const count = this.dialog.querySelector("[data-count]");
        const update = () => {
            const meaningful = area.value.replace(/\s/g, "").length;
            count.textContent = `${meaningful} of ${this.minimumCharacters} meaningful characters`;
            this.dialog.querySelector("[data-save]").disabled = meaningful < this.minimumCharacters;
        };
        area.addEventListener("input", update);
        this.dialog.querySelector("[data-save]").addEventListener("click", async () => {
            await this.onSave(this.session, area.value);
            this.dialog.close();
        });
        update();
    }

    open(session, summary = "") {
        this.session = session;
        this.dialog.querySelector("[data-summary]").textContent = summary;
        this.dialog.querySelector("[data-text]").value = "";
        this.dialog.querySelector("[data-text]").dispatchEvent(new Event("input"));
        this.dialog.showModal();
    }
}
