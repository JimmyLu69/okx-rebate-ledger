import test from "node:test";
import assert from "node:assert/strict";
import { matchesFilters } from "../dist/view-model.mjs";
test("direction filters raw views without dropping the opposite side of net accounting", () => {
  for (const view of ["review", "spam", "ignored"]) {
    assert.equal(
      matchesFilters({ direction: "in" }, { direction: new Set(["in"]) }, view),
      true,
    );
    assert.equal(
      matchesFilters(
        { direction: "out" },
        { direction: new Set(["in"]) },
        view,
      ),
      false,
    );
    assert.equal(
      matchesFilters(
        { direction: "out" },
        { direction: new Set(["in", "out"]) },
        view,
      ),
      true,
    );
  }
  for (const view of ["ledger", "assets"])
    assert.equal(
      matchesFilters(
        { direction: "in" },
        { direction: new Set(["out"]) },
        view,
      ),
      true,
    );
});
