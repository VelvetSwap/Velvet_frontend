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
 * Format validity proof for Anchor (Option<CompressedProof>)
 * Returns null for None variant when using proveByIndex=true
 */
function formatValidityProof(compressedProof: any, proveByIndex: boolean = false) {
    // When using proveByIndex=true (V2 batched trees), proof should be None
    if (proveByIndex || !compressedProof) {
        return null; // None variant for Option<CompressedProof>
    }
    return {
        0: {
            a: compressedProof.a ? Array.from(compressedProof.a) : new Array(32).fill(0),
            b: compressedProof.b ? Array.from(compressedProof.b) : new Array(64).fill(0),
            c: compressedProof.c ? Array.from(compressedProof.c) : new Array(32).fill(0),
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
    accountHash: any;
    treeInfo: {
        tree: PublicKey;
        queue: PublicKey;
    };
    leafIndex: number;
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
        
        // Extract the actual tree info from the account (NOT hardcoded values)
        const acct = poolAccount as any;
        const treeInfo = acct.treeInfo || {};
        const leafIndex = acct.leafIndex || 0;
        const accountHash = acct.hash;
        
        console.log('Pool account found:', {
            address: poolAddress.toBase58(),
            tree: treeInfo.tree,
            queue: treeInfo.queue,
            leafIndex,
        });
        
        return {
            poolMeta: {
                // This will be populated with correct indices after building PackedAccounts
                treeInfo: {
                    rootIndex: 0, // Will be set from proof
                    proveByIndex: false,
                    merkleTreePubkeyIndex: 0, // Will be set after insertOrGet
                    queuePubkeyIndex: 0, // Will be set after insertOrGet
                    leafIndex,
                },
                address: Array.from(poolAddress.toBytes()),
                outputStateTreeIndex: 0, // Will be set after insertOrGet
            },
            poolData: Buffer.from(acct.data?.data || []),
            poolAddress,
            accountHash,
            treeInfo: {
                tree: new PublicKey(treeInfo.tree),
                queue: new PublicKey(treeInfo.queue),
            },
            leafIndex,
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

    // Fetch pool state (includes actual tree info from the account)
    const poolState = await fetchPoolState(mintA, mintB);
    if (!poolState) {
        throw new Error('Pool not initialized. Please initialize pool first.');
    }

    // Use the ACTUAL tree info from the pool account, not hardcoded values
    const stateTree = poolState.treeInfo.tree;
    const stateQueue = poolState.treeInfo.queue;
    
    console.log('Using pool tree info:', {
        stateTree: stateTree.toBase58(),
        stateQueue: stateQueue.toBase58(),
        leafIndex: poolState.leafIndex,
    });

    // Get validity proof for the existing compressed account (required for state transitions)
    let rootIndex = 0;
    let compressedProof = null;
    
    // Convert hash to BN254 format required by getValidityProofV0
    // The hash from getCompressedAccountsByOwner is a byte array, convert to BN
    const hashBn = bn(poolState.accountHash);
    
    console.log('Fetching validity proof for hash:', hashBn.toString().slice(0, 20) + '...');
    
    try {
        // For state transitions on existing compressed accounts, we need getValidityProofV0
        // with the account hash as input (must be BN254 format)
        console.log('Calling getValidityProofV0 with:', {
            hash: hashBn.toString().slice(0, 30) + '...',
            tree: stateTree.toBase58(),
            queue: stateQueue.toBase58(),
        });
        
        const proofResult = await lightRpc.getValidityProofV0(
            [{ hash: hashBn, tree: stateTree, queue: stateQueue }],
            [] // no new addresses
        );
        
        console.log('getValidityProofV0 result:', {
            hasCompressedProof: !!proofResult?.compressedProof,
            rootIndices: proofResult?.rootIndices,
            roots: proofResult?.roots?.length,
        });
        
        if (proofResult) {
            rootIndex = proofResult.rootIndices?.[0] || 0;
            compressedProof = proofResult.compressedProof;
            console.log('Got validity proof, rootIndex:', rootIndex, 'hasProof:', !!compressedProof);
        }
    } catch (proofError: any) {
        console.error('Failed to get validity proof:', proofError?.message, proofError);
        // Don't fallback - we need a real validity proof for state transitions
        throw new Error(`Cannot get validity proof: ${proofError?.message}`);
    }

    // Build remaining accounts using the ACTUAL trees from the pool
    const packedAccounts = new PackedAccounts();
    packedAccounts.addSystemAccountsV2(SystemAccountMetaConfig.new(LIGHT_SWAP_PROGRAM_ID));
    
    // Insert the actual state tree and queue from the pool account
    const stateTreeIndex = packedAccounts.insertOrGet(stateTree);
    const stateQueueIndex = packedAccounts.insertOrGet(stateQueue);
    
    // Also add the address tree for any new addresses
    const addressTreeIndex = packedAccounts.insertOrGet(LIGHT_BATCH_ADDRESS_TREE);
    
    const remainingAccounts = buildRemainingAccounts(stateTreeIndex, stateQueueIndex, packedAccounts);

    // Update poolMeta with correct indices
    // V2 batched trees use proveByIndex=true optimization (no ZK proof needed)
    const poolMeta = {
        treeInfo: {
            rootIndex,
            proveByIndex: true, // V2 batched trees verify by index, not merkle proof
            merkleTreePubkeyIndex: stateTreeIndex,
            queuePubkeyIndex: stateQueueIndex,
            leafIndex: poolState.leafIndex,
        },
        address: Array.from(poolState.poolAddress.toBytes()),
        outputStateTreeIndex: stateQueueIndex,
    };

    // For V2 batched trees with proveByIndex=true, proof should be None (null)
    const validityProof = formatValidityProof(compressedProof, true);
    console.log('Pool meta:', {
        proveByIndex: true,
        leafIndex: poolState.leafIndex,
        rootIndex,
        proof: validityProof === null ? 'None' : 'Some',
    });

    const ix = await program.methods
        .swapExactIn(
            validityProof,
            poolMeta,
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
 * Encrypt an amount for Inco Lightning
 * 
 * With input_type=0 (plaintext), the on-chain program encrypts via CPI to Inco Lightning.
 * The amount is passed as plaintext bytes, and new_euint128() encrypts it on-chain.
 * 
 * This provides:
 * - Pool reserves stored encrypted (FHE)
 * - Swap math computed on encrypted values
 * - Only the initial tx data is plaintext (encrypted on-chain immediately)
 */
export function encryptAmount(amount: bigint): Buffer {
    // For input_type=0, we pass plaintext bytes
    // The on-chain program encrypts via Inco Lightning CPI: new_euint128(data, input_type=0)
    // This is the same approach used in the test files
    const buf = Buffer.alloc(16); // u128 = 16 bytes
    
    // Write as little-endian u128
    const lo = amount & BigInt('0xFFFFFFFFFFFFFFFF');
    const hi = (amount >> 64n) & BigInt('0xFFFFFFFFFFFFFFFF');
    buf.writeBigUInt64LE(lo, 0);
    buf.writeBigUInt64LE(hi, 8);
    
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
