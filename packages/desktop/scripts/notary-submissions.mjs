/** 同一原包候选公证的导入与选择；IO 由 state.json 所有者注入，见 macos-signing spec。 */
import { basename, dirname, join } from "node:path";

function submissionCandidates(state) {
  const candidates = state.submissions ?? [
    {
      id: state.id,
      uploadName: state.uploadName,
      status: state.status,
      checkedAt: state.checkedAt,
    },
  ];
  if (
    !Array.isArray(candidates) ||
    !candidates.length ||
    candidates.some((item) => !item.id) ||
    new Set(candidates.map((item) => item.id)).size !== candidates.length
  )
    throw new Error("Invalid notarization candidate state");
  return candidates;
}
function verifySubmissionInfo(bundle, id, result) {
  const originalName = `${basename(bundle.dmg, ".dmg")}-${bundle.files[bundle.dmg].sha256}`;
  const retrySuffix = result.name?.startsWith(`${originalName}-retry-`)
    ? result.name.slice(`${originalName}-retry-`.length)
    : "";
  if (
    result.id !== id ||
    (result.name !== `${originalName}.dmg` && !/^\d+\.dmg$/.test(retrySuffix))
  )
    throw new Error("Additional submission upload identity mismatch");
}
export async function addSubmissionCandidate({ bundle, state, submissionId, runNotary }) {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(submissionId ?? ""))
    throw new Error("Invalid additional submission ID");
  if (!state.id) throw new Error("Original submission ID required before adoption");
  const result = await runNotary(["info", submissionId], { timeout: 30_000 });
  verifySubmissionInfo(bundle, submissionId, result);
  const candidates = submissionCandidates(state).filter((item) => item.id !== submissionId);
  candidates.push({
    id: submissionId,
    uploadName: result.name,
    status: result.status,
    checkedAt: new Date().toISOString(),
    createdDate: result.createdDate,
  });
  state.submissions = candidates;
  return state;
}
export async function waitCandidateNotarizations({
  bundle,
  state,
  statePath,
  saveJson,
  runNotary,
  timeout,
  now,
  sleep,
}) {
  const duration = /^(\d+)([smh]?)$/.exec(timeout);
  const milliseconds =
    duration && Number(duration[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[duration[2] || "s"];
  if (!milliseconds || !Number.isFinite(milliseconds))
    throw new Error("Invalid notary wait timeout");
  const deadline = now() + milliseconds;
  const candidates = submissionCandidates(state);
  while (true) {
    if (now() >= deadline) return false;
    // In Progress 不暴露内部子状态；同时续查同包的全部申请，不能只盯住旧 ID。
    const results = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          const result = await runNotary(["info", candidate.id], {
            timeout: Math.max(1, Math.min(30_000, deadline - now())),
          });
          verifySubmissionInfo(bundle, candidate.id, result);
          Object.assign(candidate, {
            uploadName: result.name,
            status: result.status,
            checkedAt: new Date().toISOString(),
            queryFailed: false,
          });
          return candidate;
        } catch {
          // 不保存子进程原始异常，避免带凭据的命令参数落入 artifact。
          candidate.queryFailed = true;
          return undefined;
        }
      }),
    );
    const available = results.filter(Boolean);
    const accepted = available.find((item) => item.status === "Accepted");
    const pending = available.find((item) => item.status === "In Progress");
    const selected = accepted ?? pending ?? available[0];
    if (selected)
      Object.assign(state, {
        id: selected.id,
        uploadName: selected.uploadName,
        status: selected.status,
        checkedAt: selected.checkedAt,
        phase: accepted ? "accepted" : "submitted",
      });
    state.submissions = candidates;
    await saveJson(statePath, state);
    if (accepted) return true;
    if (!available.length)
      throw new Error("All notarization candidate queries failed; submissions retained");
    if (!pending && !candidates.some((item) => item.queryFailed)) {
      for (const candidate of candidates) {
        try {
          await saveJson(
            join(dirname(statePath), `notary-log-${candidate.id}.json`),
            await runNotary(["log", candidate.id]),
          );
        } catch {
          console.error(`Could not retrieve rejection log for ${candidate.id}`);
        }
      }
      throw new Error(
        `Apple notarization candidates not Accepted: ${available.map((item) => item.status).join(", ")}`,
      );
    }
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleep(Math.min(30_000, remaining));
  }
}
