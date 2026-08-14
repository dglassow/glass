/**
 * Sending via Messages.app (AppleScript). Two scripts, both taking their
 * inputs through `on run argv` — the message text and target ride ARGV, and
 * are NEVER interpolated into AppleScript source, so quotes/newlines/anything
 * in a message can't become script (the injection surface simply doesn't
 * exist). execFile, no shell, for the same reason.
 *
 * Replying into an existing conversation (chat id) is reliable. Starting a
 * thread to a bare handle is best-effort — modern macOS is flaky about
 * brand-new threads (an accepted limitation; the error surfaces to the
 * viewer). First send prompts the one-time Automation consent for Messages.
 *
 * GLASS_IMESSAGE_SEND_BIN overrides the binary — the test seam (a stub that
 * records its argv), same pattern as GLASS_ETCH_BIN.
 */
import { execFile } from "node:child_process";

const REPLY_SCRIPT = `on run {targetGuid, msgText}
	tell application "Messages" to send msgText to chat id targetGuid
end run`;

const NEW_THREAD_SCRIPT = `on run {targetHandle, msgText}
	tell application "Messages"
		set targetService to 1st account whose service type = iMessage
		send msgText to participant targetHandle of targetService
	end tell
end run`;

export function sendIMessage(target: { chatGuid?: string; handle?: string }, text: string): Promise<void> {
  const targetArg = target.chatGuid ?? target.handle;
  if (!targetArg) return Promise.reject(new Error("imessage send: no target"));
  const bin = process.env["GLASS_IMESSAGE_SEND_BIN"] || "/usr/bin/osascript";
  const script = target.chatGuid !== undefined ? REPLY_SCRIPT : NEW_THREAD_SCRIPT;
  return new Promise((resolve, reject) => {
    execFile(bin, ["-e", script, targetArg, text], { timeout: 15_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(firstLine(stderr) || err.message));
      else resolve();
    });
  });
}

function firstLine(s: string): string {
  return (s.split("\n", 1)[0] ?? "").trim().slice(0, 256);
}
