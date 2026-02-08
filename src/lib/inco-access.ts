/**
 * Inco Access Control Utilities
 * 
 * Automatic allowance PDA derivation and grant-access flow.
 * Follows the Inco docs pattern: simulate → derive PDA → execute with remainingAccounts
 * https://docs.inco.org/svm/guide/access-control
 */

import { Connection, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { Program, AnchorProvider } from '@coral-xyz/anchor';
import { INCO_LIGHTNING_PROGRAM_ID } from './inco-account-manager';
import { encryptValue } from '@inco/solana-sdk/encryption';
import { hexToBuffer } from '@inco/solana-sdk/utils';

const HANDLE_OFFSET = 72; // IncoAccount.amount starts at byte 72
const HANDLE_SIZE = 16;   // Euint128 = u128 = 16 bytes

/**
 * Derive allowance PDA from a handle and allowed address
 * Seeds: [handle.to_le_bytes(), allowed_address]
 */
export function getAllowancePda(handle: bigint, allowedAddress: PublicKey): [PublicKey, number] {
    const handleBuffer = Buffer.alloc(16);
    let h = handle;
    for (let i = 0; i < 16; i++) {
        handleBuffer[i] = Number(h & BigInt(0xff));
        h = h >> BigInt(8);
    }
    return PublicKey.findProgramAddressSync(
        [handleBuffer, allowedAddress.toBuffer()],
        INCO_LIGHTNING_PROGRAM_ID
    );
}

/**
 * Extract the balance handle (u128) from IncoAccount data
 */
export function extractHandleFromData(data: Buffer): bigint {
    const amountBytes = data.slice(HANDLE_OFFSET, HANDLE_OFFSET + HANDLE_SIZE);
    let handle = BigInt(0);
    for (let i = 15; i >= 0; i--) {
        handle = handle * BigInt(256) + BigInt(amountBytes[i]);
    }
    return handle;
}

/**
 * Check if an allowance PDA exists (i.e., access has been granted)
 */
export async function hasDecryptAccess(
    connection: Connection,
    handle: bigint,
    ownerAddress: PublicKey
): Promise<boolean> {
    if (handle === BigInt(0)) return true; // zero balance, no handle to check
    const [allowancePda] = getAllowancePda(handle, ownerAddress);
    const info = await connection.getAccountInfo(allowancePda);
    return info !== null;
}

/**
 * Encrypt zero using Inco SDK ECIES encryption for the burn-based access grant.
 * The official inco-token test proves encryptValue is required for all instructions.
 * Burning 0 tokens doesn't change the balance value but creates a new handle,
 * allowing us to attach an allowance PDA for the owner.
 */
async function encryptZero(): Promise<Buffer> {
    const hex = await encryptValue(BigInt(0));
    return hexToBuffer(hex);
}

/**
 * Automatically grant decrypt access for an IncoAccount.
 * 
 * Uses burn(0) instead of mint_to — this is critical because:
 * - burn can be called by the account OWNER (any wallet)
 * - mint_to requires the mint authority (only deployer)
 * - burning 0 tokens creates a new handle via e_sub(balance, 0) = same value
 * - the allowance remaining_accounts grant decrypt access to the new handle
 * 
 * Flow:
 * 1. Build burn(0) tx WITHOUT allowance accounts
 * 2. Simulate to get the new handle (after e_sub)
 * 3. Derive allowance PDA from [new_handle, owner]
 * 4. Execute real burn(0) tx WITH allowance remaining_accounts
 */
export async function grantDecryptAccess(
    connection: Connection,
    wallet: {
        publicKey: PublicKey;
        signTransaction: (tx: Transaction) => Promise<Transaction>;
    },
    accountPubkey: PublicKey,
    mintPubkey: PublicKey,
    onStatus?: (msg: string) => void,
): Promise<string> {
    const status = (msg: string) => {
        console.log('[grant-access]', msg);
        onStatus?.(msg);
    };

    // Load IDL
    const incoTokenIdl = await fetch('/idl/inco_token.json').then(r => r.json());
    const provider = new AnchorProvider(connection, wallet as any, { commitment: 'confirmed' });
    const program = new Program(incoTokenIdl, provider);

    const computeIxs = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ];

    const ciphertext = await encryptZero();

    // Step 1: Build burn(0) simulation tx (no allowance accounts)
    // The account owner signs as authority — no mint authority needed!
    status('Simulating to derive access key...');
    const burnIx = await program.methods
        .burn(Buffer.from(ciphertext), 0)
        .accounts({
            account: accountPubkey,
            mint: mintPubkey,
            authority: wallet.publicKey,
            incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
        })
        .instruction();

    const simTx = new Transaction();
    computeIxs.forEach(ix => simTx.add(ix));
    simTx.add(burnIx);

    const { blockhash } = await connection.getLatestBlockhash();
    simTx.recentBlockhash = blockhash;
    simTx.feePayer = wallet.publicKey;

    // User signs as the account owner (not mint authority)
    const signedSimTx = await wallet.signTransaction(simTx);

    // Step 2: Simulate to get new handle after burn(0)
    status('Reading encrypted handle...');
    const simulation = await connection.simulateTransaction(
        signedSimTx,
        undefined,
        [accountPubkey]
    );

    if (simulation.value.err) {
        console.error('Simulation failed:', simulation.value.err, simulation.value.logs?.slice(-5));
        throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }

    if (!simulation.value.accounts?.[0]?.data) {
        throw new Error('No account data in simulation result');
    }

    const simData = Buffer.from(simulation.value.accounts[0].data[0], 'base64');
    const newHandle = extractHandleFromData(simData);
    console.log('New handle from simulation:', newHandle.toString());

    if (newHandle === BigInt(0)) {
        status('Account has zero balance, no access grant needed');
        return '';
    }

    // Step 3: Derive allowance PDA from [new_handle, owner]
    const [allowancePda] = getAllowancePda(newHandle, wallet.publicKey);
    status('Granting decrypt access...');

    // Step 4: Execute burn(0) with allowance remaining_accounts
    const realTx = await program.methods
        .burn(Buffer.from(ciphertext), 0)
        .accounts({
            account: accountPubkey,
            mint: mintPubkey,
            authority: wallet.publicKey,
            incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
            { pubkey: allowancePda, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: false, isWritable: false },
        ])
        .transaction();

    const finalTx = new Transaction();
    computeIxs.forEach(ix => finalTx.add(ix));
    finalTx.add(...realTx.instructions);

    const { blockhash: bh2 } = await connection.getLatestBlockhash();
    finalTx.recentBlockhash = bh2;
    finalTx.feePayer = wallet.publicKey;

    const signedTx = await wallet.signTransaction(finalTx);
    const sig = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: false });
    
    status('Confirming access grant...');
    await connection.confirmTransaction(sig, 'confirmed');

    // Wait for covalidator to process the new FHE handle
    // The official inco-token test uses 5s delays after on-chain operations
    status('Waiting for covalidator to process...');
    await new Promise(r => setTimeout(r, 5000));

    status('Decrypt access granted!');
    return sig;
}

/**
 * Ensure decrypt access for a user's IncoAccounts.
 * Checks if access exists, grants it automatically if not.
 * Returns true if access was already present or successfully granted.
 */
export async function ensureDecryptAccess(
    connection: Connection,
    wallet: {
        publicKey: PublicKey;
        signTransaction: (tx: Transaction) => Promise<Transaction>;
    },
    accountPubkey: PublicKey,
    mintPubkey: PublicKey,
    onStatus?: (msg: string) => void,
): Promise<boolean> {
    // Read current handle
    const accountInfo = await connection.getAccountInfo(accountPubkey);
    if (!accountInfo) return false;

    const handle = extractHandleFromData(accountInfo.data);
    if (handle === BigInt(0)) return true; // zero balance, nothing to decrypt

    // Check if access already exists
    const hasAccess = await hasDecryptAccess(connection, handle, wallet.publicKey);
    if (hasAccess) {
        onStatus?.('Decrypt access already granted');
        return true;
    }

    // Grant access automatically
    try {
        await grantDecryptAccess(connection, wallet, accountPubkey, mintPubkey, onStatus);
        return true;
    } catch (e: any) {
        console.error('Failed to grant access:', e);
        onStatus?.(`Access grant failed: ${e.message}`);
        return false;
    }
}
