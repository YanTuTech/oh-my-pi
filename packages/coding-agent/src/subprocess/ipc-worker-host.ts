/** Run a subprocess-isolated worker over Bun's process IPC channel. */
export async function runIpcSubprocessWorker<In, Out>(
	start: (transport: {
		send(message: Out): void;
		sendAndFlush(message: Out): Promise<void>;
		onMessage(handler: (message: In) => void): () => void;
	}) => void,
	options?: { rethrowConnectedSendErrors?: boolean },
): Promise<void> {
	const { promise: shuttingDown, resolve: shutdown } = Promise.withResolvers<void>();
	type IpcSend = (this: NodeJS.Process, message: unknown, callback?: (error: Error | null) => void) => boolean;
	const ipcSend = (): IpcSend | undefined => (process as NodeJS.Process & { send?: IpcSend }).send;
	const send = (message: Out): void => {
		const sender = ipcSend();
		if (!sender) {
			shutdown();
			return;
		}
		try {
			sender.call(process, message);
		} catch (error) {
			if (options?.rethrowConnectedSendErrors && process.connected) throw error;
			shutdown();
		}
	};
	const sendAndFlush = (message: Out): Promise<void> => {
		const sender = ipcSend();
		if (!sender) {
			shutdown();
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		try {
			sender.call(process, message, () => resolve());
		} catch {
			shutdown();
			resolve();
		}
		return promise;
	};
	start({
		send,
		sendAndFlush,
		onMessage(handler) {
			const wrap = (data: unknown): void => handler(data as In);
			process.on("message", wrap);
			return () => process.off("message", wrap);
		},
	});
	const keepalive = setInterval(() => {}, 2 ** 30);
	process.on("disconnect", shutdown);
	try {
		await shuttingDown;
	} finally {
		clearInterval(keepalive);
		process.off("disconnect", shutdown);
	}
	process.kill(process.pid, "SIGKILL");
}
