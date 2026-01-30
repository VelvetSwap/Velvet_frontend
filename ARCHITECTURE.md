# VelvetSwap Architecture

## Overview

VelvetSwap is a privacy-first confidential swap terminal for Solana, combining:

- **[Velvet Swap](https://github.com/your-username/velvet-swap)** — Confidential AMM with encrypted reserves
- **Inco Lightning** — Encrypted math + Confidential SPL token balances
- **MagicBlock PER** — Permissioned execution for confidential state updates

## System Architecture

```mermaid
flowchart TB
    subgraph Client["Client Layer"]
        USER[User Browser]
        WALLET[Wallet Adapter]
    end

    subgraph Frontend["VelvetSwap Frontend"]
        MAIN[Main UI<br/>page.tsx]
    end

    subgraph OnChain["On-Chain Programs"]
        subgraph VelvetSwap["Velvet Swap"]
            AMM[AMM Program]
            POOL[Pool PDA]
        end
        INCO[Inco Lightning]
        TOKEN[Confidential SPL]
        PER[MagicBlock PER]
    end

    subgraph OffChain["Off-Chain Services"]
        RPC[Helius RPC]
    end

    USER --> WALLET
    WALLET --> MAIN
    MAIN --> AMM
    AMM --> INCO
    AMM --> TOKEN
    AMM --> PER
    POOL --> INCO
    AMM --> RPC
```

## Component Details

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Velvet Swap** | Anchor (Rust) | Confidential AMM with encrypted reserves |
| **Inco Lightning** | Inco Network | Encrypted math via `Euint128` |
| **Confidential SPL** | inco_token | Encrypted token balances |
| **MagicBlock PER** | ephemeral-rollups-sdk | Permissioned execution |

---

## Flow A: Confidential Swap

### Sequence Diagram

```mermaid
sequenceDiagram
    participant User
    participant UI as VelvetSwap UI
    participant Wallet
    participant VS as Velvet Swap
    participant Inco as Inco Lightning
    participant RPC as Helius RPC

    User->>UI: Select swap direction
    UI->>VS: Build encrypted quote
    VS->>Inco: e_mul(reserve_a, reserve_b)
    Inco-->>VS: Encrypted K value
    VS-->>UI: Quote (ciphertext)

    UI->>User: Display encrypted amounts
    User->>Wallet: Approve transaction

    Wallet->>VS: swap_exact_in(amount_in_cipher, amount_out_cipher)
    VS->>Inco: Verify K invariant (encrypted)
    VS->>Inco: e_add(reserve_a, amount_in)
    VS->>Inco: e_sub(reserve_b, amount_out)
    VS->>RPC: Commit state
    VS-->>UI: ✓ Swap complete
```

### Velvet Swap Instructions

| Instruction | Description |
|-------------|-------------|
| `initialize_pool` | Create pool PDA with `Euint128` reserves |
| `add_liquidity` | Deposit encrypted token amounts |
| `remove_liquidity` | Withdraw encrypted token amounts |
| `swap_exact_in` | Execute swap with encrypted amounts |
| `create_permission` | Register with MagicBlock PER |
| `delegate_pda` | Delegate to MagicBlock validator |

### Swap Logic (Encrypted)

```mermaid
flowchart TD
    A[User submits swap] --> B{Check liquidity}
    B -->|e_ge reserve_b, amount_out| C[Sufficient]
    B -->|Insufficient| D[Zero out amounts]
    
    C --> E[Compute new reserves]
    E --> F[old_k = e_mul reserve_a, reserve_b]
    F --> G[new_k = e_mul new_reserve_a, new_reserve_b]
    G --> H{K invariant}
    H -->|e_ge new_k, old_k| I[Valid swap]
    H -->|Violated| D
    
    I --> J[inco_transfer: user → pool]
    J --> K[inco_transfer: pool → user]
    K --> L[Update encrypted reserves]
    L --> M[✓ Complete]
    D --> M
```

### Privacy Properties

- **Encrypted reserves**: `reserve_a`, `reserve_b` stored as `Euint128`
- **Encrypted transfers**: All token movements use ciphertext
- **Encrypted math**: `e_add`, `e_sub`, `e_mul`, `e_ge` operate on ciphertext
- **Permissioned access**: MagicBlock PER controls state updates
- **No plaintext leakage**: UI displays only hex ciphertext

---

## Security Model

```mermaid
flowchart LR
    subgraph Privacy["Privacy Layer"]
        INCO[Inco Lightning<br/>Encrypted State]
    end

    subgraph Access["Access Control"]
        PER[MagicBlock PER]
    end
    Privacy --> Access
    PER --> |Guards| INCO
```

| Layer | Protection |
|-------|------------|
| **State Privacy** | Inco Lightning encrypts all pool reserves and balances |
| **Access Control** | MagicBlock PER gates confidential swaps |

---

## File Structure

```
velvet-rope/
├── src/
│   ├── app/
│   │   └── page.tsx           # Main swap UI
│   ├── lib/
│   │   └── private-swap.ts    # Velvet Swap helpers
└── public/
```

## Related Repositories

| Repository | Description |
|------------|-------------|
| [Velvet Swap](https://github.com/your-username/velvet-swap) | Confidential AMM (Anchor/Rust) |
| [Inco Lightning](https://github.com/Inco-fhevm/inco-solana-programs) | Confidential SPL |

