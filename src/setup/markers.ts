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
const MARKER_LIKE_PATTERN = /papercuts[ \t:._-]*(begin|end)\b/gi;

export function parseManagedBlock(input: string): ManagedBlockParseResult {
  const begins = [...input.matchAll(BEGIN_MARKER_PATTERN)];
  const ends = allIndexesOf(input, END_MARKER);
  const markerLike = [...input.matchAll(MARKER_LIKE_PATTERN)];
  const markerLikeBeginCount = markerLike.filter(
    (match) => match[1]?.toLowerCase() === "begin",
  ).length;
  const markerLikeEndCount = markerLike.filter(
    (match) => match[1]?.toLowerCase() === "end",
  ).length;

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
    !isStandaloneMarkerLine(
      input,
      begin.index,
      begin.index + begin[0].length,
    ) ||
    !isStandaloneMarkerLine(
      input,
      endStart,
      endStart + END_MARKER.length,
    ) ||
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

function isStandaloneMarkerLine(
  input: string,
  start: number,
  end: number,
): boolean {
  const startsLine =
    start === 0 ||
    (start === 1 && input.charCodeAt(0) === 0xfeff) ||
    input[start - 1] === "\n" ||
    input[start - 1] === "\r";
  const endsLine =
    end === input.length || input[end] === "\n" || input[end] === "\r";

  return startsLine && endsLine;
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
