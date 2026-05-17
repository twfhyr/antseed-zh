# Demand Document

> **Project Name**: AntSeed Dashboard (antseed-zh)
> **Version**: v1.0.0
> **Last Updated**: 2026-05-16

---

## 1. Project Background & Goals

### 1.1 Background
AntSeed is a peer-to-peer AI inference marketplace protocol running on **Base mainnet**, connecting:
- **Sellers**: Node operators who provide GPU compute and serve AI model inference
- **Buyers**: Users/agents who deposit USDC and pay for AI inference services

The app `antseed-zh` is the dedicated dashboard for a specific seller node (Peer ID: `412282c48584073c5aee6a79945f105a7777e194`), serving both as a network-wide dashboard and a landing page for that node.

### 1.2 Core Goals
1. **Node Showcase**: Display available models, pricing, status, and connection instructions for the `antseed-zh` node
2. **Network Browser**: Provide search, filter, and comparison capabilities for all seller nodes and AI services across the network
3. **Token Economy**: Display the on-chain economic model, issuance data, and contract information for the $ANTS token
4. **Reward Claims**: Support wallet connection to query and claim $ANTS buyer/seller epoch emissions

---

## 2. User Roles & Requirements

### 2.1 Role Definitions

| Role | Description | Core Needs |
|------|-------------|------------|
| **Potential Buyer** | Wants to use AI inference and learn how to connect | Quickly find suitable models, understand pricing and connection method |
| **Network Browser** | Wants to compare nodes/services across the network | Search, filter, and compare different nodes and services |
| **Token Holder** | Holds/earns $ANTS | View emission data, claim rewards |
| **Node Operator** | Manager of `antseed-zh` | Showcase node info, attract buyer connections |

### 2.2 Requirement Matrix

| Role | Functional Requirement | Priority |
|------|------------------------|----------|
| Potential Buyer | View node basic info and available models | P0 |
| Potential Buyer | Copy CLI connection command | P0 |
| Potential Buyer | View quick start guide | P1 |
| Network Browser | Browse/search all seller nodes | P0 |
| Network Browser | Browse/search/filter all AI services | P0 |
| Network Browser | View service pricing and load | P0 |
| Token Holder | Connect wallet to view $ANTS balance | P0 |
| Token Holder | View historical epoch emission details | P0 |
| Token Holder | Claim buyer/seller emission rewards | P0 |
| Token Holder | View token economy model and contract info | P1 |
| Node Operator | Node info prioritized in display | P1 |
| Node Operator | Attract buyers to connect and generate revenue | P2 |

---

## 3. Functional Requirements

### 3.1 Home / Welcome Tab

**FR-001** The page header shall display the current node's **Peer ID** and node name (antseed-zh).

**FR-002** Provide a one-click copyable CLI connection command:
```
antseed buyer connection set --peer 412282c48584073c5aee6a79945f105a7777e194
```

**FR-003** Display a list of all **AI model services** currently offered by this node, including model name, provider, and pricing (input/output/cached per 1M tokens).

**FR-004** Provide a "How to Get Started" quick guide, including CLI installation, Base network USDC wallet configuration, connecting to the node, and making requests.

### 3.2 Sellers Browser (Sellers Tab)

**FR-005** Display all active seller nodes in a table with the following columns:
- Node name / Peer ID
- Status (online/offline)
- Total earnings (USDC)
- Capacity and uptime
- Number of models offered
- Join date

**FR-006** Support **real-time search** by name or ID.

**FR-007** The `antseed-zh` node shall be **pinned to the top and highlighted with special styling**.

**FR-008** Seller data must be synchronized in real-time from the official API (`https://network.antseed.com/stats`).

### 3.3 Services Browser (Services Tab)

**FR-009** Display all AI model services across the network in a table with the following columns:
- Model name
- Provider
- Seller node
- Category tags (e.g., coding, privacy, finance, legal, uncensored, TEE)
- Protocol types
- Pricing (input / output / cached per 1M tokens)
- Current load (green/orange/red indicator)
- Status

**FR-010** Support **real-time search** by model name, provider, or seller name.

