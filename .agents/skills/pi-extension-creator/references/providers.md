# Custom providers reference

`pi.registerProvider(name, config)` (or pass a native pi-ai `Provider` object) to
register or override a model provider — for proxies, local servers, team-wide model
configs, OAuth. Calls during the factory are queued and applied at startup; calls
after load take effect immediately (no `/reload`). `pi.unregisterProvider(name)`
removes it and restores any built-in models it overrode.

Full prose in `docs/extensions.md` → "pi.registerProvider"; advanced topics
(custom streaming, OAuth details, model definition reference) in `custom-provider.md`.

## Simplest: a named config object
```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("my-proxy", {
    name: "My Proxy",
    baseUrl: "https://proxy.example.com",
    apiKey: "$PROXY_API_KEY",     // env interpolation: $VAR or ${VAR}; $$ escapes $; leading !cmd runs a command ($! escapes literal !)
    api: "anthropic-messages",     // "anthropic-messages" | "openai-completions" | "openai-responses" | ...
    // headers: { ... }, authHeader: true,
    models: [
      {
        id: "claude-sonnet-4-5",
        name: "Sonnet (proxy)",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
        // baseUrl: "..." // optional per-model override of the provider endpoint
      },
    ],
  });
}
```
- `models`, if provided, **replaces** all existing models for the provider.
- `baseUrl` is required when defining models; `apiKey` required unless `oauth` given.

## Override an existing provider (keeps its models)
```typescript
pi.registerProvider("anthropic", { baseUrl: "https://proxy.example.com" });
```

## Dynamic discovery (`refreshModels`)
The returned models replace extension-provided models. Pi calls it during model
refresh and passes a scoped `context` (credential/store/network/signal). Use
`context.store` only if results should persist (live servers like llama.cpp can
ignore it).
```typescript
pi.registerProvider("llama.cpp", {
  baseUrl: "http://localhost:8080/v1",
  apiKey: "local",
  api: "openai-completions",
  async refreshModels({ signal }) {
    const r = await fetch("http://localhost:8080/v1/models", { signal });
    const { data } = await r.json();
    return data.map(({ id }) => ({
      id, name: id, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 16384,
    }));
  },
});
```
Fetch models at load time for an auto-discovered catalog (async factory):
```typescript
export default async function (pi: ExtensionAPI) {
  const r = await fetch("http://localhost:1234/v1/models");
  const { data } = await r.json();
  pi.registerProvider("local-openai", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "$LOCAL_OPENAI_API_KEY",
    api: "openai-completions",
    models: data.map((m) => ({
      id: m.id, name: m.name ?? m.id, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.context_window ?? 128000, maxTokens: m.max_tokens ?? 4096,
    })),
  });
}
```
⚠️ Async factories run before any session. Don't start background resources there;
fetching config/model lists is fine.

## OAuth (appears in `/login`)
```typescript
pi.registerProvider("corporate-ai", {
  baseUrl: "https://ai.corp.com",
  api: "openai-responses",
  models: [/* ... */],
  oauth: {
    name: "Corporate AI (SSO)",
    async login(callbacks) {
      callbacks.onAuth({ url: "https://sso.corp.com/..." });
      const code = await callbacks.onPrompt({ message: "Enter code:" });
      return { refresh: code, access: code, expires: Date.now() + 3600_000 };
    },
    async refreshToken(creds) { /* ... */ return creds; },
    getApiKey(creds) { return creds.access; },
  },
});
```

## Native pi-ai `Provider` object (full control)
For native auth, `getModels`, `refreshModels`, `filterModels`, `stream`, `streamSimple`.
The provider becomes the composition base; `models.json` overrides still apply above it.
```typescript
import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai";

const provider = createProvider({
  id: "local-server",
  name: "Local Server",
  baseUrl: "http://localhost:8080/v1",
  auth: {
    apiKey: {
      name: "Local server setup",
      async login(interaction) {
        return { type: "api_key", key: await interaction.prompt({ type: "secret", message: "API key" }) };
      },
      async resolve({ credential }) {
        return credential?.key ? { auth: { apiKey: credential.key }, source: "stored API key" } : undefined;
      },
    },
  },
  models: [],
  api: openAICompletionsApi(),
});
pi.registerProvider(provider);
```

## Config options summary
`name`, `baseUrl`, `apiKey` (literal / `$ENV` / `!cmd`), `api`, `headers`,
`authHeader`, `models[]` (id, name, reasoning, input[], cost{input,output,cacheRead,cacheWrite},
contextWindow, maxTokens, optional baseUrl), `refreshModels`, `oauth`, `streamSimple`.

## Examples
`custom-provider-anthropic/` (proxy), `custom-provider-gitlab-duo/` (OAuth). For
deeper custom streaming APIs and the model-definition reference, read `custom-provider.md`.
