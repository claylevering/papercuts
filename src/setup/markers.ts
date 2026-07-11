import { PapercutsError } from "../domain/errors";
import { END_MARKER } from "./content";

export type ManagedBlockParseResult =
  | { kind: "absent" }
  | {
      kind: "present";
      start: number;
      end: number;
      version: string;
    };

const BEGIN_MARKER_PATTERN =
  /<!-- papercuts:begin v([A-Za-z0-9][A-Za-z0-9._-]*) -->/g;
const BEGIN_MARKER_PREFIX = "<!-- papercuts:begin";
const END_MARKER_PREFIX = "<!-- papercuts:end";

export function parseManagedBlock(input: string): ManagedBlockParseResult {
  const begins = [...input.matchAll(BEGIN_MARKER_PATTERN)];
  const ends = allIndexesOf(input, END_MARKER);
  const markerLikeBeginCount = countOccurrences(input, BEGIN_MARKER_PREFIX);
  const markerLikeEndCount = countOccurrences(input, END_MARKER_PREFIX);

  if (markerLikeBeginCount === 0 && markerLikeEndCount === 0) {
    return { kind: "absent" };
  }

  if (
    begins.length !== 1 ||
    ends.length !== 1 ||
    markerLikeBeginCount !== begins.length ||
    markerLikeEndCount !== ends.length
  ) {
    throw new PapercutsError("setup_conflict");
  }

  const begin = begins[0];
  const endStart = ends[0];
  const version = begin?.[1];

  if (
    begin === undefined ||
    begin.index === undefined ||
    endStart === undefined ||
    version === undefined ||
    endStart < begin.index + begin[0].length
  ) {
    throw new PapercutsError("setup_conflict");
  }

  return {
    kind: "present",
    start: begin.index,
    end: endStart + END_MARKER.length,
    version,
  };
}

function allIndexesOf(input: string, needle: string): number[] {
  const indexes: number[] = [];
  let cursor = 0;

  while (cursor <= input.length - needle.length) {
    const index = input.indexOf(needle, cursor);

    if (index === -1) {
      break;
    }

    indexes.push(index);
    cursor = index + needle.length;
  }

  return indexes;
}

function countOccurrences(input: string, needle: string): number {
  return allIndexesOf(input, needle).length;
}
