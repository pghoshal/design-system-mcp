import { describe, expect, it } from "vitest";
import {
  ComponentMetadataSchema,
  PlatformMappingSchema,
  TokenEntityDataSchema,
} from "../../../src/bundle/schema.js";

describe("strict bundle schemas", () => {
  it("validates token entity data and token replacement ids", () => {
    const valid = TokenEntityDataSchema.safeParse({
      name: "color-action-primary",
      path: ["color", "action", "primary"],
      value: "#2563EB",
      original: "{color.blue.500}",
      $type: "color",
      deprecated: "Use token:color.action.primaryStrong instead.",
      replacement: "token:color.action.primaryStrong",
    });
    const invalidReplacement = TokenEntityDataSchema.safeParse({
      name: "color-action-legacy",
      path: ["color", "action", "legacy"],
      value: "#1D4ED8",
      replacement: "color.action.primary",
    });

    expect(valid.success).toBe(true);
    expect(invalidReplacement.success).toBe(false);
  });

  it("validates component platform mappings for native and web consumers", () => {
    const reactNative = PlatformMappingSchema.safeParse({
      platform: "react-native",
      framework: "react-native",
      package: "@acme/mobile-ui",
      importPath: "@acme/mobile-ui/button",
      component: "Button",
      tokens: {
        backgroundColor: "token:color.action.primary",
      },
      notes: ["Use Pressable semantics."],
    });
    const customPlatform = PlatformMappingSchema.safeParse({
      platform: "flutter",
      framework: "dart",
      component: "Button",
    });

    expect(reactNative.success).toBe(true);
    expect(customPlatform.success).toBe(true);
  });

  it("bounds custom platform mapping identifiers", () => {
    const invalidPlatform = PlatformMappingSchema.safeParse({
      platform: "../ios",
      component: "Button",
    });
    const invalidFramework = PlatformMappingSchema.safeParse({
      platform: "web",
      framework: "react native with spaces",
      component: "Button",
    });

    expect(invalidPlatform.success).toBe(false);
    expect(invalidFramework.success).toBe(false);
  });

  it("includes platform mappings in component metadata", () => {
    const result = ComponentMetadataSchema.safeParse({
      id: "component:button",
      type: "component",
      name: "Button",
      summary: "Triggers an action.",
      importPath: "@acme/ui/button",
      platforms: [
        {
          platform: "ios",
          framework: "swiftui",
          component: "AcmeButton",
          importPath: "AcmeUI.AcmeButton",
          tokens: {
            foregroundColor: "token:color.text.inverse",
          },
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.data?.platforms[0]?.platform).toBe("ios");
  });
});
