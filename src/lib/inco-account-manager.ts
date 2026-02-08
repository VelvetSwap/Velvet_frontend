/**
 * Inco Account Manager
 * 
 * Handles the full frontend flow for Inco Token accounts:
 * 1. Check if user has IncoAccounts for the swap tokens
 * 2. Create IncoAccounts on-the-fly if needed
 * 3. Return account addresses for swap execution
 */

import { Connection, PublicKey, Transaction, Keypair, ComputeBudgetProgram } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import devnetConfig from '@/config/devnet-config.json';

// Program IDs
export const INCO_TOKEN_PROGRAM_ID = new PublicKey('CYVSeUyVzHGVcrxsJt3E8tbaPCQT8ASdRR45g5WxUEW7');
export const INCO_LIGHTNING_PROGRAM_ID = new PublicKey('5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj');

// Devnet mints
export const INCO_MINT_A = new PublicKey(devnetConfig.incoMintA); // wSOL
export const INCO_MINT_B = new PublicKey(devnetConfig.incoMintB); // USDC
export const POOL_VAULT_A = new PublicKey(devnetConfig.poolVaultA);
export const POOL_VAULT_B = new PublicKey(devnetConfig.poolVaultB);

// IncoAccount discriminator (first 8 bytes of account data)
const INCO_ACCOUNT_DISCRIMINATOR = Buffer.from([112, 234, 85, 188, 136, 127, 133, 93]);

export interface UserIncoAccounts {
    tokenA: PublicKey | null;
    tokenB: PublicKey | null;
}

export interface WalletAdapter {
    publicKey: PublicKey;
    signTransaction: (tx: Transaction) => Promise<Transaction>;
    signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
}

/**
 * Find existing IncoAccounts owned by a wallet for the devnet mints
 */
export async function findUserIncoAccounts(
    connection: Connection,
    walletPubkey: PublicKey
): Promise<UserIncoAccounts> {
    console.log('Finding IncoAccounts for wallet:', walletPubkey.toBase58());
    
    // Get all accounts owned by the Inco Token program
    const accounts = await connection.getProgramAccounts(INCO_TOKEN_PROGRAM_ID, {
        filters: [
            { dataSize: 221 }, // IncoAccount size
        ],
    });

    let tokenA: PublicKey | null = null;
    let tokenB: PublicKey | null = null;

    for (const { pubkey, account } of accounts) {
        const data = account.data;
        
        // Check discriminator
        if (!data.slice(0, 8).equals(INCO_ACCOUNT_DISCRIMINATOR)) {
            continue;
        }

        // Parse mint (offset 8, 32 bytes)
        const mint = new PublicKey(data.slice(8, 40));
        
        // Parse owner (offset 40, 32 bytes)
        const owner = new PublicKey(data.slice(40, 72));

        // Check if this account belongs to the wallet
        if (!owner.equals(walletPubkey)) {
            continue;
        }

        // Match to our devnet mints
        if (mint.equals(INCO_MINT_A)) {
            tokenA = pubkey;
            console.log('Found Token A account:', pubkey.toBase58());
        } else if (mint.equals(INCO_MINT_B)) {
            tokenB = pubkey;
            console.log('Found Token B account:', pubkey.toBase58());
        }
    }

    return { tokenA, tokenB };
}

/**
 * Create IncoAccount for a user (returns the transaction to sign)
 */
export async function createIncoAccountTx(
    connection: Connection,
    wallet: WalletAdapter,
    mint: PublicKey,
    newAccountKeypair: Keypair
): Promise<Transaction> {
    // Load IDL dynamically to avoid build issues
    const incoTokenIdl = await fetch('/idl/inco_token.json').then(r => r.json());
    
    const provider = new AnchorProvider(
        connection,
        wallet as any,
        { commitment: 'confirmed' }
    );
    const program = new Program(incoTokenIdl, provider);

    const ix = await program.methods
        .initializeAccount()
        .accounts({
            account: newAccountKeypair.publicKey,
            mint: mint,
            owner: wallet.publicKey,
            payer: wallet.publicKey,
        })
        .instruction();

    const tx = new Transaction();
    tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        ix
    );

    return tx;
}

/**
 * Ensure user has IncoAccounts for both tokens
 * Creates them if they don't exist
 * Returns the account addresses
 */
export async function ensureUserIncoAccounts(
    connection: Connection,
    wallet: WalletAdapter,
    onStatusUpdate?: (status: string) => void
): Promise<{ tokenA: PublicKey; tokenB: PublicKey; created: boolean }> {
    const status = (msg: string) => {
        console.log(msg);
        onStatusUpdate?.(msg);
    };

    // Faucet is the single source of truth: creates accounts + mints + fixes corrupted ones
    status('Setting up token accounts via faucet...');
    try {
        const resp = await fetch('/api/faucet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallet: wallet.publicKey.toBase58() }),
        });
        const result = await resp.json();
        if (result.success && result.tokenA && result.tokenB) {
            if (result.mintedA || result.mintedB) {
                status('Accounts created & funded ✓');
            } else {
                status('Accounts ready ✓');
            }
            return {
                tokenA: new PublicKey(result.tokenA),
                tokenB: new PublicKey(result.tokenB),
                created: !!(result.mintedA || result.mintedB),
            };
        }
        // Faucet returned an error but didn't throw
        status('Faucet: ' + (result.error || 'unknown error'));
    } catch (e: any) {
        console.warn('Faucet call failed:', e.message);
        status('Faucet unavailable, checking local accounts...');
    }

    // Fallback: find existing accounts if faucet is unreachable
    const accounts = await findUserIncoAccounts(connection, wallet.publicKey);
    if (accounts.tokenA && accounts.tokenB) {
        return { tokenA: accounts.tokenA, tokenB: accounts.tokenB, created: false };
    }

    throw new Error('No token accounts found and faucet is unavailable. Please try again.');
}

/**
 * Full swap flow for frontend
 * 1. Ensure user has IncoAccounts
 * 2. Build swap transaction
 * 3. Return ready-to-sign transaction
 */
export interface SwapParams {
    connection: Connection;
    wallet: WalletAdapter;
    amountIn: bigint;
    aToB: boolean; // true = swap A for B, false = swap B for A
    onStatusUpdate?: (status: string) => void;
}

export interface SwapResult {
    userTokenA: PublicKey;
    userTokenB: PublicKey;
    poolVaultA: PublicKey;
    poolVaultB: PublicKey;
    mintA: PublicKey;
    mintB: PublicKey;
}

/**
 * Prepare swap - ensures accounts exist and returns all addresses needed
 */
export async function prepareSwap(params: SwapParams): Promise<SwapResult> {
    const { connection, wallet, onStatusUpdate } = params;

    // Ensure user has IncoAccounts
    const { tokenA, tokenB } = await ensureUserIncoAccounts(
        connection,
        wallet,
        onStatusUpdate
    );

    return {
        userTokenA: tokenA,
        userTokenB: tokenB,
        poolVaultA: POOL_VAULT_A,
        poolVaultB: POOL_VAULT_B,
        mintA: INCO_MINT_A,
        mintB: INCO_MINT_B,
    };
}
