import { describe, expect, it } from "vitest";
import { KIRO_NATIVE_TOOLS } from "../src/kiro-tools";

// Covers the static native Kiro CLI tool schemas (src/kiro-tools.ts). These
// are injected verbatim so the request is structurally identical to the real
// client (conformance §11-ish, fidelity contract). The tests lock the
// structural invariants rather than the full schema text, so intentional
// schema edits stay easy while accidental shape regressions fail loudly.

describe("KIRO_NATIVE_TOOLS", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(KIRO_NATIVE_TOOLS)).toBe(true);
    expect(KIRO_NATIVE_TOOLS.length).toBeGreaterThan(0);
  });

  it("ships the captured native tool set", () => {
    const names = KIRO_NATIVE_TOOLS.map((t) => t.toolSpecification.name);
    expect(names).toEqual([
      "code",
      "glob",
      "grep",
      "read",
      "write",
      "shell",
      "use_aws",
      "web_search",
      "web_fetch",
      "knowledge",
      "todo_list",
      "subagent",
      "introspect",
    ]);
  });

  it("has unique tool names", () => {
    const names = KIRO_NATIVE_TOOLS.map((t) => t.toolSpecification.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("omits MCP tools (codegraph / pencil are handled by pi directly)", () => {
    const names = KIRO_NATIVE_TOOLS.map((t) => t.toolSpecification.name);
    expect(names).not.toContain("codegraph");
    expect(names).not.toContain("pencil");
  });

  describe("every tool", () => {
    it.each(KIRO_NATIVE_TOOLS.map((t) => [t.toolSpecification.name, t] as const))(
      "%s is well-formed (name, description, object input schema)",
      (_name, tool) => {
        const spec = tool.toolSpecification;
        expect(typeof spec.name).toBe("string");
        expect(spec.name.length).toBeGreaterThan(0);
        expect(typeof spec.description).toBe("string");
        expect(spec.description.length).toBeGreaterThan(0);

        const json = spec.inputSchema.json as Record<string, unknown>;
        expect(json.type).toBe("object");
        expect(typeof json.properties).toBe("object");
      },
    );

    it.each(KIRO_NATIVE_TOOLS.map((t) => [t.toolSpecification.name, t] as const))(
      "%s exposes the __tool_use_purpose field at the top level",
      (_name, tool) => {
        const json = tool.toolSpecification.inputSchema.json as Record<string, unknown>;
        const props = json.properties as Record<string, unknown>;
        expect(props.__tool_use_purpose).toEqual({
          type: "string",
          description: "A brief explanation why you are making this tool use.",
        });
      },
    );
  });
});
