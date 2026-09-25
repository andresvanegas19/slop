import { withRouteLog } from "@/lib/route-log";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  FineTuneValidationError,
  type FineTuneRecord,
  safeCheckpointName,
  validateFineTuneDraft,
} from "@/lib/finetune";
import { logError, logInfo } from "@/lib/runtime-log";

export const runtime = "nodejs";

const MAX_CHECKPOINT_BYTES = 100 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function formValue(formData: FormData, key: string) {
  const values = formData.getAll(key);
  if (values.length !== 1 || typeof values[0] !== "string") {
    throw new FineTuneValidationError(`Provide a single ${key} field.`);
  }

  return values[0];
}

async function writeAtomically(destination: string, contents: Uint8Array | string) {
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, contents, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, destination);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function routePOST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    logError("finetune_rejected", { reason: "invalid_content_type" });
    return errorResponse("Content-Type must be multipart/form-data.", 415);
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_CHECKPOINT_BYTES + MAX_MULTIPART_OVERHEAD_BYTES
  ) {
    logError("finetune_rejected", { reason: "request_too_large" });
    return errorResponse("Checkpoint exceeds the 100 MiB size limit.", 413);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    logError("finetune_rejected", { reason: "invalid_multipart" });
    return errorResponse("Unable to parse multipart form data.", 400);
  }

  try {
    const name = formValue(formData, "name");
    const baseModel = formValue(formData, "baseModel");
    const precision = formValue(formData, "precision");
    const triggerPhrase = formValue(formData, "triggerPhrase");
    const termsAccepted = formValue(formData, "termsAccepted");

    validateFineTuneDraft({ name, baseModel, precision, triggerPhrase, termsAccepted });

    const checkpoints = formData.getAll("checkpoint");
    if (checkpoints.length !== 1 || !(checkpoints[0] instanceof File)) {
      logError("finetune_rejected", { reason: "invalid_checkpoint_count" });
      return errorResponse("Provide exactly one checkpoint file.", 400);
    }

    const checkpoint = checkpoints[0];
    if (!checkpoint.name.toLowerCase().endsWith(".safetensors")) {
      logError("finetune_rejected", { reason: "invalid_checkpoint_extension" });
      return errorResponse("Checkpoint must use the .safetensors extension.", 400);
    }
    if (checkpoint.size === 0) {
      logError("finetune_rejected", { reason: "empty_checkpoint" });
      return errorResponse("Checkpoint file must not be empty.", 400);
    }
    if (checkpoint.size > MAX_CHECKPOINT_BYTES) {
      logError("finetune_rejected", { reason: "checkpoint_too_large" });
      return errorResponse("Checkpoint exceeds the 100 MiB size limit.", 413);
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const record: FineTuneRecord = {
      id,
      name: name.trim(),
      baseModel: baseModel as FineTuneRecord["baseModel"],
      precision: "FP8",
      ...(triggerPhrase.trim() ? { triggerPhrase: triggerPhrase.trim() } : {}),
      state: "ready_for_provider",
      checkpoint: {
        filename: safeCheckpointName(checkpoint.name),
        byteSize: checkpoint.size,
      },
      createdAt,
      workflowVersion: 1,
    };

    const outputRoot = path.resolve(process.cwd(), "output");
    const checkpointsDirectory = path.join(outputRoot, "finetunes");
    const manifestsDirectory = path.join(outputRoot, "manifests");
    await Promise.all([
      mkdir(checkpointsDirectory, { recursive: true, mode: 0o700 }),
      mkdir(manifestsDirectory, { recursive: true, mode: 0o700 }),
    ]);

    const checkpointPath = path.join(checkpointsDirectory, `${id}.safetensors`);
    const manifestPath = path.join(manifestsDirectory, `${id}.json`);

    await writeAtomically(checkpointPath, new Uint8Array(await checkpoint.arrayBuffer()));
    try {
      await writeAtomically(manifestPath, `${JSON.stringify(record)}\n`);
    } catch (error) {
      await rm(checkpointPath, { force: true });
      throw error;
    }

    logInfo("finetune_registered", { id, byteSize: checkpoint.size, state: record.state });
    return Response.json(record, { status: 201 });
  } catch (error) {
    if (error instanceof FineTuneValidationError) {
      logError("finetune_rejected", { reason: error.message });
      return errorResponse(error.message, 400);
    }

    logError("finetune_failed", { reason: "storage_error" });
    return errorResponse("Unable to save fine-tune checkpoint.", 500);
  }
}

export const POST = withRouteLog(routePOST);
