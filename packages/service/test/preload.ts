import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// startService defaults desktopDir to ~/.agent-strata; on a dev machine that
// directory holds a live embedded server plus its remembered credentials, and
// every test that omitted desktopDir would connect to it for real. Point the
// default at a throwaway dir instead — tests that pass desktopDir explicitly
// are unaffected.
process.env.STRATA_DESKTOP_DIR ??= mkdtempSync(join(tmpdir(), "strata-desktop-"));
