import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  checkSource,
  type Architecture,
} from "../../scripts/product/boundaries.js";

const spec = JSON.parse(
  await readFile("spec/architecture.json", "utf8"),
) as Architecture;
test("boundary checks reject report lifecycle dependencies and cross-owner SQL", () => {
  const path = "packages/core/reports/report.ts";
  assert.ok(
    checkSource(
      path,
      "import { request } from '@campussec/core/requests';",
      spec,
    ).some((error) => error.includes("reports -> requests")),
  );
  assert.ok(
    checkSource(path, "tx.run('UPDATE jobs SET state=?');", spec).some(
      (error) => error.includes("belongs to S07"),
    ),
  );
  assert.deepEqual(
    checkSource(
      path,
      "import type { ReportAssessment } from '@campussec/contracts'; tx.run('INSERT INTO result_packages(request_id) VALUES(?)');",
      spec,
    ),
    [],
  );
});
test("boundary checks reject infrastructure in shared fakes and privileged renderer imports", () => {
  assert.ok(
    checkSource(
      "packages/testkit/src/fake.ts",
      "import { createStorage } from '@campussec/storage';",
      spec,
    ).length,
  );
  assert.ok(
    checkSource(
      "apps/desktop/renderer/view.ts",
      "const fs = require('node:fs');",
      spec,
    ).length,
  );
  assert.ok(
    checkSource(
      "apps/desktop/preload/index.cts",
      "const fs = require('fs');",
      spec,
    ).length,
  );
  assert.ok(
    checkSource(
      "packages/core/cases/case.ts",
      "import { repo } from '../../storage/src/private.js';",
      spec,
    ).length,
  );
  assert.deepEqual(
    checkSource(
      "packages/testkit/src/fake.ts",
      "import type { HttpPort } from '@campussec/contracts';",
      spec,
    ),
    [],
  );
});
