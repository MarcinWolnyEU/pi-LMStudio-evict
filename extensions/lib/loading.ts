/**
 * Loading indicators for the model picker: pi's cancellable loader in the TUI,
 * the footer status line everywhere else.
 *
 * Lives outside `evict.ts` so the cancel and failure paths can be tested with a
 * fake context; they are the subtle part and cannot be reached in the
 * integration harness, which has no TUI.
 */

import type { BorderedLoader, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * Footer line for work started from the picker. Separate from the status key
 * used for model switches so a manual load finishing cannot clear the
 * "loading…" of a switch made in the meantime (and the other way round).
 */
export const COMMAND_STATUS_KEY = "pi-lmstudio-evict:command";

/** What `withLoader` resolves to when the user pressed Escape. */
export const CANCELLED = Symbol("cancelled");

export type LoaderClass = typeof BorderedLoader;

/**
 * The loader class is a runtime import from pi, unlike every other pi import in
 * this package (those are type-only and erased), so it is loaded lazily: pi is
 * only a peer dependency, and a host that can't supply it must still get a
 * working picker, just without the spinner.
 */
const loadBorderedLoader = async (): Promise<LoaderClass> =>
	(await import("@earendil-works/pi-coding-agent")).BorderedLoader;

const setCommandStatus = (ctx: ExtensionCommandContext, text: string | undefined) => {
	try {
		ctx.ui.setStatus(COMMAND_STATUS_KEY, text);
	} catch {
		// Modes without a footer (print, RPC) — nothing to show.
	}
};

/** Footer status for the duration of a slow action. */
export async function withStatus<T>(
	ctx: ExtensionCommandContext,
	text: string,
	action: () => Promise<T>,
): Promise<T> {
	setCommandStatus(ctx, text);
	try {
		return await action();
	} finally {
		setCommandStatus(ctx, undefined);
	}
}

/**
 * Run `work` behind a loading indicator. In the TUI that is pi's own
 * cancellable loader (Escape resolves `CANCELLED` and aborts the signal handed
 * to `work`); anywhere else it is the footer status line, and the signal never
 * fires.
 *
 * If the loader can't be obtained in the TUI the picker still works, but the
 * user is told once, so a broken import shows up instead of silently costing
 * every picker its spinner.
 *
 * `loadLoader` is injectable for tests.
 */
export async function withLoader<T>(
	ctx: ExtensionCommandContext,
	message: string,
	work: (signal: AbortSignal) => Promise<T>,
	loadLoader: () => Promise<LoaderClass> = loadBorderedLoader,
): Promise<T | typeof CANCELLED> {
	let Loader: LoaderClass | undefined;
	if (ctx.mode === "tui") {
		try {
			Loader = await loadLoader();
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`lmstudio: loading indicator unavailable (${reason}); continuing without it`, "warning");
		}
	}

	if (!Loader) {
		return withStatus(ctx, `lmstudio: ${message}`, () => work(new AbortController().signal));
	}

	const LoaderCtor = Loader;
	// A failure must reach the caller, not look like Escape: the command
	// reports errors, and a vanished loader with no picker reads as a bug. One
	// that arrives after Escape is dropped: nobody is waiting for it.
	let settled = false;
	let failure: { error: unknown } | undefined;
	const result = await ctx.ui.custom<T | typeof CANCELLED>((tui, theme, _keybindings, done) => {
		const finish = (value: T | typeof CANCELLED) => {
			settled = true;
			done(value);
		};
		const loader = new LoaderCtor(tui, theme, message);
		loader.onAbort = () => finish(CANCELLED);
		work(loader.signal).then(
			(value) => {
				if (!settled) finish(loader.signal.aborted ? CANCELLED : value);
			},
			(error) => {
				if (settled) return;
				failure = { error };
				finish(CANCELLED);
			},
		);
		return loader;
	});
	if (failure) throw failure.error;
	return result;
}
