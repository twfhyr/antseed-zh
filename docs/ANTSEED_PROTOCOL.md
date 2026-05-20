# AntSeed Protocol — Comprehensive Reference

*Based on research of antseed.com, GitHub (AntSeed/antseed), and official protocol docs as of May 2026.*

---

## What is AntSeed?

AntSeed is a **peer-to-peer network for AI services**. It connects buyers who need AI inference with providers who deliver it — directly, without a central platform in the middle. No gatekeepers, no account walls, no single company routing your requests.

The protocol is open source (GPL-3.0) at [github.com/AntSeed/antseed](https://github.com/AntSeed/antseed) with 2,082+ commits and 73 releases (latest: v0.1.88).

### Two Products, One Network

| Product | Description | Users |
|---------|-------------|-------|
| **AntStation** | Desktop app (Mac/Windows) for chat — no account, pick a model, pay per request in USDC | Everyday users |
| **CLI / API** | `npm install -g @antseed/cli` — OpenAI/Anthropic-compatible localhost proxy for coding agents, CLIs, frameworks | Developers & agents |

Base URL for API: `http://localhost:8377/v1`

---

## Protocol Stack (5 Layers)

```
┌─────────────────────────────────┐
│ 5. Reputation Layer             │  Trust scoring, attestations, ERC-8004 feedback
├─────────────────────────────────┤
│ 4. Payments Layer               │  USDC deposits, cumulative payment channels, on-chain settlement
├─────────────────────────────────┤
│ 3. Metering Layer               │  Token counting, EIP-191 signed receipts, bilateral verification
├─────────────────────────────────┤
│ 2. Transport Layer              │  WebRTC DataChannels (primary) + TCP fallback, binary framing
├─────────────────────────────────┤
│ 1. Discovery Layer              │  BitTorrent DHT (BEP 5), metadata endpoint, peer scoring
└─────────────────────────────────┘
```

---

## Layer 1: Discovery

### DHT Topics

Sellers announce on the BitTorrent DHT using SHA1-hashed topic strings:

| Topic Type | Format | Key Normalization |
|------------|--------|-------------------|
| Provider | `antseed:{provider}` | trim + lowercase |
| Model (canonical) | `antseed:service:{model}` | trim + lowercase |
| Model (search fallback) | `antseed:service-search:{model}` | trim + lowercase, remove spaces/`-`/`_` |
| Capability | `antseed:{capability}` or `antseed:{capability}:{name}` | trim + lowercase |

Bootstrap nodes: `dht1.antseed.com:6881`, `dht2.antseed.com:6881`

### Peer Scoring

| Dimension | Weight | Description |
|-----------|--------|-------------|
| Price | 0.30 | Lower price scores higher |
| Latency | 0.25 | Lower latency scores higher (EMA-based) |
| Capacity | 0.20 | More available capacity scores higher |
| Reputation | 0.10 | Higher reputation scores higher (0-100) |
| Freshness | 0.10 | Recently seen peers score higher |
| Reliability | 0.05 | Lower failure rate and streak scores higher |

---

## Layer 2: Transport

- **Primary**: WebRTC DataChannels via `node-datachannel`
- **Fallback**: Direct TCP sockets
- **Frame protocol**: 9-byte header (1 byte type + 4 byte messageId + 4 byte payloadLength), max 64 MiB payload
- **Handshake**: EIP-191 `personal_sign` challenge-response with nonce
- **Keepalive**: Ping every 15s, pong timeout 5s, 3 missed = dead
- **Reconnection**: Exponential backoff (1s base, 30s max, 5 attempts)

### Key Message Types

| Hex | Name | Purpose |
|-----|------|---------|
| 0x20-0x26 | HTTP proxy messages | Request/response/chunked streaming |
| 0x50 | SpendingAuth | Buyer → Seller: EIP-712 spending authorization |
| 0x51 | AuthAck | Seller confirms on-chain reserve() succeeded |
| 0x53 | SellerReceipt | Running-total receipt |
| 0x55 | TopUpRequest | Seller requests additional authorization |
| 0x56 | PaymentRequired | 402 trigger with payment terms |

### 402 Payment Negotiation

- **Auto mode**: Node intercepts 402 internally, signs SpendingAuth, seller calls `reserve()` on-chain, request retries automatically
- **Manual mode**: 402 propagates to UI (desktop app), user approves, application signs SpendingAuth

---

## Layer 3: Metering

Token usage estimated from HTTP content lengths with provider-specific bytes-per-token ratios:

| Provider | Bytes/Token |
|----------|-------------|
| anthropic | 4.2 |
| openai | 4.0 |
| google | 4.1 |
| default | 4.0 |

SSE streams get a 0.82 factor for framing overhead. Minimums: 100 tokens input, 10 tokens output.

### Cost Calculation

```
costUSD = (freshInputTokens * inputUsdPerMillion
         + cachedInputTokens * cachedInputUsdPerMillion
         + outputTokens * outputUsdPerMillion) / 1_000_000
```

Sellers generate EIP-191 signed receipts. Buyers verify via `ecrecover` and flag disputes when estimates diverge >15%.

---

## Layer 4: Payments

### Session Lifecycle

```
ReserveAuth → reserve() → [serve + SpendingAuth...] → settle()/close()
```

1. Buyer signs **ReserveAuth** (EIP-712): channelId, maxAmount, deadline
2. Seller calls `reserve()` on-chain → locks funds from buyer's deposit
3. During serving, buyer signs **SpendingAuth** (EIP-712): cumulativeAmount + metadataHash
4. Seller calls `settle()` (keep open) or `close()` (finalize) with latest SpendingAuth
5. If seller disappears → buyer calls `requestClose()` → 15 min grace → `withdraw()`

First-time sessions hard-capped at **$1 USDC**. Top-up requires 85% settled + new ReserveAuth.

### Credit Limits

- New buyers: $10
- Per unique seller interaction: +$5
- Per day of history: +$0.50
- Maximum: $50

### EIP-712 Domain

```
name: "AntseedChannels"
version: "7"
chainId: <deployment chain>
verifyingContract: <channels contract address>
```

### Buyer Safety

The buyer never needs gas. All on-chain actions are seller-initiated (reserve, settle, close) or operator-initiated (requestClose, withdraw). The buyer's hot wallet only signs EIP-712 messages — never holds ETH, receives USDC, or submits transactions.

---

## Layer 5: Reputation

### On-Chain Stats (per seller agentId)

| Counter | Updated During | Description |
|---------|---------------|-------------|
| channelCount | close() | Completed channels |
| ghostCount | withdraw() (no spend) | Timed-out channels with no proven spend |
| totalVolumeUsdc | settle()/close() | Cumulative USDC volume |
| lastSettledAt | settle()/close() | Timestamp of most recent settlement |

### Staking

Sellers stake USDC via AntseedStaking (minimum 10 USDC), binding to an ERC-8004 agentId. Unstaked sellers cannot have `reserve()` called.

### ERC-8004 Feedback

Buyers submit feedback (Quality, Latency, Accuracy, Reliability: 0-100). Feedback produces an emission multiplier:

```
feedbackMultiplier = 0.5 + (avgFeedbackScore / 100)   // 0.5x to 1.5x
```

---

## Identity & Security

### Single Key Architecture

Each node has one secp256k1 private key. The EVM address is both the PeerId and on-chain identity:

```
secp256k1 private key → EVM address = PeerId
```

| Function | Mechanism |
|----------|-----------|
| P2P identity | EIP-191 `personal_sign` with `"antseed-data-v1:"` / `"antseed-msg-v1:"` domain tags |
| Payment authorization | EIP-712 signatures (ReserveAuth, SpendingAuth) |
| PeerId | EVM address (40 hex, no 0x prefix) |

### Signing Identity vs Funding Wallet

- **Signing identity**: The node's key — signs protocol messages and payment auths, never holds funds
- **Funding wallet**: Any external wallet (hardware, multisig, EOA) — deposits USDC via `depositFor(buyer, amount)`
- **Worst case** (node compromised): Loss bounded to current deposit balance only

### Key Storage

| Environment | Protection |
|-------------|-----------|
| Desktop app | Electron `safeStorage` API → OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret) |
| CLI / Server | Plaintext `~/.antseed/identity.key` — use `ANTSEED_IDENTITY_HEX` env var with secrets manager for production |

