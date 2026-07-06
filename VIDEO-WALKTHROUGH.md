# Project Walkthrough — Hermes Airlock

**Video link:** _paste your Loom (or similar) URL here_

## What I show in the video

A short walkthrough of **Hermes Airlock**, a personal AI-agent stack I built to run a 24/7 assistant through Telegram, without giving it unrestricted internet access or code execution before I was comfortable with the security boundaries.

## Demo first

Show the agent working through Telegram, with a simple prompt.

Switch to the architecture files and walk through the important parts.

## Architecture

```mermaid
flowchart LR
  U[Telegram / me] --> H[Hermes Agent]

  H --> S[SearXNG<br/>internal search]
  H --> B[Browser / reader path]

  B --> P[Caddy egress proxy<br/>deny by default]
  P --> A[Allowlisted hosts<br/>OpenAI, Telegram, r.jina.ai]

  H -. disabled for now .-> X[Terminal / code execution]

  S --> I[Internet<br/>separate egress]
```

## The hard decision

I wanted a personal AI assistant I could keep running through Telegram, with memory, search, and page reading. The challenge wasn't making it work, it was doing it in a way that's safe.

NVIDIA has a ready-made option here: NemoClaw, which has a Hermes-compatible variant, NemoHermes. But NemoHermes doesn't support ChatGPT/Codex OAuth natively, and OAuth (a fixed subscription cost) was a hard requirement for me over pay-per-token API keys, which have unbounded cost as usage grows.

So I built my own airlock around plain Hermes instead: restricted networking, allowlisted egress, no terminal/code execution yet.

## Docker architecture

A relevant part from `docker-compose.yaml`:

```yaml
# Topology (Tier 2 — egress allowlist + external reader):
#   hermes        → hermes-llm only (no direct internet)
#   egress-proxy  → hermes-llm + hermes-external; allowlist: LLM/Telegram/r.jina.ai
#   searxng       → hermes-llm + hermes-external; web_search (open egress, no proxy)
#   fastcrw       → commented out; not running by default (future reader adapter)
```

- Hermes is on an internal Docker network only.
- Browser and page-reading traffic goes through the egress proxy.
- SearXNG is separate and handles search.
- Capability is separated by network, not just by prompts.

## Egress allowlist

Relevant part from `egress.Caddyfile`:

```caddy
forward_proxy {
  ports 443

  acl {
    allow *.openai.com
    allow *.chatgpt.com
    allow api.telegram.org
    allow r.jina.ai

    deny all
  }
}
```

- The agent does not have open internet access.
- Only explicit hosts are allowed; everything else is denied.
- Blocked attempts show up in the proxy logs, a simple audit trail.

## Security, performance, and scalability

Security is defense in depth, not one silver bullet:

- web content is treated as untrusted data by the model;
- browser egress is deny-by-default at the network layer;
- internal services are separated by Docker networks;
- terminal/code execution stays disabled for now, it would make the agent more capable, but changes the risk profile completely. I'd rather ship a constrained, useful assistant now and add a real sandbox later.

This isn't a high-traffic system, so the main concern was reliability over raw throughput: SearXNG runs separate from the agent so search load never blocks it, and the local speech-to-text model is cached on disk so restarts don't re-download it.

## What I would do differently

I'd test the NemoHermes / policy-grade route earlier, even just with API keys, cheaper models, and strict daily usage caps, to validate the tradeoffs before committing to a fixed-subscription setup. I'd also build my own page-reading service sooner instead of depending on a third-party reader.
