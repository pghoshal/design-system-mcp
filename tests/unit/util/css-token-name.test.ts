import { describe, expect, it } from "vitest";
import { cssTokenName, cssTokenVar } from "../../../src/util/css-token-name.js";

describe("css-token-name", () => {
  it("keeps ordinary token paths unchanged except for separators", () => {
    expect(cssTokenName(["color", "action", "primary"])).toBe("color-action-primary");
    expect(cssTokenVar(["color", "action", "primary"])).toBe("--color-action-primary");
  });

  it("sanitizes token-set names that are valid source paths but invalid CSS names", () => {
    expect(cssTokenName(["light/color", "color", "action", "disabled"])).toBe(
      "light_u002f_color-color-action-disabled",
    );
    expect(cssTokenVar(["dark/color", "color", "background", "default"])).toBe(
      "--dark_u002f_color-color-background-default",
    );
  });

  it("does not collapse distinct source paths into the same CSS custom property", () => {
    expect(cssTokenVar(["light/color", "color", "brand"])).toBe("--light_u002f_color-color-brand");
    expect(cssTokenVar(["light-color", "color", "brand"])).toBe("--light_u002d_color-color-brand");
    expect(cssTokenVar(["", "color"])).toBe("--_u0000_-color");
    expect(cssTokenVar(["empty", "color"])).toBe("--empty-color");
  });
});
