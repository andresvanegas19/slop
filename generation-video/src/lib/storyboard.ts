export const STORYBOARD_SCHEMA_VERSION = "1.0" as const;

export type StoryboardStyle = {
  id: string;
  visualPrompt: string;
  aspectRatio: "16:9" | "9:16" | "1:1";
  seed?: number;
  referenceImageIds: string[];
};

export type StoryboardTiming = {
  startMs: number;
  durationMs: number;
};

export type StoryboardMotion = {
  camera: "static" | "pan-left" | "pan-right" | "push-in" | "pull-out" | "tilt-up" | "tilt-down";
  description: string;
};

export type StoryboardTransition = {
  type: "cut" | "cross-dissolve" | "fade-to-black" | "match-cut";
  durationMs: number;
};

export type StoryboardOnScreenText = {
  text: string;
  position: "top" | "center" | "bottom";
};

export type StoryboardNarrationWarning = {
  code: "unsupported-claim" | "ambiguous-timing" | "legal-review" | "sensitive-content";
  message: string;
};

export type StoryboardScene = {
  id: string;
  timing: StoryboardTiming;
  visualPrompt: string;
  motion: StoryboardMotion;
  transition: StoryboardTransition;
  onScreenText: StoryboardOnScreenText[];
  narration: string;
  narrationWarnings: StoryboardNarrationWarning[];
  evidenceIds: string[];
};

export type Storyboard = {
  schemaVersion: typeof STORYBOARD_SCHEMA_VERSION;
  id: string;
  patchIds: string[];
  headline: string;
  style: StoryboardStyle;
  scenes: StoryboardScene[];
};

export type StoryboardValidationIssue = {
  path: string;
  code: "invalid_type" | "missing_field" | "invalid_value" | "invalid_timing";
  message: string;
};

export type StoryboardValidationResult =
  | { success: true; data: Storyboard }
  | { success: false; errors: StoryboardValidationIssue[] };

const aspectRatios = new Set<StoryboardStyle["aspectRatio"]>(["16:9", "9:16", "1:1"]);
const cameraMoves = new Set<StoryboardMotion["camera"]>([
  "static",
  "pan-left",
  "pan-right",
  "push-in",
  "pull-out",
  "tilt-up",
  "tilt-down",
]);
const transitionTypes = new Set<StoryboardTransition["type"]>([
  "cut",
  "cross-dissolve",
  "fade-to-black",
  "match-cut",
]);
const textPositions = new Set<StoryboardOnScreenText["position"]>(["top", "center", "bottom"]);
const warningCodes = new Set<StoryboardNarrationWarning["code"]>([
  "unsupported-claim",
  "ambiguous-timing",
  "legal-review",
  "sensitive-content",
]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  errors: StoryboardValidationIssue[],
  path: string,
  code: StoryboardValidationIssue["code"],
  message: string,
) {
  errors.push({ path, code, message });
}

function stringAt(
  value: UnknownRecord,
  key: string,
  path: string,
  errors: StoryboardValidationIssue[],
): string | undefined {
  const field = value[key];
  if (typeof field !== "string") {
    issue(errors, `${path}.${key}`, field === undefined ? "missing_field" : "invalid_type", "Expected a string.");
    return undefined;
  }

  if (field.trim().length === 0) {
    issue(errors, `${path}.${key}`, "invalid_value", "Must not be empty.");
    return undefined;
  }

  return field;
}

function integerAt(
  value: UnknownRecord,
  key: string,
  path: string,
  errors: StoryboardValidationIssue[],
  minimum = 0,
): number | undefined {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field) || !Number.isInteger(field)) {
    issue(errors, `${path}.${key}`, field === undefined ? "missing_field" : "invalid_type", "Expected a finite integer.");
    return undefined;
  }

  if (field < minimum) {
    issue(errors, `${path}.${key}`, "invalid_value", `Must be at least ${minimum}.`);
    return undefined;
  }

  return field;
}

