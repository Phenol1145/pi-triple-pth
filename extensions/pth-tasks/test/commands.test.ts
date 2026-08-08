import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePthtaskArgs, renderHelp, renderTasks } from "../commands.ts";

describe("parsePthtaskArgs", () => {
  it("publish 带描述", () => {
    const c = parsePthtaskArgs("publish 调查一下 X");
    assert.equal(c.kind, "publish");
    if (c.kind === "publish") {
      assert.equal(c.desc, "调查一下 X");
      assert.equal(c.tags, undefined);
    }
  });

  it("publish 带 --tags", () => {
    const c = parsePthtaskArgs("publish 写测试 --tags code,test");
    if (c.kind === "publish") {
      assert.deepEqual(c.tags, ["code", "test"]);
      assert.equal(c.desc, "写测试");
    }
  });

  it("publish 无描述 → help", () => {
    assert.equal(parsePthtaskArgs("publish").kind, "help");
  });

  it("publish --template 解析模板与参数", () => {
    const c = parsePthtaskArgs("publish --template recon-doc --url https://go.dev/ref/spec --anchors go,spec --tags memory");
    assert.equal(c.kind, "publish-template");
    if (c.kind === "publish-template") {
      assert.equal(c.template, "recon-doc");
      assert.equal(c.params.url, "https://go.dev/ref/spec");
      assert.equal(c.params.anchors, "go,spec");
      assert.deepEqual(c.tags, ["memory"]);
    }
  });

  it("templates 命令", () => {
    assert.equal(parsePthtaskArgs("templates").kind, "templates");
  });

  it("ls 默认 limit 20 / 指定 limit", () => {
    assert.equal((parsePthtaskArgs("ls") as { limit: number }).limit, 20);
    assert.equal((parsePthtaskArgs("ls --limit 5") as { limit: number }).limit, 5);
  });

  it("batch add/remove 数量钳制 1-10", () => {
    assert.deepEqual(parsePthtaskArgs("batch add 3"), { kind: "batch", action: "add", count: 3 });
    assert.deepEqual(parsePthtaskArgs("batch remove"), { kind: "batch", action: "remove", count: 1 });
    assert.deepEqual(parsePthtaskArgs("batch add 99"), { kind: "batch", action: "add", count: 10 });
    assert.equal(parsePthtaskArgs("batch foo").kind, "help");
  });

  it("status / 空 / 未知", () => {
    assert.equal(parsePthtaskArgs("status").kind, "status");
    assert.equal(parsePthtaskArgs("").kind, "help");
    assert.equal(parsePthtaskArgs("frobnicate").kind, "help");
  });
});

describe("render", () => {
  it("renderTasks 空列表提示", () => {
    assert.match(renderTasks([]), /暂无任务/);
  });

  it("renderTasks 列表含 id/status/title", () => {
    const out = renderTasks([{ id: "abc123def", status: "pending", title: "t1" }]);
    assert.match(out, /abc123def/);
    assert.match(out, /pending/);
    assert.match(out, /t1/);
  });

  it("renderHelp 含全部子命令", () => {
    const out = renderHelp();
    for (const s of ["publish", "ls", "status", "batch"]) assert.match(out, new RegExp(s));
  });
});
