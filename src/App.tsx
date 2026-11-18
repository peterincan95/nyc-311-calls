import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BoxOutline, clampShare, useBoxDraw, type Box } from "./box";
import { loadCalls, loadStreets, type CallData } from "./data";
import { ColumnMenu } from "./ColumnMenu";
import {
  buildComplaintMenu,
  buildPlaceMenu,
  combineTags,
  complaintNames,
  type Filter,
  type Place,
} from "./filters";
import { MapView } from "./mapView";
import { HOME, isHome, PanZoom } from "./panZoom";
import {
  CallRenderer,
  SCATTER_FILL_X,
  SCATTER_MAX_ZOOM,
  type Rect,
  type ScatterAxis,
} from "./renderer";
import { dateTicks, hourRowTicks, hourTicks, longitudeTicks, weekdayTicks } from "./scatterAxes";
import {
  countCallsByDay,
  countInRange,
  countSubjectsByDay,
  countComplaints,
  countPlaces,
  countWeekCells,
  DAYS_PER_WEEK,
  GRID_MAX,
  HOURS_PER_DAY,
  isWholeCity,
  SECONDS_PER_DAY,
  selectCalls,
  sumByDay,
  WEEK_CELLS,
  WHOLE_CITY,
  type Area,
} from "./selection";
import { emptyCells, WeekGrid } from "./WeekGrid";
import { SummaryPanel, type SummaryRow } from "./SummaryPanel";
import { Timeline, type DayRange } from "./Timeline";
import { DEFAULT_VISUALS, VisualOptions, type Visuals } from "./VisualOptions";
import { OpacitySlider } from "./OpacitySlider";

const ANNOUNCE_DELAY_MS = 600;

