import * as cp from "child_process";
import { EventEmitter } from "events";
import { Readable } from "stream";
import {
  ConstructorPolicy,
  ICpOptions,
  IExecutionResult,
  ISvnOptions
} from "./common/types";
import * as encodeUtil from "./encoding";
import { configuration } from "./helpers/configuration";
import { parseInfoXml } from "./parser/infoParser";
import SvnError from "./svnError";
import { Repository } from "./svnRepository";
import { dispose, IDisposable, toDisposable } from "./util";
import { iconv } from "./vscodeModules";

export const svnErrorCodes: { [key: string]: string } = {
  AuthorizationFailed: "E170001",
  RepositoryIsLocked: "E155004",
  NotASvnRepository: "E155007",
  NotShareCommonAncestry: "E195012",
  WorkingCopyIsTooOld: "E155036"
};

function getSvnErrorCode(stderr: string): string | undefined {
  for (const name in svnErrorCodes) {
    if (svnErrorCodes.hasOwnProperty(name)) {
      const code = svnErrorCodes[name];
      const regex = new RegExp(`svn: ${code}`);
      if (regex.test(stderr)) {
        return code;
      }
    }
  }

  if (/No more credentials or we tried too many times/.test(stderr)) {
    return svnErrorCodes.AuthorizationFailed;
  }

  return void 0;
}

export function cpErrorHandler(
  cb: (reason?: any) => void
): (reason?: any) => void {
  return err => {
    if (/ENOENT/.test(err.message)) {
      err = new SvnError({
        error: err,
        message: "Failed to execute svn (ENOENT)",
        svnErrorCode: "NotASvnRepository"
      });
    }

    cb(err);
  };
}

export interface BufferResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

/**
 * Shared setup for both `exec` and `execBuffer`: builds the argument list
 * (credentials, non-interactive flag) and the spawn options.
 */
function prepareExec(
  svnPath: string,
  cwd: string,
  args: any[],
  options: ICpOptions,
  lastCwdRef: { value: string },
  logOutput: (output: string) => void
): cp.SpawnOptions {
  if (cwd) {
    lastCwdRef.value = cwd;
    options.cwd = cwd;
  }

  if (options.log !== false) {
    const argsOut = args.map(arg => (/ |^$/.test(arg) ? `'${arg}'` : arg));
    logOutput(
      `[${lastCwdRef.value.split(/[\\\/]+/).pop()}]$ svn ${argsOut.join(" ")}\n`
    );
  }

  if (options.username) {
    args.push("--username", options.username);
  }
  if (options.password) {
    args.push("--password", options.password);
  }

  if (options.username || options.password) {
    // Configuration format: FILE:SECTION:OPTION=[VALUE]
    // Disable password store
    args.push("--config-option", "config:auth:password-stores=");
    // Disable store auth credentials
    args.push("--config-option", "servers:global:store-auth-creds=no");
  }

  // Force non interactive environment
  args.push("--non-interactive");

  const defaults: cp.SpawnOptions = {
    env: Object.assign({}, process.env, options.env || {}, {
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8"
    })
  };
  if (cwd) {
    defaults.cwd = cwd;
  }

  return defaults;
}

/**
 * Spawns `svn` and collects stdout/stderr. `options.onStdout` receives each
 * raw chunk so callers can stream output (e.g. `svn log --search`).
 * `options.onCancel` is invoked to abort the process early.
 */
function runSvn(
  svnPath: string,
  args: string[],
  spawnOptions: cp.SpawnOptions,
  options: ICpOptions
): Promise<{
  exitCode: number;
  stdout: Buffer;
  stderr: string;
  child: cp.ChildProcess;
}> {
  const child = cp.spawn(svnPath, args, spawnOptions);

  const disposables: IDisposable[] = [];

  const once = (
    ee: NodeJS.EventEmitter,
    name: string,
    fn: (...args: any[]) => void
  ) => {
    ee.once(name, fn);
    disposables.push(toDisposable(() => ee.removeListener(name, fn)));
  };

  const on = (
    ee: NodeJS.EventEmitter,
    name: string,
    fn: (...args: any[]) => void
  ) => {
    ee.on(name, fn);
    disposables.push(toDisposable(() => ee.removeListener(name, fn)));
  };

  if (options.onCancel) {
    const cancel = options.onCancel;
    options.onCancel = undefined;
    disposables.push(
      toDisposable(() => {
        try {
          child.kill();
        } catch {
          // Process already gone.
        }
        cancel();
      })
    );
  }

  const result = Promise.all<any>([
    new Promise<number>((resolve, reject) => {
      once(child, "error", reject);
      once(child, "exit", resolve);
    }),
    new Promise<Buffer>(resolve => {
      const buffers: Buffer[] = [];
      on(child.stdout as Readable, "data", (b: Buffer) => {
        buffers.push(b);
        options.onStdout?.(b);
      });
      once(child.stdout as Readable, "close", () =>
        resolve(Buffer.concat(buffers))
      );
    }),
    new Promise<string>(resolve => {
      const buffers: Buffer[] = [];
      on(child.stderr as Readable, "data", (b: Buffer) => buffers.push(b));
      once(child.stderr as Readable, "close", () =>
        resolve(Buffer.concat(buffers).toString())
      );
    })
  ]);

  return result
    .then(([exitCode, stdout, stderr]) => {
      dispose(disposables);
      return { exitCode, stdout, stderr, child };
    })
    .catch(err => {
      dispose(disposables);
      throw err;
    });
}

