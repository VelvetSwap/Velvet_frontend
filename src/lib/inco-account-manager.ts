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

    status('Checking for existing Inco accounts...');
    
    // First, check if accounts already exist
    let accounts = await findUserIncoAccounts(connection, wallet.publicKey);
    
    if (accounts.tokenA && accounts.tokenB) {
        status('Found existing Inco accounts');
        return {
            tokenA: accounts.tokenA,
            tokenB: accounts.tokenB,
            created: false,
        };
    }

    status('Creating missing Inco accounts...');

    // Create missing accounts
    const newAccountA = accounts.tokenA ? null : Keypair.generate();
    const newAccountB = accounts.tokenB ? null : Keypair.generate();

    const txs: Transaction[] = [];
    const signers: Keypair[] = [];

    if (newAccountA) {
        status('Creating Token A account...');
        const tx = await createIncoAccountTx(connection, wallet, INCO_MINT_A, newAccountA);
        txs.push(tx);
        signers.push(newAccountA);
    }

    if (newAccountB) {
        status('Creating Token B account...');
        const tx = await createIncoAccountTx(connection, wallet, INCO_MINT_B, newAccountB);
        txs.push(tx);
        signers.push(newAccountB);
    }

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();

    // Sign and send each transaction
    for (let i = 0; i < txs.length; i++) {
        const tx = txs[i];
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;
        
        // Partial sign with keypair
        tx.partialSign(signers[i]);
        
        // User signs
        const signedTx = await wallet.signTransaction(tx);
        
        // Send
        const sig = await connection.sendRawTransaction(signedTx.serialize());
        status(`Account ${i + 1} created: ${sig.slice(0, 20)}...`);
        
        // Wait for confirmation
        await connection.confirmTransaction(sig, 'confirmed');
    }

    // Return the account addresses
    return {
        tokenA: accounts.tokenA || newAccountA!.publicKey,
        tokenB: accounts.tokenB || newAccountB!.publicKey,
        created: true,
    };
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
