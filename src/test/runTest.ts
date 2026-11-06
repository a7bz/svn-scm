import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runTests } from "vscode-test";

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "../../out/test");

  // The file watcher used for the auto refresh only reports changes inside a
  // workspace folder, so run the tests with an (empty) folder opened. Some
  // tests create their working copies inside of it.
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "svn-test-ws-"));

  try {
    await runTests({
      version: process.env.CODE_VERSION,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspaceDir]
    });
  } catch (err) {
    const e = err as Error;
    console.error(`Failed to run tests: ${e}\n${e.stack}`);
    process.exit(1);
  } finally {
    try {
      fs.rmdirSync(workspaceDir, { recursive: true });
    } catch (err) {
      // Best effort cleanup.
    }
  }
}

main();
