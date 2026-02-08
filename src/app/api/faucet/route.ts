/**
 * Faucet API Route
 * 
 * Server-side endpoint that mints test tokens to any wallet.
 * Uses the deployer's private key (from env) as mint authority.
 * Creates IncoAccounts + mints with ECIES + allowance PDAs.
 * 
 * POST /api/faucet
 * Body: { wallet: string, tokenA?: string, tokenB?: string }
 * 
 * - If tokenA/tokenB are provided, mints to those existing accounts
 * - If not provided, creates new accounts first
 */

import { NextRequest, NextResponse } from 'next/server';
import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    SystemProgram,
    ComputeBudgetProgram,
} from '@solana/web3.js';
import { Program, AnchorProvider } from '@coral-xyz/anchor';

// Constants
const INCO_LIGHTNING_PROGRAM_ID = new PublicKey('5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj');
const INCO_TOKEN_PROGRAM_ID = new PublicKey('CYVSeUyVzHGVcrxsJt3E8tbaPCQT8ASdRR45g5WxUEW7');
const INCO_MINT_A = new PublicKey('4AJDgxnHDNP7y9wSD24sP7YUhQrMyprLUeuRwEwYu6cy');
const INCO_MINT_B = new PublicKey('CvymLX1Tm6btpRJdfGeQ34k726yQnXSn1V7G4fworMaG');
const INPUT_TYPE = 0;

