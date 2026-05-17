# Payments UI — Demand & Implementation Plan

> **Feature**: Integrate the AntSeed Payments web UI into the antseed-zh dashboard
> **Reference**: `ref/antseed/apps/payments/` (official AntSeed monorepo)
> **Date**: 2026-05-17

---

## 1. Background

Running `antseed payments` starts a local Fastify server + React web app that provides buyer-side payment management: depositing USDC, withdrawing, viewing payment channels, tracking usage, and claiming emissions. The goal is to bring **all** of this functionality into the existing antseed-zh dashboard so users don't need to run a separate app.

---

## 2. Feature Gap Analysis

| Feature | Payments App | antseed-zh (current) | Gap |
|---------|-------------|---------------------|-----|
| **Deposit USDC** | 2-step approve+deposit modal | `DepositModal.jsx` (already exists) | **Covered** |
| **Withdraw USDC** | `WithdrawView.tsx` — operator-based withdraw via `Deposits.withdraw()` | None | **Missing** |
| **Payment Channels** | `ChannelsView.tsx` — list active/closed channels, requestClose, withdraw from channels | None | **Missing** |
| **Dashboard (buyer usage)** | `DashboardView.tsx` — personal requests/tokens/settlements + network stats | Partial (network stats only, no personal usage) | **Partial** |
| **Emissions (buyer-side)** | `EmissionsView.tsx` — epoch info, pending rewards, claim seller/buyer | `ClaimANTS.jsx` (already exists, but uses different API pattern) | **Partial** — different API contract, no legacy contract support yet in official app |
| **Authorize Wallet** | `AuthorizedWalletContext.tsx` + `AuthorizeWalletModal.tsx` — setOperator flow | None | **Missing** |
| **DIEM Staking Rewards** | `DiemRewardsView.tsx` — claim ANTS from DIEM staking proxy | None | **Missing** |
| **Buyer Balance** | `/api/balance` — available + reserved + credit limit | None | **Missing** |
| **Wallet Drawer** | Balance display, operator info, quick deposit/withdraw | None | **Missing** |

---

## 3. Requirements

### 3.1 New Pages/Tabs

**P0 — Must Have:**

| ID | Feature | Description |
|----|---------|-------------|
| PAY-001 | **Withdraw USDC** | Modal to withdraw available USDC from Deposits contract. Requires authorized operator wallet. Calls `Deposits.withdraw(buyer, amount)`. |
| PAY-002 | **Payment Channels** | New tab showing all payment channels (active + history). Displays seller, channel ID, status, reserved amount, used amount, opened date. Actions: `requestClose`, `withdraw` on channels. |
| PAY-003 | **Buyer Balance** | Display available, reserved, and total USDC balance from the Deposits contract. Show credit limit. |
| PAY-004 | **Authorize Wallet** | Flow to set an operator wallet for the buyer identity. Uses server-signed EIP-712 `setOperator` signature + on-chain `Deposits.setOperator()` tx. Shows alert banner when no operator is set. |
| PAY-005 | **Buyer Usage Dashboard** | Personal usage stats (requests, tokens, settlements, unique sellers) + usage chart over time. Fetched from buyer proxy `/_antseed/buyer-usage`. |

**P1 — Nice to Have:**

| ID | Feature | Description |
|----|---------|-------------|
| PAY-006 | **DIEM Staking Rewards** | Claim ANTS from DIEM staking proxy contract. Read `pendingAntsForEpoch`, `userEpochClaimed` via multicall. |
| PAY-007 | **Wallet Drawer** | Slide-out panel showing balance, operator info, quick deposit/withdraw buttons. |

### 3.2 New Backend API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/deposits/balance` | GET | Returns buyer balance (available, reserved, total, creditLimit) from Deposits contract |
| `/api/deposits/operator` | GET | Returns current operator address + nonce for the buyer |
| `/api/deposits/operator/sign` | POST | Server signs `setOperator` EIP-712 message with buyer identity key |
| `/api/deposits/channels` | GET | Proxies to buyer proxy `/_antseed/channels?all=1` |
| `/api/deposits/buyer-usage` | GET | Proxies to buyer proxy `/_antseed/buyer-usage` |
| `/api/deposits/config` | GET | Returns chain config (contract addresses, chain ID, RPC URL) for client-side contract interactions |
| `/api/emissions/shares` | GET | Returns emission share percentages |
| `/api/emissions/transfers-enabled` | GET | Returns whether ANTS token transfers are enabled |

