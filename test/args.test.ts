import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args";

describe("parseCliArgs", () => {
  it("defaults to run with no args", () => {
    expect(parseCliArgs([])).toEqual({ kind: "run" });
  });
  it("recognises version and help", () => {
    expect(parseCliArgs(["--version"]).kind).toBe("version");
    expect(parseCliArgs(["-v"]).kind).toBe("version");
    expect(parseCliArgs(["--help"]).kind).toBe("help");
    expect(parseCliArgs(["-h"]).kind).toBe("help");
    expect(parseCliArgs(["--discovery-status"])).toEqual({ kind: "discovery-status" });
    expect(parseCliArgs(["--log-file"])).toEqual({ kind: "log-file" });
  });
  it("treats plain args as an initial query", () => {
    expect(parseCliArgs(["ubuntu", "24.04"])).toEqual({
      kind: "run",
      initialQuery: "ubuntu 24.04",
    });
  });
  it("rejects unknown flags", () => {
    expect(parseCliArgs(["--nope"])).toEqual({ kind: "invalid", arg: "--nope" });
  });
});
