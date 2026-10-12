import { parseRocketCoordinate } from "./coordinates";

/** The archetype `nostrocket-state` advertises and the convention callers dispatch. */
export const ROCKET_VIEW_CONVENTION = "napplet:rocket/open";

export interface RocketViewPayload {
  /** The `31108:<author pubkey>:<identifier>` coordinate of the rocket to show. */
  coordinate: string;
}

/**
 * Validate an incoming rocket-view payload. The coordinate is the only field,
 * and it must be a well-formed rocket address — a bad payload opens nothing
 * rather than silently showing NOSTROCKET.
 */
export function parseRocketViewPayload(payload: unknown): RocketViewPayload | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const coordinate = (payload as { coordinate?: unknown }).coordinate;
  if (typeof coordinate !== "string") return undefined;
  const trimmed = coordinate.trim();
  if (!trimmed) return undefined;
  try {
    parseRocketCoordinate(trimmed);
  } catch (error) {
    console.warn("Rocket view payload rejected; coordinate is malformed", { coordinate: trimmed, error });
    return undefined;
  }
  return { coordinate: trimmed };
}
