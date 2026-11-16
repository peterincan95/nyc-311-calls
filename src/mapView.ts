import type { Boundaries, Meta, Streets } from "./data";
import type { Box } from "./box";
import { isHome, PanZoom } from "./panZoom";
import { MAP_MAX_ZOOM, mapFill, type CallRenderer } from "./renderer";
import { GRID_MAX, WHOLE_CITY, type Area } from "./selection";

const MAX_PIXEL_RATIO = 2;

const BOROUGH_LINE = "rgb(255 255 255 / 34%)";
const BOROUGH_LINE_WIDTH = 2;
const NEIGHBORHOOD_LINE_WIDTH = 2;
const BOX_LINE = "#e8e8e8";
// Neighborhood lines fade in between these zooms.
const NEIGHBORHOOD_FADE = [1.4, 3];
const NEIGHBORHOOD_OPACITY = 0.2;

// Labels appear once zoomed this far, and once their area is this wide on screen.
const LABEL_MIN_ZOOM = 4;
const LABEL_MIN_WIDTH = 70;
const LABEL_MAX_CHARACTERS = 20;
const LABEL_LINE_HEIGHT = 14;
const LABEL_GAP = 4;
const LABEL_COLOR = "#cfcfcf";
const LABEL_FONT = '13px "IBM Plex Sans Condensed", sans-serif';
const LABEL_ITALIC_FONT = `italic ${LABEL_FONT}`;
// Neighborhood names fade out between these zooms as street names take over.
const NEIGHBORHOOD_LABEL_FADE = [8, 11];

// Street names appear once zoomed this far, by tier: highways, major roads, local streets.
const STREET_LABEL_ZOOMS = [3, 5, 9];
const STREET_LABEL_MAX = 150;
const STREET_LABEL_FONT = '12px "IBM Plex Sans Condensed", sans-serif';
const STREET_LABEL_COLOR = "#c4c4c4";
const STREET_LABEL_HALF_HEIGHT = 7;
// Room left along the street past each end of a name, so it doesn't run off a bend.
const STREET_LABEL_ROOM = 8;
// The closest the same name repeats, in pixels.
const STREET_NAME_REPEAT = 240;

interface ScreenBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const overlapsAny = (box: ScreenBox, placed: ScreenBox[]) =>
  placed.some(
    (other) =>
      box.left < other.right &&
      box.right > other.left &&
      box.top < other.bottom &&
      box.bottom > other.top,
  );

interface Label {
  lines: string[];
  x: number;
  y: number;
  size: number;
  font: string;
  /** Widest line, once measured with the loaded font. */
  width: number;
}

/** Breaks a name at its hyphens to keep lines short. */
function wrapName(name: string) {
  const lines: string[] = [];
  for (const [index, part] of name.split("-").entries()) {
    const piece = index === 0 ? part : `-${part}`;
    const last = lines[lines.length - 1];
    if (last && last.length + piece.length <= LABEL_MAX_CHARACTERS) {
      lines[lines.length - 1] = last + piece;
    } else if (last) {
      lines[lines.length - 1] = `${last}-`;
      lines.push(part);
    } else {
      lines.push(part);
    }
  }
  return lines;
}

