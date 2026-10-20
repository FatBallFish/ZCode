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

  it("self-hosted feedback keeps product-request and issue dialogs mutually exclusive", () => {
    useFeedbackStore.getState().openFeatureRequest();
    expect(useFeedbackStore.getState()).toMatchObject({ open: false, featureRequestOpen: true });
    useFeedbackStore.getState().openSubmit({ includeLogs: true });
    expect(useFeedbackStore.getState()).toMatchObject({
      open: true,
      featureRequestOpen: false,
      submitDraft: { includeLogs: true },
      submissionJobId: null,
    });
  });

  it("new issue drafts detach an earlier background submission", () => {
    useFeedbackStore.getState().openSubmissionJob("feedback-job-a");
    expect(useFeedbackStore.getState().submissionJobId).toBe("feedback-job-a");
    useFeedbackStore.getState().openSubmit();
    expect(useFeedbackStore.getState()).toMatchObject({
      submissionJobId: null,
      submitDraft: null,
      tab: "submit",
    });
  });
});