/** Writes stderr to the output channel when logging is enabled. */
function logStderr(
  stderr: string,
  lastCwd: string,
  logOutput: (output: string) => void
): void {
  if (stderr.length === 0) {
    return;
  }

  const name = lastCwd.split(/[\\\/]+/).pop();
  const err = stderr
    .split("\n")
    .filter((line: string) => line)
    .map((line: string) => `[${name}]$ ${line}`)
    .join("\n");
  logOutput(err);
}

export class Svn {
  public version: string;

  private svnPath: string;
  private lastCwd: string = "";

  private _onOutput = new EventEmitter();
  get onOutput(): EventEmitter {
    return this._onOutput;
  }

  constructor(options: ISvnOptions) {
    this.svnPath = options.svnPath;
    this.version = options.version;
  }

  public logOutput(output: string): void {
    this._onOutput.emit("log", output);
  }

  public async exec(
    cwd: string,
    args: any[],
    options: ICpOptions = {}
  ): Promise<IExecutionResult> {
    const defaults = prepareExec(
      this.svnPath,
      cwd,
      args,
      options,
      this,
      this.logOutput.bind(this)
    );

    let encoding: string | undefined | null = options.encoding;
    delete options.encoding;

    // SVN with '--xml' always return 'UTF-8', and jschardet detects this encoding: 'TIS-620'
    if (args.includes("--xml")) {
      encoding = "utf8";
    }

    const { exitCode, stdout, stderr } = await runSvn(
      this.svnPath,
      args as string[],
      defaults,
      options
    );

    if (!encoding) {
      encoding = encodeUtil.detectEncoding(stdout);
    }

    // if not detected
    if (!encoding) {
      encoding = configuration.get<string>("default.encoding");
    }

    if (!iconv.encodingExists(encoding)) {
      if (encoding) {
        console.warn(`SVN: The encoding "${encoding}" is invalid`);
      }
      encoding = "utf8";
    }

    const decodedStdout = iconv.decode(stdout, encoding);

    if (options.log !== false && stderr.length > 0) {
      logStderr(stderr, this.lastCwd, this.logOutput.bind(this));
    }

    if (exitCode) {
      return Promise.reject<IExecutionResult>(
        new SvnError({
          message: "Failed to execute svn",
          stdout: decodedStdout,
          stderr,
          stderrFormated: stderr.replace(/^svn: E\d+: +/gm, ""),
          exitCode,
          svnErrorCode: getSvnErrorCode(stderr),
          svnCommand: args[0]
        })
      );
    }

    return { exitCode, stdout: decodedStdout, stderr };
  }

  public async execBuffer(
    cwd: string,
    args: any[],
    options: ICpOptions = {}
  ): Promise<BufferResult> {
    const defaults = prepareExec(
      this.svnPath,
      cwd,
      args,
      options,
      this,
      this.logOutput.bind(this)
    );

    const { exitCode, stdout, stderr } = await runSvn(
      this.svnPath,
      args as string[],
      defaults,
      options
    );

    if (options.log !== false && stderr.length > 0) {
      logStderr(stderr, this.lastCwd, this.logOutput.bind(this));
    }

    return { exitCode, stdout, stderr };
  }

  public async getRepositoryRoot(path: string) {
    try {
      const result = await this.exec(path, ["info", "--xml"]);

      const info = await parseInfoXml(result.stdout);

      if (info && info.wcInfo && info.wcInfo.wcrootAbspath) {
        return info.wcInfo.wcrootAbspath;
      }

      // SVN 1.6 not has "wcroot-abspath"
      return path;
    } catch (error) {
      if (error instanceof SvnError) {
        throw error;
      }
      console.error(error);
      throw new Error("Unable to find repository root path");
    }
  }

  public async open(
    repositoryRoot: string,
    workspaceRoot: string
  ): Promise<Repository> {
    return new Repository(
      this,
      repositoryRoot,
      workspaceRoot,
      ConstructorPolicy.Async
    );
  }
}
