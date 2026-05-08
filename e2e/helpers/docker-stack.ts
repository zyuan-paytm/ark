/**
 * Compose lifecycle for the e2e suite.
 *
 * Skips bring-up/tear-down when:
 *   - ARK_E2E_STACK_RUNNING=1 is set, OR
 *   - the key services are already healthy (auto-detected via `docker ps`)
 *
 * This means `make test-e2e-temporal-up` once + iterative test runs are fast.
 */

const COMPOSE_FILE = ".infra/docker-compose.e2e.yaml";
const PROJECT_NAME = "ark-e2e";

let cachedCli: string[] | null = null;

async function pickComposeCli(): Promise<string[]> {
  if (cachedCli) return cachedCli;
  const probe = Bun.spawn(["docker", "compose", "version"], { stdout: "ignore", stderr: "ignore" });
  cachedCli = (await probe.exited) === 0 ? ["docker", "compose"] : ["docker-compose"];
  return cachedCli;
}

async function isStackRunning(): Promise<boolean> {
  if (process.env.ARK_E2E_STACK_RUNNING === "1") return true;
  // Check if the postgres service is already healthy -- if so, skip cold start.
  const proc = Bun.spawn(
    ["docker", "ps", "--filter", "name=ark-e2e-postgres", "--filter", "health=healthy", "--format", "{{.Names}}"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim().length > 0;
}

export async function up(opts?: { scaleTemporal?: boolean }): Promise<void> {
  if (await isStackRunning()) return;
  const cli = await pickComposeCli();
  const args = [...cli, "-f", COMPOSE_FILE, "-p", PROJECT_NAME, "up", "-d", "--wait"];
  if (opts?.scaleTemporal) args.push("--scale", "temporal-worker=2");
  const proc = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`docker compose up failed (exit ${code})`);
}

export async function down(): Promise<void> {
  if (process.env.ARK_E2E_STACK_RUNNING === "1") return;
  if (await isStackRunning()) {
    const cli = await pickComposeCli();
    const proc = Bun.spawn([...cli, "-f", COMPOSE_FILE, "-p", PROJECT_NAME, "down", "-v"], {
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  }
}
