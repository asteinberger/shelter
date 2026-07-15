import { describe, expect, it } from "vitest";
import { parseGlobalArguments, parseOptions, requiredOption } from "../src/arguments.js";

describe("CLI argument parsing", () => {
  it("accepts global JSON mode in any position", () => {
    expect(parseGlobalArguments(["deploy", "prj_123", "--json", "--wait"])).toEqual({
      args: ["deploy", "prj_123", "--wait"],
      json: true,
      help: false,
      version: false
    });
  });

  it("parses values, equals syntax, flags, and positional arguments", () => {
    const parsed = parseOptions(
      ["prj_123", "--name", "Example", "--branch=main", "--wait"],
      ["name", "branch"],
      ["wait"]
    );
    expect(parsed.positionals).toEqual(["prj_123"]);
    expect(parsed.values).toEqual({ name: "Example", branch: "main" });
    expect([...parsed.flags]).toEqual(["wait"]);
    expect(requiredOption(parsed, "name")).toBe("Example");
  });

  it("rejects unknown, duplicate, and missing options", () => {
    expect(() => parseOptions(["--wat"], [], [])).toThrow(/Unknown option/);
    expect(() => parseOptions(["--name", "one", "--name", "two"], ["name"])).toThrow(/once/);
    expect(() => parseOptions(["--name"], ["name"])).toThrow(/requires a value/);
  });
});
