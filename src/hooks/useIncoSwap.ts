/**
 * useIncoSwap Hook
 * 
 * React hook for the full swap flow:
 * 1. User connects wallet
 * 2. Check/create IncoAccounts automatically
 * 3. Execute swap with encrypted amounts
 */

import { useState, useCallback } from 'react';
import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import {
    prepareSwap,
    ensureUserIncoAccounts,
    INCO_MINT_A,
    INCO_MINT_B,
    POOL_VAULT_A,
    POOL_VAULT_B,
    type UserIncoAccounts,
} from '@/lib/inco-account-manager';
import {
    swapExactIn,
    encryptAmount,
    computeSwapQuote,
    DEVNET_INCO_MINT_A,
    DEVNET_INCO_MINT_B,
    DEVNET_POOL_VAULT_A,
    DEVNET_POOL_VAULT_B,
} from '@/lib/swap-client';

export interface SwapState {
    status: 'idle' | 'preparing' | 'confirming' | 'signing' | 'sending' | 'success' | 'error';
    message: string;
    txSignature?: string;
    error?: string;
}

export interface UseIncoSwapResult {
    swapState: SwapState;
    userAccounts: UserIncoAccounts | null;
    isReady: boolean;
    prepareAccounts: () => Promise<void>;
    executeSwap: (amountIn: bigint, aToB: boolean) => Promise<string | null>;
    reset: () => void;
}

export function useIncoSwap(): UseIncoSwapResult {
    const { connection } = useConnection();
    const wallet = useWallet();
    
    const [swapState, setSwapState] = useState<SwapState>({
        status: 'idle',
        message: '',
    });
    const [userAccounts, setUserAccounts] = useState<UserIncoAccounts | null>(null);

    const updateStatus = useCallback((status: SwapState['status'], message: string) => {
        setSwapState(prev => ({ ...prev, status, message }));
    }, []);

    /**
     * Prepare user accounts - call this when wallet connects or before first swap
     */
    const prepareAccounts = useCallback(async () => {
        if (!wallet.publicKey || !wallet.signTransaction) {
            updateStatus('error', 'Wallet not connected');
            return;
        }

        try {
            updateStatus('preparing', 'Checking Inco accounts...');

            const { tokenA, tokenB, created } = await ensureUserIncoAccounts(
                connection,
                {
                    publicKey: wallet.publicKey,
                    signTransaction: wallet.signTransaction,
                },
                (msg) => updateStatus('preparing', msg)
            );

            setUserAccounts({ tokenA, tokenB });

            if (created) {
                updateStatus('idle', 'Inco accounts created successfully');
            } else {
                updateStatus('idle', 'Inco accounts ready');
            }
        } catch (error: any) {
            console.error('Failed to prepare accounts:', error);
            updateStatus('error', `Failed to prepare accounts: ${error.message}`);
        }
    }, [connection, wallet, updateStatus]);

    /**
     * Execute a swap
     * @param amountIn - Amount to swap (in base units)
     * @param aToB - true = swap token A for B, false = swap B for A
     */
    const executeSwap = useCallback(async (
        amountIn: bigint,
        aToB: boolean
    ): Promise<string | null> => {
        if (!wallet.publicKey || !wallet.signTransaction) {
            updateStatus('error', 'Wallet not connected');
            return null;
        }

        // Ensure accounts exist
        let accounts = userAccounts;
        if (!accounts?.tokenA || !accounts?.tokenB) {
            updateStatus('preparing', 'Setting up Inco accounts...');
            
            try {
                const { tokenA, tokenB } = await ensureUserIncoAccounts(
                    connection,
                    {
                        publicKey: wallet.publicKey,
                        signTransaction: wallet.signTransaction,
                    },
                    (msg) => updateStatus('preparing', msg)
                );
                accounts = { tokenA, tokenB };
                setUserAccounts(accounts);
            } catch (error: any) {
                updateStatus('error', `Account setup failed: ${error.message}`);
                return null;
            }
        }

        try {
            updateStatus('confirming', 'Computing swap quote...');

            // Compute swap amounts (using estimated reserves for now)
            // In production, you'd fetch actual encrypted reserves and use attested decryption
            const estimatedReserveA = 1000000000000n; // 1000 wSOL
            const estimatedReserveB = 100000000000n;  // 100000 USDC
            
            const reserveIn = aToB ? estimatedReserveA : estimatedReserveB;
            const reserveOut = aToB ? estimatedReserveB : estimatedReserveA;
            
            const { amountOut, feeAmount } = computeSwapQuote(amountIn, reserveIn, reserveOut);

            console.log('Swap quote:', {
                amountIn: amountIn.toString(),
                amountOut: amountOut.toString(),
                feeAmount: feeAmount.toString(),
            });

            // Encrypt amounts for on-chain processing
            const amountInCiphertext = await encryptAmount(amountIn);
            const amountOutCiphertext = await encryptAmount(amountOut);
            const feeAmountCiphertext = await encryptAmount(feeAmount);

            updateStatus('confirming', 'Building transaction...');

            // Build swap transaction
            const tx = await swapExactIn({
                connection,
                wallet: {
                    publicKey: wallet.publicKey,
                    signTransaction: wallet.signTransaction,
                },
                mintA: DEVNET_INCO_MINT_A,
                mintB: DEVNET_INCO_MINT_B,
                amountInCiphertext,
                amountOutCiphertext,
                feeAmountCiphertext,
                aToB,
                userTokenA: accounts.tokenA!,
                userTokenB: accounts.tokenB!,
                poolVaultA: DEVNET_POOL_VAULT_A,
                poolVaultB: DEVNET_POOL_VAULT_B,
            });

            updateStatus('signing', 'Please sign the transaction...');

            // Get recent blockhash for legacy transactions only
            if (tx instanceof Transaction) {
                const { blockhash } = await connection.getLatestBlockhash();
                tx.recentBlockhash = blockhash;
                tx.feePayer = wallet.publicKey;
            }

            const signedTx = await wallet.signTransaction(tx as Transaction | VersionedTransaction);

            updateStatus('sending', 'Sending transaction...');

            // Send transaction
            const signature = await connection.sendRawTransaction(signedTx.serialize(), {
                skipPreflight: false,
            });

            console.log('Transaction sent:', signature);

            // Wait for confirmation
            updateStatus('sending', 'Confirming transaction...');
            await connection.confirmTransaction(signature, 'confirmed');

            setSwapState({
                status: 'success',
                message: 'Swap completed successfully!',
                txSignature: signature,
            });

            return signature;
        } catch (error: any) {
            console.error('Swap failed:', error);
            setSwapState({
                status: 'error',
                message: 'Swap failed',
                error: error.message,
            });
            return null;
        }
    }, [connection, wallet, userAccounts, updateStatus]);

    const reset = useCallback(() => {
        setSwapState({ status: 'idle', message: '' });
    }, []);

    return {
        swapState,
        userAccounts,
        isReady: !!(userAccounts?.tokenA && userAccounts?.tokenB),
        prepareAccounts,
        executeSwap,
        reset,
    };
}