### 3.3 New Frontend Contract Interactions (wagmi)

These happen client-side (wallet signs directly):

| Contract | Function | Used By |
|----------|----------|---------|
| Deposits | `withdraw(buyer, amount)` | WithdrawView |
| Deposits | `setOperator(buyer, operator, nonce, buyerSig)` | AuthorizeWalletModal |
| Deposits | `transferOperator(buyer, newOperator)` | AuthorizeWalletModal |
| Channels | `requestClose(channelId)` | ChannelsView |
| Channels | `withdraw(channelId)` | ChannelsView |
| Emissions | `claimSellerEmissions(epochs)` | EmissionsView |
| Emissions | `claimBuyerEmissions(buyer, epochs)` | EmissionsView |

### 3.4 New Frontend Components

| Component | Description |
|-----------|-------------|
| `WithdrawModal.jsx` | Withdraw USDC modal — amount input, operator validation, Deposits.withdraw() |
| `ChannelsTab.jsx` | Payment channels tab — table with status, actions, pagination |
| `BuyerDashboard.jsx` | Enhanced dashboard with personal + network usage stats |
| `AuthorizeWalletModal.jsx` | Set operator wallet — connect wallet → server sign → setOperator tx |
| `AuthorizedWalletContext.jsx` | React context for operator state + `requireAuthorization()` gate |
| `WalletDrawer.jsx` | Slide-out panel with balance, operator info, quick actions |
| `UsageChart.jsx` | Recharts-based usage over time chart |

---

## 4. Implementation Plan

### Phase 1: Backend API Extensions (server.js)

1. Add Deposits client + config endpoint (`/api/deposits/config`)
2. Add balance endpoint (`/api/deposits/balance`)
3. Add operator endpoints (`/api/deposits/operator`, `/api/deposits/operator/sign`)
4. Add channel proxy (`/api/deposits/channels` → buyer proxy)
5. Add buyer-usage proxy (`/api/deposits/buyer-usage`)
6. Add emissions shares + transfers-enabled endpoints

**Note**: The official payments app uses a server-side identity (crypto context) to sign setOperator messages. Our dashboard doesn't have the buyer's identity key. We need to either:
- (a) Require the user to provide `ANTSEED_IDENTITY_HEX` env var, OR
- (b) Skip server-side signing and use a different authorization flow, OR
- (c) Document that setOperator must be done via CLI (`antseed buyer deposit`)

**Decision**: Start with option (c) for simplicity — show a banner explaining the user must run `antseed buyer deposit` first to set up their operator. Add server-side signing later if needed.

### Phase 2: Core UI Components

1. **AuthorizedWalletContext** — context provider that reads operator status from `/api/deposits/operator`, provides `requireAuthorization()` gate
2. **WithdrawModal** — reuse existing modal pattern from `DepositModal.jsx`, add operator validation + Deposits.withdraw() call
3. **ChannelsTab** — fetch channels from API, enrich with on-chain data via wagmi `useReadContracts`, render table with status/actions

### Phase 3: Enhanced Dashboard

1. **BuyerDashboard** — merge network stats (existing) with personal buyer usage from `/api/deposits/buyer-usage`
2. **UsageChart** — bar chart showing requests/tokens over time from buyer usage data

### Phase 4: Navigation & Polish

1. Add "Channels" and "Wallet" tabs to App.jsx navigation
2. Add balance display to header (available USDC)
3. Wire up WithdrawModal from deposit button area
4. Add AuthorizeWalletAlert banner when operator not set
5. Update Header.jsx with balance info + withdraw button

### Phase 5: DIEM Rewards (P1)

1. Add `DiemRewardsTab.jsx` with DIEM staking proxy ABI
2. Read pending rewards via wagmi multicall
3. Claim via `claimAnts(epochs)` on DIEM proxy contract

---

