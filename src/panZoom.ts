import { MAX_ZOOM, type Camera } from "./renderer";

export const HOME: Camera = { zoom: 1, x: 0.5, y: 0.5 };
// How far past its edges the data can be panned, as a share of its size.
const PAN_MARGIN = 0.12;

// Zoom change per pixel of wheel movement. Trackpad pinches report far smaller steps.
const WHEEL_SPEED = 0.002;
const PINCH_WHEEL_SPEED = 0.012;
const LINE_HEIGHT_PIXELS = 16;

interface Pointer {
  x: number;
  y: number;
}

export const isHome = ({ zoom, x, y }: Camera) =>
  zoom === HOME.zoom && x === HOME.x && y === HOME.y;

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/**
 * A plot's camera, moved by the wheel, by dragging and by pinching. The camera's
 * `x` and `y` are the share of the data at the plot's center.
 */
export class PanZoom {
  camera = HOME;
  private width = 1;
  private height = 1;
  private fill: readonly [number, number] = [1, 1];
  private isEnabled = true;
  private pointers = new Map<number, Pointer>();

  /** `yDirection` is 1 if the data's y runs down the plot, and -1 if it runs up. */
  constructor(
    private plot: HTMLElement,
    private yDirection: 1 | -1,
    private onChange: (camera: Camera) => void,
  ) {
    plot.addEventListener("wheel", this.onWheel, { passive: false });
    plot.addEventListener("pointerdown", this.onPointerDown);
    plot.addEventListener("pointermove", this.onPointerMove);
    plot.addEventListener("pointerup", this.onPointerEnd);
    plot.addEventListener("pointercancel", this.onPointerEnd);
  }

  destroy() {
    this.plot.removeEventListener("wheel", this.onWheel);
    this.plot.removeEventListener("pointerdown", this.onPointerDown);
    this.plot.removeEventListener("pointermove", this.onPointerMove);
    this.plot.removeEventListener("pointerup", this.onPointerEnd);
    this.plot.removeEventListener("pointercancel", this.onPointerEnd);
  }

  /** `fill` is how much of the plot's width and height the data covers at the home view. */
  setLayout(width: number, height: number, fill: readonly [number, number]) {
    this.width = width;
    this.height = height;
    this.fill = fill;
    this.moveTo(this.camera);
  }

  /** Panning gives way to drawing a box. */
  setPanEnabled(isEnabled: boolean) {
    this.isEnabled = isEnabled;
    this.pointers.clear();
    this.plot.classList.remove("panning");
  }

  reset() {
    this.moveTo(HOME);
  }

  /** The share of the data under a share of the plot's width. */
  dataX(share: number) {
    const { x, zoom } = this.camera;
    return x + (share - 0.5) / (this.fill[0] * zoom);
  }

  /** The share of the data under a share of the plot's height, from its top. */
  dataY(share: number) {
    const { y, zoom } = this.camera;
    return y + (this.yDirection * (share - 0.5)) / (this.fill[1] * zoom);
  }

  /** Keeps the data in view: its edges can only move a little inside the plot's edges. */
  private limited({ zoom, x, y }: Camera): Camera {
    const limit = (center: number, fill: number) => {
      const halfView = Math.min(0.5 / (fill * zoom), 0.5);
      return clamp(center, halfView - PAN_MARGIN, 1 - halfView + PAN_MARGIN);
    };
    return { zoom, x: limit(x, this.fill[0]), y: limit(y, this.fill[1]) };
  }

  private moveTo(camera: Camera) {
    this.camera = this.limited(camera);
    this.onChange(this.camera);
  }

  /** Zooms while keeping the data under a point on the plot still. */
  private zoomAround(shareX: number, shareY: number, factor: number) {
    const zoom = clamp(this.camera.zoom * factor, 1, MAX_ZOOM);
    const dataX = this.dataX(shareX);
    const dataY = this.dataY(shareY);
    this.moveTo({
      zoom,
      x: dataX - (shareX - 0.5) / (this.fill[0] * zoom),
      y: dataY - (this.yDirection * (shareY - 0.5)) / (this.fill[1] * zoom),
    });
  }

  private share(x: number, y: number) {
    const { left, top } = this.plot.getBoundingClientRect();
    return [(x - left) / this.width, (y - top) / this.height] as const;
  }

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const pixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? event.deltaY * LINE_HEIGHT_PIXELS
      : event.deltaY;
    const speed = event.ctrlKey ? PINCH_WHEEL_SPEED : WHEEL_SPEED;
    const [shareX, shareY] = this.share(event.clientX, event.clientY);
    this.zoomAround(shareX, shareY, Math.exp(-pixels * speed));
  };

  private onPointerDown = (event: PointerEvent) => {
    if (!this.isEnabled || event.button !== 0) return;
    // A plot's axis labels sit outside it but can be part of its element.
    const { left, right, top, bottom } = this.plot.getBoundingClientRect();
    const { clientX: x, clientY: y } = event;
    if (x < left || x > right || y < top || y > bottom) return;
    event.preventDefault();
    this.plot.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x, y });
    this.plot.classList.add("panning");
  };

  private onPointerMove = (event: PointerEvent) => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    const next = { x: event.clientX, y: event.clientY };
    const other = [...this.pointers].find(([id]) => id !== event.pointerId)?.[1];

    if (other) {
      // Two fingers: follow the middle of the pinch and the distance between them.
      const before = Math.hypot(pointer.x - other.x, pointer.y - other.y);
      const after = Math.hypot(next.x - other.x, next.y - other.y);
      const [shareX, shareY] = this.share((next.x + other.x) / 2, (next.y + other.y) / 2);
      if (before > 0) this.zoomAround(shareX, shareY, after / before);
    }
    const { zoom, x, y } = this.camera;
    // Each finger moves the middle of a pinch by half its own movement.
    const weight = other ? 0.5 : 1;
    const moveY = ((next.y - pointer.y) * weight) / (this.height * this.fill[1] * zoom);
    this.moveTo({
      zoom,
      x: x - ((next.x - pointer.x) * weight) / (this.width * this.fill[0] * zoom),
      y: y - this.yDirection * moveY,
    });
    this.pointers.set(event.pointerId, next);
  };

  private onPointerEnd = (event: PointerEvent) => {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size === 0) this.plot.classList.remove("panning");
  };
}