**FR-011** Support **multi-select filtering by category tags**.

**FR-012** The load indicator shall include a tooltip explaining the load definition and AntSeed proxy routing strategy.

**FR-013** Service data must be synchronized from the official API and globally deduplicated (the same provider on a single node may register services multiple times).

### 3.4 Claim $ANTS (Claim ANTS Tab)

**FR-014** Integrate **RainbowKit** wallet connection component, supporting MetaMask, Coinbase Wallet, etc., with the network fixed to **Base mainnet**.

**FR-015** When no wallet is connected, provide an address input field to query emission data for any Base address (read-only mode).

**FR-016** After wallet connection, display the following statistics:
- Current $ANTS balance
- Total buyer pending rewards
- Total seller pending rewards
- Current Epoch

**FR-017** Provide a **Buyer Emissions / Seller Emissions** toggle.

**FR-018** Display a **historical epoch detail table** containing:
- Epoch number
- Buyer points / Seller points
- Corresponding $ANTS reward
- Claimed / Unclaimed status

**FR-019** Support **claiming by individual epoch** and **one-click claiming for all unclaimed epochs**.

**FR-020** The claim operation must send the on-chain transaction directly from the frontend via wagmi's `useWriteContract`, without proxying through the backend.

**FR-021** After transaction submission, display transaction status (Pending / Confirmed / Failed) and a Basescan link.

**FR-022** After successful claim, automatically refresh emission data (with cache busting).

### 3.5 $ANTS Info (ANTS Info Tab)

**FR-023** Display on-chain real-time data:
- $ANTS current circulating supply / max supply
- Current Epoch / emission rate
- Genesis Block / halving interval
- USDC balances in Deposits / Channels contracts

**FR-024** Display all relevant smart contract addresses with Basescan links.

**FR-025** Display emission allocation breakdown: Seller 50% / Buyer 20% / Reserve 15% / Team 15%.

**FR-026** Provide a "How to Earn" guide explaining how sellers, buyers, and protocol reserve earn rewards.

### 3.6 Backend Admin & Data Sync

**FR-027** On server startup, automatically fetch latest network data from `https://network.antseed.com/stats` and rebuild the sellers and services tables.

**FR-028** Provide a background poller (every 5 minutes) that reads on-chain data (ANTS supply, emission info, USDC balances) via the `@antseed/node` SDK and caches it in SQLite.

**FR-029** Provide admin endpoint `POST /api/admin/sync` to manually trigger network re-sync.

**FR-030** Provide admin endpoint `POST /api/admin/force-chain-sync` to manually trigger on-chain data refresh.

---

## 4. Non-Functional Requirements

### 4.1 Performance Requirements

| Metric | Requirement |
|--------|-------------|
| First contentful paint | < 2s |
| API response time (P95) | < 500ms |
| On-chain data refresh interval | 5 minutes |
| Network data sync | Automatic on server startup, with manual trigger support |
| Concurrent connections | Support 100+ concurrent on single-node deployment |

### 4.2 Availability Requirements

- The app shall run anywhere Node.js is available with no external database dependency
- Support running both frontend and backend via `npm run dev`, or backend only via `npm run server`
- In production, Express shall serve both API and static SPA from a single port

### 4.3 Security Requirements

- Wallet private keys must remain client-side; the backend shall never touch any signing operations
- Claim transactions are sent directly from the user's browser to Base mainnet
- `/api/admin/*` endpoints currently have no auth; middleware should be added if exposed to the public internet long-term

### 4.4 Compatibility Requirements

- Support mainstream EVM wallets (MetaMask, Coinbase Wallet, WalletConnect, etc.)
- Fixed chain: Base mainnet (Chain ID 8453)
- Frontend shall be responsive for both desktop and mobile browsers

### 4.5 Data Consistency Requirements

- Seller/service data shall be fully rebuilt from the official API on each server startup
- On-chain metrics shall be periodically updated and cached by the background poller to avoid frequent direct RPC requests from the frontend
- Emission data shall support `bust=1` cache bypass parameter

---

## 5. Data Requirements

### 5.1 External Data Sources

