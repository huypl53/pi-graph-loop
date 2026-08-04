// utils — aggregator entry for small standalone extensions.
// pi loads a directory's index.ts and calls its DEFAULT export as the factory
// (loader: `jiti.import(path, { default: true })` must yield a function). A bare
// re-export barrel has no default export, so pi skips it ("does not export a
// valid factory function") and nothing inside ever runs. Wire each sub-extension
// here by calling its own default factory with the shared ExtensionAPI.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import timestamp from "./message-timestamp";
import compactResume from "./compact-resume";

export default function (pi: ExtensionAPI) {
	timestamp(pi);
	compactResume(pi);
}
