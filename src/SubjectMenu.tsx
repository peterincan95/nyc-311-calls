import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Subject } from "./data";

const ALL_CALLS = "All calls";

interface Option {
  id: number | null;
  name: string;
}

interface SubjectMenuProps {
  subjects: Subject[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}

export function SubjectMenu({ subjects, selectedId, onSelect }: SubjectMenuProps) {
  const options = useMemo<Option[]>(
    () => [{ id: null, name: ALL_CALLS }, ...subjects.map(({ id, name }) => ({ id, name }))],
    [subjects],
  );
  const selectedIndex = options.findIndex(({ id }) => id === selectedId);

  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const isHovering = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && !isHovering.current) {
      list.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [isOpen, activeIndex]);

  const open = () => {
    isHovering.current = false;
    setActiveIndex(selectedIndex);
    setIsOpen(true);
  };

  const choose = (index: number) => {
    onSelect(options[index]!.id);
    setIsOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const moves: Record<string, number> = {
      ArrowDown: Math.min(activeIndex + 1, options.length - 1),
      ArrowUp: Math.max(activeIndex - 1, 0),
      Home: 0,
      End: options.length - 1,
    };
    if (!isOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        open();
      }
      return;
    }
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      isHovering.current = false;
      setActiveIndex(move);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === "Escape" || event.key === "Tab") {
      setIsOpen(false);
    }
  };

  return (
    <div className="subject" ref={root}>
      <span id="subject-label">Regarding</span>
      <div className="subject-control">
        <button
          type="button"
          className="subject-button"
          role="combobox"
          aria-labelledby="subject-label"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-controls="subject-list"
          aria-activedescendant={isOpen ? `subject-${activeIndex}` : undefined}
          onClick={() => (isOpen ? setIsOpen(false) : open())}
          onKeyDown={onKeyDown}
        >
          <span className="subject-name">{options[selectedIndex]?.name}</span>
          <span className={isOpen ? "caret caret-open" : "caret"} aria-hidden="true" />
        </button>
        {isOpen && (
          <ul className="subject-list" id="subject-list" role="listbox" ref={list}>
            {options.map(({ id, name }, index) => (
              <li
                key={id ?? "all"}
                id={`subject-${index}`}
                role="option"
                aria-selected={id === selectedId}
                className={index === activeIndex ? "active" : undefined}
                onPointerEnter={() => {
                  isHovering.current = true;
                  setActiveIndex(index);
                }}
                onClick={() => choose(index)}
              >
                {name}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
