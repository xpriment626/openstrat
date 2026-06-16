import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureOpenStratHome,
  getPiAuthPath,
  projectObjectRef,
  projectObjectRoot,
  registerProject,
  resolveOpenStratHome,
  safePurgeOpenStratHome
} from "./home.js";

describe("OpenStrat local home", () => {
  it("creates the dev-v0 state tree under the user's .openstrat directory", () => {
    const userHome = mkdtempSync(join(tmpdir(), "openstrat-home-"));
    const home = resolveOpenStratHome({ userHome });

    ensureOpenStratHome(home);

    expect(home.root).toBe(join(userHome, ".openstrat", "dev-v0"));
    expect(existsSync(home.configPath)).toBe(true);
    expect(existsSync(home.stateDbPath)).toBe(true);
    expect(existsSync(home.objectsDir)).toBe(true);
    expect(existsSync(home.sessionsDir)).toBe(true);
    expect(existsSync(home.projectsDir)).toBe(true);
    expect(existsSync(home.scratchDir)).toBe(true);
    expect(existsSync(home.logsDir)).toBe(true);
    expect(getPiAuthPath(home)).toBe(join(home.root, "auth", "pi-auth.json"));
  });

  it("registers projects idempotently", () => {
    const userHome = mkdtempSync(join(tmpdir(), "openstrat-home-"));
    const project = mkdtempSync(join(tmpdir(), "openstrat-project-"));
    const home = resolveOpenStratHome({ userHome });
    ensureOpenStratHome(home);

    const first = registerProject(home, project);
    const second = registerProject(home, project);

    expect(second).toEqual(first);
    expect(JSON.parse(readFileSync(first.ref, "utf8"))).toMatchObject({
      cwd: project
    });
  });

  it("derives project-scoped object refs from the registered cwd", () => {
    const userHome = mkdtempSync(join(tmpdir(), "openstrat-home-"));
    const project = mkdtempSync(join(tmpdir(), "openstrat-project-"));
    const home = resolveOpenStratHome({ userHome });
    ensureOpenStratHome(home);

    const registration = registerProject(home, project);

    expect(projectObjectRoot(registration)).toBe(`projects/${registration.id}`);
    expect(
      projectObjectRef(
        registration,
        "workbench",
        "strategy-validations",
        "local_strategy",
        "result.json"
      )
    ).toBe(
      `projects/${registration.id}/workbench/strategy-validations/local_strategy/result.json`
    );
    expect(() => projectObjectRef(registration, "..", "escape.json")).toThrow(
      /Invalid project object ref segment/
    );
  });

  it("purges only a safe dev-v0 tree under .openstrat", () => {
    const userHome = mkdtempSync(join(tmpdir(), "openstrat-home-"));
    const home = resolveOpenStratHome({ userHome });
    ensureOpenStratHome(home);

    const result = safePurgeOpenStratHome(home);

    expect(result.deleted).toBe(true);
    expect(existsSync(home.root)).toBe(false);
    expect(() =>
      safePurgeOpenStratHome({
        ...home,
        root: join(userHome, "not-openstrat", "dev-v0")
      })
    ).toThrow(/Refusing to purge unsafe OpenStrat home/);
  });
});
