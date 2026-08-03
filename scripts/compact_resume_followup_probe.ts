import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FOLLOWUP_PROMPT =
	"[followup-probe] This message was queued from a turn_end hook with deliverAs=followUp. " +
	"Without waiting for any user input, respond exactly with FOLLOWUP_OK and then stop.";

export default function (pi: ExtensionAPI) {
	let queued = false;
	let completed = false;

	pi.on("turn_end", (_event, ctx) => {
		if (completed) return;
		if (!queued) {
			queued = true;
			pi.sendMessage(
				{ customType: "followup-probe", content: FOLLOWUP_PROMPT, display: true },
				{ deliverAs: "followUp" },
			);
			if (ctx.hasUI) ctx.ui.notify("followup-probe: queued one followUp from turn_end", "info");
			return;
		}
		completed = true;
		if (ctx.hasUI) ctx.ui.notify("followup-probe: observed the queued followUp turn", "info");
	});
}
