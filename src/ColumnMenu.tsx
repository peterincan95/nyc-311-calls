import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { matchesQuery, toWords } from "./filters";

/** Long enough that crossing an item on the way to the next column doesn't switch to it. */
const HOVER_DELAY_MS = 110;
const SCREEN_MARGIN = 16;

export interface MenuItem<T> {
  name: string;
  /** What choosing this item selects. Without one, the item only reveals its children. */
  value?: T;
  children: MenuItem<T>[];
  /** The heading this item appears under in search results. */
  section?: string;
  /** Shown beside the item in search results. */
  parent?: string;
  /** Shown in the next column when there are no children. */
  hint?: string;
  /** Keeps the item first or last in its column, however the column is sorted. */
  pin?: "start" | "end";
}

type SortOrder = "name" | "count";

interface ColumnMenuProps<T> {
  id: string;
  /** The words before the control in the sentence. */
  label: string;
  items: MenuItem<T>[];
  columnNames: string[];
  searchLabel: string;
  selected: T;
  selectedName: string;
  onSelect: (value: T) => void;
  /** How many calls an item would show. Only called while the menu is open. */
  countOf: (value: T) => number;
}

const compactFormat = (maximumFractionDigits: number) =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits });
const thousandsFormat = compactFormat(0);
const millionsFormat = compactFormat(1);

/** 165, 17k or 3.8M. */
const formatCount = (count: number) =>
  (count < 1_000_000 ? thousandsFormat : millionsFormat).format(count).replace("K", "k");

const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

/** Sorts each column of the menu its own way. Items that select nothing have no count. */
function sortItems<T>(
  items: MenuItem<T>[],
  orders: SortOrder[],
  countOf: (value: T) => number,
  column = 0,
): MenuItem<T>[] {
  const isByCount = orders[column] === "count";
  const rank = ({ pin }: MenuItem<T>) => (pin === "start" ? 0 : pin === "end" ? 2 : 1);
  const counts = new Map(
    items.map((item) => [item, isByCount && item.value !== undefined ? countOf(item.value) : -1]),
  );
  return [...items]
    .sort(
      (a, b) =>
        rank(a) - rank(b) || counts.get(b)! - counts.get(a)! || byName(a.name, b.name),
    )
    .map((item) =>
      item.children.length > 0
        ? { ...item, children: sortItems(item.children, orders, countOf, column + 1) }
        : item,
    );
}

/** The same items' positions once the menu is sorted another way. Names are unique in a column. */
function samePath<T>(from: MenuItem<T>[], to: MenuItem<T>[], path: number[]) {
  const moved: number[] = [];
  let before = from;
  let after = to;
  for (const index of path) {
    const position = after.findIndex(({ name }) => name === before[index]?.name);
    if (position < 0) break;
    moved.push(position);
    before = before[index]!.children;
    after = after[position]!.children;
  }
  return moved.length > 0 ? moved : [0];
}

function pathTo<T>(items: MenuItem<T>[], value: T): number[] | null {
  for (const [index, item] of items.entries()) {
    if (item.value === value) return [index];
    const rest = pathTo(item.children, value);
    if (rest) return [index, ...rest];
  }
  return null;
}

function itemAt<T>(items: MenuItem<T>[], path: number[]) {
  let current: MenuItem<T> | undefined;
  let level = items;
  for (const index of path) {
    current = level[index];
    level = current?.children ?? [];
  }
  return current;
}

/** Selectable items whose names match, grouped by section in the order they first appear. */
function search<T>(items: MenuItem<T>[], query: string) {
  const words = toWords(query);
  const sections = new Map<string, MenuItem<T>[]>();
  const visit = (level: MenuItem<T>[]) => {
    for (const item of level) {
      if (item.value !== undefined && matchesQuery(item.name, words)) {
        const section = item.section ?? "";
        sections.set(section, [...(sections.get(section) ?? []), item]);
      }
      visit(item.children);
    }
  };
  if (words.length > 0) visit(items);
  return { isSearching: words.length > 0, sections: [...sections] };
}

