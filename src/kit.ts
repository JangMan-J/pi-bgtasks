import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export type Status = "running" | "completed" | "failed" | "killed";

/** Fields the notifier needs. Names match the published v1 task protocol. */
export interface Notifiable {
	id: string;
	status: Status;
	notifyOnCompletion: boolean;
	resultObservedAt?: number | null;
	notificationDeliveredAt?: number | null;
}

// Minimal TypeBox-compatible schema builders: no runtime dependency.
const KIND = Symbol.for("TypeBox.Kind");
const OPTIONAL = Symbol.for("TypeBox.Optional");
type Schema = Record<symbol | string, unknown>;
export const Type = {
	String: (o?: Schema): Schema => ({ [KIND]: "String", type: "string", ...o }),
	Number: (o?: Schema): Schema => ({ [KIND]: "Number", type: "number", ...o }),
	Boolean: (o?: Schema): Schema => ({ [KIND]: "Boolean", type: "boolean", ...o }),
	Optional: (s: Schema): Schema => ({ ...s, [OPTIONAL]: "Optional" }),
	Object: (props: Record<string, Schema>): any => {
		const required = Object.keys(props).filter((k) => !(OPTIONAL in props[k]));
		return { [KIND]: "Object", type: "object", properties: props, ...(required.length ? { required } : {}) };
	},
};

/** Status plus whether a finished result has reached the model yet (read with bg_logs, or delivered as a wake-up). */
export function stateLabel(j: { status: Status; resultObservedAt?: number | null; notificationDeliveredAt?: number | null }): string {
	return j.status !== "running" && !j.resultObservedAt && !j.notificationDeliveredAt ? `${j.status}, unread` : j.status;
}

export function newId(taken: (id: string) => boolean): string {
	for (;;) {
		const id = randomBytes(3).toString("hex");
		if (!taken(id)) return id;
	}
}

/** Exact id, else a unique prefix. Throws on none or ambiguous. */
export function resolveId<T extends { id: string }>(store: Map<string, T>, needle: string): T | undefined {
	const n = needle.trim();
	if (!n) return undefined;
	const exact = store.get(n);
	if (exact) return exact;
	const hits = [...store.values()].filter((r) => r.id.startsWith(n));
	if (hits.length > 1) throw new Error(`Ambiguous id "${n}": ${hits.map((h) => h.id).join(", ")}`);
	return hits[0];
}

/** Single-line, control-character-free text. Safe for footers and transcripts. */
export function oneLine(s: string, max = 60): string {
	return s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function escapeXml(s: string): string {
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function duration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : s % 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s / 60}m`;
}

export const MAX_TAIL = 64 * 1024;

/** Last `maxBytes` (clamped to 512..64KiB) and optionally last `maxLines` lines of a file. */
export function readTail(path: string, maxBytes = 16 * 1024, maxLines?: number) {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		if (size === 0) return { text: "(no output)", truncated: false, totalBytes: 0 };
		const want = Math.min(size, Math.min(Math.max(512, maxBytes), MAX_TAIL));
		const buf = Buffer.alloc(want);
		readSync(fd, buf, 0, want, size - want);
		let text = buf.toString("utf8");
		let truncated = size > want;
		if (maxLines && maxLines > 0) {
			const lines = text.split("\n");
			if (lines.length > maxLines + 1) {
				text = lines.slice(-maxLines).join("\n");
				truncated = true;
			}
		}
		return { text: text.trimEnd() || "(no output)", truncated, totalBytes: size };
	} catch (e) {
		return { text: `(log unreadable: ${e instanceof Error ? e.message : e})`, truncated: false, totalBytes: 0 };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
