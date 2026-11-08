import { useEffect, useRef, type KeyboardEvent } from "react";

export interface SummaryRow {
  id: number;
  name: string;
  count: number;
}

interface SummaryPanelProps {
  isOpen: boolean;
  onToggle: (isOpen: boolean) => void;
  /** Complaints with calls, most calls first. */
  rows: SummaryRow[];
  /** Filters to one complaint, by its subject id. */
  onSelect: (id: number) => void;
  /** The complaint the app is filtered to, if it's filtered to just one. */
  selectedId: number | null;
  onClear: () => void;
}

/** A column down the right of the screen listing complaints by their number of calls. */
export function SummaryPanel({
  isOpen,
  onToggle,
  rows,
  onSelect,
  selectedId,
  onClear,
}: SummaryPanelProps) {
  const toggle = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLOListElement>(null);
  // Filtering swaps a row's button for its clear button and back, so focus follows the swap.
  const focusAfterRender = useRef<number | null>(null);

  useEffect(() => {
    if (focusAfterRender.current === null) return;
    list.current?.querySelector<HTMLElement>(`[data-focus="${focusAfterRender.current}"]`)?.focus();
    focusAfterRender.current = null;
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !isOpen) return;
    onToggle(false);
    toggle.current?.focus();
  };

  return (
    <aside
      className={isOpen ? "side-panel open" : "side-panel"}
      aria-label="Summary"
      onKeyDown={onKeyDown}
    >
      {/* One button for both states, so focus stays put when the panel opens or closes. */}
      <button
        type="button"
        className="side-toggle"
        ref={toggle}
        aria-expanded={isOpen}
        aria-controls="side-body"
        aria-label={isOpen ? "Hide summary" : "Show summary"}
        title={isOpen ? "Hide summary" : "Show summary"}
        onClick={() => onToggle(!isOpen)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d={isOpen ? "M6 3.5 10.5 8 6 12.5" : "M10 3.5 5.5 8 10 12.5"} />
        </svg>
        {!isOpen && <span className="side-rail-label">Summary</span>}
      </button>

      {isOpen && (
        <div className="side-body" id="side-body">
          <h2 className="side-head">Summary</h2>
          {rows.length > 0 ? (
            <ol className="side-list" ref={list}>
              {rows.map(({ id, name, count }) => (
                <li key={id}>
                  {id === selectedId ? (
                    <div className="side-row selected">
                      <span className="side-name">{name}</span>
                      <span className="side-count">{count.toLocaleString("en-US")}</span>
                      <button
                        type="button"
                        className="side-clear"
                        aria-label={`Stop filtering to ${name}`}
                        title="Show all complaints"
                        data-focus={id}
                        onClick={() => {
                          focusAfterRender.current = id;
                          onClear();
                        }}
                      >
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                        </svg>
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="side-row"
                      title={`Show only ${name}`}
                      data-focus={id}
                      onClick={() => {
                        focusAfterRender.current = id;
                        onSelect(id);
                      }}
                    >
                      <span className="side-name">{name}</span>
                      <span className="side-count">{count.toLocaleString("en-US")}</span>
                    </button>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="side-empty">No calls match these filters.</p>
          )}
        </div>
      )}
    </aside>
  );
}
