import type { MenuItem } from "./ColumnMenu";
import {
  BOROUGH_MASK,
  BOROUGH_SHIFT,
  DETAIL_MASK,
  NEIGHBORHOOD_MASK,
  NEIGHBORHOOD_SHIFT,
  type Meta,
  type Subject,
} from "./data";

/** Keeps the calls whose tag, with `mask` applied, equals `match`. */
export interface TagFilter {
  mask: number;
  match: number;
}

/** A complaint filter: every call, a category, one complaint or one of its details. */
export interface Filter extends TagFilter {
  name: string;
  subjects: Subject[];
}

export interface Place extends TagFilter {
  name: string;
}

const ALL_TAGS = { mask: 0, match: 0 };

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name.localeCompare(b.name, "en", { sensitivity: "base" });

export const combineTags = (a: TagFilter, b: TagFilter): TagFilter => ({
  mask: a.mask | b.mask,
  match: a.match | b.match,
});

function complaintItem(subject: Subject, groupName: string): MenuItem<Filter> {
  // A complaint can't share its category's name, or the two would look identical.
  const name = subject.name === groupName ? `${groupName} - General` : subject.name;
  return {
    name,
    value: { name, subjects: [subject], ...ALL_TAGS },
    section: "Complaints",
    parent: groupName,
    hint: "No further details",
    children: subject.details.map((detail) => ({
      name: detail.name,
      value: {
        name: `${name}: ${detail.name}`,
        subjects: [subject],
        mask: DETAIL_MASK,
        match: detail.id,
      },
      section: "Details",
      parent: name,
      children: [],
    })),
  };
}

export function buildComplaintMenu({ subjects, groups }: Meta): MenuItem<Filter>[] {
  const subjectsById = new Map(subjects.map((subject) => [subject.id, subject]));
  const allCalls: Filter = { name: "All calls", subjects, ...ALL_TAGS };

  return [
    {
      name: allCalls.name,
      value: allCalls,
      section: "Categories",
      hint: "Every complaint in every category",
      children: [],
    },
    ...groups.map(({ name, subjects: ids }) => {
      const members = ids.map((id) => subjectsById.get(id)!);
      return {
        name,
        value: { name, subjects: members, ...ALL_TAGS },
        section: "Categories",
        children: members.map((subject) => complaintItem(subject, name)).sort(byName),
      };
    }),
  ];
}

export function buildPlaceMenu({ boroughs, neighborhoods }: Meta): MenuItem<Place>[] {
  const city: Place = { name: "New York City", ...ALL_TAGS };
  const place = (section: string, name: string, mask: number, match: number) => ({
    name,
    value: { name, mask, match },
    section,
    children: [],
  });

  return [
    { name: city.name, value: city, section: "City", hint: "All five boroughs", children: [] },
    {
      name: "Boroughs",
      children: boroughs.map(({ id, name }) =>
        place("Boroughs", name, BOROUGH_MASK, id << BOROUGH_SHIFT),
      ),
    },
    {
      name: "Neighborhoods",
      children: neighborhoods.map(({ id, name }) =>
        place("Neighborhoods", name, NEIGHBORHOOD_MASK, id << NEIGHBORHOOD_SHIFT),
      ),
    },
  ];
}

/** The number of calls with no coordinates that fit the filter. */
export function countMissing({ missingCalls }: Meta, subjects: Subject[], tags: TagFilter) {
  const ids = new Set(subjects.map(({ id }) => id));
  return missingCalls.reduce(
    (sum, [subject, callTags, count]) =>
      ids.has(subject) && (callTags & tags.mask) === tags.match ? sum + count : sum,
    0,
  );
}

export const toWords = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Whether each query word starts a word in the name, so "tree" doesn't find "Street". */
export function matchesQuery(name: string, queryWords: string[]) {
  const nameWords = toWords(name);
  return queryWords.every((query) => nameWords.some((word) => word.startsWith(query)));
}
