export const FINE_TUNE_STATES = ["draft", "validating", "ready_for_provider", "failed"] as const;

export type FineTuneState = (typeof FINE_TUNE_STATES)[number];

export const MOCK_BASE_MODELS = [
  { id: "placeholder-flux-2-klein", label: "FLUX.2 [klein] — placeholder, verify with provider" },
  { id: "placeholder-flux-2-pro", label: "FLUX.2 [pro] — placeholder, verify with provider" },
] as const;

export type MockBaseModelId = (typeof MOCK_BASE_MODELS)[number]["id"];

export type FineTuneRecord = {
  id: string;
  name: string;
  baseModel: MockBaseModelId;
  precision: "FP8";
  triggerPhrase?: string;
  state: FineTuneState;
  checkpoint: {
    filename: string;
    byteSize: number;
  };
  createdAt: string;
  workflowVersion: 1;
};

export class FineTuneValidationError extends Error {}

export function validateFineTuneDraft(draft: {
  name: unknown;
  baseModel: unknown;
  precision: unknown;
  triggerPhrase: unknown;
  termsAccepted: unknown;
}) {
  if (typeof draft.name !== "string" || draft.name.trim().length < 3 || draft.name.trim().length > 80) {
    throw new FineTuneValidationError("Name must contain between 3 and 80 characters.");
  }
  if (!MOCK_BASE_MODELS.some((model) => model.id === draft.baseModel)) {
    throw new FineTuneValidationError("Select a supported placeholder base model.");
  }
  if (draft.precision !== "FP8") {
    throw new FineTuneValidationError("Only FP8 is available in this mock workflow.");
  }
  if (typeof draft.triggerPhrase !== "string" || draft.triggerPhrase.trim().length > 160) {
    throw new FineTuneValidationError("Trigger phrase must be 160 characters or fewer.");
  }
  if (draft.termsAccepted !== "true") {
    throw new FineTuneValidationError("Accept the Developer Terms acknowledgement before continuing.");
  }
}

export function safeCheckpointName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
