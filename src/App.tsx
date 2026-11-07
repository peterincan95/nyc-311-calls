import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BoxOutline, clampShare, useBoxDraw, type Box } from "./box";
import { loadCalls, type CallData } from "./data";
import { ColumnMenu } from "./ColumnMenu";
import {
  buildComplaintMenu,
  buildPlaceMenu,
  combineTags,
  type Filter,
  type Place,
} from "./filters";
import { MapView } from "./mapView";
import { HOME, isHome, PanZoom } from "./panZoom";
import { CallRenderer, SCATTER_FILL_X, type Rect, type ScatterAxis } from "./renderer";
import { dateTicks, hourTicks, longitudeTicks } from "./scatterAxes";
import {
  countCallsByDay,
  countComplaints,
  countPlaces,
  GRID_MAX,
  SECONDS_PER_DAY,
  selectCalls,
  WHOLE_CITY,
  type Area,
} from "./selection";
import { Timeline, type DayRange } from "./Timeline";

const ANNOUNCE_DELAY_MS = 600;
const SCATTER_FILL = [SCATTER_FILL_X, 1] as const;

const dateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function App() {
  const [data, setData] = useState<CallData | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadCalls(setProgress).then(setData, (reason: Error) => setError(reason.message));
  }, []);

  if (error) return <p className="status">{error}</p>;
  if (!data) {
    return (
      <p className="status" role="status">
        Loading 311 calls… {Math.round(progress * 100)}%
      </p>
    );
  }
  return <Explorer data={data} />;
}

/** Puts off an expensive count until something asks for it, then keeps the answer. */
function lazyCounts<T>(count: () => (value: T) => number) {
  let counts: ((value: T) => number) | null = null;
  return (value: T) => (counts ??= count())(value);
}

function relativeRect(element: HTMLElement, parent: DOMRect): Rect {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left: left - parent.left, top: top - parent.top, width, height };
}

