/**
 * Inco Balance Manager
 * 
 * Handles fetching and decrypting encrypted token balances from IncoAccounts.
 * Uses @inco/solana-sdk attested decrypt to reveal balances to the account owner.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { INCO_TOKEN_PROGRAM_ID, INCO_LIGHTNING_PROGRAM_ID, INCO_MINT_A, INCO_MINT_B } from './inco-account-manager';

// IncoAccount data layout offsets
// [0..8]   discriminator
// [8..40]  mint (pubkey)
// [40..72] owner (pubkey)
// [72..88] amount (Euint128 = u128 handle)
const AMOUNT_OFFSET = 72;
const HANDLE_SIZE = 16; // u128 = 16 bytes

export interface IncoAccountInfo {
    pubkey: PublicKey;
    mint: PublicKey;
    owner: PublicKey;
    amountHandle: string; // u128 handle as decimal string
    delegateHandle: string | null;
    state: number;
}

/**
 * Parse an IncoAccount's raw data to extract the encrypted balance handle
 */
export function parseIncoAccountData(data: Buffer): {
    mint: PublicKey;
    owner: PublicKey;
    amountHandle: string;
} {
    const mint = new PublicKey(data.slice(8, 40));
    const owner = new PublicKey(data.slice(40, 72));

    // Read u128 handle as little-endian
    const handleBytes = data.slice(AMOUNT_OFFSET, AMOUNT_OFFSET + HANDLE_SIZE);
    const lo = handleBytes.readBigUInt64LE(0);
    const hi = handleBytes.readBigUInt64LE(8);
    const handleValue = (hi << 64n) | lo;
    const amountHandle = handleValue.toString();

    return { mint, owner, amountHandle };
}

/**
 * Find and parse user's IncoAccounts with their encrypted balance handles
 */
export async function fetchUserIncoAccounts(
    connection: Connection,
    walletPubkey: PublicKey
): Promise<{ tokenA: IncoAccountInfo | null; tokenB: IncoAccountInfo | null }> {
    // Get all IncoAccount accounts owned by the program
    const accounts = await connection.getProgramAccounts(INCO_TOKEN_PROGRAM_ID, {
        commitment: 'confirmed',
        filters: [
            { dataSize: 221 }, // IncoAccount size
        ],
    });

    // Collect ALL candidate accounts per mint (user may have old corrupted + new valid)
    const candidatesA: IncoAccountInfo[] = [];
    const candidatesB: IncoAccountInfo[] = [];

    for (const { pubkey, account } of accounts) {
        const data = account.data;
        const mint = new PublicKey(data.slice(8, 40));
        const owner = new PublicKey(data.slice(40, 72));

        if (!owner.equals(walletPubkey)) continue;

        const parsed = parseIncoAccountData(data);
        const info: IncoAccountInfo = {
            pubkey,
            mint: parsed.mint,
            owner: parsed.owner,
            amountHandle: parsed.amountHandle,
            delegateHandle: null,
            state: data[121] || 0,
        };

        if (mint.equals(INCO_MINT_A)) candidatesA.push(info);
        else if (mint.equals(INCO_MINT_B)) candidatesB.push(info);
    }

    // Pick the best account per mint: prefer one with a valid allowance PDA
    async function pickBest(candidates: IncoAccountInfo[]): Promise<IncoAccountInfo | null> {
        if (candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];

        // Check which candidate has a valid allowance PDA (non-corrupted)
        for (const c of candidates) {
            if (c.amountHandle === '0') continue;
            const handle = BigInt(c.amountHandle);
            const handleBuf = Buffer.alloc(16);
            let h = handle;
            for (let i = 0; i < 16; i++) { handleBuf[i] = Number(h & 0xffn); h >>= 8n; }
            const [pda] = PublicKey.findProgramAddressSync(
                [handleBuf, walletPubkey.toBuffer()],
                INCO_LIGHTNING_PROGRAM_ID
            );
            const pdaInfo = await connection.getAccountInfo(pda);
            if (pdaInfo !== null) return c; // has allowance PDA → valid account
        }
        // Fallback: return last candidate (newest)
        return candidates[candidates.length - 1];
    }

    const tokenA = await pickBest(candidatesA);
    const tokenB = await pickBest(candidatesB);

    return { tokenA, tokenB };
}

/**
 * Decrypt encrypted balance handles using Inco SDK attested reveal
 * Requires the wallet owner to sign a message for authentication
 */
export async function decryptBalances(
    handles: string[],
    walletAddress: PublicKey | string,
    signMessage: (message: Uint8Array) => Promise<Uint8Array>
): Promise<string[]> {
    // Filter out zero handles (no balance)
    const validHandles = handles.filter(h => h !== '0');
    if (validHandles.length === 0) {
        return handles.map(h => h === '0' ? '0' : '0');
    }

    try {
        // Dynamic import to avoid SSR issues
        // @ts-ignore - @inco/solana-sdk may not have type declarations
        const { decrypt } = await import('@inco/solana-sdk/attested-decrypt');
        
        const address = typeof walletAddress === 'string' 
            ? walletAddress 
            : walletAddress.toBase58();

        const result = await decrypt(validHandles, {
            address,
            signMessage,
        });

        // Map back to original order
        let validIdx = 0;
        return handles.map(h => {
            if (h === '0') return '0';
            const plaintext = result.plaintexts[validIdx];
            validIdx++;
            return plaintext || '0';
        });
    } catch (error: any) {
        console.error('Decrypt failed:', error);
        throw new Error(`Balance decryption failed: ${error.message}`);
    }
}

/**
 * Format a raw balance value with decimals
 */
export function formatBalance(rawValue: string, decimals: number): string {
    const value = BigInt(rawValue);
    if (value === 0n) return '0';

    const divisor = BigInt(10 ** decimals);
    const whole = value / divisor;
    const fraction = value % divisor;

    if (fraction === 0n) return whole.toString();

    const fractionStr = fraction.toString().padStart(decimals, '0');
    // Trim trailing zeros
    const trimmed = fractionStr.replace(/0+$/, '');
    return `${whole}.${trimmed}`;
}
