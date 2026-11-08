import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

export interface Visuals {
  /** 0 to 100, where 50 leaves the brightness the app picks. */
  opacity: number;
  colorByBorough: boolean;
}

export const DEFAULT_VISUALS: Visuals = { opacity: 50, colorByBorough: false };

interface VisualOptionsProps {
  visuals: Visuals;
  onChange: (visuals: Visuals) => void;
}

/** A button on the map that opens a small menu of options for how points are drawn. */
export function VisualOptions({ visuals, onChange }: VisualOptionsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!isOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [isOpen]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !isOpen) return;
    event.stopPropagation();
    setIsOpen(false);
    button.current?.focus();
  };

  return (
    <div className="visual-options" ref={root} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="pill pill-icon"
        ref={button}
        aria-label="Visualization options"
        title="Visualization options"
        aria-expanded={isOpen}
        aria-controls={`${id}-menu`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 4.5h11M2.5 11.5h11" />
          <circle cx="10.5" cy="4.5" r="1.8" className="knob" />
          <circle cx="5.5" cy="11.5" r="1.8" className="knob" />
        </svg>
      </button>

      {isOpen && (
        <div className="visual-menu" id={`${id}-menu`} role="group" aria-label="Visualization options">
          <div className="visual-row">
            <label htmlFor={`${id}-opacity`}>Point opacity</label>
            <output htmlFor={`${id}-opacity`}>{visuals.opacity}%</output>
          </div>
          <input
            type="range"
            className="visual-slider"
            id={`${id}-opacity`}
            min={0}
            max={100}
            step={1}
            value={visuals.opacity}
            aria-valuetext={
              visuals.opacity === DEFAULT_VISUALS.opacity ? "50%, the default" : `${visuals.opacity}%`
            }
            onChange={(event) => onChange({ ...visuals, opacity: Number(event.target.value) })}
          />
          {/* Sits with the slider, since it only resets the opacity. */}
          <button
            type="button"
            className="pill visual-reset"
            aria-label="Reset point opacity"
            disabled={visuals.opacity === DEFAULT_VISUALS.opacity}
            onClick={() => onChange({ ...visuals, opacity: DEFAULT_VISUALS.opacity })}
          >
            Reset
          </button>

          <button
            type="button"
            className="visual-switch"
            role="switch"
            aria-checked={visuals.colorByBorough}
            onClick={() => onChange({ ...visuals, colorByBorough: !visuals.colorByBorough })}
          >
            <span>Color by borough</span>
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb" />
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
