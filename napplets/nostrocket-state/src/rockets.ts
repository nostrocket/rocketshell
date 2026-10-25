import type { NostrEvent } from "./state";

export const NOSTROCKET_AUTHOR = "d91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075";
export const NOSTROCKET_COORDINATE = `31108:${NOSTROCKET_AUTHOR}:NOSTROCKET`;

export type RocketOption = { coordinate: string; name: string; author: string; event?: NostrEvent };
const PUBKEY = /^[0-9a-f]{64}$/;

export function rocketsFromEvents(events: NostrEvent[]): RocketOption[] {
  const latest = new Map<string, RocketOption>();
  for (const event of events) {
    if (event.kind !== 31108 || !PUBKEY.test(event.pubkey)) continue;
    const name = event.tags.find(([tag]) => tag === "d")?.[1]?.trim();
    if (!name) continue;
    const coordinate = `31108:${event.pubkey}:${name}`;
    const current = latest.get(coordinate)?.event;
    if (!current || event.created_at > current.created_at || (event.created_at === current.created_at && event.id > current.id)) {
      latest.set(coordinate, { coordinate, name, author: event.pubkey, event });
    }
  }
  return [...latest.values()].sort((left, right) => left.coordinate === NOSTROCKET_COORDINATE ? -1 : right.coordinate === NOSTROCKET_COORDINATE ? 1 : left.name.localeCompare(right.name) || left.coordinate.localeCompare(right.coordinate));
}