## 5. Key Architecture Decisions

### 5.1 Balance & Operator: Read from Chain vs. Proxy

The official payments app reads balance/operator directly from the Deposits contract. Since our dashboard already has `@antseed/node` with `DepositsClient`, we'll do the same — read on-chain, cache in SQLite with TTL.

### 5.2 Channels: Proxy Required

Channel data comes from the **local buyer proxy** at `http://localhost:8377/_antseed/channels`. This is only available when `antseed buyer start` is running. Our API should gracefully handle the proxy being offline (return empty arrays).

### 5.3 SetOperator: CLI-First

The `setOperator` flow requires the buyer's identity key (stored in `~/.antseed/identity.hex`). Our dashboard doesn't have access to this. The official payments app solves this by running as a subprocess of the desktop app, which has the key. For our standalone dashboard, we'll:
- Display the current operator status
- If no operator is set, show instructions to run `antseed buyer deposit` or connect via the desktop app
- If operator is set, allow all wallet-gated actions (withdraw, close channels, claim)

### 5.4 Contract Addresses

All contract addresses are already defined in the codebase. The config endpoint will expose them so the frontend can make direct contract calls via wagmi.

---

## 6. File Mapping (Reference → Implementation)

| Reference File | Our Implementation | Notes |
|---------------|-------------------|-------|
| `payments/src/routes.ts` | `backend/server.js` (new routes) | Add deposits/balance, operator, channels, buyer-usage, config |
| `payments/web/src/api.ts` | `src/api.js` (new functions) | Add getBalance, getConfig, getOperatorInfo, signOperatorAuth, getChannels, getBuyerUsage, getEmissionsShares, getTransfersEnabled |
| `payments/web/src/types.ts` | Inline in components | Types are simple enough to inline |
| `payments/web/src/context/AuthorizedWalletContext.tsx` | `src/context/AuthorizedWalletContext.jsx` | Port with same logic, adapt API calls |
| `payments/web/src/components/WithdrawView.tsx` | `src/components/WithdrawModal.jsx` | Adapt to modal pattern, reuse DepositModal styling |
| `payments/web/src/components/ChannelsView.tsx` | `src/components/ChannelsTab.jsx` | New tab component |
| `payments/web/src/views/DashboardView.tsx` | Enhance existing dashboard | Add personal usage section |
| `payments/web/src/views/EmissionsView.tsx` | Enhance `ClaimANTS.jsx` | Already implemented, minor API alignment |
| `payments/web/src/views/DiemRewardsView.tsx` | `src/components/DiemRewardsTab.jsx` | New tab (P1) |
| `payments/web/src/hooks/useWithdraw.ts` | `src/hooks/useWithdraw.js` | Port wagmi hook |
| `payments/web/src/hooks/useSetOperator.ts` | `src/hooks/useSetOperator.js` | Port wagmi hook |
| `payments/web/src/hooks/useChannels.ts` | `src/hooks/useChannels.js` | Port wagmi hook |
| `payments/web/src/payment-network.ts` | `src/hooks/usePaymentNetwork.js` | Port chain-switching utility |
| `payments/web/src/channels-abi.ts` | `src/abi/channels-abi.js` | Port ABI definitions |
| `payments/web/src/emissions-abi.ts` | Inline in ClaimANTS.jsx | Already have emissions ABI |

---

## 7. Acceptance Criteria

| ID | Criteria |
|----|----------|
| AC-PAY-001 | User can withdraw available USDC to their authorized wallet |
| AC-PAY-002 | User can view all payment channels with real-time on-chain enrichment |
| AC-PAY-003 | User can request close on active channels and withdraw from withdrawable channels |
| AC-PAY-004 | Dashboard shows personal buyer usage (requests, tokens, settlements, sellers) |
| AC-PAY-005 | User can see available/reserved/total USDC balance |
| AC-PAY-006 | AuthorizeWallet banner appears when no operator is set |
| AC-PAY-007 | All wallet-gated actions check operator authorization before proceeding |
| AC-PAY-008 | App gracefully handles buyer proxy being offline (empty channels, usage) |
| AC-PAY-009 | Existing deposit + claim functionality continues to work |
