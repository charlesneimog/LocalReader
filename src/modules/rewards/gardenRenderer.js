import { getPlantDefinition, getPlantStage } from "./plantDefinitions.js";

/** Serializable, read-only Canvas projection of a garden plot. */
export class GardenRenderer {
    constructor(canvas, { onSelect = null } = {}) {
        this.canvas = canvas;
        this.context = canvas.getContext("2d");
        this.onSelect = onSelect;
        this.data = null;
        this.selectedIndex = 0;
        this.hitAreas = [];
        this.imageCache = new Map();
        this.resizeObserver = typeof ResizeObserver === "function"
            ? new ResizeObserver(() => this.render(this.data))
            : null;
        this.resizeObserver?.observe(canvas);
        canvas.tabIndex = 0;
        canvas.setAttribute("role", "grid");
        canvas.addEventListener("pointermove", (event) => this._handlePointer(event, false));
        canvas.addEventListener("click", (event) => this._handlePointer(event, true));
        canvas.addEventListener("keydown", (event) => this._handleKey(event));
    }

    render(data) {
        if (!data?.plot) return;
        this.data = data;
        const { canvas, context } = this;
        const rect = canvas.getBoundingClientRect();
        const cssWidth = Math.max(320, rect.width || 640);
        const tileWidth = Math.max(44, Math.min(86, cssWidth / (data.plot.columns + data.plot.rows)));
        const tileHeight = tileWidth * 0.52;
        const originY = 112;
        const maximumDepth = Math.max(0, data.plot.columns + data.plot.rows - 2);
        const cssHeight = Math.max(
            260,
            originY + maximumDepth * tileHeight / 2 + tileHeight / 2 + 32,
        );
        const ratio = Math.max(1, globalThis.devicePixelRatio || 1);
        canvas.width = Math.round(cssWidth * ratio);
        canvas.height = Math.round(cssHeight * ratio);
        canvas.style.height = `${cssHeight}px`;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, cssWidth, cssHeight);

