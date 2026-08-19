import { describe, it, expect } from "vitest";
import type { WorkMode } from "@away_from/shared";
import type {
  OperatorAcceptanceProjection,
  OperatorCommandPreview,
  OperatorContext,
  OperatorFormDescriptor,
  NativeWorkProjection,
  NativeWorkRef,
} from "../../packages/framework/src/operator-console/contracts.js";
import {
  createOperatorActionRegistry,
  type OperatorActionRegistry,
  type OperatorModeAdapter,
} from "../../packages/framework/src/operator-console/action-registry.js";

/** 构造一个具备完整 compile-time adapter 形状的 fake adapter。 */
function fakeAdapter(mode: WorkMode, action: string): OperatorModeAdapter {
  return {
    mode,
    action,
    describe(): OperatorFormDescriptor {
      return { title: action, fields: [] };
    },
    async preview(_input: unknown, _context: OperatorContext): Promise<OperatorCommandPreview> {
      throw new Error("fake preview not implemented");
    },
    async submit(_preview: OperatorCommandPreview, _context: OperatorContext): Promise<NativeWorkRef> {
      throw new Error("fake submit not implemented");
    },
    async inspect(_ref: NativeWorkRef, _context: OperatorContext): Promise<NativeWorkProjection> {
      throw new Error("fake inspect not implemented");
    },
    async evaluate(
      _ref: NativeWorkRef,
      _context: OperatorContext,
    ): Promise<OperatorAcceptanceProjection> {
      throw new Error("fake evaluate not implemented");
    },
  };
}

describe("createOperatorActionRegistry", () => {
  it("registers and retrieves an adapter by (mode, action)", () => {
    const registry: OperatorActionRegistry = createOperatorActionRegistry();
    const adapter = fakeAdapter("run", "task.publish");
    registry.register(adapter);

    expect(registry.get("run", "task.publish")).toBe(adapter);
    expect(registry.get("run", "task.publish")).toBeDefined();
  });

  it("rejects duplicate registration of the same (mode, action)", () => {
    const registry = createOperatorActionRegistry();
    registry.register(fakeAdapter("run", "task.publish"));

    expect(() => registry.register(fakeAdapter("run", "task.publish"))).toThrow(
      /duplicate/i,
    );
  });

  it("throws /unknown/i for a missing action", () => {
    const registry = createOperatorActionRegistry();
    registry.register(fakeAdapter("run", "task.publish"));

    expect(() => registry.get("run", "http.request")).toThrow(/unknown/i);
    expect(() => registry.get("shell", "exec")).toThrow(/unknown/i);
  });

  it("does not register shell.exec without an exact compile-time adapter object", () => {
    const registry = createOperatorActionRegistry();

    // 仅有 mode/action 的裸对象不是完整的 OperatorModeAdapter
    expect(() =>
      registry.register({
        mode: "run",
        action: "shell.exec",
      } as unknown as OperatorModeAdapter),
    ).toThrow(/invalid adapter/i);

    expect(() => registry.get("run", "shell.exec")).toThrow(/unknown/i);
  });

  it("does not register adapters missing any of the five methods", () => {
    const registry = createOperatorActionRegistry();

    const missingDescribe = {
      mode: "run",
      action: "task.publish",
      preview: async () => {
        throw new Error("x");
      },
      submit: async () => {
        throw new Error("x");
      },
      inspect: async () => {
        throw new Error("x");
      },
      evaluate: async () => {
        throw new Error("x");
      },
    } as unknown as OperatorModeAdapter;

    expect(() => registry.register(missingDescribe)).toThrow(/invalid adapter/i);
  });

  it("treats distinct modes as distinct keys", () => {
    const registry = createOperatorActionRegistry();
    registry.register(fakeAdapter("run", "task.publish"));
    registry.register(fakeAdapter("intake", "task.publish"));
    registry.register(fakeAdapter("optimize", "task.publish"));

    expect(registry.get("run", "task.publish")).toBeDefined();
    expect(registry.get("intake", "task.publish")).toBeDefined();
    expect(registry.get("optimize", "task.publish")).toBeDefined();
  });
});