function recordAt(
  value: UnknownRecord,
  key: string,
  path: string,
  errors: StoryboardValidationIssue[],
): UnknownRecord | undefined {
  const field = value[key];
  if (!isRecord(field)) {
    issue(errors, `${path}.${key}`, field === undefined ? "missing_field" : "invalid_type", "Expected an object.");
    return undefined;
  }
  return field;
}

function stringsAt(
  value: UnknownRecord,
  key: string,
  path: string,
  errors: StoryboardValidationIssue[],
  minimumLength = 0,
): string[] | undefined {
  const field = value[key];
  if (!Array.isArray(field)) {
    issue(errors, `${path}.${key}`, field === undefined ? "missing_field" : "invalid_type", "Expected an array of strings.");
    return undefined;
  }

  const strings: string[] = [];
  field.forEach((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      issue(errors, `${path}.${key}[${index}]`, "invalid_type", "Expected a non-empty string.");
      return;
    }
    strings.push(item);
  });

  if (field.length < minimumLength) {
    issue(errors, `${path}.${key}`, "invalid_value", `Must contain at least ${minimumLength} item(s).`);
  }

  return field.length === strings.length ? strings : undefined;
}

function enumAt<T extends string>(
  value: UnknownRecord,
  key: string,
  path: string,
  allowed: Set<T>,
  errors: StoryboardValidationIssue[],
): T | undefined {
  const field = value[key];
  if (typeof field !== "string") {
    issue(errors, `${path}.${key}`, field === undefined ? "missing_field" : "invalid_type", "Expected a string.");
    return undefined;
  }
  if (!allowed.has(field as T)) {
    issue(errors, `${path}.${key}`, "invalid_value", "Contains an unsupported value.");
    return undefined;
  }
  return field as T;
}

function parseStyle(value: UnknownRecord, errors: StoryboardValidationIssue[]): StoryboardStyle | undefined {
  const path = "$.style";
  const id = stringAt(value, "id", path, errors);
  const visualPrompt = stringAt(value, "visualPrompt", path, errors);
  const aspectRatio = enumAt(value, "aspectRatio", path, aspectRatios, errors);
  const referenceImageIds = stringsAt(value, "referenceImageIds", path, errors);
  const seed = value.seed === undefined ? undefined : integerAt(value, "seed", path, errors);

  if (!id || !visualPrompt || !aspectRatio || !referenceImageIds || (value.seed !== undefined && seed === undefined)) {
    return undefined;
  }
  return { id, visualPrompt, aspectRatio, ...(seed === undefined ? {} : { seed }), referenceImageIds };
}

