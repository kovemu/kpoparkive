"use client";

export type V3RegisteredOperation = {
  op: string;
  nodeId?: string;
  [key: string]: unknown;
};

export type V3OperationProvider = () => V3RegisteredOperation[];

type ProviderRegistry = Map<string, V3OperationProvider>;

declare global {
  interface Window {
    __kpoparkiveVe3OperationProviders?: ProviderRegistry;
  }
}

function registry(): ProviderRegistry {
  if (typeof window === "undefined") return new Map();
  if (!window.__kpoparkiveVe3OperationProviders) window.__kpoparkiveVe3OperationProviders = new Map();
  return window.__kpoparkiveVe3OperationProviders;
}

export function registerV3OperationProvider(key: string, provider: V3OperationProvider) {
  if (!key.trim()) throw new Error("V3 operation provider key is required");
  const providers = registry();
  providers.set(key, provider);
  return () => {
    if (providers.get(key) === provider) providers.delete(key);
  };
}

export function collectV3RegisteredOperations() {
  const operations: V3RegisteredOperation[] = [];
  for (const [key, provider] of registry().entries()) {
    const supplied = provider();
    if (!Array.isArray(supplied)) throw new Error(`V3 operation provider ${key} returned an invalid payload`);
    for (const operation of supplied) {
      if (!operation || typeof operation.op !== "string" || !operation.op.trim()) {
        throw new Error(`V3 operation provider ${key} returned an invalid operation`);
      }
      operations.push(operation);
    }
  }
  return operations;
}

export function clearV3OperationProviders() {
  registry().clear();
}

function operationNodeId(operation: V3RegisteredOperation) {
  return typeof operation.nodeId === "string" && operation.nodeId.trim() ? operation.nodeId : null;
}

const COMBINABLE_TABLE_OPERATIONS = new Set([
  "table-structure",
  "table-fields",
  "table-media",
  "table-cell-style",
  "table-layout",
]);

/**
 * Normalize the complete page edit before POST.
 * Backend validation remains authoritative; this catches predictable UI-layer
 * conflicts early and applies the same delete-wins semantics as the AST engine.
 */
export function preflightV3Operations(input: V3RegisteredOperation[]) {
  const operations = input.filter((operation) => operation && typeof operation.op === "string" && operation.op.trim());
  const blockDeletes = new Set(
    operations.filter((operation) => operation.op === "delete-node").map(operationNodeId).filter((id): id is string => Boolean(id)),
  );
  const inlineDeletes = new Set(
    operations.filter((operation) => operation.op === "delete-inline-node").map(operationNodeId).filter((id): id is string => Boolean(id)),
  );

  const seenBlockDeletes = new Set<string>();
  const seenInlineDeletes = new Set<string>();
  const normalized: V3RegisteredOperation[] = [];

  for (const operation of operations) {
    const nodeId = operationNodeId(operation);

    if (operation.op === "delete-node") {
      if (!nodeId) throw new Error("A block delete is missing its AST node id.");
      if (seenBlockDeletes.has(nodeId)) continue;
      seenBlockDeletes.add(nodeId);
      normalized.push(operation);
      continue;
    }

    if (operation.op === "delete-inline-node") {
      if (!nodeId) throw new Error("An inline delete is missing its AST node id.");
      if (blockDeletes.has(nodeId) || seenInlineDeletes.has(nodeId)) continue;
      seenInlineDeletes.add(nodeId);
      normalized.push(operation);
      continue;
    }

    if (nodeId && (blockDeletes.has(nodeId) || inlineDeletes.has(nodeId))) continue;
    normalized.push(operation);
  }

  const byNode = new Map<string, V3RegisteredOperation[]>();
  for (const operation of normalized) {
    const nodeId = operationNodeId(operation);
    if (!nodeId || operation.op === "delete-node" || operation.op === "delete-inline-node") continue;
    byNode.set(nodeId, [...(byNode.get(nodeId) || []), operation]);
  }

  for (const [nodeId, group] of byNode.entries()) {
    if (group.length <= 1) continue;

    const raw = group.filter((operation) => operation.op === "replace-raw");
    if (raw.length) {
      throw new Error(
        `AST node ${nodeId} was edited in both Advanced Source and Visual mode. Reset one of those edits before saving.`,
      );
    }

    const replacements = group.filter((operation) => operation.op === "replace-node");
    if (replacements.length) {
      throw new Error(
        `AST node ${nodeId} has more than one whole-block visual edit. Keep only one editor surface for this block before saving.`,
      );
    }

    if (group.every((operation) => COMBINABLE_TABLE_OPERATIONS.has(operation.op))) continue;

    throw new Error(
      `AST node ${nodeId} received incompatible visual operations (${group.map((operation) => operation.op).join(", ")}).`,
    );
  }

  return normalized;
}
