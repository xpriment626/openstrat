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
  it("creates the state tree under the project .openstrat directory", () => {
    const userHome = mkdtempSync(join(tmpdir(), "openstrat-home-"));
    const project = mkdtempSync(join(tmpdir(), "openstrat-project-"));
    const home = resolveOpenStratHome({ cwd: project, userHome });

    ensureOpenStratHome(home);

    expect(home.root).toBe(join(project, ".openstrat"));
    expect(JSON.parse(readFileSync(home.configPath, "utf8"))).toMatchObject({
      epoch: "project-v0",
      version: 1
    });
    expect(existsSync(home.configPath)).toBe(true);
    expect(existsSync(home.stateDbPath)).toBe(true);
    expect(existsSync(home.objectsDir)).toBe(true);
    expect(existsSync(home.sessionsDir)).toBe(true);
    expect(existsSync(home.projectsDir)).toBe(true);
    expect(existsSync(home.scratchDir)).toBe(true);
    expect(existsSync(home.logsDir)).toBe(true);
    expect(getPiAuthPath(home)).toBe(join(home.root, "auth", "pi-auth.json"));
  });

  it("uses OPENSTRAT_HOME as an explicit override for tests and custom runtimes", () => {
    const userHome = mkdtempSync(join(tmpdir(), "openstrat-home-"));
    const project = mkdtempSync(join(tmpdir(), "openstrat-project-"));
    const override = join(userHome, "custom-openstrat-home");

    const home = resolveOpenStratHome({
      cwd: project,
      env: { OPENSTRAT_HOME: override },
      userHome
    });

    expect(home.root).toBe(override);
  });

  it("registers projects idempotently", () => {
    const userHome = mkdtempSync(join(tmpdir(), "openstrat-home-"));
    const project = mkdtempSync(join(tmpdir(), "openstrat-project-"));
    const home = resolveOpenStratHome({ cwd: project, userHome });
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
    const home = resolveOpenStratHome({ cwd: project, userHome });
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

  it("purges only a safe project .openstrat tree", () => {
    const userHome = mkdtempSync(join(tmpdir(), "openstrat-home-"));
    const project = mkdtempSync(join(tmpdir(), "openstrat-project-"));
    const home = resolveOpenStratHome({ cwd: project, userHome });
    ensureOpenStratHome(home);

    const result = safePurgeOpenStratHome(home);

    expect(result.deleted).toBe(true);
    expect(existsSync(home.root)).toBe(false);
    expect(() =>
      safePurgeOpenStratHome({
        ...home,
        root: join(userHome, "not-openstrat")
      })
    ).toThrow(/Refusing to purge unsafe OpenStrat home/);
  });
});
