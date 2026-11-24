import { useEffect, useRef } from "react";

// Everything the info panel says, in one place to edit.
const COPY = {
  title: "About this map",
  intro: [
    "Every point of light is a request to NYC 311, the city's line for non-emergency complaints and services, placed where it was reported. The site covers about 3.8 million requests from July 2025 through June 2026, so the brightest areas are where New Yorkers asked for help most.",
  ],
  howTo: [
    "Choose a complaint and a place from the menus in the title. Every view updates to match.",
    "Scroll or pinch to zoom the map and chart, and drag to move around.",
    "Drag the timeline's handles, or use 1 Month, 1 Week and 1 Day, to pick dates.",
    "Switch the chart between longitude, time of day, and a day-of-week grid. Click grid cells to pick hours, and shift-click to add more.",
    "Turn on Box select and drag over the map or chart to focus on an area.",
    "Use the options button by the map to color by borough, show streets and neighborhoods, or change the colors.",
  ],
  close: "Start exploring",
  closeIcon: "Close",
  openButton: "About this map",
};

// Remembers that this browser has seen the panel, so it only opens by itself once.
const SEEN_KEY = "nyc311.infoSeen";

function hasSeenInfo() {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Without storage the panel just opens again next visit.
  }
}

/** A button that opens a description of the site, which also opens by itself on a first visit. */
export function InfoPanel() {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!hasSeenInfo()) dialog.current?.showModal();
  }, []);

  const close = () => dialog.current?.close();

  return (
    <>
      <button
        type="button"
        className="pill pill-icon info-button"
        aria-label={COPY.openButton}
        title={COPY.openButton}
        onClick={() => dialog.current?.showModal()}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" />
          <path d="M8 7.2v4.3" />
          <circle cx="8" cy="4.8" r="0.4" className="dot" />
        </svg>
      </button>

      <dialog
        className="info-panel"
        ref={dialog}
        aria-labelledby="info-title"
        onClose={rememberSeen}
        // A click on the backdrop lands on the dialog itself, outside its content.
        onClick={(event) => {
          if (event.target === dialog.current) close();
        }}
      >
        <div className="info-content">
          <div className="info-heading">
            <h2 id="info-title">{COPY.title}</h2>
            <button type="button" className="pill pill-icon info-close" aria-label={COPY.closeIcon} onClick={close}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
          {COPY.intro.map((text) => (
            <p key={text}>{text}</p>
          ))}
          <ul>
            {COPY.howTo.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
          <button type="button" className="pill info-start" onClick={close}>
            {COPY.close}
          </button>
        </div>
      </dialog>
    </>
  );
}