        const originX = cssWidth / 2;
        this.hitAreas = [];
        const plantsByCell = new Map(
            data.plants.filter((plant) => plant.cell).map((plant) => [`${plant.cell.x}:${plant.cell.y}`, plant]),
        );
        const cells = [];
        for (let y = 0; y < data.plot.rows; y++) {
            for (let x = 0; x < data.plot.columns; x++) {
                cells.push({ x, y, depth: x + y });
            }
        }
        cells.sort((left, right) => left.depth - right.depth || left.y - right.y || left.x - right.x);
        for (const cell of cells) {
            const screen = this._screen(cell.x, cell.y, originX, originY, tileWidth, tileHeight);
            this._drawTile(screen.x, screen.y, tileWidth, tileHeight, cell);
            const plant = plantsByCell.get(`${cell.x}:${cell.y}`);
            if (plant) this._drawPlant(screen.x, screen.y, tileWidth, tileHeight, plant);
            this.hitAreas.push({
                cell,
                plant,
                x: screen.x - tileWidth / 2,
                y: screen.y - tileHeight / 2,
                width: tileWidth,
                height: tileHeight + 60,
            });
        }
        this._drawSelection(originX, originY, tileWidth, tileHeight);
    }

    destroy() {
        this.resizeObserver?.disconnect();
    }

    _screen(gridX, gridY, originX, originY, tileWidth, tileHeight) {
        return {
            x: originX + (gridX - gridY) * tileWidth / 2,
            y: originY + (gridX + gridY) * tileHeight / 2,
        };
    }

    _drawTile(x, y, width, height, cell) {
        const context = this.context;
        context.beginPath();
        context.moveTo(x, y - height / 2);
        context.lineTo(x + width / 2, y);
        context.lineTo(x, y + height / 2);
        context.lineTo(x - width / 2, y);
        context.closePath();
        context.fillStyle = (cell.x + cell.y) % 2 ? "#78b879" : "#83c482";
        context.fill();
        context.strokeStyle = "rgba(36, 82, 54, .35)";
        context.lineWidth = 1;
        context.stroke();
    }

    _drawPlant(x, y, tileWidth, tileHeight, plant) {
        const context = this.context;
        const definition = getPlantDefinition(plant.speciesId);
        const stage = getPlantStage(plant.speciesId, plant.pointsInvested, plant.growthProgress);
        const scale = 0.3 + stage.progress * 0.7;
        // Keep the planting point just below the cell center. SVGs include
        // padding below their shadow, so the configured shadow line—not the
        // image bounding box—is aligned to this subtle offset.
        const baseY = y + tileHeight * 0.18;
        context.save();
        context.translate(x, baseY);
        context.scale(scale, scale);
        context.lineCap = "round";
        if (stage.id === "seed") {
            context.fillStyle = "#6d4c35";
            context.beginPath();
            context.ellipse(0, -4, 5, 3, -0.35, 0, Math.PI * 2);
            context.fill();
            context.restore();
            return;
        }
        const treeImage = this._getTreeImage(definition.image);
        if (treeImage?.complete && treeImage.naturalWidth > 0) {
            const drawWidth = 90;
            const drawHeight = 105;
            const groundAnchor = Math.max(
                0.5,
                Math.min(1, Number(definition.groundAnchor) || 0.92),
            );
            context.drawImage(
                treeImage,
                -drawWidth / 2,
                -drawHeight * groundAnchor,
                drawWidth,
                drawHeight,
            );
            context.restore();
            return;
        }
        const stems = definition.id === "fern" ? 5 : definition.id === "flowering-tree" ? 1 : 3;
        context.strokeStyle = definition.palette[2];
        context.lineWidth = definition.id === "flowering-tree" ? 7 : 3;
        for (let index = 0; index < stems; index++) {
            const offset = (index - (stems - 1) / 2) * 7;
            context.beginPath();
            context.moveTo(0, 0);
            context.quadraticCurveTo(offset * 0.4, -22, offset, -42 - (index % 2) * 7);
            context.stroke();
            context.fillStyle = definition.palette[2];
            context.beginPath();
            context.ellipse(offset * 0.5 + 5, -22, 8, 3.5, -0.55, 0, Math.PI * 2);
            context.fill();
        }
        if (["flowering", "mature"].includes(stage.id)) {
            const blossomCount = definition.id === "flowering-tree" ? 9 : stage.id === "mature" ? 7 : 3;
            for (let index = 0; index < blossomCount; index++) {
                const angle = (index / blossomCount) * Math.PI * 2;
                const radius = definition.id === "flowering-tree" ? 20 : 12;
                const bx = Math.cos(angle) * radius;
                const by = -44 + Math.sin(angle) * radius * 0.55;
                this._drawBlossom(bx, by, definition.palette[0], definition.palette[1]);
            }
        }
        context.restore();
    }

    _getTreeImage(source) {
        if (!source || typeof Image !== "function") return null;
        if (this.imageCache.has(source)) return this.imageCache.get(source);
        const image = new Image();
        image.decoding = "async";
        image.onload = () => this.render(this.data);
        image.onerror = () => console.warn("[GardenRenderer] Unable to load tree image", source);
        image.src = source;
        this.imageCache.set(source, image);
        return image;
    }

    _drawBlossom(x, y, petal, center) {
        const context = this.context;
        context.fillStyle = petal;
        for (let index = 0; index < 5; index++) {
            const angle = index * Math.PI * 0.4;
            context.beginPath();
            context.ellipse(x + Math.cos(angle) * 5, y + Math.sin(angle) * 5, 4.5, 3, angle, 0, Math.PI * 2);
            context.fill();
        }
        context.fillStyle = center;
        context.beginPath();
        context.arc(x, y, 3, 0, Math.PI * 2);
        context.fill();
    }

    _drawSelection(originX, originY, tileWidth, tileHeight) {
        const area = this.hitAreas[this.selectedIndex];
        if (!area) return;
        const screen = this._screen(area.cell.x, area.cell.y, originX, originY, tileWidth, tileHeight);
        this.context.strokeStyle = "#153d2d";
        this.context.lineWidth = 3;
        this.context.beginPath();
        this.context.moveTo(screen.x, screen.y - tileHeight / 2);
        this.context.lineTo(screen.x + tileWidth / 2, screen.y);
        this.context.lineTo(screen.x, screen.y + tileHeight / 2);
        this.context.lineTo(screen.x - tileWidth / 2, screen.y);
        this.context.closePath();
        this.context.stroke();
    }

    _handlePointer(event, select) {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const index = this.hitAreas.findIndex(
            (area) => x >= area.x && x <= area.x + area.width && y >= area.y - 60 && y <= area.y + area.height,
        );
        if (index < 0) return;
        this.selectedIndex = index;
        this.canvas.title = this._label(this.hitAreas[index]);
        if (select) this.onSelect?.(this.hitAreas[index]);
        this.render(this.data);
    }

    _handleKey(event) {
        const columns = this.data?.plot?.columns || 1;
        const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
        if (delta) {
            event.preventDefault();
            this.selectedIndex = Math.max(0, Math.min(this.hitAreas.length - 1, this.selectedIndex + delta));
            this.canvas.setAttribute("aria-label", this._label(this.hitAreas[this.selectedIndex]));
            this.render(this.data);
        } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.onSelect?.(this.hitAreas[this.selectedIndex]);
        }
    }

    _label(area) {
        if (!area?.plant) return `Empty garden cell, column ${area.cell.x + 1}, row ${area.cell.y + 1}`;
        const definition = getPlantDefinition(area.plant.speciesId);
        const stage = getPlantStage(
            area.plant.speciesId,
            area.plant.pointsInvested,
            area.plant.growthProgress,
        );
        return `${definition.name}, ${stage.label}, column ${area.cell.x + 1}, row ${area.cell.y + 1}`;
    }
}
