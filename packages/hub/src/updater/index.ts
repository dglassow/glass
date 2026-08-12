export { parseSemVer, compareSemVer, isNewer, type SemVer } from "./semver.js";
export { verifyTagSignature, UpdateVerifyError, type VerifyResult } from "./verify.js";
export { GitUpdateSource, type ReleaseManifest, type ReleaseTag } from "./update-source.js";
export { Updater, type UpdateDecision, type StageResult, type UpdaterOptions, type RejectedTag } from "./updater.js";
export { requestSwap, type SwapOutcome } from "./supervisor-client.js";
