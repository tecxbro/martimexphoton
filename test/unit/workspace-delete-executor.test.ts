import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ActionExecutorError } from "../../src/actions/action-executor.js";
import { ActionExecutorRegistry } from "../../src/actions/action-executor-registry.js";
import { WorkspaceDeleteExecutor } from "../../src/actions/workspace-delete-executor.js";

const created: string[] = [];

async function workspace(): Promise<{ root: string; outside: string }> {
  const base = await mkdtemp(join(tmpdir(), "workspace-delete-test-"));
  created.push(base);
  const root = join(base, "workspaces");
  const outside = join(base, "outside");
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "ProofOfHuman", "src"), { recursive: true });
  await writeFile(join(root, "ProofOfHuman", "src", "index.js"), "x");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "keep me");
  return { root, outside };
}

function action(path: unknown, operation: unknown = "delete_path") {
  return {
    actionExecutionId: "00000000-0000-4000-8000-000000000001",
    actionType: "filesystem.destructive" as const,
    target: String(path),
    normalizedPayload: { operation, path } as never,
  };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("workspace delete executor", () => {
  it("deletes the approved directory and nothing else", async () => {
    const { root, outside } = await workspace();
    const executor = new WorkspaceDeleteExecutor({ workspaceRoot: root });

    const result = await executor.execute(action("ProofOfHuman"));

    expect(await exists(join(root, "ProofOfHuman"))).toBe(false);
    expect(await exists(join(root, ".git"))).toBe(true);
    expect(await exists(join(outside, "secret.txt"))).toBe(true);
    expect(result.safeMetadata).toEqual({ path: "ProofOfHuman", existed: true });
  });

  it("reports success when the path is already absent, so a repeated execution is safe", async () => {
    const { root } = await workspace();
    const executor = new WorkspaceDeleteExecutor({ workspaceRoot: root });

    await executor.execute(action("ProofOfHuman"));
    const second = await executor.execute(action("ProofOfHuman"));

    expect(second.safeMetadata).toEqual({ path: "ProofOfHuman", existed: false });
  });

  it.each([
    ["an absolute path", "/etc"],
    ["a parent segment", "../outside"],
    ["a nested parent segment", "ProofOfHuman/../../outside"],
    ["the workspace root", "."],
    ["the workspace repository", ".git"],
  ])("refuses %s and deletes nothing", async (_name, path) => {
    const { root, outside } = await workspace();
    const executor = new WorkspaceDeleteExecutor({ workspaceRoot: root });

    await expect(executor.execute(action(path))).rejects.toBeInstanceOf(
      ActionExecutorError,
    );
    expect(await exists(join(root, "ProofOfHuman"))).toBe(true);
    expect(await exists(join(root, ".git"))).toBe(true);
    expect(await exists(join(outside, "secret.txt"))).toBe(true);
  });

  it("refuses a path that leaves the workspace through a symbolic link", async () => {
    const { root, outside } = await workspace();
    await symlink(outside, join(root, "escape"));
    const executor = new WorkspaceDeleteExecutor({ workspaceRoot: root });

    await expect(
      executor.execute(action("escape/secret.txt")),
    ).rejects.toBeInstanceOf(ActionExecutorError);
    expect(await exists(join(outside, "secret.txt"))).toBe(true);
  });

  it("removes a symbolic link itself and keeps its target", async () => {
    const { root, outside } = await workspace();
    await symlink(outside, join(root, "escape"));
    const executor = new WorkspaceDeleteExecutor({ workspaceRoot: root });

    await executor.execute(action("escape"));

    expect(await exists(join(root, "escape"))).toBe(false);
    expect(await exists(join(outside, "secret.txt"))).toBe(true);
  });

  it.each([
    ["another operation", action("ProofOfHuman", "overwrite")],
    ["a missing path", action(undefined)],
    ["an extra key", { ...action("ProofOfHuman"), normalizedPayload: { operation: "delete_path", path: "ProofOfHuman", force: true } as never }],
  ])("refuses a payload with %s", async (_name, input) => {
    const { root } = await workspace();
    const executor = new WorkspaceDeleteExecutor({ workspaceRoot: root });

    await expect(executor.execute(input)).rejects.toBeInstanceOf(
      ActionExecutorError,
    );
    expect(await exists(join(root, "ProofOfHuman"))).toBe(true);
  });

  it("is the executor for filesystem.destructive, and no other action type has one", () => {
    const registry = new ActionExecutorRegistry([
      new WorkspaceDeleteExecutor({ workspaceRoot: "/data/workspaces" }),
    ]);

    expect(registry.supports("filesystem.destructive")).toBe(true);
    expect(registry.supports("external.send")).toBe(false);
  });
});
