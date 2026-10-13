import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("sandboxed problem editor markup", () => {
  it("uses scripted controls without native form submission", () => {
    expect(source).not.toContain("<form");
    expect(source).not.toContain('addEventListener("submit"');
    expect(source).toContain('type="button"');
    expect(source).toContain('event.key === "Enter"');
    expect(source).toContain("event.preventDefault()");
  });
});

describe("problem publishing identity", () => {
  it("guards publication on a validated shell identity before building event identity", () => {
    const publishStart = source.indexOf("async function publishProblem()");
    const guard = source.indexOf("if (!identityReady()) {", publishStart);
    const build = source.indexOf("buildProblemTemplate(", publishStart);
    expect(publishStart).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(publishStart);
    expect(guard).toBeLessThan(build);
  });

  it("tracks shell identity changes so a late sign-in re-enables publishing", () => {
    expect(source).toContain("identity.onChanged(");
    expect(source).toContain("identitySubscription?.close()");
  });
});
