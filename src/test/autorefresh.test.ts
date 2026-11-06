import * as assert from "assert";
import * as fs from "original-fs";
import * as path from "path";
import { commands, Uri, workspace } from "vscode";
import { SourceControlManager } from "../source_control_manager";
import { Repository } from "../repository";
import { Status } from "../common/types";
import * as testUtil from "./testUtil";
import { timeout } from "../util";

async function waitFor(
  condition: () => boolean,
  ms: number = 15000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (condition()) {
      return true;
    }
    await timeout(100);
  }
  return condition();
}

function runSvn(cwd: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = testUtil.spawn("svn", args, { cwd });
    proc.once("exit", code => (code === 0 ? resolve() : reject(code)));
  });
}

/**
 * Regression tests for the automatic refresh of the working copy.
 *
 * The extension used to wait for the window to be focused before refreshing
 * (and to drop change events while an operation was running), which made
 * changes made after the initial status - and deletions in particular - never
 * show up in the Source Control view.
 */
suite("Auto Refresh Tests", () => {
  let sourceControlManager: SourceControlManager;
  let repository: Repository;
  let wcPath: string;
  let versionedFile: string;
  let tempWorkspaceFolder: Uri | undefined;
  let skipReason: string | undefined;
  const watcherEvents: string[] = [];

  suiteSetup(async function () {
    this.timeout(180000);
    await testUtil.activeExtension();

    // The file watcher only reports changes for paths inside a workspace
    // folder, so make sure the working copy lives in one.
    if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
      tempWorkspaceFolder = Uri.file(testUtil.newTempDir("svn_watch_ws_"));

      try {
        workspace.updateWorkspaceFolders(0, 0, {
          uri: tempWorkspaceFolder,
          name: "svn-watch"
        });
      } catch (error) {
        // Ignored: handled by the skip below.
      }
    }

    const workspaceFolder = (workspace.workspaceFolders || [])[0];

    if (!workspaceFolder) {
      // VS Code does not always allow adding a workspace folder while running
      // extension tests; skip instead of failing the whole suite.
      skipReason = "no workspace folder available for the file watcher";
      return;
    }
    wcPath = path.join(workspaceFolder!.uri.fsPath, "wc");

    // Do not pop up the "remove from SVN?" notification during the tests.
    await workspace
      .getConfiguration("svn")
      .update("delete.actionForDeletedFiles", "none", true);

    const repoUri = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(repoUri));
    await runSvn(path.dirname(wcPath), [
      "checkout",
      testUtil.getSvnUrl(repoUri) + "/trunk",
      wcPath
    ]);

    versionedFile = path.join(wcPath, "versioned.txt");
    fs.writeFileSync(versionedFile, "one");
    await runSvn(wcPath, ["add", "versioned.txt"]);
    await runSvn(wcPath, ["commit", "-m", "init"]);

    sourceControlManager = (await commands.executeCommand(
      "svn.getSourceControlManager",
      Uri.file(wcPath)
    )) as SourceControlManager;

    await sourceControlManager.tryOpenRepository(wcPath);

    const opened = sourceControlManager.getRepository(wcPath);
    assert.ok(opened, "repository was not opened");
    repository = opened!;

    repository.fsWatcher.onDidAny(uri => watcherEvents.push(uri.fsPath));

    // Let the initial status run settle.
    await timeout(3000);
  });

  suiteTeardown(async () => {
    if (sourceControlManager) {
      sourceControlManager.openRepositories.forEach(r =>
        r.repository.dispose()
      );
    }

    if (tempWorkspaceFolder) {
      await workspace.updateWorkspaceFolders(0, 1);
    }

    testUtil.destroyAllTempPaths();
  });

  test("detects a new unversioned file", async function () {
    this.timeout(60000);
    if (skipReason) {
      this.skip();
    }
    const file = path.join(wcPath, "added.txt");
    fs.writeFileSync(file, "hello");

    const detected = await waitFor(() =>
      repository.unversioned.resourceStates.some(
        r => r.resourceUri.fsPath === file
      )
    );

    assert.ok(
      detected,
      `unversioned file was not detected. watcher events: ${JSON.stringify(
        watcherEvents
      )}`
    );
  });

  test("detects a modified file", async function () {
    this.timeout(60000);
    if (skipReason) {
      this.skip();
    }
    fs.writeFileSync(versionedFile, "two");

    const detected = await waitFor(() =>
      repository.changes.resourceStates.some(
        r =>
          r.resourceUri.fsPath === versionedFile &&
          r.type === Status.MODIFIED
      )
    );

    assert.ok(
      detected,
      `modification was not detected. watcher events: ${JSON.stringify(
        watcherEvents
      )}`
    );
  });

  test("detects a deleted file", async function () {
    this.timeout(60000);
    if (skipReason) {
      this.skip();
    }
    fs.unlinkSync(versionedFile);

    const detected = await waitFor(() =>
      repository.changes.resourceStates.some(
        r =>
          r.resourceUri.fsPath === versionedFile && r.type === Status.MISSING
      )
    );

    assert.ok(
      detected,
      `deletion was not detected. watcher events: ${JSON.stringify(
        watcherEvents
      )}`
    );
  });
});
