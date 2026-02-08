/**
 * Inco Allowance Manager
 * 
 * Handles the approve/delegate flow for Inco Token accounts.
 * Allows the pool authority PDA to spend tokens on behalf of the user.
 */

import { Connection, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { Program, AnchorProvider } from '@coral-xyz/anchor';
import { INCO_LIGHTNING_PROGRAM_ID } from './inco-account-manager';
import { encryptValue } from '@inco/solana-sdk/encryption';
import { hexToBuffer } from '@inco/solana-sdk/utils';
import devnetConfig from '@/config/devnet-config.json';

const POOL_AUTHORITY_PDA = new PublicKey(devnetConfig.poolAuthorityPda);

export interface ApproveParams {
    connection: Connection;
    wallet: {
        publicKey: PublicKey;
        signTransaction: (tx: Transaction) => Promise<Transaction>;
    };
    sourceAccount: PublicKey; // User's IncoAccount
    delegate: PublicKey;     // Pool authority PDA (or any delegate)
    amount: bigint;          // Amount to approve
}

/**
 * Encrypt an amount using Inco SDK ECIES encryption for the approve instruction.
 * The official inco-token test proves encryptValue is required for all instructions.
 */
async function encryptApproveAmount(amount: bigint): Promise<Buffer> {
    const hex = await encryptValue(amount);
    return hexToBuffer(hex);
}

/**
 * Build an approve transaction for the Inco Token program
 * This approves a delegate (e.g., pool authority) to spend tokens
 */
export async function buildApproveTransaction(params: ApproveParams): Promise<Transaction> {
    const { connection, wallet, sourceAccount, delegate, amount } = params;

    // Load IDL dynamically
    const incoTokenIdl = await fetch('/idl/inco_token.json').then(r => r.json());
    
    const provider = new AnchorProvider(
        connection,
        wallet as any,
        { commitment: 'confirmed' }
    );
    const program = new Program(incoTokenIdl, provider);

    const ciphertext = await encryptApproveAmount(amount);

    const ix = await program.methods
        .approve(Buffer.from(ciphertext), 0) // input_type = 0 (plaintext)
        .accounts({
            source: sourceAccount,
            delegate: delegate,
            owner: wallet.publicKey,
            incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
            systemProgram: PublicKey.default,
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
 * Approve pool authority to spend tokens from user's IncoAccount
 * This is needed before swaps so the pool can transfer tokens
 */
export async function approvePoolAuthority(
    connection: Connection,
    wallet: {
        publicKey: PublicKey;
        signTransaction: (tx: Transaction) => Promise<Transaction>;
    },
    userTokenAccount: PublicKey,
    amount: bigint,
    onStatus?: (msg: string) => void,
): Promise<string> {
    const status = (msg: string) => {
        console.log(msg);
        onStatus?.(msg);
    };

    status('Building approve transaction...');

    const tx = await buildApproveTransaction({
        connection,
        wallet,
        sourceAccount: userTokenAccount,
        delegate: POOL_AUTHORITY_PDA,
        amount,
    });

    status('Please sign the approve transaction...');

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    const signedTx = await wallet.signTransaction(tx);

    status('Sending approve transaction...');

    const signature = await connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
    });

    status('Confirming...');
    await connection.confirmTransaction(signature, 'confirmed');

    status(`Approved! Tx: ${signature.slice(0, 20)}...`);
    return signature;
}

/**
 * Get the pool authority PDA address
 */
export function getPoolAuthorityPda(): PublicKey {
    return POOL_AUTHORITY_PDA;
}
