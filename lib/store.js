// Saved runs on disk, so past analyses reopen instantly (no API cost).
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const RUNS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "runs");
await mkdir(RUNS, { recursive: true });

export const saveRun = run => writeFile(path.join(RUNS, `${run.id}.json`), JSON.stringify(run, null, 2));
export const loadRun = async id => JSON.parse(await readFile(path.join(RUNS, `${path.basename(String(id))}.json`), "utf8"));
export async function listRuns() {
  const files = (await readdir(RUNS)).filter(f => f.endsWith(".json"));
  const runs = await Promise.all(files.map(f => loadRun(f.slice(0, -5)).catch(() => null)));
  return runs.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(r => ({ id: r.id, topic: r.topic, createdAt: r.createdAt, total: r.stats.total, net: r.stats.netSentiment }));
}
