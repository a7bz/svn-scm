import { isTrunk, selectBranch } from "../helpers/branch";
import { mergeBranch } from "../helpers/merge";
import { Repository } from "../repository";
import { Command } from "./command";

export class Merge extends Command {
  constructor() {
    super("svn.merge", { repository: true });
  }

  public async execute(repository: Repository) {
    const branch = await selectBranch(repository);

    if (!branch) {
      return;
    }

    await mergeBranch(repository, branch.path, {
      reintegrate: isTrunk(repository.currentBranch)
    });
  }
}
