import { describe, expect, it } from "vitest";
import {
  CommandCancelledError,
  CommandTimeoutError,
  runCommand
} from "../src/lib/command.js";

describe("runCommand cancellation and timeouts", () => {
  it("terminates a process group when its hard timeout expires", async () => {
    await expect(runCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { timeoutMs: 50 }
    )).rejects.toBeInstanceOf(CommandTimeoutError);
  });

  it("cooperatively aborts a running process through AbortSignal", async () => {
    const controller = new AbortController();
    const command = runCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { signal: controller.signal, timeoutMs: 5_000 }
    );
    setTimeout(() => controller.abort(), 50);

    await expect(command).rejects.toBeInstanceOf(CommandCancelledError);
  });

  it("does not spawn when the signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runCommand(process.execPath, ["--version"], {
      signal: controller.signal
    })).rejects.toBeInstanceOf(CommandCancelledError);
  });

  it("supports a larger bounded output window for binary transport encodings", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write('a'.repeat(1_100_000))"],
      { maxOutputChars: 1_200_000 }
    );
    expect(result.stdout).toHaveLength(1_100_000);
  });
});
