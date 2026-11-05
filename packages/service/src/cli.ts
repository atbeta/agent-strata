/**
 * Entry point of the compiled sidecar.
 *
 * Top-level code here runs whether or not `import.meta.main` is true. The
 * Windows bun runtime that `bun build --compile` embeds reports that flag as
 * false, so the listen call cannot live behind it — the process would reach
 * the end of the file and exit 0, and the shell would only see a dead child.
 */
import { main } from "./index";

main();
