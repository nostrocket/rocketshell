export interface PublishResult {
  readonly ok: boolean;
  readonly event?: { readonly id: string };
  readonly relays?: Readonly<Record<string, boolean>>;
  readonly error?: string;
}

const shortId = (id: string) => `${id.slice(0, 12)}…`;

/** Genesis publish copy: partial relay acceptance still reads as published. */
export function publishSuccessMessage(result: PublishResult): string {
  const outcomes = Object.values(result.relays ?? {});
  const accepted = outcomes.filter(Boolean).length;
  if (!result.event || (!result.ok && accepted === 0)) {
    throw new Error(result.error ?? "Shell could not publish the problem.");
  }
  const id = shortId(result.event.id);
  return result.ok || outcomes.length === 0
    ? `Published · ${id}`
    : `Published to ${accepted} of ${outcomes.length} relays · ${id}`;
}

/** Revision publish copy: distinguishes "no relay accepted" from a shell failure. */
export function revisionPublishMessage(result: PublishResult): string {
  const outcomes = Object.values(result.relays ?? {});
  const accepted = outcomes.filter(Boolean).length;
  if (!result.event || (!result.ok && accepted === 0)) {
    if (outcomes.length > 0) throw new Error(`No relay accepted the revision (0 of ${outcomes.length}).`);
    throw new Error(result.error ?? "Shell could not publish the revision.");
  }
  const eventId = shortId(result.event.id);
  return result.ok || outcomes.length === 0
    ? `Revision published · ${eventId}`
    : `Revision published to ${accepted} of ${outcomes.length} relays · ${eventId}`;
}
