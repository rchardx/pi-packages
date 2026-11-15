import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

/**
 * How a command ended, classified at the operations seam where pi's contract
 * is stable — `{ exitCode }`, `"aborted"`, `"timeout:<seconds>"` — rather than
 * from the formatted error text the tool layer builds for humans.
 */
export type JobOutcome =
  | { readonly kind: "exit"; readonly exitCode: number }
  | { readonly kind: "aborted" }
  | { readonly kind: "timeout"; readonly seconds: number }
  | { readonly kind: "error"; readonly message: string };

const TIMEOUT_PREFIX = "timeout:";

export interface TeeOperations {
  /** The operations to hand to the wrapped bash tool definition. */
  operations: BashOperations;
  /**
   * Stop forwarding output to the wrapped tool. After backgrounding, the inner
   * tool's accumulator no longer grows (its final result is discarded anyway),
   * which avoids persisting a second copy of chatty output to a temp file.
   */
  stopForwarding(): void;
  /** The command's outcome once it settled; undefined before that. */
  outcome(): JobOutcome | undefined;
}

/**
 * Wrap pi's built-in local shell backend with a tee of the raw output for the
 * job's log file and in-memory tail. All process behavior — shell resolution,
 * pipe draining after exit, timeout and abort process-tree kills, crash
 * cleanup tracking — stays with pi's own implementation.
 */
export function createTeeOperations(
  tee: (data: Buffer) => void,
  options?: { shellPath?: string },
): TeeOperations {
  const local = createLocalBashOperations(
    options?.shellPath ? { shellPath: options.shellPath } : {},
  );
  let forwarding = true;
  let settled: JobOutcome | undefined;
  return {
    operations: {
      exec: (command, cwd, execOptions) =>
        local
          .exec(command, cwd, {
            ...execOptions,
            onData: (data) => {
              tee(data);
              if (forwarding) execOptions.onData(data);
            },
          })
          .then(
            ({ exitCode }) => {
              settled =
                exitCode === null
                  ? { kind: "error", message: "Command terminated without an exit code" }
                  : { kind: "exit", exitCode };
              return { exitCode };
            },
            (error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              if (message === "aborted") {
                settled = { kind: "aborted" };
              } else if (message.startsWith(TIMEOUT_PREFIX)) {
                settled = {
                  kind: "timeout",
                  seconds: Number(message.slice(TIMEOUT_PREFIX.length)),
                };
              } else {
                settled = { kind: "error", message };
              }
              throw error;
            },
          ),
    },
    stopForwarding: () => {
      forwarding = false;
    },
    outcome: () => settled,
  };
}
