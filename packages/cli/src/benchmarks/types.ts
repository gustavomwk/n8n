/** A benchmarking task, i.e. a single operation whose performance to measure. */
export type Task = {
	description: string;
	operation: () => Promise<void>;
};