### Operator Concept

Buyers can authorize an **operator** address via `setOperator()` on the Deposits contract. The operator can call `requestClose()` and `withdraw()` on channels but cannot sign ReserveAuth or SpendingAuth (those require the buyer's key). This is used when the funding wallet (e.g., MetaMask) differs from the node's identity key.

---

## Smart Contracts (Base Mainnet, Chain ID 8453)

| Contract | Address | Purpose |
|----------|---------|---------|
| USDC (Circle) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Payment token (6 decimals) |
| AntseedRegistry | `0xf33fC901BFa97326379A369401F4490E231B69B0` | Central address book |
| AntseedDeposits | `0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2` | Buyer deposits, seller payouts (holds USDC) |
| AntseedChannels | `0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d` | Payment channel lifecycle (swappable, holds NO USDC) |
| AntseedStaking | `0x3652E6B22919bd322A25723B94BB207602E5c8e6` | Seller staking (min 10 USDC, binds to ERC-8004 agentId) |
| AntseedStats | `0x15649ff076BFa5e37e24EE3154a00503149954Fd` | On-chain counters (optional, token/request stats) |
| AntseedEmissionsV2 | `0xF13bE52c4A3afC6AE29536f073588d01A0564088` | ANTS token emissions (backward-compatible from epoch 4) |
| ANTSToken | `0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263` | ANTS ERC-20 (1.04B max supply) |
| ERC-8004 IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | Identity registry |

### Contract Architecture

- **Stable contracts** (Staking, Deposits) hold funds and rarely change
- **Swappable contract** (Channels) holds no USDC — can be redeployed by re-pointing via Registry
- Network fee: **4%** of settlement → Protocol Reserve (ecosystem sustainability, grants, buy-and-burn)
- DIEM program fee: **10%** program/operator fee

---

## $ANTS Token

### Tokenomics

| Parameter | Value |
|-----------|-------|
| Max supply | 1,040,000,000 ANTS |
| Epoch duration | 1 week (604,800 seconds) |
| First epoch budget | 5,000,000 ANTS |
| Halving interval | Every 104 epochs (~2 years) |
| Transfers | Currently restricted |

### Emission Split

| Recipient | Share | Notes |
|-----------|-------|-------|
| Sellers (Provider Pool) | 50% | Locked pending stronger validation/attestation |
| Buyers | 20% | Claimable after epoch finalization (operator address) |
| Ecosystem Reserve | 15% | Sustainability, grants, incentives, alignment |
| Contributors | 15% | Vesting for long-term development |

### Emission Points

**Seller points**: `V(P) * feedbackMultiplier` where V(P) = USDC volume settled

**Buyer points**: `usagePoints + feedbackPoints + diversityBonus`

- usagePoints: proportional to USDC spent
- feedbackPoints: awarded for submitting feedback
- diversityBonus: bonus for transacting with more unique sellers

### Anti-Abuse

Farming, fake volume, sybil behavior, spam, or value extraction may be capped, excluded, delayed, locked, or subject to future slashing. ANTS token economics are evolving.

---

## Three Ways to Provide

1. **Raw Inference** — Serve a model, fine-tune, local GPU, or proxy an API. Set per-token price. Margins compress toward zero when many sellers offer the same model.

2. **Routing Service** — Build specialized routing logic (latency-optimized, cost-minimizing, TEE-only, jurisdiction-aware). Earn on every request routed without running models.

3. **AI Agent** — Wrap domain knowledge as a named service. System prompt, RAG, toolchain stay private. Buyers pay for expertise, not just tokens.

---

## Tech Stack (Official Repo)

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js >= 20, ES modules |
| Language | TypeScript 5.x, strict mode |
| Package Manager | pnpm workspaces |
| Build | tsc (libraries), Vite (web apps) |
| Test | vitest |
| Desktop | Electron |
| P2P | BitTorrent DHT + WebRTC DataChannels (node-datachannel) |
| Payments | On-chain USDC (Base mainnet), EIP-712 signatures |
| Smart Contracts | Solidity 11.4% of codebase |

### Repository Structure

```
packages/           Core libraries
  node/             Protocol SDK — P2P, discovery, metering, payments
  provider-core/    Shared provider infrastructure
  router-core/      Shared router infrastructure

plugins/            Provider and router plugins
  provider-anthropic/      Anthropic API key provider
  provider-claude-code/    Claude Code keychain provider
  provider-claude-oauth/   Claude OAuth provider
  provider-openai/         OpenAI-compatible provider
  provider-local-llm/      Local LLM provider (Ollama, llama.cpp)
  router-local/            Local router (Claude Code, Aider, Continue.dev)

apps/               Applications
  cli/              CLI tool and plugin manager
  desktop/          Electron desktop app (AntStation)
  payments/         Payment management web app
  website/          Marketing website (antseed.com)

e2e/                End-to-end tests
docs/protocol/      Protocol specification
```

---

## Supported Chains

| Chain | Chain ID | Status |
|-------|----------|--------|
| base-mainnet | 8453 | Production (default) |
| base-sepolia | 84532 | Testnet |

---

## vs OpenRouter

| Aspect | AntSeed | OpenRouter |
|--------|---------|------------|
| Architecture | P2P network, direct buyer↔provider | Centralized aggregator, every request through their servers |
| Provider onboarding | Permissionless, run the node binary | Approval-based, curated by platform |
| Payments | On-chain USDC, per request, settled directly to provider wallet | Credit card, platform holds earnings until payout |
| Account required | No — no email, no API keys | Yes — sign-up, API key, account limits |
| Request privacy | P2P without central platform account; TEE providers available | Every prompt transits their infrastructure |
| Censorship resistance | Open P2P software; independent nodes continue independently | Single company can be sued/acquired/deplatformed |
| Agent-ready | Designed for it — USDC-native, no account, always-on discovery | Works via API key, assumes human operator |

---

## CLI Quick Reference

```bash
# Install
npm install -g @antseed/cli

# Setup
antseed seller setup           # Create ~/.antseed/config.json

# Run
antseed seller start           # Start providing
antseed buyer start            # Start buying (proxy at localhost:8377)

# Network
antseed network browse         # Discover peers
antseed buyer connection set --peer <peerId>  # Pin to a peer

# Metrics
antseed metrics serve --role seller --host 0.0.0.0 --port 9108
antseed metrics serve --role buyer --host 127.0.0.1 --port 9108
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTSEED_IDENTITY_HEX` | Production identity key (recommended over plaintext file) |
| `OPENAI_API_KEY` | For OpenAI-compatible provider plugins |
| `ANTHROPIC_API_KEY` | For Anthropic provider plugins |

### Config File

`~/.antseed/config.json` — main source of truth for providers, services, pricing, categories, ports, baseUrl.

---

## Links

- Website: [antseed.com](https://antseed.com)
- GitHub: [github.com/AntSeed/antseed](https://github.com/AntSeed/antseed)
- Docs: [antseed.com/docs](https://antseed.com/docs)
- Light Paper: [antseed.com/docs/lightpaper](https://antseed.com/docs/lightpaper)
- Network stats: [network.antseed.com/stats](https://network.antseed.com/stats) (public JSON, no auth)
- Dune Analytics: [dune.com/antseed_com/antseed](https://dune.com/antseed_com/antseed)
- Twitter: [@antseedai](https://x.com/antseedai)
- Telegram: [t.me/antseed](https://t.me/antseed)
