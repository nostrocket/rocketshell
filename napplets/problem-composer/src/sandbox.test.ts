import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

const composeSource = read("compose-view.ts");
const reviseSource = read("revise-view.ts");
const mainSource = read("main.ts");

describe("sandboxed problem composer markup", () => {
  for (const [name, source] of [["compose", composeSource], ["revise", reviseSource]] as const) {
    it(`${name} mode uses scripted controls without native form submission`, () => {
      expect(source).not.toContain("<form");
      expect(source).not.toContain('addEventListener("submit"');
      expect(source).toContain('type="button"');
      expect(source).toContain('key === "Enter"');
      expect(source).toContain("preventDefault()");
    });
  }
});

describe("composer identity handling", () => {
  it("guards genesis publication on a validated shell identity before building event identity", () => {
    const publishStart = composeSource.indexOf("async function publishProblem()");
    const guard = composeSource.indexOf("if (!identityReady()) {", publishStart);
    const build = composeSource.indexOf("buildProblemTemplate(", publishStart);
    expect(publishStart).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(publishStart);
    expect(guard).toBeLessThan(build);
  });

  it("tracks shell identity changes so a late sign-in re-enables both modes", () => {
    expect(mainSource).toContain("identity.onChanged(");
    expect(mainSource).toContain("identitySubscription?.close()");
    expect(composeSource).toContain("ctx.onIdentityChanged(");
    expect(reviseSource).toContain("ctx.onIdentityChanged(");
  });
});

describe("composer intent routing", () => {
  it("registers both composer conventions before awaiting identity", () => {
    const register = mainSource.indexOf("inc.on(CHILD_CONVENTION");
    const edit = mainSource.indexOf("inc.on(EDIT_CONVENTION");
    const identity = mainSource.indexOf("await identity.getPublicKey()");
    expect(register).toBeGreaterThan(-1);
    expect(edit).toBeGreaterThan(register);
    expect(identity).toBeGreaterThan(edit);
  });

  it("validates both delivered payloads with the shared exact-shape guard", () => {
    expect(mainSource).toContain("isProblemIdPayload(event.payload)");
    expect(mainSource.match(/isProblemIdPayload\(event\.payload\)/g)).toHaveLength(2);
  });
});