export function ColumnMenu<T>({
  id,
  label,
  items,
  columnNames,
  searchLabel,
  selected,
  selectedName,
  onSelect,
  countOf,
}: ColumnMenuProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** The active item in each column, up to the column the user is in. */
  const [path, setPath] = useState<number[]>([0]);
  const [resultIndex, setResultIndex] = useState(0);
  const [orders, setOrders] = useState<SortOrder[]>(() => columnNames.map(() => "name"));

  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const isHovering = useRef(false);
  const isTouch = useRef(false);
  const hoverTimer = useRef(0);
  const hoverTarget = useRef<string | null>(null);

  const { isSearching, sections } = useMemo(() => search(items, query), [items, query]);
  // Counts are only worked out while the menu is open.
  const sorted = useMemo(
    () => (isOpen ? sortItems(items, orders, countOf) : items),
    [isOpen, items, orders, countOf],
  );
  const results = sections.flatMap(([, members]) => members);

  const columnCount = columnNames.length;
  const depth = path.length - 1;
  const activeItem = itemAt(sorted, path);
  /** The item whose children fill a column. Columns past the active one have none. */
  const parentOf = (column: number) =>
    column > 0 && column <= path.length ? itemAt(sorted, path.slice(0, column)) : undefined;
  const columns = columnNames.map((_, column) =>
    column === 0 ? sorted : (parentOf(column)?.children ?? []),
  );
  // Phones only have room for two columns, so the third replaces the first.
  const isShifted = columnCount > 2 && columns[2]!.length > 0;

  const optionId = (column: number, index: number) => `${id}-${column}-${index}`;
  const activeId = isSearching ? `${id}-result-${resultIndex}` : optionId(depth, path[depth]!);
  const activeList = isSearching ? `${id}-results` : `${id}-column-${depth}`;

  useEffect(() => {
    if (!isOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [isOpen]);

  const cancelHover = () => {
    window.clearTimeout(hoverTimer.current);
    hoverTarget.current = null;
  };

  useEffect(() => {
    // A touch keyboard would cover the menu, so touch users tap into search themselves.
    if (isOpen && !isTouch.current) searchBox.current?.focus();
    if (!isOpen) cancelHover();
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && !isHovering.current) {
      document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
    }
  }, [isOpen, activeId]);

  // The panel is wider than its button, so it's kept on screen rather than left-aligned to it.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const place = () => {
      const { left, bottom } = button.current!.getBoundingClientRect();
      const element = panel.current!;
      const furthest = window.innerWidth - element.offsetWidth - SCREEN_MARGIN;
      const clamped = Math.max(SCREEN_MARGIN, Math.min(left, furthest));
      element.style.setProperty("--panel-left", `${clamped}px`);
      element.style.setProperty("--panel-top", `${bottom + 8}px`);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [isOpen, selected]);

  const open = () => {
    isHovering.current = false;
    setQuery("");
    setPath(pathTo(sortItems(items, orders, countOf), selected) ?? [0]);
    setIsOpen(true);
  };

  /** Keeps the same items active and the search box focused. */
  const sortColumn = (column: number, order: SortOrder) => {
    const next = orders.map((current, index) => (index === column ? order : current));
    isHovering.current = false;
    setPath(samePath(sorted, sortItems(items, next, countOf), path));
    setOrders(next);
    if (!isTouch.current) searchBox.current?.focus();
  };

  const close = () => {
    setIsOpen(false);
    button.current?.focus();
  };

  const choose = (value: T) => {
    onSelect(value);
    close();
  };

  const hover = (column: number, index: number) => {
    isHovering.current = true;
    const target = `${column}-${index}`;
    if (hoverTarget.current === target) return;
    cancelHover();
    if (path[column] === index) return;

    const next = [...path.slice(0, column), index];
    if (column === columnCount - 1) {
      setPath(next);
      return;
    }
    hoverTarget.current = target;
    hoverTimer.current = window.setTimeout(() => {
      hoverTarget.current = null;
      setPath(next);
    }, HOVER_DELAY_MS);
  };

  /** Touch has no hover, so a tap filters and leaves any children open to choose from. */
  const clickItem = (item: MenuItem<T>, column: number, index: number) => {
    const next = [...path.slice(0, column), index];
    cancelHover();
    if (item.value === undefined) {
      setPath(next);
    } else if (isTouch.current && item.children.length > 0) {
      setPath(next);
      onSelect(item.value);
    } else {
      choose(item.value);
    }
  };

  const moveInColumn = (key: string) => {
    const index = path[depth]!;
    const last = columns[depth]!.length - 1;
    const moves: Record<string, number> = {
      ArrowDown: Math.min(index + 1, last),
      ArrowUp: Math.max(index - 1, 0),
      Home: 0,
      End: last,
    };
    const next = moves[key];
    if (next === undefined) return false;
    setPath([...path.slice(0, depth), next]);
    return true;
  };

  const moveBetweenColumns = (key: string) => {
    if (key === "ArrowRight" && activeItem && activeItem.children.length > 0) {
      setPath([...path, 0]);
      return true;
    }
    if (key === "ArrowLeft" && depth > 0) {
      setPath(path.slice(0, -1));
      return true;
    }
    return false;
  };

  const moveInResults = (key: string) => {
    if (key === "ArrowDown") setResultIndex(Math.min(resultIndex + 1, results.length - 1));
    else if (key === "ArrowUp") setResultIndex(Math.max(resultIndex - 1, 0));
    else return false;
    return true;
  };

  const onEnter = () => {
    const item = isSearching ? results[resultIndex] : activeItem;
    if (item?.value !== undefined) choose(item.value);
    else if (item) moveBetweenColumns("ArrowRight");
  };

  const onSearchKeyDown = (event: KeyboardEvent) => {
    const { key } = event;
    isHovering.current = false;
    if (key === "Escape" || key === "Tab") {
      event.preventDefault();
      close();
    } else if (key === "Enter") {
      event.preventDefault();
      onEnter();
    } else if (isSearching ? moveInResults(key) : moveInColumn(key) || moveBetweenColumns(key)) {
      event.preventDefault();
    }
  };

  const onButtonKeyDown = (event: KeyboardEvent) => {
    if (!isOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      open();
    }
  };

  const optionClass = (state?: string) => (state ? `menu-option ${state}` : "menu-option");

  const itemName = ({ name, value }: MenuItem<T>) => (
    <span>
      {name}
      {value !== undefined && (
        <span className="menu-count"> ({formatCount(countOf(value))})</span>
      )}
    </span>
  );

  const renderColumn = (column: number) => {
    const parent = parentOf(column);
    const members = columns[column]!;
    const sortButton = (order: SortOrder, text: string, description: string) => (
      <button
        type="button"
        className="menu-sort-button"
        aria-pressed={orders[column] === order}
        title={description}
        onClick={() => sortColumn(column, order)}
      >
        {text}
      </button>
    );
    return (
      <div className="menu-column" key={column}>
        {members.length > 0 && (
          <div className="menu-sort" role="group" aria-label={`Sort ${columnNames[column]}`}>
            {sortButton("name", "A–Z", "Sort alphabetically")}
            {sortButton("count", "Most calls", "Sort by number of calls, most first")}
          </div>
        )}
        <div
          className="menu-list"
          id={`${id}-column-${column}`}
          // Restarts the list, and its scroll position, when its parent changes.
          key={path.slice(0, column).join("-")}
          role="listbox"
          aria-label={parent ? `${columnNames[column]} in ${parent.name}` : columnNames[column]}
        >
          {members.map((item, index) => {
            let state;
            if (path[column] === index) state = column === depth ? "active" : "shown";
            return (
              <div
                key={item.name}
                id={optionId(column, index)}
                role="option"
                aria-selected={item.value !== undefined && item.value === selected}
                className={optionClass(state)}
                // Move, not enter: rows appearing under a resting pointer shouldn't take the highlight.
                onPointerMove={() => hover(column, index)}
                onPointerLeave={cancelHover}
                onClick={() => clickItem(item, column, index)}
              >
                {itemName(item)}
                {item.children.length > 0 && <span className="menu-more" aria-hidden="true" />}
              </div>
            );
          })}
          {members.length === 0 && parent?.hint && <p className="menu-hint">{parent.hint}</p>}
        </div>
      </div>
    );
  };

  let resultNumber = -1;
  const renderResult = (item: MenuItem<T>) => {
    resultNumber += 1;
    const index = resultNumber;
    return (
      <div
        key={`${item.parent ?? ""}-${item.name}`}
        id={`${id}-result-${index}`}
        role="option"
        aria-selected={item.value === selected}
        className={optionClass(index === resultIndex ? "active" : undefined)}
        onPointerMove={() => {
          isHovering.current = true;
          setResultIndex(index);
        }}
        onClick={() => choose(item.value!)}
      >
        {itemName(item)}
        {item.parent && <span className="menu-parent">{item.parent}</span>}
      </div>
    );
  };

  return (
    <div
      className="menu"
      ref={root}
      onPointerDownCapture={(event) => {
        isTouch.current = event.pointerType === "touch";
      }}
    >
      <span className="menu-label" id={`${id}-label`}>
        {label}
      </span>
      <button
        type="button"
        className="menu-button"
        ref={button}
        aria-labelledby={`${id}-label ${id}-current`}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={() => (isOpen ? setIsOpen(false) : open())}
        onKeyDown={onButtonKeyDown}
      >
        <span className="menu-name" id={`${id}-current`}>
          {selectedName}
        </span>
        <span className={isOpen ? "caret caret-open" : "caret"} aria-hidden="true" />
      </button>

      {isOpen && (
        <div
          className={`menu-panel columns-${columnCount}`}
          ref={panel}
          role="dialog"
          aria-label={searchLabel}
        >
          <input
            className="menu-search"
            ref={searchBox}
            type="search"
            role="combobox"
            placeholder={searchLabel}
            aria-label={searchLabel}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={activeList}
            aria-activedescendant={activeId}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              isHovering.current = false;
              setQuery(event.target.value);
              setResultIndex(0);
            }}
            onKeyDown={onSearchKeyDown}
          />

          {isSearching ? (
            <div className="menu-results" id={`${id}-results`} role="listbox" aria-label="Results">
              {sections.map(([section, members]) => (
                <div role="group" aria-label={section} key={section}>
                  <p className="menu-heading" aria-hidden="true">
                    {section}
                  </p>
                  {members.map(renderResult)}
                </div>
              ))}
              {results.length === 0 && <p className="menu-hint">No matches for “{query.trim()}”</p>}
            </div>
          ) : (
            <>
              {isShifted && (
                <button
                  type="button"
                  className="menu-back"
                  onClick={() => setPath([path[0]!])}
                >
                  ‹ {sorted[path[0]!]!.name}
                </button>
              )}
              <div className={isShifted ? "menu-columns shifted" : "menu-columns"}>
                {columnNames.map((_, column) => renderColumn(column))}
              </div>
            </>
          )}

          <p className="visually-hidden" role="status">
            {isSearching ? `${results.length} results` : ""}
          </p>
        </div>
      )}
    </div>
  );
}
