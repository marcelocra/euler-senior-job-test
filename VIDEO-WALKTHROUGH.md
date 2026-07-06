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

## Talking points

### 1. Context

I wanted a personal AI assistant that I could keep running through Telegram.

The challenge was not only making it work. The harder question was: what should this agent _not_ be allowed to do yet?

### 2. Initial decision

I considered more policy-grade options like NemoClaw / NemoHermes / OpenShell.

The problem was that I already had ChatGPT/Codex OAuth available and wanted to use that value. NemoHermes did not fit that OAuth requirement well for my first version.

So I chose Hermes for the first implementation, but wrapped it in an "airlock": restricted networking, allowlisted egress, no terminal/code execution yet, and a tiered plan for enabling more capabilities later.

### 3. Docker architecture

Relevant part from `docker-compose.yaml`:

```yaml
# Topology (Tier 2 — egress allowlist + external reader):
#   hermes        → hermes-llm only (no direct internet)
#   egress-proxy  → hermes-llm + hermes-external; allowlist: LLM/Telegram/r.jina.ai
#   searxng       → hermes-llm + hermes-external; web_search (open egress, no proxy)
#   fastcrw       → commented out; not running by default (future reader adapter)
```

What I explain:

- Hermes is on an internal Docker network.
- Browser traffic goes through the egress proxy.
- SearXNG is separate and handles search.
- `fastcrw` is parked for now; I did not enable every capability at once.

### 4. Egress allowlist

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

What I explain:

- The agent does not have open internet access.
- Only explicit hosts are allowed.
- Blocked attempts show up in proxy logs.
- This is stronger than relying only on prompt instructions.

### 5. Security tradeoff

Prompt injection is not solved by one prompt or one delimiter.

The stack uses defense in depth:

- web content is treated as untrusted;
- browser egress is deny-by-default;
- internal services are separated by Docker networks;
- terminal/code execution is disabled for now;
- sensitive actions require clearer boundaries before being enabled.

### 6. What I would do differently

The one thing I would do differently is test the NemoHermes / policy-grade route earlier.

Even if I still chose Hermes for the first version because of ChatGPT/Codex OAuth, I would compare the tradeoffs sooner, especially for future code execution and multi-agent orchestration.

I also plan to open-source this once I finish validating the setup and clean up any sensitive configuration.
