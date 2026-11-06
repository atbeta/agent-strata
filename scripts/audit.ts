// Dependency audit for both installs.
//
// The desktop UI is a separate install with its own lockfile, so one `bun
// audit` at the root never sees it. This runs both and fails on a new high or
// critical advisory. Two kinds of exceptions exist:
//
// - low and moderate findings are printed but do not fail the run; they are
//   recorded in the audit report and handled on their own schedule;
// - a high finding may be listed below with a reason and an expiry. The only
//   one today is the zod advisory: fixing it means Zod 4, which is a migration
//   the project deliberately deferred. The request/collection caps added next
//   to this script are the mitigation until that migration happens.
import { join } from "node:path";

type Advisory = {
  url: string;
  severity: string;
  title: string;
  vulnerable_versions: string;
};

const root = join(import.meta.dir, "..");
const targets = [
  { label: "workspace", cwd: root },
  { label: "desktop UI", cwd: join(root, "apps/desktop/ui") },
];

const exceptions = new Map([
  [
    "GHSA-mrhx-c7xc-m3w5",
    {
      until: "2027-01-31",
      reason: "Zod 4 migration deferred; request/collection caps mitigate the memory cost",
    },
  ],
]);

let failed = false;
for (const target of targets) {
  const result = Bun.spawnSync(["bun", "audit", "--json"], {
    cwd: target.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = result.stdout.toString().trim();
  if (!text) {
    const error = result.stderr.toString().trim();
    if (result.exitCode !== 0 && error) {
      console.error(`${target.label}: audit could not run\n${error}`);
      failed = true;
    }
    continue;
  }
  let report: Record<string, Advisory[]>;
  try {
    report = JSON.parse(text) as Record<string, Advisory[]>;
  } catch {
    console.error(`${target.label}: audit returned unreadable JSON`);
    failed = true;
    continue;
  }
  for (const [dependency, advisories] of Object.entries(report)) {
    for (const advisory of advisories) {
      const id = advisory.url.split("/").pop() ?? advisory.url;
      const line = `${target.label}: ${dependency} ${advisory.severity} ${id}\n  ${advisory.title}\n  affects ${advisory.vulnerable_versions}`;
      if (advisory.severity !== "critical" && advisory.severity !== "high") {
        console.warn(`warn ${line}`);
        continue;
      }
      const exception = exceptions.get(id);
      if (exception && new Date() < new Date(`${exception.until}T00:00:00Z`)) {
        console.warn(`allowed until ${exception.until}: ${exception.reason}\n${line}`);
        continue;
      }
      console.error(`FAIL ${line}`);
      failed = true;
    }
  }
}

if (failed) {
  console.error("\nDependency audit failed: fix the advisory or add a dated exception with a reason.");
  process.exit(1);
}
console.log("dependency audit passed (low/moderate and dated exceptions are reported above)");
