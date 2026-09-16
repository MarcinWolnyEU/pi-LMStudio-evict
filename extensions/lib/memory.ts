/**
 * What is actually free right now, and how to render sizes.
 *
 * LM Studio exposes no hardware information through `lms` or its REST API
 * (checked against 0.3.x), so free VRAM has to come from a vendor tool.
 */

import { execFile } from "node:child_process";
import * as os from "node:os";

export interface Pool {
	freeBytes: number;
	totalBytes: number;
}

const GIB = 1024 ** 3;

/** Human size in binary units, matching how `lms` reports memory. */
export function formatBytes(bytes: number | undefined): string {
	if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "size?";
	if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GiB`;
	return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

/**
 * Free/total VRAM in bytes, summed across GPUs. NVIDIA-only: `nvidia-smi` is
 * the one vendor tool reliably on PATH. Resolves undefined on AMD/Intel/Apple
 * machines or when the query fails — callers then fall back to RAM only.
 */
export function vram(): Promise<Pool | undefined> {
	return new Promise((resolve) => {
		execFile(
			"nvidia-smi",
			["--query-gpu=memory.free,memory.total", "--format=csv,noheader,nounits"],
			{ windowsHide: true, timeout: 3_000 },
			(error, stdout) => {
				if (error) return resolve(undefined);
				let free = 0;
				let total = 0;
				for (const line of stdout.trim().split("\n")) {
					const [f, t] = line.split(",").map((v) => Number.parseInt(v.trim(), 10));
					if (!Number.isFinite(f) || !Number.isFinite(t)) return resolve(undefined);
					free += f;
					total += t;
				}
				if (total === 0) return resolve(undefined);
				// nvidia-smi reports MiB.
				resolve({ freeBytes: free * 1024 ** 2, totalBytes: total * 1024 ** 2 });
			},
		);
	});
}

export function ram(): Pool {
	return { freeBytes: os.freemem(), totalBytes: os.totalmem() };
}

/** How a candidate model's size compares to what is free. */
export type Fit = "fits" | "tight" | "over";

/**
 * `over` — larger than free RAM and free VRAM combined, so it cannot fit at
 * all. `tight` — larger than one pool alone, so it can only load by spilling
 * into the other. Without VRAM information the check degrades to RAM only.
 */
export function fitOf(bytes: number | undefined, ramFree: number, vramFree?: number): Fit {
	if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "fits";
	if (bytes > ramFree + (vramFree ?? 0)) return "over";
	if (bytes > ramFree || (vramFree !== undefined && bytes > vramFree)) return "tight";
	return "fits";
}
