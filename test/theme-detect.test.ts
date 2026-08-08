import { afterEach, describe, expect, it } from "vitest";

import { lightColors, darkColors } from "../src/tui/theme/colors.ts";
import { parseColorFgBg, themeFromBackground } from "../src/tui/theme/detect.ts";
import { currentTheme } from "../src/tui/theme/theme.ts";

describe("terminal background detection (#23)", () => {
  it("computes theme from relative luminance", () => {
    expect(themeFromBackground({ r: 255, g: 255, b: 255 })).toBe("light");
    expect(themeFromBackground({ r: 0, g: 0, b: 0 })).toBe("dark");
    expect(themeFromBackground({ r: 30, g: 30, b: 46 })).toBe("dark");
    expect(themeFromBackground({ r: 250, g: 250, b: 240 })).toBe("light");
  });

  it("parses COLORFGBG fallback", () => {
    expect(parseColorFgBg("0;15")).toBe("light");
    expect(parseColorFgBg("15;0")).toBe("dark");
    expect(parseColorFgBg("7;8")).toBe("dark"); // 亮黑≈中灰，按暗色（同 kimi-code）
    expect(parseColorFgBg("0;7")).toBe("light");
    expect(parseColorFgBg(undefined)).toBeUndefined();
    expect(parseColorFgBg("garbage")).toBeUndefined();
    expect(parseColorFgBg("1;99")).toBeUndefined();
  });

  it("light palette is complete and distinct from dark", () => {
    expect(Object.keys(lightColors).sort()).toEqual(Object.keys(darkColors).sort());
    expect(lightColors.text).not.toBe(darkColors.text);
  });

  describe("currentTheme switching", () => {
    afterEach(() => currentTheme.setTheme("dark"));

    it("setTheme switches palette lookups in place", () => {
      expect(currentTheme.current).toBe("dark");
      expect(currentTheme.color("text")).toBe(darkColors.text);

      currentTheme.setTheme("light");

      expect(currentTheme.current).toBe("light");
      expect(currentTheme.color("text")).toBe(lightColors.text);
    });
  });
});
