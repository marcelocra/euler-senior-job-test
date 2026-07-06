# Project Walkthrough — Hermes Airlock

**Video link:** _paste your Loom (or similar) URL here_

## What I show in the video

A short walkthrough of **Hermes Airlock**, a personal AI-agent stack I built to run a 24/7 assistant through Telegram.

The goal was to keep the agent useful, but not give it unrestricted internet access or code execution before I was comfortable with the security boundaries.

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

## The challenge: making it safe

I wanted a personal AI assistant that I could keep running through Telegram, with memory, search, and page reading.

The challenge was not making it work, but do it in a way that is safe.

There's a ready-made solution by NVIDIA, NemoClaw, with support for Hermes Agent, but it doesn't support ChatGPT/Codex OAuth natively.

That was a requirement for me, so I decided to build my own solution.

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
- Blocked attempts show up in the proxy logs — a simple audit trail.

## Security tradeoff

My approach is defense in depth, not one silver bullet:

- web content is treated as untrusted data by the model;
- browser egress is deny-by-default at the network layer;
- internal services are separated by Docker networks;
- terminal/code execution stays disabled for now — it would make the agent more capable, but changes the risk profile completely. I'd rather ship a constrained, useful assistant now and add a real sandbox later.

## What I would do differently

I would try NemoHermes first, using API keys.
