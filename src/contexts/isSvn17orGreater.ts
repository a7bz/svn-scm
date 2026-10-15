import { Disposable } from "vscode";
import * as semver from "semver";
import { setVscodeContext } from "../util";

export class IsSvn17orGreater implements Disposable {
  constructor(svnVersion: string) {
    const is17orGreater = semver.satisfies(svnVersion, ">= 1.7");

    setVscodeContext("isSvn17orGreater", is17orGreater);
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  dispose() {}
}