function Explorer({ data }: { data: CallData }) {
  const { meta } = data;
  const span = meta.tEnd - meta.tStart;
  const fullRange: DayRange = [0, meta.days.length - 1];

  const complaintMenu = useMemo(() => buildComplaintMenu(meta), [meta]);
  const placeMenu = useMemo(() => buildPlaceMenu(meta), [meta]);
  const [filter, setFilter] = useState<Filter>(complaintMenu[0]!.value!);
  const [place, setPlace] = useState<Place>(placeMenu[0]!.value!);
  const [range, setRange] = useState<DayRange>(fullRange);
  const [area, setArea] = useState<Area>(WHOLE_CITY);
  // A box on the scatterplot also sets the dates, so clearing it should too.
  const [boxSetDates, setBoxSetDates] = useState(false);
  const [isDrawingBox, setIsDrawingBox] = useState(false);
  const [isMapMoved, setIsMapMoved] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [scatterAxis, setScatterAxis] = useState<ScatterAxis>("longitude");
  const [scatterCamera, setScatterCamera] = useState(HOME);
  const [scatterSize, setScatterSize] = useState({ width: 1, height: 1 });
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canvas = useRef<HTMLCanvasElement>(null);
  const mapCanvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const mapPlot = useRef<HTMLDivElement>(null);
  const scatterPlot = useRef<HTMLDivElement>(null);
  const startHandle = useRef<HTMLDivElement>(null);
  const renderer = useRef<CallRenderer | null>(null);
  const mapView = useRef<MapView | null>(null);
  const scatterView = useRef<PanZoom | null>(null);

  const tFrom = meta.days[range[0]]!;
  const tTo = meta.days[range[1]]!;
  const isFiltered = range[0] > 0 || range[1] < meta.days.length - 1;

  const hasArea = area !== WHOLE_CITY;
  const hasBox = hasArea || boxSetDates;
  const isTimeAxis = scatterAxis === "time";
  const axisName = isTimeAxis ? "time of day" : "longitude";

  const tags = useMemo(() => combineTags(filter, place), [filter, place]);
  const cityDailyCounts = useMemo(
    () => countCallsByDay(data, filter.subjects, tags, WHOLE_CITY),
    [data, filter, tags],
  );
  const dailyCounts = useMemo(
    () =>
      area === WHOLE_CITY ? cityDailyCounts : countCallsByDay(data, filter.subjects, tags, area),
    [data, filter, tags, area, cityDailyCounts],
  );
  const selection = useMemo(
    () =>
      selectCalls(
        data,
        filter.subjects,
        tags,
        area,
        dailyCounts,
        cityDailyCounts,
        range[0],
        range[1],
      ),
    [data, filter, tags, area, dailyCounts, cityDailyCounts, range],
  );

  const complaintCounts = useMemo(
    () => lazyCounts(() => countComplaints(data, place, area, tFrom, tTo)),
    [data, place, area, tFrom, tTo],
  );
  const placeCounts = useMemo(
    () => lazyCounts(() => countPlaces(data, filter, area, tFrom, tTo)),
    [data, filter, area, tFrom, tTo],
  );

  const formatDay = (t: number) => dateFormat.format((meta.tStart + t) * 1000);
  const callCount = selection.insideCount.toLocaleString("en-US");
  const dates = `${formatDay(tFrom)} to ${formatDay(meta.days[range[1] - 1]!)}`;
  const boxNote = hasBox ? " inside the drawn box" : "";
  const description = `${filter.name} in ${place.name}${boxNote}: ${callCount} calls, ${dates}`;

  useLayoutEffect(() => {
    let current: CallRenderer;
    try {
      current = new CallRenderer(canvas.current!, data);
    } catch (reason) {
      setError((reason as Error).message);
      return;
    }
    renderer.current = current;
    const view = new MapView(
      mapPlot.current!,
      mapCanvas.current!,
      current,
      meta.bounds,
      data.boundaries,
      setIsMapMoved,
    );
    mapView.current = view;
    const scatter = new PanZoom(scatterPlot.current!, 1, (camera) => {
      current.setScatterCamera(camera);
      setScatterCamera(camera);
    });
    scatterView.current = scatter;
    if (import.meta.env.DEV) Object.assign(window, { callRenderer: current, mapView: view });

    const updateLayout = () => {
      const bounds = stage.current!.getBoundingClientRect();
      const map = relativeRect(mapPlot.current!, bounds);
      const scatterRect = relativeRect(scatterPlot.current!, bounds);
      current.setLayout(bounds.width, bounds.height, map, scatterRect);
      view.setLayout(map.width, map.height);
      scatter.setLayout(scatterRect.width, scatterRect.height, SCATTER_FILL);
      setScatterSize({ width: scatterRect.width, height: scatterRect.height });
    };
    const observer = new ResizeObserver(updateLayout);
    observer.observe(stage.current!);
    updateLayout();

    return () => {
      observer.disconnect();
      view.destroy();
      scatter.destroy();
      current.destroy();
      mapView.current = null;
      scatterView.current = null;
      renderer.current = null;
    };
  }, [data, meta]);

  useLayoutEffect(() => {
    renderer.current?.setSelection(selection);
    mapView.current?.setArea(area);
  }, [selection, area]);

  useLayoutEffect(() => {
    renderer.current?.setScatterAxis(scatterAxis);
  }, [scatterAxis]);

  useEffect(() => {
    mapView.current?.setLabelsVisible(showLabels);
  }, [showLabels]);

  useEffect(() => {
    mapView.current?.setPanEnabled(!isDrawingBox);
    scatterView.current?.setPanEnabled(!isDrawingBox);
    if (!isDrawingBox) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsDrawingBox(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isDrawingBox]);

  // Screen readers hear the result once the range settles, not every day of a drag.
  useEffect(() => {
    const timer = setTimeout(() => setAnnouncement(description), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [description]);

  const drawOnMap = (box: Box) => {
    setArea({ ...area, ...mapView.current!.boxToArea(box) });
    setIsDrawingBox(false);
  };

  const drawOnScatter = ({ left, right, top, bottom }: Box) => {
    const view = scatterView.current!;
    const from = clampShare(view.dataX(left));
    const to = clampShare(view.dataX(right));
    if (isTimeAxis) {
      setArea({
        ...area,
        timeFrom: Math.round(from * SECONDS_PER_DAY),
        timeTo: Math.round(to * SECONDS_PER_DAY),
      });
    } else {
      setArea({ ...area, west: Math.round(from * GRID_MAX), east: Math.round(to * GRID_MAX) });
    }
    const lastDay = meta.days.length - 1;
    const firstDay = meta.days.findLastIndex((t) => t <= clampShare(view.dataY(top)) * span);
    const endDay = meta.days.findIndex((t) => t >= clampShare(view.dataY(bottom)) * span);
    setRange([Math.min(firstDay, lastDay - 1), Math.max(endDay, firstDay + 1)]);
    setBoxSetDates(true);
    setIsDrawingBox(false);
  };

  const clearBox = () => {
    setArea(WHOLE_CITY);
    if (boxSetDates) setRange(fullRange);
    setBoxSetDates(false);
    startHandle.current?.focus();
  };

  const mapDraw = useBoxDraw(drawOnMap);
  const scatterDraw = useBoxDraw(drawOnScatter);

  if (error) return <p className="status">{error}</p>;

  const peakCount = Math.max(...dailyCounts);
  const peakDay = formatDay(meta.days[dailyCounts.indexOf(peakCount)]!);
  const peakText = peakCount > 0 ? ` The busiest day was ${peakDay}.` : "";

  let emptyMessage = null;
  if (selection.totalCount === 0 && hasArea) {
    emptyMessage = "No calls like these in this box. Try a bigger box.";
  } else if (selection.totalCount === 0) {
    emptyMessage = `No calls like these in ${place.name}. Try a wider area.`;
  } else if (selection.insideCount === 0) {
    emptyMessage = "No calls in these dates. Try a wider range.";
  }

  const { zoom } = scatterCamera;
  const toPlotX = (share: number) => 0.5 + (share - scatterCamera.x) * SCATTER_FILL_X * zoom;
  const toPlotY = (share: number) => 0.5 + (share - scatterCamera.y) * zoom;
  const isOnPlot = (share: number) => share >= 0 && share <= 1;
  const percent = (share: number) => `${share * 100}%`;

  const dataWidth = scatterSize.width * SCATTER_FILL_X * zoom;
  const xTicks = isTimeAxis ? hourTicks(dataWidth) : longitudeTicks(meta.bounds, dataWidth);
  const yTicks = dateTicks(meta, scatterSize.height * zoom);

  const resetRange = () => {
    setRange(fullRange);
    startHandle.current?.focus();
  };

  const scatterBox: Box = {
    left: toPlotX(isTimeAxis ? area.timeFrom / SECONDS_PER_DAY : area.west / GRID_MAX),
    right: toPlotX(isTimeAxis ? area.timeTo / SECONDS_PER_DAY : area.east / GRID_MAX),
    top: toPlotY(tFrom / span),
    bottom: toPlotY(tTo / span),
  };

  return (
    <main className="app">
      <header className="header">
        <div className="sentence">
          <h1>311 Calls</h1>
          <ColumnMenu
            id="complaint"
            label="regarding"
            items={complaintMenu}
            columnNames={["Categories", "Complaints", "Details"]}
            searchLabel="Search categories, complaints and details"
            selected={filter}
            selectedName={filter.name}
            onSelect={setFilter}
            countOf={complaintCounts}
          />
          <ColumnMenu
            id="place"
            label="in"
            items={placeMenu}
            columnNames={["Geography types", "Places"]}
            searchLabel="Search boroughs and neighborhoods"
            selected={place}
            selectedName={place.name}
            onSelect={setPlace}
            countOf={placeCounts}
          />
        </div>
        <div className="summary">
          <p>
            <strong>{callCount}</strong> calls{hasBox && " in the box"}
          </p>
        </div>
      </header>

      <p className="visually-hidden" role="status">
        {announcement}
      </p>

      <div className="stage" ref={stage}>
        <canvas className="points" ref={canvas} aria-hidden="true" />

        <section className="panel" aria-label="Map of calls">
          <canvas className="map-lines" ref={mapCanvas} aria-hidden="true" />
          <div
            className={isDrawingBox ? "plot map-plot drawing-box" : "plot map-plot"}
            ref={mapPlot}
            role="img"
            aria-label={`Map of New York City. ${description}.`}
            {...(isDrawingBox ? mapDraw.handlers : {})}
          >
            {mapDraw.draft && <BoxOutline box={mapDraw.draft} draft />}
          </div>
          {emptyMessage && <p className="empty">{emptyMessage}</p>}
          <div className="box-bar">
            <button
              className="pill"
              type="button"
              aria-pressed={isDrawingBox}
              onClick={() => setIsDrawingBox(!isDrawingBox)}
            >
              Box select
            </button>
            <button
              className="pill"
              type="button"
              aria-pressed={showLabels}
              onClick={() => setShowLabels(!showLabels)}
            >
              Labels
            </button>
            {hasBox && (
              <button className="pill" type="button" onClick={clearBox}>
                Clear box
              </button>
            )}
            {isMapMoved && (
              <button
                className="pill"
                type="button"
                onClick={() => mapView.current?.resetView()}
              >
                Reset view
              </button>
            )}
            {isDrawingBox && <p>Drag on either plot to draw a box</p>}
          </div>
        </section>

        <section className="panel scatter" aria-label={`Calls by ${axisName} and date`}>
          <div
            className={isDrawingBox ? "plot drawing-box" : "plot"}
            ref={scatterPlot}
            role="img"
            aria-label={`Scatterplot of ${axisName} against date for the full year, highlighting ${dates}.${peakText}`}
            {...(isDrawingBox ? scatterDraw.handlers : {})}
          >
            {yTicks
              .filter(({ share }) => isOnPlot(toPlotY(share)))
              .map(({ share, label }) => (
                <span className="month" key={share} style={{ top: percent(toPlotY(share)) }}>
                  {label}
                </span>
              ))}
            <div className="plot-clip">
              {isFiltered &&
                [tFrom, tTo].map((t, index) => (
                  <div className="edge" key={index} style={{ top: percent(toPlotY(t / span)) }} />
                ))}
              {hasBox && <BoxOutline box={scatterBox} />}
              {scatterDraw.draft && <BoxOutline box={scatterDraw.draft} draft />}
            </div>
          </div>
          {!isHome(scatterCamera) && (
            <button
              className="pill scatter-reset"
              type="button"
              onClick={() => scatterView.current?.reset()}
            >
              Reset view
            </button>
          )}
          <div className="x-axis">
            {xTicks
              .filter(({ share }) => isOnPlot(toPlotX(share)))
              .map(({ share, label }) => (
                <span key={share} style={{ left: percent(toPlotX(share)) }}>
                  {label}
                </span>
              ))}
            <div className="x-axis-title">
              <p>{isTimeAxis ? "Time of day" : "Longitude, west to east"}</p>
              <button
                className="pill pill-icon axis-toggle"
                type="button"
                aria-label={isTimeAxis ? "Show longitude" : "Show time of day"}
                title={isTimeAxis ? "Show longitude" : "Show time of day"}
                onClick={() => setScatterAxis(isTimeAxis ? "longitude" : "time")}
              >
                {isTimeAxis ? (
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M2 4l4-1.5L10 4l4-1.5V12l-4 1.5L6 12l-4 1.5z" />
                    <path d="M6 2.5V12M10 4v9.5" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="6" />
                    <path d="M8 4.5V8l2.5 1.5" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </section>
      </div>

      <Timeline
        days={meta.days}
        months={meta.months}
        dailyCounts={dailyCounts}
        span={span}
        range={range}
        isFiltered={isFiltered}
        formatDay={formatDay}
        onChange={setRange}
        onReset={resetRange}
        startHandle={startHandle}
      />
    </main>
  );
}
