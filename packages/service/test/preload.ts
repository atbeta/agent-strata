import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// startService defaults desktopDir to ~/.agent-strata; on a dev machine that
// directory holds a live embedded server plus its remembered credentials, and
// every test that omitted desktopDir would connect to it for real. Point the
// default at a throwaway dir instead — tests that pass desktopDir explicitly
// are unaffected. Assigned, not defaulted: the desktop shell sets this for
// its service, and a terminal opened inside the app inherits the real one.
process.env.STRATA_DESKTOP_DIR = mkdtempSync(join(tmpdir(), "strata-desktop-"));
