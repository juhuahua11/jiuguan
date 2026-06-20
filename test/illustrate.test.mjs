import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAidrawDir } from "./_aidraw_path.mjs";

test("aidrawDir resolves to sibling quick AIdraw by default", () => {
  const d = resolveAidrawDir("/some/jiuguan", "");
  assert.match(d, /quick AIdraw$/);
});

test("aidrawDir honors AIDRAW_DIR env override", () => {
  const d = resolveAidrawDir("/some/jiuguan", "/custom/aidraw");
  assert.equal(d, "/custom/aidraw");
});
