import { describe, expect, test } from "vitest";
import { parseRuntimeArgs } from "../src/runtime-args.js";

describe("runtime args", () => {
  test("parses verbose flags", () => {
    expect(parseRuntimeArgs([])).toEqual({ verbose: false });
    expect(parseRuntimeArgs(["--verbose"])).toEqual({ verbose: true });
    expect(parseRuntimeArgs(["-v"])).toEqual({ verbose: true });
  });

  test("rejects unknown runtime flags", () => {
    expect(() => parseRuntimeArgs(["--unknown"])).toThrow(/Unknown argument/);
  });
});
