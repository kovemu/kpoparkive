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
