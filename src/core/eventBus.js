export class EventBus {
    constructor() {
        this.listeners = new Map();
    }
    emit(event, data) {
        const handlers = this.listeners.get(event) || [];
        handlers.forEach(h => {
            try { h(data); } catch (e) { console.warn('Event handler error', event, e); }
        });
    }
    on(event, handler) {
        if (!this.listeners.has(event)) this.listeners.set(event, []);
        this.listeners.get(event).push(handler);
        return () => {
            const arr = this.listeners.get(event);
            if (!arr) return;
            const i = arr.indexOf(handler);
            if (i >= 0) arr.splice(i, 1);
        };
    }
}