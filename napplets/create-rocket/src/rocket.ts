export interface RocketDraft { identifier: string; mission: string; problemCoordinate: string; problemRelay: string; repoCoordinate: string; repoRelay: string }
export interface EventTemplate { kind: 31108; created_at: number; content: ""; tags: string[][] }
export interface RocketIdentifierEvent { kind: number; tags: string[][] }

const PROBLEM_COORDINATE = /^31971:[0-9a-f]{64}:[0-9a-f]{64}$/;
const REPOSITORY_COORDINATE = /^30617:[0-9a-f]{64}:.+$/s;

export function validateDraft(draft: RocketDraft): string[] {
  const errors: string[] = [];
  if (!draft.identifier.trim()) errors.push("Identifier is required.");
  if ([...draft.mission.trim()].length >= 140) errors.push("Mission must contain fewer than 140 characters.");
  validateOptional("problem", draft.problemCoordinate.trim(), draft.problemRelay.trim(), PROBLEM_COORDINATE, "31971:<64-char pubkey>:<64-char problem id>", errors);
  validateOptional("repository", draft.repoCoordinate.trim(), draft.repoRelay.trim(), REPOSITORY_COORDINATE, "30617:<64-char pubkey>:<d-tag>", errors);
  return errors;
}

export function rocketIdentifier(event: RocketIdentifierEvent): string | undefined {
  if (event.kind !== 31108) return undefined;
  const identifier = event.tags.find((tag) => tag[0] === "d")?.[1]?.trim();
  return identifier || undefined;
}

export function normalizeRocketIdentifier(identifier: string): string {
  return identifier.trim().toLocaleLowerCase("en-US");
}

export function hasObservedRocketIdentifier(identifier: string, observed: ReadonlySet<string>): boolean {
  const normalized = normalizeRocketIdentifier(identifier);
  return normalized.length > 0 && observed.has(normalized);
}

function validateOptional(label: string, coordinate: string, relay: string, coordinatePattern: RegExp, shape: string, errors: string[]): void {
  if (!coordinate && relay) errors.push(`${label} relay requires a ${label} coordinate.`);
  if (coordinate && !coordinatePattern.test(coordinate)) errors.push(`${label} coordinate must be ${shape}.`);
  if (relay && !isSecureRelayUrl(relay)) errors.push(`${label} relay must be a wss:// URL.`);
}

function isSecureRelayUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "wss:" && Boolean(url.hostname) && !url.username && !url.password; }
  catch (error) { console.warn("Rocket relay URL validation failed", { value, error }); return false; }
}

export function buildIgnitionTemplate(draft: RocketDraft, createdAt: number): EventTemplate {
  const normalized = { ...draft, identifier: draft.identifier.trim(), mission: draft.mission.trim(), problemCoordinate: draft.problemCoordinate.trim(), problemRelay: draft.problemRelay.trim(), repoCoordinate: draft.repoCoordinate.trim(), repoRelay: draft.repoRelay.trim() };
  const errors = validateDraft(normalized);
  if (errors.length) throw new Error(errors.join(" "));
  const tags: string[][] = [["d", normalized.identifier], ["ruleset", "334000"], ["ignition", "this"], ["parent", "this"]];
  if (normalized.mission) tags.push(["mission", normalized.mission]);
  if (normalized.problemCoordinate) tags.push(["problem", normalized.problemCoordinate, normalized.problemRelay]);
  if (normalized.repoCoordinate) tags.push(["repo", normalized.repoCoordinate, normalized.repoRelay]);
  return { kind: 31108, created_at: createdAt, content: "", tags };
}

export interface PublishOptions {
  toOutbox?: boolean;
  relays?: string[];
  toInboxes?: string[];
}

export async function publishIgnition(
  publish: (template: EventTemplate, options?: PublishOptions) => Promise<{ ok: boolean; event?: { id: string }; error?: string }>,
  template: EventTemplate,
  options: PublishOptions = { toOutbox: true }
): Promise<string> {
  const result = await publish(template, options);
  if (!result.ok || !result.event?.id) throw new Error(result.error ?? "Shell did not return a published event.");
  return result.event.id;
}
