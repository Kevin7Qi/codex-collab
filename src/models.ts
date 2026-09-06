// src/models.ts — model selection shared by the CLI and the peer
//
// Both paths answer the same question when nothing names a model: which one
// should a new thread run on? The answer must not depend on how the prompt
// arrived — typed at a terminal or delivered as a message — so the walk
// from the server default up its upgrade chain lives here, once. The CLI's
// resolveDefaults and the peer's startThread both call it.

import type { AppServerClient } from "./client";
import type { Model } from "./types";
import { config, type ReasoningEffort } from "./config";

/** Fetch every page of a paginated list method. */
export async function fetchAllPages<T>(
  client: Pick<AppServerClient, "request">,
  method: string,
  baseParams: Record<string, unknown>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const params = cursor ? { ...baseParams, cursor } : baseParams;
    const page = await client.request<{ data: T[]; nextCursor: string | null }>(method, params);
    items.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

/** Pick the best model by following the upgrade chain from the server default,
 *  then preferring a -codex variant if one exists at the latest generation. */
export function pickBestModel(models: Model[]): string | undefined {
  const byId = new Map(models.map(m => [m.id, m]));

  // Start from the server's default model
  let current = models.find(m => m.isDefault);
  if (!current) return undefined;

  // Follow the upgrade chain to the latest generation
  const visited = new Set<string>();
  while (current.upgrade && !visited.has(current.id)) {
    visited.add(current.id);
    const next = byId.get(current.upgrade);
    if (!next) break; // upgrade target not in the list
    current = next;
  }

  // Prefer -codex variant if available at this generation
  if (!current.id.endsWith("-codex")) {
    const codexVariant = byId.get(current.id + "-codex");
    if (codexVariant && codexVariant.upgrade === null) return codexVariant.id;
  }

  return current.id;
}

/** Pick the highest reasoning effort a model supports, capped at the
 *  auto-select ceiling. */
export function pickAutoEffort(supported: Array<{ reasoningEffort: string }>): ReasoningEffort | undefined {
  const available = new Set(supported.map(s => s.reasoningEffort));
  const ceiling = config.reasoningEfforts.indexOf(config.autoEffortCeiling);
  for (let i = ceiling; i >= 0; i--) {
    if (available.has(config.reasoningEfforts[i])) return config.reasoningEfforts[i];
  }
  return undefined;
}

/** The defaults a thread gets when neither a flag, a header, nor `config`
 *  names them: the best model, and the highest effort it supports under the
 *  ceiling. `model` may be preset (only the effort is then resolved). Null
 *  when the server's list could not be read or is empty — the caller then
 *  lets the server choose, and says so. */
export async function resolveModelDefaults(
  client: Pick<AppServerClient, "request">,
  preset: { model?: string; effort?: string },
): Promise<{ model?: string; effort?: string } | null> {
  const models = await fetchAllPages<Model>(client, "model/list", { includeHidden: true });
  if (models.length === 0) return null;
  const model = preset.model ?? pickBestModel(models);
  let effort = preset.effort;
  if (effort === undefined) {
    const data = models.find(m => m.id === model);
    if (data?.supportedReasoningEfforts?.length) effort = pickAutoEffort(data.supportedReasoningEfforts);
  }
  return { model, effort };
}
