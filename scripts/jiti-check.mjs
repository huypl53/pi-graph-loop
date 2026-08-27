#!/usr/bin/env node
import { createRequire } from "node:module";
import { resolve } from "node:path";
const require = createRequire("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
const { createJiti } = require("jiti");

const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });

async function main() {
	const extensions = process.argv.slice(2);
	if (extensions.length === 0) {
		console.error("Usage: node scripts/ji-check.mjs <glob-to-extensions>");
		process.exit(1);
	}
	
	// Convert glob to paths
	const { glob } = await import('glob');
	const extPaths = [];
	for (const pattern of extensions) {
		const matches = await glob(pattern);
		for (const match of matches) {
			extPaths.push(match);
		}
	}
	
	if (extPaths.length === 0) {
		console.error("No extension files found");
		process.exit(1);
	}
	
	let hasErrors = false;
	
	for (const extPath of extPaths) {
		try {
			await jiti.import(resolve(process.cwd(), extPath));
			console.log(`✓ ${extPath} - PARSE OK`);
		} catch (err) {
			console.error(`✗ ${extPath} - FAIL`);
			console.error(`  Error: ${err.message}`);
			hasErrors = true;
		}
	}
	
	if (hasErrors) {
		process.exit(1);
	}
	
	console.log("All extensions parsed successfully with jiti");
	process.exit(0);
}

main().catch((err) => {
	console.error(`Unexpected error: ${err.message}`);
	process.exit(1);
});
