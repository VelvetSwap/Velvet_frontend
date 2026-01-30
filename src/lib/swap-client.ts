/**
 * Light Swap PSP Client
 * Client for interacting with the light_swap_psp program on devnet
 * Uses Light Protocol V2 for compressed accounts + Inco FHE for encryption
 */

import { AnchorProvider, BN, Program, type Idl } from '@coral-xyz/anchor';
import { Connection, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import {
    createRpc,
    bn,
    deriveAddressSeedV2,
    deriveAddressV2,
    PackedAccounts,
    SystemAccountMetaConfig,
    featureFlags,
    VERSION,
    batchAddressTree,
    type Rpc,
} from '@lightprotocol/stateless.js';
import lightSwapIdl from '@/idl/light_swap_psp.json';

// Force V2 mode for Light Protocol
(featureFlags as any).version = VERSION.V2;

// Program ID from deployed program
export const LIGHT_SWAP_PROGRAM_ID = new PublicKey('4b8jCufu7b4WKXdxFRQHWSks4QdskW62qF7tApSNXuZD');

// Inco Lightning Program
export const INCO_LIGHTNING_PROGRAM_ID = new PublicKey('5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj');

// Light Protocol V2 batch address tree
export const LIGHT_BATCH_ADDRESS_TREE = new PublicKey(batchAddressTree);

// Light Protocol V2 output queue (devnet)
export const LIGHT_OUTPUT_QUEUE = new PublicKey('oq1na8gojfdUhsfCpyjNt6h4JaDWtHf1yQj4koBWfto');

// Pool authority seed
const POOL_AUTH_SEED = Buffer.from('pool_authority');

export interface WalletAdapter {
    publicKey: PublicKey;
    signTransaction: (tx: Transaction) => Promise<Transaction>;
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}

/**
 * Derive pool authority PDA from mint pair
 */
export function derivePoolAuthorityPda(mintA: PublicKey, mintB: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [POOL_AUTH_SEED, mintA.toBuffer(), mintB.toBuffer()],
        LIGHT_SWAP_PROGRAM_ID
    );
    return pda;
}

/**
 * Create Anchor provider from wallet adapter
 */
function createProvider(connection: Connection, wallet: WalletAdapter): AnchorProvider {
    const anchorWallet = {
        publicKey: wallet.publicKey,
        signTransaction: async <T extends Transaction>(tx: T): Promise<T> =>
            (await wallet.signTransaction(tx)) as T,
        signAllTransactions: async <T extends Transaction>(txs: T[]): Promise<T[]> =>
            Promise.all(txs.map(async (tx) => (await wallet.signTransaction(tx)) as T)),
    };

    return new AnchorProvider(connection, anchorWallet as never, {
        commitment: 'confirmed',
        preflightCommitment: 'confirmed',
    });
}

/**
 * Get the swap program instance
 */
export function getSwapProgram(connection: Connection, wallet: WalletAdapter): Program {
    const provider = createProvider(connection, wallet);
    return new Program(lightSwapIdl as Idl, provider);
}

// Helius devnet RPC (public)
const HELIUS_DEVNET_RPC = 'https://devnet.helius-rpc.com/?api-key=2d8978c6-7067-459f-ae97-7ea035f1a0cb';

/**
 * Create Light RPC client for validity proofs
 */
export function createLightRpc(): Rpc {
    return createRpc(HELIUS_DEVNET_RPC, HELIUS_DEVNET_RPC);
}

/**
 * Derive pool address using Light Protocol V2
 */
export function derivePoolAddress(mintA: PublicKey, mintB: PublicKey): PublicKey {
    const seeds = [Buffer.from('pool'), mintA.toBuffer(), mintB.toBuffer()];
    const poolAddressSeed = deriveAddressSeedV2(seeds);
    return deriveAddressV2(poolAddressSeed, LIGHT_BATCH_ADDRESS_TREE, LIGHT_SWAP_PROGRAM_ID);
}

/**
 * Build remaining accounts with proper writable flags for Anchor
 * CRITICAL: Must convert isWritable to boolean (not number) for Anchor
 */
export function buildRemainingAccounts(
    addressTreeIndex: number,
    outputQueueIndex: number,
    packedAccounts: PackedAccounts
) {
    const { remainingAccounts: rawAccounts } = packedAccounts.toAccountMetas();
    
    // CRITICAL FIX: Convert isWritable from number to boolean for Anchor
    return rawAccounts.map((acct: any) => ({
        pubkey: acct.pubkey,
        isWritable: Boolean(acct.isWritable),
        isSigner: Boolean(acct.isSigner),
    }));
}

/**
 * Format validity proof for Anchor (Option<CompressedProof> as { 0: proof })
 */
