import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { DEFAULT_OPACITY } from "./OpacitySlider";
import { DEFAULT_GRADIENT, gradientStops } from "./renderer";

export interface Visuals {
  /** 0 to 100 for each plot, where 50 leaves the brightness the app picks. */
  mapOpacity: number;
  chartOpacity: number;
  colorByBorough: boolean;
  streets: boolean;
  neighborhoods: boolean;
  /** The points' gradient colors after black, from the sparsest areas to the densest. */
  gradient: readonly string[];
}

export const DEFAULT_VISUALS: Visuals = {
  mapOpacity: DEFAULT_OPACITY,
  chartOpacity: DEFAULT_OPACITY,
  colorByBorough: false,
  streets: true,
  neighborhoods: false,
  gradient: DEFAULT_GRADIENT,
};

const isDefaultGradient = (gradient: readonly string[]) =>
  gradient.every((color, index) => color === DEFAULT_GRADIENT[index]);

interface VisualOptionsProps {
  visuals: Visuals;
  onChange: (visuals: Visuals) => void;
}

/** A button on the map that opens a small menu of options for what the plots show. */
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

          <button
            type="button"
            className="visual-switch"
            role="switch"
            aria-checked={visuals.streets}
            onClick={() => onChange({ ...visuals, streets: !visuals.streets })}
          >
            <span>Streets</span>
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb" />
            </span>
          </button>

          <button
            type="button"
            className="visual-switch"
            role="switch"
            aria-checked={visuals.neighborhoods}
            onClick={() => onChange({ ...visuals, neighborhoods: !visuals.neighborhoods })}
          >
            <span>Neighborhoods</span>
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb" />
            </span>
          </button>

          <div className="gradient-editor" role="group" aria-labelledby={`${id}-gradient`}>
            <div className="gradient-heading">
              <span id={`${id}-gradient`}>Gradient</span>
              <button
                type="button"
                className="pill pill-icon gradient-reset"
                aria-label="Reset gradient colors"
                title="Reset colors"
                disabled={isDefaultGradient(visuals.gradient)}
                onClick={() => onChange({ ...visuals, gradient: DEFAULT_GRADIENT })}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3.5 6.5a5 5 0 1 1-.2 3.2" />
                  <path d="M3 2.5v4h4" />
                </svg>
              </button>
            </div>
            <div
              className="gradient-preview"
              style={{ background: `linear-gradient(to right, ${gradientStops(visuals.gradient).join(", ")})` }}
            />
            <div className="gradient-stops">
              {visuals.gradient.map((color, index) => (
                <label
                  key={index}
                  className="gradient-stop"
                  style={{ left: `${((index + 1) / visuals.gradient.length) * 100}%`, background: color }}
                  title={color}
                >
                  <input
                    type="color"
                    value={color}
                    aria-label={`Gradient color ${index + 1} of ${visuals.gradient.length}`}
                    onChange={(event) => {
                      const gradient = [...visuals.gradient];
                      gradient[index] = event.target.value;
                      onChange({ ...visuals, gradient });
                    }}
                  />
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