function parseScene(
  value: unknown,
  index: number,
  errors: StoryboardValidationIssue[],
): StoryboardScene | undefined {
  const path = `$.scenes[${index}]`;
  if (!isRecord(value)) {
    issue(errors, path, "invalid_type", "Expected an object.");
    return undefined;
  }

  const id = stringAt(value, "id", path, errors);
  const visualPrompt = stringAt(value, "visualPrompt", path, errors);
  const narration = stringAt(value, "narration", path, errors);
  const evidenceIds = stringsAt(value, "evidenceIds", path, errors);

  const timingValue = recordAt(value, "timing", path, errors);
  const startMs = timingValue && integerAt(timingValue, "startMs", `${path}.timing`, errors);
  const durationMs = timingValue && integerAt(timingValue, "durationMs", `${path}.timing`, errors, 1);

  const motionValue = recordAt(value, "motion", path, errors);
  const camera = motionValue && enumAt(motionValue, "camera", `${path}.motion`, cameraMoves, errors);
  const motionDescription = motionValue && stringAt(motionValue, "description", `${path}.motion`, errors);

  const transitionValue = recordAt(value, "transition", path, errors);
  const transitionType = transitionValue && enumAt(transitionValue, "type", `${path}.transition`, transitionTypes, errors);
  const transitionDurationMs = transitionValue && integerAt(transitionValue, "durationMs", `${path}.transition`, errors);
  if (transitionDurationMs !== undefined && durationMs !== undefined && transitionDurationMs > durationMs) {
    issue(errors, `${path}.transition.durationMs`, "invalid_timing", "Cannot exceed the scene duration.");
  }

  const textValue = value.onScreenText;
  const onScreenText: StoryboardOnScreenText[] = [];
  if (!Array.isArray(textValue)) {
    issue(errors, `${path}.onScreenText`, textValue === undefined ? "missing_field" : "invalid_type", "Expected an array.");
  } else {
    textValue.forEach((item, textIndex) => {
      const textPath = `${path}.onScreenText[${textIndex}]`;
      if (!isRecord(item)) {
        issue(errors, textPath, "invalid_type", "Expected an object.");
        return;
      }
      const text = stringAt(item, "text", textPath, errors);
      const position = enumAt(item, "position", textPath, textPositions, errors);
      if (text && position) onScreenText.push({ text, position });
    });
  }

  const warningsValue = value.narrationWarnings;
  const narrationWarnings: StoryboardNarrationWarning[] = [];
  if (!Array.isArray(warningsValue)) {
    issue(errors, `${path}.narrationWarnings`, warningsValue === undefined ? "missing_field" : "invalid_type", "Expected an array.");
  } else {
    warningsValue.forEach((item, warningIndex) => {
      const warningPath = `${path}.narrationWarnings[${warningIndex}]`;
      if (!isRecord(item)) {
        issue(errors, warningPath, "invalid_type", "Expected an object.");
        return;
      }
      const code = enumAt(item, "code", warningPath, warningCodes, errors);
      const message = stringAt(item, "message", warningPath, errors);
      if (code && message) narrationWarnings.push({ code, message });
    });
  }

  if (
    !id ||
    !visualPrompt ||
    !narration ||
    !evidenceIds ||
    startMs === undefined ||
    durationMs === undefined ||
    !camera ||
    !motionDescription ||
    !transitionType ||
    transitionDurationMs === undefined ||
    !Array.isArray(textValue) ||
    !Array.isArray(warningsValue)
  ) {
    return undefined;
  }

  return {
    id,
    timing: { startMs, durationMs },
    visualPrompt,
    motion: { camera, description: motionDescription },
    transition: { type: transitionType, durationMs: transitionDurationMs },
    onScreenText,
    narration,
    narrationWarnings,
    evidenceIds,
  };
}