function formatValidityProof(compressedProof: any) {
    if (!compressedProof) return null;
    return {
        0: {
            a: Array.from(compressedProof.a),
            b: Array.from(compressedProof.b),
            c: Array.from(compressedProof.c),
        }
    };
}

/**
 * Create compute budget instructions
 */
function computeBudgetIxs() {
    return [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ];
}

/**
 * Initialize a new pool with Light Protocol V2
 */
export async function initializePool(params: {
    connection: Connection;
    wallet: WalletAdapter;
    mintA: PublicKey;
    mintB: PublicKey;
    feeBps?: number;
}): Promise<{ transaction: Transaction; poolAddress: PublicKey }> {
    const { connection, wallet, mintA, mintB, feeBps = 30 } = params;
    const program = getSwapProgram(connection, wallet);
    const lightRpc = createLightRpc();

    // Derive pool address using V2
    const poolAddress = derivePoolAddress(mintA, mintB);
    const addressTree = LIGHT_BATCH_ADDRESS_TREE;
    const outputQueue = LIGHT_OUTPUT_QUEUE;

    // Get validity proof from Light RPC
    const proofResult = await lightRpc.getValidityProofV0(
        [],
        [{
            address: bn(poolAddress.toBytes()),
            tree: addressTree,
            queue: addressTree, // Same as tree per Light Protocol example
        }]
    );

    // Build remaining accounts with PackedAccounts
    const packedAccounts = new PackedAccounts();
    packedAccounts.addSystemAccountsV2(SystemAccountMetaConfig.new(LIGHT_SWAP_PROGRAM_ID));
    const addressTreeIndex = packedAccounts.insertOrGet(addressTree);
    const outputQueueIndex = packedAccounts.insertOrGet(outputQueue);
    const remainingAccounts = buildRemainingAccounts(addressTreeIndex, outputQueueIndex, packedAccounts);

    const packedAddressTreeInfo = {
        addressMerkleTreePubkeyIndex: addressTreeIndex,
        addressQueuePubkeyIndex: addressTreeIndex,
        rootIndex: proofResult.rootIndices[0],
    };

    const validityProof = formatValidityProof(proofResult.compressedProof);

    const ix = await program.methods
        .initializePool(
            validityProof,
            packedAddressTreeInfo,
            outputQueueIndex,
            mintA,
            mintB,
            feeBps
        )
        .accounts({
            feePayer: wallet.publicKey,
            authority: wallet.publicKey,
            incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .instruction();

    const tx = new Transaction();
    tx.add(...computeBudgetIxs());
    tx.add(ix);

    return { transaction: tx, poolAddress };
}

/**
 * Fetch pool state from Light Protocol compressed account
 * Returns the pool data and metadata needed for state transitions
 */
export async function fetchPoolState(mintA: PublicKey, mintB: PublicKey): Promise<{
    poolMeta: any;
    poolData: Buffer;
    poolAddress: PublicKey;
} | null> {
    const lightRpc = createLightRpc();
    const poolAddress = derivePoolAddress(mintA, mintB);
    
    try {
        // Get compressed account by address
        const accounts = await lightRpc.getCompressedAccountsByOwner(LIGHT_SWAP_PROGRAM_ID);
        const poolAccount = accounts.items.find((acc: any) => 
            acc.address && Buffer.from(acc.address).equals(poolAddress.toBuffer())
        );
        
        if (!poolAccount) return null;
        
        // Extract merkle context info
        const merkleContext = (poolAccount as any).merkleContext || {};
        
        return {
            poolMeta: {
                treeInfo: {
                    rootIndex: merkleContext.rootIndex || 0,
                    proveByIndex: false,
                    merkleTreePubkeyIndex: 0,
                    queuePubkeyIndex: 1,
                    leafIndex: merkleContext.leafIndex || 0,
                },
                address: Array.from(poolAddress.toBytes()),
                outputStateTreeIndex: 1,
            },
            poolData: Buffer.from((poolAccount as any).data?.data || []),
            poolAddress,
        };
    } catch (e) {
        console.warn('Pool not found:', e);
        return null;
    }
}

/**
 * Execute a swap with Light Protocol V2
 */
export async function swapExactIn(params: {
    connection: Connection;
    wallet: WalletAdapter;
    mintA: PublicKey;
    mintB: PublicKey;
    amountInCiphertext: Buffer;
    amountOutCiphertext: Buffer;
    feeAmountCiphertext: Buffer;
    aToB: boolean;
}): Promise<Transaction> {
    const { connection, wallet, mintA, mintB, amountInCiphertext, amountOutCiphertext, feeAmountCiphertext, aToB } = params;
    const program = getSwapProgram(connection, wallet);
    const lightRpc = createLightRpc();

    // Fetch pool state
    const poolState = await fetchPoolState(mintA, mintB);
    if (!poolState) {
        throw new Error('Pool not initialized. Please initialize pool first.');
    }

    const addressTree = LIGHT_BATCH_ADDRESS_TREE;
    const outputQueue = LIGHT_OUTPUT_QUEUE;

    // Get validity proof for state transition
    const proofResult = await lightRpc.getValidityProofV0(
        [bn(poolState.poolAddress.toBytes())], // existing compressed account
        []
    );

    // Build remaining accounts
    const packedAccounts = new PackedAccounts();
    packedAccounts.addSystemAccountsV2(SystemAccountMetaConfig.new(LIGHT_SWAP_PROGRAM_ID));
    const addressTreeIndex = packedAccounts.insertOrGet(addressTree);
    const outputQueueIndex = packedAccounts.insertOrGet(outputQueue);
    const remainingAccounts = buildRemainingAccounts(addressTreeIndex, outputQueueIndex, packedAccounts);

    const validityProof = formatValidityProof(proofResult.compressedProof);

    const ix = await program.methods
        .swapExactIn(
            validityProof,
            poolState.poolMeta,
            poolState.poolData,
            amountInCiphertext,
            amountOutCiphertext,
            feeAmountCiphertext,
            0, // input_type (plaintext for now)
            aToB
        )
        .accounts({
            feePayer: wallet.publicKey,
            incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .instruction();

    const tx = new Transaction();
    tx.add(...computeBudgetIxs());
    tx.add(ix);

    return tx;
}

/**
 * Add liquidity to pool with Light Protocol V2
 */
export async function addLiquidity(params: {
    connection: Connection;
    wallet: WalletAdapter;
    mintA: PublicKey;
    mintB: PublicKey;
    amountACiphertext: Buffer;
    amountBCiphertext: Buffer;
}): Promise<Transaction> {
    const { connection, wallet, mintA, mintB, amountACiphertext, amountBCiphertext } = params;
    const program = getSwapProgram(connection, wallet);
    const lightRpc = createLightRpc();

    // Fetch pool state
    const poolState = await fetchPoolState(mintA, mintB);
    if (!poolState) {
        throw new Error('Pool not initialized. Please initialize pool first.');
    }

    const addressTree = LIGHT_BATCH_ADDRESS_TREE;
    const outputQueue = LIGHT_OUTPUT_QUEUE;

    // Get validity proof
    const proofResult = await lightRpc.getValidityProofV0(
        [bn(poolState.poolAddress.toBytes())],
        []
    );

    // Build remaining accounts
    const packedAccounts = new PackedAccounts();
    packedAccounts.addSystemAccountsV2(SystemAccountMetaConfig.new(LIGHT_SWAP_PROGRAM_ID));
    const addressTreeIndex = packedAccounts.insertOrGet(addressTree);
    const outputQueueIndex = packedAccounts.insertOrGet(outputQueue);
    const remainingAccounts = buildRemainingAccounts(addressTreeIndex, outputQueueIndex, packedAccounts);

    const validityProof = formatValidityProof(proofResult.compressedProof);

    const ix = await program.methods
        .addLiquidity(
            validityProof,
            poolState.poolMeta,
            poolState.poolData,
            amountACiphertext,
            amountBCiphertext,
            0 // input_type
        )
        .accounts({
            feePayer: wallet.publicKey,
            authority: wallet.publicKey,
            incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .instruction();

    const tx = new Transaction();
    tx.add(...computeBudgetIxs());
    tx.add(ix);

    return tx;
}

/**
 * Encrypt an amount using Inco encryption (placeholder)
 * In production, use @inco/solana-sdk/encryption
 */
export function encryptAmount(amount: bigint): Buffer {
    // Placeholder - in production use Inco SDK
    const buf = Buffer.alloc(32);
    buf.writeBigUInt64LE(amount, 0);
    return buf;
}

/**
 * Compute constant product swap quote
 */
export function computeSwapQuote(
    amountIn: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
    feeBps: bigint = 30n
): { amountOut: bigint; feeAmount: bigint } {
    if (reserveIn === 0n || reserveOut === 0n) {
        return { amountOut: 0n, feeAmount: 0n };
    }

    const feeAmount = (amountIn * feeBps) / 10000n;
    const netIn = amountIn - feeAmount;
    
    // Constant product: x * y = k
    // (reserveIn + netIn) * (reserveOut - amountOut) = reserveIn * reserveOut
    const amountOut = (reserveOut * netIn) / (reserveIn + netIn);

    return { amountOut, feeAmount };
}
