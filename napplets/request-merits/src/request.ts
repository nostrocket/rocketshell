export type SolutionType = "url" | "text";
export interface MeritRequestDraft {
  rocket: string;
  problem: string;
  solution: string;
  solutionType: SolutionType;
  sats: string;
}
export interface MeritRequestTemplate { kind: 1409; created_at: number; content: ""; tags: string[][] }

const ROCKET = /^31108:[0-9a-f]{64}:.+$/s;
const INTEGER = /^(0|[1-9][0-9]*)$/;

export function validateDraft(draft: MeritRequestDraft): string[] {
  const errors: string[] = [];
  const rocket = draft.rocket.trim();
  const problem = draft.problem.trim();
  const solution = draft.solution.trim();
  if (!ROCKET.test(rocket)) errors.push("Rocket must be 31108:<64-character pubkey>:<rocket d-tag>.");
  if (!problem) errors.push("Describe problem or work addressed.");
  if (!INTEGER.test(draft.sats.trim()) || BigInt(draft.sats.trim() || "0") <= 0n) errors.push("Work value must be a positive integer number of sats.");
  if (solution && draft.solutionType === "url" && !isProofUrl(solution)) errors.push("Proof URL must use http:// or https://.");
  return errors;
}

function isProofUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.hostname);
  } catch (error) {
    console.warn("Merit request proof URL validation failed", { value, error });
    return false;
  }
}

export function buildMeritRequest(draft: MeritRequestDraft, createdAt: number): MeritRequestTemplate {
  const normalized = {
    ...draft,
    rocket: draft.rocket.trim(), problem: draft.problem.trim(), solution: draft.solution.trim(),
    sats: draft.sats.trim()
  };
  const errors = validateDraft(normalized);
  if (errors.length) throw new Error(errors.join(" "));
  const tags: string[][] = [["problem", "text", normalized.problem]];
  if (normalized.solution) tags.push(["solution", normalized.solutionType, normalized.solution]);
  tags.push(["a", normalized.rocket], ["merits", normalized.sats], ["sats", normalized.sats]);
  return { kind: 1409, created_at: createdAt, content: "", tags };
}

export interface PublishOptions {
  relays?: string[];
  toOutbox?: boolean;
  toInboxes?: string[];
}

export async function publishMeritRequest(
  publish: (template: MeritRequestTemplate, options: PublishOptions) => Promise<{ ok: boolean; event?: { id: string; pubkey?: string }; error?: string }>,
  template: MeritRequestTemplate,
  options: PublishOptions = { toOutbox: true }
): Promise<{ id: string; pubkey?: string }> {
  const result = await publish(template, options);
  if (!result.ok || !result.event?.id) throw new Error(result.error ?? "Shell did not return a published merit request.");
  return { id: result.event.id, pubkey: result.event.pubkey };
}
