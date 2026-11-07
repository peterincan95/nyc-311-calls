import { useEffect, useRef, useState, type PointerEvent } from "react";

/** A rectangle on a plot, as shares of the plot's width and height from its top left. */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface DragStart {
  pointer: number;
  x: number;
  y: number;
}

// Shorter drags are slips of the mouse, not boxes.
const MIN_DRAG_PIXELS = 4;

export const clampShare = (share: number) => Math.min(1, Math.max(0, share));

/** Lets the user drag out a box on a plot. Escape abandons the drag. */
export function useBoxDraw(onDraw: (box: Box) => void) {
  const start = useRef<DragStart | null>(null);
  const [draft, setDraft] = useState<Box | null>(null);

  const isDragging = draft !== null;
  useEffect(() => {
    if (!isDragging) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      start.current = null;
      setDraft(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isDragging]);

  const boxTo = (event: PointerEvent<HTMLElement>, { x, y }: DragStart): Box => {
    const { left, top, width, height } = event.currentTarget.getBoundingClientRect();
    const shareX = (clientX: number) => clampShare((clientX - left) / width);
    const shareY = (clientY: number) => clampShare((clientY - top) / height);
    const [fromX, toX] = [shareX(x), shareX(event.clientX)];
    const [fromY, toY] = [shareY(y), shareY(event.clientY)];
    return {
      left: Math.min(fromX, toX),
      right: Math.max(fromX, toX),
      top: Math.min(fromY, toY),
      bottom: Math.max(fromY, toY),
    };
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (start.current || event.button !== 0) return;
    // The axis labels sit outside the plot but are part of its element.
    const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
    const { clientX: x, clientY: y } = event;
    if (x < left || x > right || y < top || y > bottom) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { pointer: event.pointerId, x, y };
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (start.current?.pointer === event.pointerId) setDraft(boxTo(event, start.current));
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const current = start.current;
    if (current?.pointer !== event.pointerId) return;
    start.current = null;
    setDraft(null);
    const moved = Math.max(
      Math.abs(event.clientX - current.x),
      Math.abs(event.clientY - current.y),
    );
    if (moved >= MIN_DRAG_PIXELS) onDraw(boxTo(event, current));
  };

  const onPointerCancel = (event: PointerEvent<HTMLElement>) => {
    if (start.current?.pointer !== event.pointerId) return;
    start.current = null;
    setDraft(null);
  };

  return { draft, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } };
}

export function BoxOutline({ box, draft = false }: { box: Box; draft?: boolean }) {
  const { left, right, top, bottom } = box;
  return (
    <div
      className={draft ? "box draft" : "box"}
      style={{
        left: `${left * 100}%`,
        top: `${top * 100}%`,
        width: `${(right - left) * 100}%`,
        height: `${(bottom - top) * 100}%`,
      }}
    />
  );
}
