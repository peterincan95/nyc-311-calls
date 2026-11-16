import { useId } from "react";

export const DEFAULT_OPACITY = 50;

interface OpacitySliderProps {
  /** Names the plot it controls, for screen readers. */
  plotName: string;
  value: number;
  onChange: (value: number) => void;
  className?: string;
}

/** An always-visible slider for one plot's point opacity, with a button back to the default. */
export function OpacitySlider({ plotName, value, onChange, className = "" }: OpacitySliderProps) {
  const id = useId();
  return (
    <div className={`opacity-control ${className}`}>
      <label htmlFor={id}>Opacity</label>
      <input
        type="range"
        className="visual-slider"
        id={id}
        min={0}
        max={100}
        step={1}
        value={value}
        aria-label={`${plotName} point opacity`}
        aria-valuetext={value === DEFAULT_OPACITY ? `${value}%, the default` : `${value}%`}
        title={`${value}%`}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <button
        type="button"
        className="pill pill-icon opacity-reset"
        aria-label={`Reset ${plotName.toLowerCase()} point opacity`}
        title="Reset opacity"
        disabled={value === DEFAULT_OPACITY}
        onClick={() => onChange(DEFAULT_OPACITY)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 6.5a5 5 0 1 1-.2 3.2" />
          <path d="M3 2.5v4h4" />
        </svg>
      </button>
    </div>
  );
}
