import { lstat, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

import {
  ActionExecutorError,
  type ActionExecutor,
  type ActionExecutorInput,
  type ActionExecutorResult,
} from "./action-executor.js";

/** The only operation this executor performs. */
export const WORKSPACE_DELETE_OPERATION = "delete_path";

/**
 * Exact payload of an executable `filesystem.destructive` action. The path is
 * relative to the workspace root. The approval is bound to this payload, so the
 * owner approves one exact path.
 */
export const workspaceDeletePayloadSchema = z
  .object({
    operation: z.literal(WORKSPACE_DELETE_OPERATION),
    path: z.string().trim().min(1).max(1_024),
  })
  .strict();

/** Tasks need the workspace repository itself, so an action may not delete it. */
const PROTECTED_TOP_LEVEL_NAMES = new Set([".git"]);

function refuse(code: string, safeMessage: string): ActionExecutorError {
  return new ActionExecutorError(code, safeMessage, false, safeMessage);
}

function isInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation !== "" && !relation.startsWith("..") && !isAbsolute(relation)
  );
}

/**
 * Deletes one approved file or directory inside the agent workspace.
 *
 * The executor refuses an absolute path, a path with a `..` segment, the
 * workspace root, the workspace repository (`.git`), and a path whose parent
 * resolves outside the workspace through a symbolic link. A symbolic link is
 * removed as a link; its target is not followed. A path that is already absent
 * is a success, so a repeated execution of the same approval is safe.
 */
export class WorkspaceDeleteExecutor implements ActionExecutor {
  public readonly actionType = "filesystem.destructive" as const;
  readonly #workspaceRoot: string;

  public constructor(options: { workspaceRoot: string }) {
    if (!isAbsolute(options.workspaceRoot)) {
      throw new Error("The workspace delete executor needs an absolute root.");
    }
    this.#workspaceRoot = resolve(options.workspaceRoot);
  }

  public async execute(
    input: ActionExecutorInput,
  ): Promise<ActionExecutorResult> {
    const parsed = workspaceDeletePayloadSchema.safeParse(
      input.normalizedPayload,
    );
    if (!parsed.success) {
      throw refuse(
        "WORKSPACE_DELETE_PAYLOAD_INVALID",
        'The approved action is not an executable deletion. The payload must be {"operation":"delete_path","path":"<path relative to the workspace>"}.',
      );
    }
    const requested = parsed.data.path;
    const segments = requested.split(/[\\/]+/u).filter((part) => part !== "");
    if (
      isAbsolute(requested) ||
      /^[a-z]:[\\/]/iu.test(requested) ||
      segments.length === 0 ||
      segments.includes("..") ||
      segments.includes(".")
    ) {
      throw refuse(
        "WORKSPACE_DELETE_PATH_REFUSED",
        "The deletion path must be a plain path relative to the workspace root.",
      );
    }
    if (PROTECTED_TOP_LEVEL_NAMES.has(segments[0]!) && segments.length === 1) {
      throw refuse(
        "WORKSPACE_DELETE_PATH_PROTECTED",
        "The workspace repository itself cannot be deleted.",
      );
    }

    const root = await realpath(this.#workspaceRoot);
    const candidate = resolve(root, segments.join(sep));
    let parent: string;
    try {
      parent = await realpath(dirname(candidate));
    } catch {
      return this.#result(requested, false);
    }
    if (parent !== root && !isInside(root, parent)) {
      throw refuse(
        "WORKSPACE_DELETE_PATH_REFUSED",
        "The deletion path resolves outside the workspace.",
      );
    }
    const target = resolve(parent, segments[segments.length - 1]!);
    try {
      await lstat(target);
    } catch {
      return this.#result(requested, false);
    }
    await rm(target, { recursive: true, force: true });
    return this.#result(requested, true);
  }

  #result(path: string, existed: boolean): ActionExecutorResult {
    return {
      safeSummary: existed
        ? `Deleted ${path} from the workspace.`
        : `${path} was already absent from the workspace.`,
      providerReference: null,
      safeMetadata: { path, existed },
    };
  }
}
