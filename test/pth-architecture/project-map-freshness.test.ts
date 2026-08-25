import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECT_DIR_DUTY,
  PROJECT_FILE_DUTY,
} from "../../packages/pth-kernel-execution/src/prompt-docs.js";

const repoRoot = join(import.meta.dirname, "..", "..");

describe("PTH project-map freshness", () => {
  it("every PROJECT_DIR_DUTY key points to an existing directory", () => {
    const missing = Object.keys(PROJECT_DIR_DUTY).filter(
      (dir) => !existsSync(join(repoRoot, dir)),
    );
    expect(missing, `PROJECT_DIR_DUTY 指向不存在的目录: ${missing.join(", ")}`).toEqual([]);
  });

  it("every PROJECT_FILE_DUTY key points to an existing file", () => {
    const missing = Object.keys(PROJECT_FILE_DUTY).filter(
      (file) => !existsSync(join(repoRoot, file)),
    );
    expect(missing, `PROJECT_FILE_DUTY 指向不存在的文件: ${missing.join(", ")}`).toEqual([]);
  });
});