| Data Source | Purpose | Update Frequency |
|-------------|---------|------------------|
| `https://network.antseed.com/stats` | Network-wide seller/service/pricing data | On startup + manual trigger |
| Base mainnet RPC (publicnode) | ANTS supply, emissions, USDC balances | Every 5 minutes |
| `@antseed/node` SDK | Wrapped on-chain reads | Every 5 minutes |

### 5.2 Internal Data Model

Core SQLite tables:
- `buyers` — Buyer information (currently mock data)
- `sellers` — Seller node information (from official API)
- `services` — AI service information (from official API, globally deduplicated)
- `stats` — Aggregated statistics (single row)
- `chain_metrics` — Cached on-chain metrics (single row)
- `address_emissions` — Per-address emission data cache
- `address_balances` — Per-address ANTS balance cache

---

## 6. Technical Constraints

### 6.1 Tech Stack
- **Frontend**: React 19, Vite 6, Lucide React, plain CSS
- **Backend**: Express 5, better-sqlite3, CORS
- **Web3**: wagmi v2, viem v2, RainbowKit v2, @tanstack/react-query v5
- **On-chain SDK**: @antseed/node v0.2.84
- **Network**: Fixed to Base mainnet

### 6.2 Determined Contract Addresses

| Contract | Base Mainnet Address |
|----------|----------------------|
| ANTS Token | `0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263` |
| Emissions | `0xF13bE52c4A3afC6AE29536f073588d01A0584088` |
| Deposits | `0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2` |
| Channels | `0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d` |
| Staking | `0x3652E6B22919bd322A25723B94BB207602E5c8e6` |
| Stats | `0x15649ff076BFa5e37e24EE3154a00503149954Fd` |
| Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

### 6.3 Known Limitations
- Seller emissions are currently locked in the Provider Pool; they can be claimed but not transferred
- Buyer emissions are eligible for claiming only after epoch finalization, subject to anti-abuse and cap rules
- Seller/service data depends on the availability of the official API; falls back to local cache if network fails

---

## 7. Acceptance Criteria

### 7.1 Functional Acceptance

| ID | Acceptance Item | Pass Criteria |
|----|-----------------|---------------|
| AC-001 | Home page load | Peer ID, CLI command, model list, and quick start guide display correctly |
| AC-002 | Seller search | Can search and highlight antseed-zh node; data matches official API |
| AC-003 | Service filter | Supports multi-select category filtering; pricing and load display correctly |
| AC-004 | Wallet connect | RainbowKit modal works; can connect MetaMask and switch to Base mainnet |
| AC-005 | Emission query | Can query buyer/seller emission details for connected address; epoch table is complete |
| AC-006 | Emission claim | Can successfully submit claim transaction and get on-chain confirmation; status feedback is correct |
| AC-007 | ANTS info | On-chain supply, epoch, contract addresses match the chain |
| AC-008 | Data sync | Seller/service data auto-updates on server restart; on-chain metrics refresh within 5 minutes |

### 7.2 Non-Functional Acceptance

| ID | Acceptance Item | Pass Criteria |
|----|-----------------|---------------|
| AC-009 | Performance | First paint < 2s, API P95 < 500ms |
| AC-010 | Security | Claim transactions do not go through backend; private keys never leave browser |
| AC-011 | Deployment | Can one-click start with `npm install && npm run dev` |

---

## 8. Appendices

### 8.1 Glossary

| Term | Definition |
|------|------------|
| Epoch | $ANTS emission cycle, 1 epoch = 1 week (604,800 seconds) |
| Peer ID | Unique identifier for a node in the AntSeed network |
| Provider | Entity offering specific AI model inference services,隶属于某个 Peer |
| Buyer | User who deposits USDC and pays for inference services |
| Seller | Node operator who provides GPU compute and model services |
| Provider Pool | Locked pool for seller emission rewards; currently non-transferable |

### 8.2 Reference Links

- AntSeed official network API: `https://network.antseed.com/stats`
- Base mainnet explorer: `https://basescan.org`
- wagmi docs: `https://wagmi.sh`
- RainbowKit docs: `https://www.rainbowkit.com`

---

*End of Document*
