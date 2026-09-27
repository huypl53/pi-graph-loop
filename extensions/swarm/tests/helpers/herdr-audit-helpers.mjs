// helpers/herdr-audit-helpers.mjs — tiny helpers for herdr-audit-gap-branches.test.mjs.
// Kept separate so the test file stays focused on assertions.

export function getAttachCommandsShapeProbe(driver, target) {
	return driver.getAttachCommands(target);
}
