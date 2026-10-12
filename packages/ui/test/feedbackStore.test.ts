import { beforeEach, describe, expect, it } from "vitest";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";

function resetFeedbackStore() {
  useFeedbackStore.setState({
    open: false,
    featureRequestOpen: false,
    tab: "submit",
    submitDraft: null,
    submissionJobId: null,
    selectedTicketId: null,
  });
}

describe("feedback store", () => {
  beforeEach(() => {
    resetFeedbackStore();
  });

  it("入口关闭期间：互斥对话框与新建表单行为全部 no-op（FEEDBACK_ENTRY_ENABLED=false）", () => {
    // custom 反馈暂时关闭（spec specs/mikiko-cloud/agent-endpoint-plan.md §4.4）：
    // openSubmit/openFeatureRequest/openSubmissionJob 均直接 return，状态恒为关闭。
    // 恢复开关时，把本用例改回上游互斥/新建表单/按 jobId 打开三组断言。
    useFeedbackStore.getState().openFeatureRequest();
    expect(useFeedbackStore.getState()).toMatchObject({
      open: false,
      featureRequestOpen: false,
    });

    useFeedbackStore.getState().openSubmit({ includeLogs: true });
    expect(useFeedbackStore.getState()).toMatchObject({
      open: false,
      featureRequestOpen: false,
      submitDraft: null,
      submissionJobId: null,
    });

    useFeedbackStore.getState().openSubmissionJob("feedback-job-a");
    expect(useFeedbackStore.getState().submissionJobId).toBe(null);
  });
});
