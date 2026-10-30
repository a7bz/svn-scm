/**
 * Simple in-memory key/value store for the per-file decoration records.
 *
 * Adapted from the "SVN Blamer" extension (blamer-vs) by BeauAgst, MIT licensed:
 * https://github.com/BeauAgst/blamer-vs
 */
export class Storage<T> {
  private storage: Map<string, T> = new Map();

  public get(key: string): T | undefined {
    return this.storage.get(key);
  }

  public set(key: string, value: T): void {
    this.storage.set(key, value);
  }

  public delete(key: string): void {
    this.storage.delete(key);
  }

  public clear(): void {
    this.storage.clear();
  }
}
