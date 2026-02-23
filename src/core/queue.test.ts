import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase } from "./db.js";
import { TaskQueue } from "./queue.js";

function mkTask(id: string, projectAlias: string) {
  return {
    id,
    projectAlias,
    projectPath: `/tmp/${projectAlias}`,
    prompt: `prompt-${id}`,
    threadId: `thread-${projectAlias}`,
    adapter: "web" as const,
    continueSession: false,
    tokenBudget: 1000,
  };
}

test("TaskQueue enforces queued capacity per project", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "remotewiz-queue-cap-"));
  const db = openDatabase(cwd);
  try {
    const queue = new TaskQueue(db, 2);
    queue.enqueue(mkTask("t1", "alpha"));
    queue.enqueue(mkTask("t2", "alpha"));
    assert.throws(() => queue.enqueue(mkTask("t3", "alpha")), /queue_full/);
  } finally {
    closeDatabase(db);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("TaskQueue keeps one running task per project while allowing parallel projects", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "remotewiz-queue-lock-"));
  const db = openDatabase(cwd);
  try {
    const queue = new TaskQueue(db, 10);
    queue.enqueue(mkTask("a1", "alpha"));
    queue.enqueue(mkTask("a2", "alpha"));
    queue.enqueue(mkTask("b1", "beta"));

    const first = queue.dequeueNext();
    assert.ok(first);
    assert.equal(first.id, "a1");

    const second = queue.dequeueNext();
    assert.ok(second);
    assert.equal(second.id, "b1");

    const blocked = queue.dequeueNext();
    assert.equal(blocked, undefined);

    queue.markDone("a1", "done");
    const third = queue.dequeueNext();
    assert.ok(third);
    assert.equal(third.id, "a2");
  } finally {
    closeDatabase(db);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