function ringsToPath(rings: number[][], aspect: number) {
  const path = new Path2D();
  for (const ring of rings) {
    path.moveTo((ring[0]! / GRID_MAX) * aspect, ring[1]! / GRID_MAX);
    for (let index = 2; index < ring.length; index += 2) {
      path.lineTo((ring[index]! / GRID_MAX) * aspect, ring[index + 1]! / GRID_MAX);
    }
    path.closePath();
  }
  return path;
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/**
 * The map's camera: pans and zooms with the pointer, tells the renderer where to
 * draw the calls, and draws the boundaries, labels and box on a canvas above them.
 */
export class MapView {
  private view: PanZoom;
  private width = 1;
  private height = 1;
  private fill: [number, number] = [1, 1];
  private pixelRatio = 1;
  private area = WHOLE_CITY;
  private frame = 0;
  private showLabels = true;
  private context: CanvasRenderingContext2D;
  private aspect: number;
  private boroughs: Path2D;
  private neighborhoods: Path2D;
  private labels: Label[];
  private streets: Streets | null = null;
  private showStreets = true;
  private showNeighborhoods = false;
  /** Each street name's width, measured when first drawn. Negative until then. */
  private streetNameWidths = new Float32Array(0);

  constructor(
    plot: HTMLElement,
    private canvas: HTMLCanvasElement,
    renderer: CallRenderer,
    private bounds: Meta["bounds"],
    boundaries: Boundaries,
    onMovedChange: (isMoved: boolean) => void,
  ) {
    this.context = canvas.getContext("2d")!;
    const { lonMin, lonMax, latMin, latMax } = bounds;
    const middleLatitude = ((latMin + latMax) / 2) * (Math.PI / 180);
    this.aspect = ((lonMax - lonMin) * Math.cos(middleLatitude)) / (latMax - latMin);
    this.boroughs = ringsToPath(boundaries.boroughs, this.aspect);
    this.neighborhoods = ringsToPath(boundaries.neighborhoods, this.aspect);
    this.labels = boundaries.labels.map(({ name, x, y, size, residential }) => ({
      lines: wrapName(name),
      x: x / GRID_MAX,
      y: y / GRID_MAX,
      size,
      font: residential ? LABEL_FONT : LABEL_ITALIC_FONT,
      width: 0,
    }));

    this.view = new PanZoom(plot, -1, MAP_MAX_ZOOM, (camera) => {
      renderer.setCamera(camera);
      this.requestDraw();
      onMovedChange(!isHome(camera));
    });
    // Label widths depend on the web font.
    void document.fonts.ready.then(() => {
      this.measureLabels();
      this.streetNameWidths.fill(-1);
      this.requestDraw();
    });
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.view.destroy();
  }

  setLayout(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.fill = mapFill(this.bounds, width, height);
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    this.canvas.width = Math.max(1, Math.round(width * this.pixelRatio));
    this.canvas.height = Math.max(1, Math.round(height * this.pixelRatio));
    this.view.setLayout(width, height, this.fill);
  }

  setArea(area: Area) {
    this.area = area;
    this.requestDraw();
  }

  setStreets(streets: Streets) {
    this.streets = streets;
    this.streetNameWidths = new Float32Array(streets.names.length).fill(-1);
    this.requestDraw();
  }

  setStreetsVisible(isVisible: boolean) {
    this.showStreets = isVisible;
    this.requestDraw();
  }

  setNeighborhoodsVisible(isVisible: boolean) {
    this.showNeighborhoods = isVisible;
    this.requestDraw();
  }

  setLabelsVisible(isVisible: boolean) {
    this.showLabels = isVisible;
    this.requestDraw();
  }

  /** Panning gives way to drawing a box. */
  setPanEnabled(isEnabled: boolean) {
    this.view.setPanEnabled(isEnabled);
  }

  resetView() {
    this.view.reset();
  }

  /** The city area under a box drawn on the map. */
  boxToArea({ left, right, top, bottom }: Box) {
    const toGrid = (share: number) => Math.round(clamp(share, 0, 1) * GRID_MAX);
    return {
      west: toGrid(this.view.dataX(left)),
      east: toGrid(this.view.dataX(right)),
      south: toGrid(this.view.dataY(bottom)),
      north: toGrid(this.view.dataY(top)),
    };
  }

  private requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private measureLabels() {
    const { context } = this;
    for (const label of this.labels) {
      context.font = label.font;
      label.width = Math.max(...label.lines.map((line) => context.measureText(line).width));
    }
  }

  private draw() {
    const { context, canvas, pixelRatio, width, height, fill, aspect } = this;
    const { camera } = this.view;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);

    // City shares on screen, in pixels. Paths have x scaled by the aspect, so one scale fits both.
    const scale = height * fill[1] * camera.zoom;
    const toScreenX = (x: number) => width / 2 + (x - camera.x) * width * fill[0] * camera.zoom;
    const toScreenY = (y: number) => height / 2 - (y - camera.y) * scale;

    context.setTransform(
      scale * pixelRatio,
      0,
      0,
      -scale * pixelRatio,
      toScreenX(0) * pixelRatio,
      toScreenY(0) * pixelRatio,
    );
    context.lineJoin = "round";
    const fade = clamp(
      (camera.zoom - NEIGHBORHOOD_FADE[0]!) / (NEIGHBORHOOD_FADE[1]! - NEIGHBORHOOD_FADE[0]!),
      0,
      1,
    );
    if (fade > 0 && this.showNeighborhoods) {
      context.strokeStyle = `rgb(255 255 255 / ${fade * NEIGHBORHOOD_OPACITY})`;
      context.lineWidth = NEIGHBORHOOD_LINE_WIDTH / scale;
      context.stroke(this.neighborhoods);
    }
    context.strokeStyle = BOROUGH_LINE;
    context.lineWidth = BOROUGH_LINE_WIDTH / scale;
    context.stroke(this.boroughs);

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    if (this.showLabels) {
      // Labels placed earlier keep their space, so neighborhoods come before streets.
      const placed: ScreenBox[] = [];
      const neighborhoodOpacity =
        1 -
        clamp(
          (camera.zoom - NEIGHBORHOOD_LABEL_FADE[0]!) /
            (NEIGHBORHOOD_LABEL_FADE[1]! - NEIGHBORHOOD_LABEL_FADE[0]!),
          0,
          1,
        );
      if (this.showNeighborhoods && camera.zoom >= LABEL_MIN_ZOOM && neighborhoodOpacity > 0) {
        this.drawLabels(toScreenX, toScreenY, scale, aspect, placed, neighborhoodOpacity);
      }
      if (this.streets && this.showStreets) this.drawStreetLabels(toScreenX, toScreenY, scale, placed);
    }
    this.drawBox(toScreenX, toScreenY);
  }

  /** Larger areas come first, and a label that would overlap one already placed is skipped. */
  private drawLabels(
    toScreenX: (x: number) => number,
    toScreenY: (y: number) => number,
    scale: number,
    aspect: number,
    placed: ScreenBox[],
    opacity: number,
  ) {
    const { context, width, height } = this;
    // Fading labels stop holding their space halfway out, so street names can move in.
    const ownSpace: ScreenBox[] = [];
    context.globalAlpha = opacity;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.lineWidth = 3;
    context.strokeStyle = "rgb(0 0 0 / 80%)";
    context.fillStyle = LABEL_COLOR;

    for (const label of this.labels) {
      if (label.size * scale * aspect < LABEL_MIN_WIDTH) continue;
      const x = toScreenX(label.x);
      const y = toScreenY(label.y);
      const halfWidth = label.width / 2 + LABEL_GAP;
      const halfHeight = (label.lines.length * LABEL_LINE_HEIGHT) / 2 + LABEL_GAP;
      const box = {
        left: x - halfWidth,
        right: x + halfWidth,
        top: y - halfHeight,
        bottom: y + halfHeight,
      };
      if (box.right < 0 || box.left > width || box.bottom < 0 || box.top > height) continue;
      if (overlapsAny(box, ownSpace)) continue;
      ownSpace.push(box);
      if (opacity >= 0.5) placed.push(box);

      context.font = label.font;
      label.lines.forEach((line, index) => {
        const lineY = y + (index - (label.lines.length - 1) / 2) * LABEL_LINE_HEIGHT;
        context.strokeText(line, x, lineY);
        context.fillText(line, x, lineY);
      });
    }
    context.globalAlpha = 1;
  }

  /**
   * Names streets along their direction. Spots come most important first, and a name
   * is skipped if it won't fit its stretch of street, would overlap a label already
   * placed, or would repeat too close to the same name.
   */
  private drawStreetLabels(
    toScreenX: (x: number) => number,
    toScreenY: (y: number) => number,
    scale: number,
    placed: ScreenBox[],
  ) {
    const { context, width, height, fill, pixelRatio, streetNameWidths } = this;
    const { anchors, reach, anchorCount, names } = this.streets!;
    const { zoom } = this.view.camera;
    const xScale = (width * fill[0] * zoom) / GRID_MAX;
    const yScale = scale / GRID_MAX;
    const shownByName = new Map<number, { x: number; y: number }[]>();
    let count = 0;

    context.font = STREET_LABEL_FONT;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.lineWidth = 3;
    context.strokeStyle = "rgb(0 0 0 / 80%)";
    context.fillStyle = STREET_LABEL_COLOR;

    for (let index = 0; index < anchorCount && count < STREET_LABEL_MAX; index += 1) {
      const tier = anchors[index * 4 + 3]!;
      // Spots run in tier order, so the rest are too far out as well.
      if (zoom < STREET_LABEL_ZOOMS[tier - 1]!) break;
      const x = toScreenX(anchors[index * 4]! / GRID_MAX);
      const y = toScreenY(anchors[index * 4 + 1]! / GRID_MAX);
      if (x < -200 || x > width + 200 || y < -200 || y > height + 200) continue;

      const reachX = reach[index * 2]! * xScale;
      const reachY = -reach[index * 2 + 1]! * yScale;
      const name = anchors[index * 4 + 2]!;
      let textWidth = streetNameWidths[name]!;
      if (textWidth < 0) {
        textWidth = context.measureText(names[name]!).width;
        streetNameWidths[name] = textWidth;
      }
      if (textWidth + 2 * STREET_LABEL_ROOM > 2 * Math.hypot(reachX, reachY)) continue;

      // Turned to run along the street, but never upside down.
      let angle = Math.atan2(reachY, reachX);
      if (angle > Math.PI / 2) angle -= Math.PI;
      else if (angle < -Math.PI / 2) angle += Math.PI;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const halfWidth = textWidth / 2 + LABEL_GAP;
      const halfHeight = STREET_LABEL_HALF_HEIGHT + LABEL_GAP;
      const spanX = halfWidth * Math.abs(cos) + halfHeight * Math.abs(sin);
      const spanY = halfWidth * Math.abs(sin) + halfHeight * Math.abs(cos);
      const box = { left: x - spanX, right: x + spanX, top: y - spanY, bottom: y + spanY };
      if (box.right < 0 || box.left > width || box.bottom < 0 || box.top > height) continue;
      if (overlapsAny(box, placed)) continue;
      const shown = shownByName.get(name) ?? [];
      if (shown.some((other) => Math.hypot(other.x - x, other.y - y) < STREET_NAME_REPEAT)) continue;

      placed.push(box);
      shown.push({ x, y });
      shownByName.set(name, shown);
      count += 1;
      context.setTransform(
        pixelRatio * cos,
        pixelRatio * sin,
        -pixelRatio * sin,
        pixelRatio * cos,
        pixelRatio * x,
        pixelRatio * y,
      );
      context.strokeText(names[name]!, 0, 0);
      context.fillText(names[name]!, 0, 0);
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  private drawBox(toScreenX: (x: number) => number, toScreenY: (y: number) => number) {
    const { context, area } = this;
    const isWholeCity =
      area.west === WHOLE_CITY.west &&
      area.east === WHOLE_CITY.east &&
      area.south === WHOLE_CITY.south &&
      area.north === WHOLE_CITY.north;
    if (isWholeCity) return;
    const left = toScreenX(area.west / GRID_MAX);
    const right = toScreenX(area.east / GRID_MAX);
    const top = toScreenY(area.north / GRID_MAX);
    const bottom = toScreenY(area.south / GRID_MAX);
    context.strokeStyle = BOX_LINE;
    context.lineWidth = 1;
    context.strokeRect(left, top, right - left, bottom - top);
  }
}