const RPC_URL = process.env.HELIUS_DEVNET_API_KEY
    ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_DEVNET_API_KEY}`
    : 'https://api.devnet.solana.com';

function getDeployerKeypair(): Keypair {
    const key = process.env.DEPLOYER_PRIVATE_KEY;
    if (!key) {
        // Fallback: read from default solana keypair path
        const fs = require('fs');
        const path = require('path');
        const keyPath = process.env.ANCHOR_WALLET || 
            path.join(process.env.HOME || '/root', '.config/solana/id.json');
        const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
        return Keypair.fromSecretKey(Uint8Array.from(keyData));
    }
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key)));
}

function getAllowancePda(handle: bigint, allowedAddress: PublicKey): [PublicKey, number] {
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

function extractHandle(accountData: Buffer): bigint {
    const amountBytes = accountData.slice(72, 88);
    let handle = BigInt(0);
    for (let i = 15; i >= 0; i--) {
        handle = handle * BigInt(256) + BigInt(amountBytes[i]);
    }
    return handle;
}

async function encryptAmount(amount: bigint): Promise<Buffer> {
    // Dynamic import to avoid SSR issues
    const { encryptValue } = await import('@inco/solana-sdk/encryption');
    const { hexToBuffer } = await import('@inco/solana-sdk/utils');
    const hex = await encryptValue(amount);
    return hexToBuffer(hex);
}

// Simple rate limiting: 1 request per wallet per 60s
const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 60_000;

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { wallet: walletStr } = body;

        if (!walletStr) {
            return NextResponse.json({ error: 'wallet is required' }, { status: 400 });
        }

        // Rate limit check
        const now = Date.now();
        const lastCall = rateLimitMap.get(walletStr) || 0;
        if (now - lastCall < RATE_LIMIT_MS) {
            return NextResponse.json({ error: 'Rate limited. Try again in 60s.' }, { status: 429 });
        }
        rateLimitMap.set(walletStr, now);

        const userWallet = new PublicKey(walletStr);
        const deployer = getDeployerKeypair();
        const connection = new Connection(RPC_URL, 'confirmed');

        // Create Anchor provider with deployer wallet (manual wallet object)
        const anchorWallet = {
            publicKey: deployer.publicKey,
            signTransaction: async <T extends Transaction>(tx: T): Promise<T> => { tx.sign(deployer); return tx; },
            signAllTransactions: async <T extends Transaction>(txs: T[]): Promise<T[]> => { txs.forEach(tx => tx.sign(deployer)); return txs; },
        };
        const provider = new AnchorProvider(connection, anchorWallet as any, { commitment: 'confirmed' });

        // Load IDL
        const fs = require('fs');
        const path = require('path');
        const idlPath = path.join(process.cwd(), 'public/idl/inco_token.json');
        const incoTokenIdl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));
        const program = new Program(incoTokenIdl, provider);

        const computeIxs = [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
        ];

        const results: { tokenA?: string; tokenB?: string; mintedA?: boolean; mintedB?: boolean } = {};

        // Find existing accounts
        const accounts = await connection.getProgramAccounts(INCO_TOKEN_PROGRAM_ID, {
            filters: [{ dataSize: 221 }],
        });

        let tokenAPubkey: PublicKey | null = null;
        let tokenBPubkey: PublicKey | null = null;
        let createdA = false;
        let createdB = false;

        for (const { pubkey, account } of accounts) {
            const owner = new PublicKey(account.data.slice(40, 72));
            if (!owner.equals(userWallet)) continue;
            const mint = new PublicKey(account.data.slice(8, 40));
            if (mint.equals(INCO_MINT_A)) tokenAPubkey = pubkey;
            if (mint.equals(INCO_MINT_B)) tokenBPubkey = pubkey;
        }

        // Create accounts if needed
        if (!tokenAPubkey) {
            const kp = Keypair.generate();
            const ix = await program.methods
                .initializeAccount()
                .accounts({
                    account: kp.publicKey,
                    mint: INCO_MINT_A,
                    owner: userWallet,
                    payer: deployer.publicKey,
                })
                .instruction();
            const tx = new Transaction();
            computeIxs.forEach(i => tx.add(i));
            tx.add(ix);
            const { blockhash } = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.feePayer = deployer.publicKey;
            tx.sign(deployer, kp);
            const sig = await connection.sendRawTransaction(tx.serialize());
            await connection.confirmTransaction(sig, 'confirmed');
            tokenAPubkey = kp.publicKey;
            createdA = true;
            console.log('[faucet] Created Token A account:', tokenAPubkey.toBase58());
        }

        if (!tokenBPubkey) {
            const kp = Keypair.generate();
            const ix = await program.methods
                .initializeAccount()
                .accounts({
                    account: kp.publicKey,
                    mint: INCO_MINT_B,
                    owner: userWallet,
                    payer: deployer.publicKey,
                })
                .instruction();
            const tx = new Transaction();
            computeIxs.forEach(i => tx.add(i));
            tx.add(ix);
            const { blockhash } = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.feePayer = deployer.publicKey;
            tx.sign(deployer, kp);
            const sig = await connection.sendRawTransaction(tx.serialize());
            await connection.confirmTransaction(sig, 'confirmed');
            tokenBPubkey = kp.publicKey;
            createdB = true;
            console.log('[faucet] Created Token B account:', tokenBPubkey.toBase58());
        }

        results.tokenA = tokenAPubkey.toBase58();
        results.tokenB = tokenBPubkey.toBase58();

        // Check if accounts need minting
        // If handle is non-zero but has no allowance PDA → corrupted from raw-bytes ops → create new account
        async function needsMint(acctPubkey: PublicKey): Promise<boolean> {
            const data = await connection.getAccountInfo(acctPubkey, 'confirmed');
            if (!data) return true;
            const handle = extractHandle(data.data as Buffer);
            if (handle === BigInt(0)) return true;
            // Check if allowance PDA exists — if not, handle is corrupted
            const [pda] = getAllowancePda(handle, userWallet);
            const pdaInfo = await connection.getAccountInfo(pda);
            return pdaInfo === null; // needs mint if no PDA
        }

        async function replaceCorruptedAccount(mint: PublicKey, currentPubkey: PublicKey): Promise<PublicKey> {
            // Check if current account is corrupted (has balance but no allowance PDA)
            const data = await connection.getAccountInfo(currentPubkey, 'confirmed');
            if (!data) return currentPubkey;
            const handle = extractHandle(data.data as Buffer);
            if (handle === BigInt(0)) return currentPubkey; // zero balance, just needs mint
            const [pda] = getAllowancePda(handle, userWallet);
            const pdaInfo = await connection.getAccountInfo(pda);
            if (pdaInfo !== null) return currentPubkey; // has PDA, account is fine
            
            // Corrupted — create a new account (manual tx to handle multiple signers)
            console.log('[faucet] Detected corrupted account, creating replacement:', currentPubkey.toBase58());
            const kp = Keypair.generate();
            const ix = await program.methods
                .initializeAccount()
                .accounts({
                    account: kp.publicKey,
                    mint,
                    owner: userWallet,
                    payer: deployer.publicKey,
                })
                .instruction();
            const tx = new Transaction();
            computeIxs.forEach(i => tx.add(i));
            tx.add(ix);
            const { blockhash } = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.feePayer = deployer.publicKey;
            tx.sign(deployer, kp);
            const sig = await connection.sendRawTransaction(tx.serialize());
            await connection.confirmTransaction(sig, 'confirmed');
            console.log('[faucet] Replacement account:', kp.publicKey.toBase58());
            return kp.publicKey;
        }

        // Replace corrupted accounts if needed (skip for freshly created accounts —
        // initializeAccount creates an FHE-encrypted zero which has a non-zero handle, that's normal)
        if (!createdA) {
            tokenAPubkey = await replaceCorruptedAccount(INCO_MINT_A, tokenAPubkey);
        }
        if (!createdB) {
            tokenBPubkey = await replaceCorruptedAccount(INCO_MINT_B, tokenBPubkey);
        }
        results.tokenA = tokenAPubkey.toBase58();
        results.tokenB = tokenBPubkey.toBase58();

        // Mint Token A (10 wSOL = 10e9) if needs minting
        if (await needsMint(tokenAPubkey)) {
            try {
                const amount = BigInt(10_000_000_000); // 10 tokens (9 decimals)
                const ciphertext = await encryptAmount(amount);

                // Step 1: Simulate to get new handle
                const simIx = await program.methods
                    .mintTo(Buffer.from(ciphertext), INPUT_TYPE)
                    .accounts({
                        mint: INCO_MINT_A,
                        account: tokenAPubkey,
                        mintAuthority: deployer.publicKey,
                        incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
                        systemProgram: SystemProgram.programId,
                    })
                    .instruction();

                const simTx = new Transaction();
                computeIxs.forEach(ix => simTx.add(ix));
                simTx.add(simIx);
                const { blockhash } = await connection.getLatestBlockhash();
                simTx.recentBlockhash = blockhash;
                simTx.feePayer = deployer.publicKey;
                simTx.sign(deployer);

                const simulation = await connection.simulateTransaction(simTx, undefined, [tokenAPubkey]);
                if (simulation.value.err) throw new Error(`Sim failed: ${JSON.stringify(simulation.value.err)}`);

                const simData = Buffer.from(simulation.value.accounts![0]!.data[0], 'base64');
                const newHandle = extractHandle(simData);

                // Step 2: Derive allowance PDA
                const [allowancePda] = getAllowancePda(newHandle, userWallet);

                // Step 3: Execute with allowance
                const tx = await program.methods
                    .mintTo(Buffer.from(ciphertext), INPUT_TYPE)
                    .accounts({
                        mint: INCO_MINT_A,
                        account: tokenAPubkey,
                        mintAuthority: deployer.publicKey,
                        incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
                        systemProgram: SystemProgram.programId,
                    })
                    .remainingAccounts([
                        { pubkey: allowancePda, isSigner: false, isWritable: true },
                        { pubkey: userWallet, isSigner: false, isWritable: false },
                    ])
                    .preInstructions(computeIxs)
                    .rpc();

                await connection.confirmTransaction(tx, 'confirmed');
                results.mintedA = true;
                console.log('[faucet] Minted Token A with allowance:', tx);
            } catch (e: any) {
                console.error('[faucet] Token A mint failed:', e.message);
            }
        }

        // Mint Token B (10000 USDC = 10000e6) if needs minting
        if (await needsMint(tokenBPubkey)) {
            try {
                const amount = BigInt(10_000_000_000); // 10000 tokens (6 decimals)
                const ciphertext = await encryptAmount(amount);

                const simIx = await program.methods
                    .mintTo(Buffer.from(ciphertext), INPUT_TYPE)
                    .accounts({
                        mint: INCO_MINT_B,
                        account: tokenBPubkey,
                        mintAuthority: deployer.publicKey,
                        incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
                        systemProgram: SystemProgram.programId,
                    })
                    .instruction();

                const simTx = new Transaction();
                computeIxs.forEach(ix => simTx.add(ix));
                simTx.add(simIx);
                const { blockhash } = await connection.getLatestBlockhash();
                simTx.recentBlockhash = blockhash;
                simTx.feePayer = deployer.publicKey;
                simTx.sign(deployer);

                const simulation = await connection.simulateTransaction(simTx, undefined, [tokenBPubkey]);
                if (simulation.value.err) throw new Error(`Sim failed: ${JSON.stringify(simulation.value.err)}`);

                const simData = Buffer.from(simulation.value.accounts![0]!.data[0], 'base64');
                const newHandle = extractHandle(simData);

                const [allowancePda] = getAllowancePda(newHandle, userWallet);

                const tx = await program.methods
                    .mintTo(Buffer.from(ciphertext), INPUT_TYPE)
                    .accounts({
                        mint: INCO_MINT_B,
                        account: tokenBPubkey,
                        mintAuthority: deployer.publicKey,
                        incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
                        systemProgram: SystemProgram.programId,
                    })
                    .remainingAccounts([
                        { pubkey: allowancePda, isSigner: false, isWritable: true },
                        { pubkey: userWallet, isSigner: false, isWritable: false },
                    ])
                    .preInstructions(computeIxs)
                    .rpc();

                await connection.confirmTransaction(tx, 'confirmed');
                results.mintedB = true;
                console.log('[faucet] Minted Token B with allowance:', tx);
            } catch (e: any) {
                console.error('[faucet] Token B mint failed:', e.message);
            }
        }

        return NextResponse.json({
            success: true,
            ...results,
        });
    } catch (e: any) {
        console.error('[faucet] Error:', e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