// What the chart's view menu offers, in order.
const SCATTER_VIEWS: { axis: ScatterAxis; label: string; name: string }[] = [
  { axis: "longitude", label: "Longitude, west to east", name: "longitude and date" },
  { axis: "time", label: "Time of day", name: "time of day and date" },
  { axis: "week", label: "Day of week and hour", name: "day of week and hour" },
];
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
        Loading 311 requests… {Math.round(progress * 100)}%
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
  const complaintNameById = useMemo(() => complaintNames(meta), [meta]);
  // The complaint menu's own filters, so choosing from the summary also marks the menu.
  const complaintFilters = useMemo(() => {
    const filters = new Map<number, Filter>();
    for (const category of complaintMenu) {
      for (const { value } of category.children) {
        if (value && value.mask === 0) filters.set(value.subjects[0]!.id, value);
      }
    }
    return filters;
  }, [complaintMenu]);
  const [filter, setFilter] = useState<Filter>(complaintMenu[0]!.value!);
  const [place, setPlace] = useState<Place>(placeMenu[0]!.value!);
  const [range, setRange] = useState<DayRange>(fullRange);
  const [area, setArea] = useState<Area>(WHOLE_CITY);
  // A box on the scatterplot also sets the dates, so clearing it should too.
  const [boxSetDates, setBoxSetDates] = useState(false);
  const [isDrawingBox, setIsDrawingBox] = useState(false);
  const [isMapMoved, setIsMapMoved] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [isSummaryOpen, setIsSummaryOpen] = useState(false);
  const [isTimelineOpen, setIsTimelineOpen] = useState(true);
  const [visuals, setVisuals] = useState<Visuals>(DEFAULT_VISUALS);
  // A complaint chosen in the summary, and the filter it replaced, so clearing it goes back.
  const [summaryChoice, setSummaryChoice] = useState<{ base: Filter; chosen: Filter } | null>(
    null,
  );
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
  // Choosing in the header afterwards replaces the summary's choice.
  const isSummaryChoice = summaryChoice !== null && summaryChoice.chosen === filter;
  const isTimeAxis = scatterAxis === "time";
  const isWeekView = scatterAxis === "week";
  const viewName = SCATTER_VIEWS.find(({ axis }) => axis === scatterAxis)!.name;

  const tags = useMemo(() => combineTags(filter, place), [filter, place]);
  // Each complaint's calls by day, so the summary can total any date range quickly.
  const subjectDailyCounts = useMemo(
    () => countSubjectsByDay(data, filter.subjects, tags, area),
    [data, filter, tags, area],
  );
  const dailyCounts = useMemo(
    () => sumByDay(subjectDailyCounts, meta.days.length - 1),
    [subjectDailyCounts, meta],
  );
  const cityDailyCounts = useMemo(
    () =>
      area === WHOLE_CITY ? dailyCounts : countCallsByDay(data, filter.subjects, tags, WHOLE_CITY),
    [data, filter, tags, area, dailyCounts],
  );
  const summaryRows = useMemo(() => {
    const rows: SummaryRow[] = filter.subjects.map(({ id }, index) => ({
      id,
      name: complaintNameById.get(id)!,
      count: countInRange(subjectDailyCounts[index]!, range[0], range[1]),
    }));
    return rows
      .filter(({ count }) => count > 0)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [filter, complaintNameById, subjectDailyCounts, range]);
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

  // Only the week grid needs these, and they take a pass over the calls.
  const weekCounts = useMemo(
    () => (isWeekView ? countWeekCells(data, filter.subjects, tags, area, tFrom, tTo) : null),
    [isWeekView, data, filter, tags, area, tFrom, tTo],
  );

  const formatDay = (t: number) => dateFormat.format((meta.tStart + t) * 1000);
  const callCount = selection.insideCount.toLocaleString("en-US");
  const dates = `${formatDay(tFrom)} to ${formatDay(meta.days[range[1] - 1]!)}`;
  const boxNote = hasBox ? " inside the drawn box" : "";
  const description = `${filter.name} in ${place.name}${boxNote}: ${callCount} requests, ${dates}`;

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
    const scatter = new PanZoom(scatterPlot.current!, 1, SCATTER_MAX_ZOOM, (camera) => {
      current.setScatterCamera(camera);
      setScatterCamera(camera);
    });
    scatterView.current = scatter;
    if (import.meta.env.DEV) Object.assign(window, { callRenderer: current, mapView: view });

    // Streets come after the points, and the map works without them.
    let isCurrent = true;
    loadStreets()
      .then((streets) => {
        if (!isCurrent) return;
        current.setStreets(streets);
        view.setStreets(streets);
      })
      .catch((reason: unknown) => console.warn("Streets didn't load", reason));

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
      isCurrent = false;
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

  useLayoutEffect(() => {
    renderer.current?.setPointStyle(visuals);
    renderer.current?.setStreetsVisible(visuals.streets);
    mapView.current?.setStreetsVisible(visuals.streets);
    mapView.current?.setNeighborhoodsVisible(visuals.neighborhoods);
  }, [visuals]);

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

  // The week grid always fits, so it doesn't pan or zoom.
  useEffect(() => {
    scatterView.current?.setLocked(isWeekView);
  }, [isWeekView]);

  // Screen readers hear the result once the range settles, not every day of a drag.
  useEffect(() => {
    const timer = setTimeout(() => setAnnouncement(description), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [description]);

  const drawOnMap = (box: Box) => {
    setArea({ ...area, ...mapView.current!.boxToArea(box) });
    setIsDrawingBox(false);
  };

  /** Picks hours of the week, replacing any time-of-day box. Picking all of them, or none, clears the pick. */
  const pickCells = (cells: Uint8Array) => {
    const count = cells.reduce((sum, isIn) => sum + isIn, 0);
    const next = {
      ...area,
      timeFrom: 0,
      timeTo: SECONDS_PER_DAY,
      cells: count === 0 || count === WEEK_CELLS ? null : cells,
    };
    setArea(isWholeCity(next) ? WHOLE_CITY : next);
  };

  /** A click picks just that cell, or clears it if it's the only one. Shift adds or removes it. */
  const pickCell = (cell: number, isAdding: boolean) => {
    const current = area.cells;
    if (isAdding) {
      const cells = current ? current.slice() : emptyCells();
      cells[cell] = cells[cell] ? 0 : 1;
      pickCells(cells);
      return;
    }
    const isOnlyPick = current?.[cell] === 1 && current.reduce((sum, isIn) => sum + isIn, 0) === 1;
    const cells = emptyCells();
    if (!isOnlyPick) cells[cell] = 1;
    pickCells(cells);
  };

  const drawOnScatter = ({ left, right, top, bottom }: Box, isAdding: boolean) => {
    if (isWeekView) {
      // Every cell the box touches.
      const cells = isAdding && area.cells ? area.cells.slice() : emptyCells();
      const [dayFrom, dayTo] = [left, right].map((share) => Math.min(Math.floor(share * DAYS_PER_WEEK), DAYS_PER_WEEK - 1));
      const [hourFrom, hourTo] = [top, bottom].map((share) => Math.min(Math.floor(share * HOURS_PER_DAY), HOURS_PER_DAY - 1));
      for (let day = dayFrom!; day <= dayTo!; day += 1) {
        for (let hour = hourFrom!; hour <= hourTo!; hour += 1) cells[day * HOURS_PER_DAY + hour] = 1;
      }
      pickCells(cells);
      setIsDrawingBox(false);
      return;
    }
    const view = scatterView.current!;
    const from = clampShare(view.dataX(left));
    const to = clampShare(view.dataX(right));
    if (isTimeAxis) {
      // A time-of-day box replaces any hours picked on the week grid.
      setArea({
        ...area,
        timeFrom: Math.round(from * SECONDS_PER_DAY),
        timeTo: Math.round(to * SECONDS_PER_DAY),
        cells: null,
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
    emptyMessage = "No requests like these in this box. Try a bigger box.";
  } else if (selection.totalCount === 0) {
    emptyMessage = `No requests like these in ${place.name}. Try a wider area.`;
  } else if (selection.insideCount === 0) {
    emptyMessage = "No requests in these dates. Try a wider range.";
  }

  const { zoom } = scatterCamera;
  const toPlotX = (share: number) => 0.5 + (share - scatterCamera.x) * SCATTER_FILL_X * zoom;
  const toPlotY = (share: number) => 0.5 + (share - scatterCamera.y) * zoom;
  const isOnPlot = (share: number) => share >= 0 && share <= 1;
  const percent = (share: number) => `${share * 100}%`;

  const dataWidth = scatterSize.width * SCATTER_FILL_X * zoom;
  const xTicks = isWeekView
    ? weekdayTicks()
    : isTimeAxis
      ? hourTicks(dataWidth)
      : longitudeTicks(meta.bounds, dataWidth);
  const yTicks = isWeekView ? hourRowTicks() : dateTicks(meta, scatterSize.height * zoom);
  // The week grid fills the plot without a camera.
  const toTickX = isWeekView ? (share: number) => share : toPlotX;
  const toTickY = isWeekView ? (share: number) => share : toPlotY;

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
          <h1>311 Requests</h1>
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
            unsortedColumns={[0]}
            searchLabel="Search boroughs and neighborhoods"
            selected={place}
            selectedName={place.name}
            onSelect={setPlace}
            countOf={placeCounts}
          />
        </div>
        <div className="summary">
          <p>
            <strong>{callCount}</strong> requests
          </p>
        </div>
      </header>

      <p className="visually-hidden" role="status">
        {announcement}
      </p>

      <div className="stage" ref={stage}>
        <canvas className="points" ref={canvas} aria-hidden="true" />

        <section className="panel" aria-label="Map of requests">
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
          <OpacitySlider
            className="map-opacity"
            plotName="Map"
            value={visuals.mapOpacity}
            onChange={(mapOpacity) => setVisuals({ ...visuals, mapOpacity })}
          />
          <div className="box-bar">
            <VisualOptions visuals={visuals} onChange={setVisuals} />
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

        <section className="panel scatter" aria-label={`Requests by ${viewName}`}>
          <div
            className={["plot", isDrawingBox && "drawing-box", isWeekView && "week-plot"]
              .filter(Boolean)
              .join(" ")}
            ref={scatterPlot}
            role="img"
            aria-label={
              isWeekView
                ? `Grid of requests by day of week and hour, ${dates}.`
                : `Scatterplot of ${viewName} for the full year, highlighting ${dates}.${peakText}`
            }
            {...(isDrawingBox ? scatterDraw.handlers : {})}
          >
            {yTicks
              .filter(({ share }) => isOnPlot(toTickY(share)))
              .map(({ share, label }) => (
                <span className="month" key={share} style={{ top: percent(toTickY(share)) }}>
                  {label}
                </span>
              ))}
            {isWeekView && weekCounts && (
              <WeekGrid counts={weekCounts} area={area} gradient={visuals.gradient} onPick={pickCell} />
            )}
            <div className="plot-clip">
              {!isWeekView &&
                isFiltered &&
                [tFrom, tTo].map((t, index) => (
                  <div className="edge" key={index} style={{ top: percent(toPlotY(t / span)) }} />
                ))}
              {hasBox && !isWeekView && <BoxOutline box={scatterBox} />}
              {scatterDraw.draft && <BoxOutline box={scatterDraw.draft} draft />}
            </div>
          </div>
          <div className="scatter-tools">
            {!isWeekView && !isHome(scatterCamera) && (
              <button
                className="pill"
                type="button"
                onClick={() => scatterView.current?.reset()}
              >
                Reset view
              </button>
            )}
            {!isWeekView && (
              <OpacitySlider
                plotName="Chart"
                value={visuals.chartOpacity}
                onChange={(chartOpacity) => setVisuals({ ...visuals, chartOpacity })}
              />
            )}
          </div>
          <div className="x-axis">
            {xTicks
              .filter(({ share }) => isOnPlot(toTickX(share)))
              .map(({ share, label }) => (
                <span key={share} style={{ left: percent(toTickX(share)) }}>
                  {label}
                </span>
              ))}
            <div className="x-axis-title">
              <select
                className="view-select"
                aria-label="Chart view"
                value={scatterAxis}
                onChange={(event) => setScatterAxis(event.target.value as ScatterAxis)}
              >
                {SCATTER_VIEWS.map(({ axis, label }) => (
                  <option key={axis} value={axis}>
                    {label}
                  </option>
                ))}
              </select>
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
        isOpen={isTimelineOpen}
        onToggle={setIsTimelineOpen}
        chartColor={visuals.gradient.at(-2)!}
      />

      <SummaryPanel
        isOpen={isSummaryOpen}
        onToggle={setIsSummaryOpen}
        rows={summaryRows}
        onSelect={(id) => {
          const chosen = complaintFilters.get(id)!;
          setSummaryChoice({ base: isSummaryChoice ? summaryChoice.base : filter, chosen });
          setFilter(chosen);
        }}
        selectedId={isSummaryChoice ? filter.subjects[0]!.id : null}
        onClear={() => {
          if (summaryChoice) setFilter(summaryChoice.base);
          setSummaryChoice(null);
        }}
      />
    </main>
  );
}
