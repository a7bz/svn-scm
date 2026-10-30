/**
 * Debounce helper (function form) used to throttle the high-frequency editor
 * events. The rest of this extension uses the `@debounce` decorator, but the
 * blame engine needs to wrap plain event handlers.
 *
 * Adapted from the "SVN Blamer" extension (blamer-vs) by BeauAgst, MIT licensed:
 * https://github.com/BeauAgst/blamer-vs
 */
export const debounce = <This, Args extends unknown[], R>(
  fn: (this: This, ...args: Args) => R,
  ms = 200
): ((this: This, ...args: Args) => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return function (this: This, ...args: Args) {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      fn.apply(this, args);
    }, ms);
  };
};