function normalizeSuppliedStoryboard(value: UnknownRecord): unknown {
  if (typeof value.storyboard_id !== "string") return value;

  const sourceStyle = isRecord(value.style) ? value.style : {};
  const sourceScenes = Array.isArray(value.scenes) ? value.scenes : [];
  const narrationWarnings = Array.isArray(value.narration_warnings) ? value.narration_warnings : undefined;

  return {
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    id: value.storyboard_id,
    patchIds: sourceScenes.flatMap((scene) => isRecord(scene) && Array.isArray(scene.change_ids)
      ? scene.change_ids.filter((id): id is string => typeof id === "string")
      : []),
    headline: value.title,
    style: {
      id: "supplied-storyboard-style",
      visualPrompt: sourceStyle.prompt_prefix,
      aspectRatio: sourceStyle.aspect_ratio,
      seed: sourceStyle.seed,
      referenceImageIds: [],
    },
    scenes: sourceScenes.map((scene, index) => {
      const source = isRecord(scene) ? scene : {};
      const text = isRecord(source.on_screen_text) ? source.on_screen_text : {};
      const headline = typeof text.headline === "string" ? text.headline : undefined;
      const sub = typeof text.sub === "string" ? text.sub : undefined;
      const transitionMatch = typeof source.transition_out === "string"
        ? source.transition_out.match(/^crossfade_(\d+(?:\.\d+)?)s$/)
        : undefined;
      const motion: Record<string, StoryboardMotion["camera"]> = {
        "slow push in": "push-in",
        "slow zoom out": "pull-out",
        static: "static",
      };

      return {
        id: `scene_${typeof source.scene === "number" ? source.scene : index + 1}`,
        timing: {
          startMs: typeof source.start_sec === "number" ? Math.round(source.start_sec * 1000) : source.start_sec,
          durationMs: typeof source.duration_sec === "number" ? Math.round(source.duration_sec * 1000) : source.duration_sec,
        },
        visualPrompt: source.image_prompt,
        motion: {
          camera: typeof source.motion === "string" ? motion[source.motion] ?? source.motion : source.motion,
          description: source.motion,
        },
        transition: {
          type: transitionMatch ? "cross-dissolve" : "cut",
          durationMs: transitionMatch ? Math.round(Number(transitionMatch[1]) * 1000) : 0,
        },
        onScreenText: [
          ...(headline ? [{ text: headline, position: "top" }] : []),
          ...(sub ? [{ text: sub, position: "bottom" }] : []),
        ],
        narration: source.narration,
        narrationWarnings: narrationWarnings,
        evidenceIds: Array.isArray(source.change_ids) ? source.change_ids : [],
      };
    }),
  };
}

/** Validates untrusted JSON without throwing or exposing submitted values in errors. */
export function validateStoryboard(value: unknown): StoryboardValidationResult {
  const errors: StoryboardValidationIssue[] = [];
  if (!isRecord(value)) {
    return { success: false, errors: [{ path: "$", code: "invalid_type", message: "Expected an object." }] };
  }
  value = normalizeSuppliedStoryboard(value);
  if (!isRecord(value)) {
    return { success: false, errors: [{ path: "$", code: "invalid_type", message: "Expected an object." }] };
  }

  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== STORYBOARD_SCHEMA_VERSION) {
    issue(errors, "$.schemaVersion", schemaVersion === undefined ? "missing_field" : "invalid_value", `Expected "${STORYBOARD_SCHEMA_VERSION}".`);
  }
  const id = stringAt(value, "id", "$", errors);
  const patchIds = stringsAt(value, "patchIds", "$", errors);
  const headline = stringAt(value, "headline", "$", errors);

  const styleValue = recordAt(value, "style", "$", errors);
  const style = styleValue && parseStyle(styleValue, errors);

  const scenesValue = value.scenes;
  const scenes: StoryboardScene[] = [];
  if (!Array.isArray(scenesValue)) {
    issue(errors, "$.scenes", scenesValue === undefined ? "missing_field" : "invalid_type", "Expected an array.");
  } else if (scenesValue.length === 0) {
    issue(errors, "$.scenes", "invalid_value", "Must contain at least one scene.");
  } else {
    scenesValue.forEach((scene, index) => {
      const parsed = parseScene(scene, index, errors);
      if (parsed) scenes.push(parsed);
    });
    for (let index = 1; index < scenes.length; index += 1) {
      const previous = scenes[index - 1];
      const current = scenes[index];
      const previousEnd = previous.timing.startMs + previous.timing.durationMs;
      if (current.timing.startMs < previousEnd) {
        issue(errors, `$.scenes[${index}].timing.startMs`, "invalid_timing", "Scenes must be ordered without overlap.");
      }
    }
  }

  if (
    errors.length > 0 ||
    schemaVersion !== STORYBOARD_SCHEMA_VERSION ||
    !id ||
    !patchIds ||
    !headline ||
    !style ||
    !Array.isArray(scenesValue) ||
    scenes.length !== scenesValue.length
  ) {
    return { success: false, errors };
  }

  return {
    success: true,
    data: { schemaVersion: STORYBOARD_SCHEMA_VERSION, id, patchIds, headline, style, scenes },
  };
}
