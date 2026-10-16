/**
 * Shared process teardown for the scripts that boot the sidecar `bun` process.
 *
 * `proc.kill()` does not reliably release the port on Windows — the orphaned
 * sidecar then keeps answering on the test port, so the next run silently talks
 * to stale code and reports unrelated failures. Killing the tree fixes that.
 */
export function killProcessTree(proc: ReturnType<typeof Bun.spawn>): void {
  if (process.platform === 'win32' && proc.pid) {
    Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(proc.pid)], { stdout: 'ignore', stderr: 'ignore' });
    return;
  }
  proc.kill(9);
}
