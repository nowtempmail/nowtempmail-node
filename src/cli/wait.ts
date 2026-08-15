/**
 * A cancellable sleep that resolves rather than throwing.
 *
 * `src/http.ts` exports a `sleep` that rejects with `ConnectionError` when its
 * signal fires, which is right for a request pipeline and wrong for `tail`: ⌃C
 * there is a successful end to the command, not an error to render. This version
 * reports the abort as a return value.
 *
 * It also always clears its timer. A live `setTimeout` handle at exit is how the
 * Windows libuv assertion that reports exit code 127 gets triggered.
 */
export function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<"elapsed" | "aborted"> {
  if (signal?.aborted === true) return Promise.resolve("aborted");
  if (!(ms > 0)) return Promise.resolve("elapsed");
  return new Promise<"elapsed" | "aborted">((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve("aborted");
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve("elapsed");
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
