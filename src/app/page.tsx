'use client';

import React, { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useWallet } from '@solana/wallet-adapter-react';
import { Shield, ArrowDownUp, Lock, ExternalLink, CheckCircle, AlertCircle, Loader2, EyeOff, Zap, Eye } from 'lucide-react';
import { useConnection } from '@solana/wallet-adapter-react';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
// Range Protocol compliance is handled in range-compliance.ts
import { 
    DEVNET_WSOL_MINT,
    DEVNET_TEST_USDC_MINT,
} from '@/lib/solana/constants';
import {
    swapExactIn,
    encryptAmount,
    computeSwapQuote,
    fetchPoolState,
    DEVNET_INCO_MINT_A,
    DEVNET_INCO_MINT_B,
    DEVNET_POOL_VAULT_A,
    DEVNET_POOL_VAULT_B,
} from '@/lib/swap-client';
import {
    ensureUserIncoAccounts,
} from '@/lib/inco-account-manager';
import {
    checkAddressCompliance,
    formatComplianceStatus,
    ComplianceResult,
} from '@/lib/range-compliance';

const WalletMultiButton = dynamic(
    () => import('@solana/wallet-adapter-react-ui').then(mod => mod.WalletMultiButton),
    { ssr: false, loading: () => <div className="h-10 w-32 bg-secondary rounded-lg animate-pulse" /> }
);

type SwapStep = 'idle' | 'authenticating' | 'swapping' | 'complete' | 'error';

interface TokenInfo {
    symbol: string;
    mint: PublicKey;
    decimals: number;
    icon: string;
}

const TOKENS: TokenInfo[] = [
    { symbol: 'SOL', mint: DEVNET_WSOL_MINT, decimals: 9, icon: '◎' },
    { symbol: 'USDC', mint: DEVNET_TEST_USDC_MINT, decimals: 6, icon: '$' },
];

export default function Home() {
    return (
        <main className="min-h-screen flex flex-col items-center justify-center p-4 relative overflow-hidden">
            {/* Header */}
            <header className="absolute top-0 w-full p-6 flex justify-between items-center z-10">
                <div className="flex items-center gap-3">
                    <div className="relative">
                        <Shield className="w-9 h-9 text-primary" />
                        <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full animate-pulse" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">
                            Velvet<span className="text-primary">Swap</span>
                        </h1>
                        <p className="text-xs text-muted-foreground -mt-0.5">Confidential AMM</p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <div className="hidden sm:flex items-center gap-1 px-3 py-1.5 privacy-badge rounded-full text-xs text-primary">
                        <Zap className="w-3 h-3" />
                        <span>Devnet</span>
                    </div>
                    <WalletMultiButton />
                </div>
            </header>

            {/* Main Card */}
            <div className="relative z-10 w-full max-w-md mt-16">
                <div className="glass rounded-3xl p-1.5 velvet-glow">
                    <PrivateSwapInterface />
                </div>

                {/* Status Footer */}
                <div className="mt-8 flex items-center justify-center gap-4 flex-wrap">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <div className="w-6 h-6 rounded-lg bg-green-500/10 flex items-center justify-center">
                            <Shield className="w-3 h-3 text-green-500" />
                        </div>
                        <span>Inco FHE</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <div className="w-6 h-6 rounded-lg bg-purple-500/10 flex items-center justify-center">
                            <Lock className="w-3 h-3 text-purple-500" />
                        </div>
                        <span>Light ZK</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <div className="w-6 h-6 rounded-lg bg-blue-500/10 flex items-center justify-center">
                            <CheckCircle className="w-3 h-3 text-blue-500" />
                        </div>
                        <span>Range Compliance</span>
                    </div>
                </div>
            </div>
        </main>
    );
}

function PrivateSwapInterface() {
    const { publicKey, connected, signTransaction, signMessage } = useWallet();
    const { connection } = useConnection();

    const [fromToken, setFromToken] = useState<TokenInfo>(TOKENS[0]);
    const [toToken, setToToken] = useState<TokenInfo>(TOKENS[1]);
    const [amount, setAmount] = useState('');
    const [estimatedOutput, setEstimatedOutput] = useState<string | null>(null);
    
    const [step, setStep] = useState<SwapStep>('idle');
    const [statusMessage, setStatusMessage] = useState<string | null>(null);
    const [txSignature, setTxSignature] = useState<string | null>(null);
    const [privacyMode, setPrivacyMode] = useState(true);
    const [poolStatus, setPoolStatus] = useState<'checking' | 'ready' | 'not_found'>('checking');
    const [demoMode, setDemoMode] = useState(true); // Demo mode for hackathon presentation
    const [complianceResult, setComplianceResult] = useState<ComplianceResult | null>(null);
    const [complianceChecking, setComplianceChecking] = useState(false);
    const [balances, setBalances] = useState<{ tokenA: string | null; tokenB: string | null }>({ tokenA: null, tokenB: null });
    const [balanceLoading, setBalanceLoading] = useState(false);
    const [userAccounts, setUserAccounts] = useState<{ tokenA: PublicKey | null; tokenB: PublicKey | null }>({ tokenA: null, tokenB: null });

    // Check pool status on mount
    useEffect(() => {
        const checkPool = async () => {
            try {
                const pool = await fetchPoolState(DEVNET_WSOL_MINT, DEVNET_TEST_USDC_MINT);
                setPoolStatus(pool ? 'ready' : 'not_found');
            } catch (e) {
                console.warn('Pool check failed, assuming ready:', e);
                setPoolStatus('ready');
            }
        };
        checkPool();
    }, []);

    // Check compliance when wallet connects
    useEffect(() => {
        const checkCompliance = async () => {
            if (!publicKey) {
                setComplianceResult(null);
                return;
            }
            setComplianceChecking(true);
            try {
                const result = await checkAddressCompliance(publicKey.toBase58());
                setComplianceResult(result);
            } catch (e) {
                console.warn('Compliance check failed:', e);
            } finally {
                setComplianceChecking(false);
            }
        };
        checkCompliance();
    }, [publicKey]);

    // Fetch Inco token balances - check if accounts exist
    useEffect(() => {
        const fetchBalances = async () => {
            if (!publicKey || !connection) {
                setBalances({ tokenA: null, tokenB: null });
                setUserAccounts({ tokenA: null, tokenB: null });
                return;
            }
            
            // If we already have accounts from swap, just verify they exist
            if (userAccounts.tokenA && userAccounts.tokenB) {
                setBalances({ tokenA: '✓ Active', tokenB: '✓ Active' });
                return;
            }
            
            setBalanceLoading(true);
            try {
                const { findUserIncoAccounts } = await import('@/lib/inco-account-manager');
                console.log('Fetching balances for:', publicKey.toBase58());
                const accounts = await findUserIncoAccounts(connection, publicKey);
                console.log('Found accounts:', accounts);
                
                setUserAccounts(accounts);
                const balA = accounts.tokenA ? '✓ Active' : 'No account';
                const balB = accounts.tokenB ? '✓ Active' : 'No account';
                setBalances({ tokenA: balA, tokenB: balB });
            } catch (e) {
                console.warn('Failed to fetch balances:', e);
                setBalances({ tokenA: 'Error', tokenB: 'Error' });
            } finally {
                setBalanceLoading(false);
            }
        };
        fetchBalances();
    }, [publicKey, connection]);


    // Swap tokens
    const handleSwapTokens = () => {
        const temp = fromToken;
        setFromToken(toToken);
        setToToken(temp);
        setEstimatedOutput(null);
    };

    // Calculate estimated output
    useEffect(() => {
        if (!amount || parseFloat(amount) <= 0) {
            setEstimatedOutput(null);
            return;
        }

        const inputAmount = parseFloat(amount);
        const feeRate = 0.003;
        const rate = fromToken.symbol === 'SOL' ? 150 : 1/150;
        const outputAmount = inputAmount * rate * (1 - feeRate);
        setEstimatedOutput(outputAmount.toFixed(toToken.decimals > 6 ? 6 : toToken.decimals));
    }, [amount, fromToken, toToken]);

    // Toggle privacy mode
    const togglePrivacy = () => setPrivacyMode(!privacyMode);

    // Sign and send transaction
    const signAndSend = async (tx: Transaction, conn: Connection = connection): Promise<string> => {
        if (!signTransaction || !publicKey) throw new Error('Wallet not connected');

        tx.feePayer = publicKey;
        const { blockhash } = await conn.getLatestBlockhash();
        tx.recentBlockhash = blockhash;

        const signed = await signTransaction(tx);
        const signature = await conn.sendRawTransaction(signed.serialize());
        await conn.confirmTransaction(signature, 'confirmed');
        return signature;
    };

    // Private swap flow with Inco Token transfers
    const handlePrivateSwap = async () => {
        if (!publicKey || !signMessage || !signTransaction) {
            setStatusMessage('Please connect your wallet');
            return;
        }

        if (!amount || parseFloat(amount) <= 0) {
            setStatusMessage('Please enter a valid amount');
            return;
        }

        const inputAmount = Math.floor(parseFloat(amount) * Math.pow(10, fromToken.decimals));

        try {
            // Step 0: Check compliance with Range Protocol
            setStep('authenticating');
            setStatusMessage('Checking compliance with Range Protocol...');
            
            if (!complianceResult) {
                const result = await checkAddressCompliance(publicKey.toBase58());
                setComplianceResult(result);
                if (!result.isCompliant) {
                    throw new Error(`Compliance check failed: ${result.reasoning}`);
                }
            } else if (!complianceResult.isCompliant) {
                throw new Error(`Compliance check failed: ${complianceResult.reasoning}`);
            }

            // Step 1: Ensure user has Inco Token accounts
            setStatusMessage('Setting up confidential token accounts...');
            
            const { tokenA: userTokenA, tokenB: userTokenB, created } = await ensureUserIncoAccounts(
                connection,
                { publicKey, signTransaction },
                (msg) => setStatusMessage(msg)
            );

            // Store account addresses for balance display
            setUserAccounts({ tokenA: userTokenA, tokenB: userTokenB });
            setBalances({ tokenA: '✓ Active', tokenB: '✓ Active' });

            if (created) {
                setStatusMessage('Token accounts created! Preparing swap...');
            }

            // Step 2: Compute swap quote
            setStatusMessage('Computing confidential swap quote...');
            
            const { amountOut, feeAmount } = computeSwapQuote(
                BigInt(inputAmount),
                BigInt(1_000_000_000_000), // Reserve A - in production fetch from pool
                BigInt(100_000_000_000),   // Reserve B
                30n // 0.3% fee
            );
            
            // Format amounts for on-chain encryption via Inco Lightning
            const amountInCiphertext = encryptAmount(BigInt(inputAmount));
            const amountOutCiphertext = encryptAmount(amountOut);
            const feeAmountCiphertext = encryptAmount(feeAmount);

            // Step 3: Execute swap with Inco Token transfers
            setStep('swapping');
            setStatusMessage('Executing confidential swap with token transfers...');

            const swapTx = await swapExactIn({
                connection,
                wallet: { publicKey, signTransaction },
                mintA: DEVNET_INCO_MINT_A,
                mintB: DEVNET_INCO_MINT_B,
                amountInCiphertext,
                amountOutCiphertext,
                feeAmountCiphertext,
                aToB: fromToken.symbol === 'SOL',
                userTokenA,
                userTokenB,
                poolVaultA: DEVNET_POOL_VAULT_A,
                poolVaultB: DEVNET_POOL_VAULT_B,
            });
            
            const sig = await signAndSend(swapTx, connection);
            setTxSignature(sig);

            setStep('complete');
            setStatusMessage('Private swap completed! Tokens transferred.');
        } catch (e: any) {
            console.error('Private swap failed:', e);
            setStep('error');
            setStatusMessage(`Swap failed: ${e?.message || 'Unknown error'}`);
        }
    };

    // Reset
    const handleReset = () => {
        setStep('idle');
        setStatusMessage(null);
        setTxSignature(null);
        setAmount('');
        setEstimatedOutput(null);
    };

    const isProcessing = !['idle', 'complete', 'error'].includes(step);
    const canSwap = connected && amount && parseFloat(amount) > 0 && !isProcessing;

    return (
        <div className="bg-card rounded-[22px] p-6 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between mb-2">
                <h2 className="text-lg font-semibold">Private Swap</h2>
                <button
                    onClick={togglePrivacy}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all hover:scale-105 privacy-badge"
                >
                    {privacyMode ? (
                        <>
                            <EyeOff className="w-3.5 h-3.5 text-primary" />
                            <span className="text-primary">Hidden</span>
                        </>
                    ) : (
                        <>
                            <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                            <span className="text-muted-foreground">Visible</span>
                        </>
                    )}
                </button>
            </div>

            {/* From Token */}
            <div className="token-input overflow-hidden">
                <div className="flex items-center justify-between text-sm text-muted-foreground mb-3">
                    <span>You Pay</span>
                    <span className="text-xs">
                        {balanceLoading ? '...' : (fromToken.symbol === 'SOL' ? (balances.tokenA || '--') : (balances.tokenB || '--'))}
                    </span>
                </div>
                <div className="flex items-center gap-3">
                    <input
                        type="number"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="0.0"
                        className="flex-1 min-w-0 bg-transparent text-3xl font-semibold outline-none placeholder:text-muted-foreground/30"
                        disabled={isProcessing}
                    />
                    <button className="flex-shrink-0 flex items-center gap-2 bg-secondary hover:bg-secondary/80 px-4 py-2.5 rounded-xl font-medium transition-colors">
                        <span className="text-lg">{fromToken.icon}</span>
                        <span>{fromToken.symbol}</span>
                    </button>
                </div>
            </div>

            {/* Swap Arrow */}
            <div className="flex justify-center -my-1 relative z-10">
                <button
                    onClick={handleSwapTokens}
                    className="swap-arrow"
                    disabled={isProcessing}
                >
                    <ArrowDownUp className="w-4 h-4" />
                </button>
            </div>

            {/* To Token */}
            <div className="token-input overflow-hidden">
                <div className="flex items-center justify-between text-sm text-muted-foreground mb-3">
                    <span>You Receive</span>
                    <span className="text-xs">
                        {balanceLoading ? '...' : (toToken.symbol === 'SOL' ? (balances.tokenA || '--') : (balances.tokenB || '--'))}
                    </span>
                </div>
                <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0 text-3xl font-semibold">
                        {estimatedOutput ? (
                            <span className="flex items-center gap-2">
                                <span className="text-emerald-400">~{estimatedOutput}</span>
                                {privacyMode && <EyeOff className="w-4 h-4 text-muted-foreground" />}
                            </span>
                        ) : (
                            <span className="text-muted-foreground/30">0.0</span>
                        )}
                    </div>
                    <button className="flex-shrink-0 flex items-center gap-2 bg-secondary hover:bg-secondary/80 px-4 py-2.5 rounded-xl font-medium transition-colors">
                        <span className="text-lg">{toToken.icon}</span>
                        <span>{toToken.symbol}</span>
                    </button>
                </div>
            </div>

            {/* Compact Status Row */}
            <div className="flex items-center justify-between text-xs px-1">
                <div className="flex items-center gap-1.5">
                    {poolStatus === 'checking' ? (
                        <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                    ) : poolStatus === 'ready' ? (
                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    ) : (
                        <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    )}
                    <span className="text-muted-foreground">
                        {poolStatus === 'ready' ? 'Pool active' : poolStatus === 'checking' ? 'Checking...' : 'Initializing'}
                    </span>
                </div>
                {connected && (
                    <div className="flex items-center gap-1.5">
                        {complianceChecking ? (
                            <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                        ) : complianceResult?.isCompliant ? (
                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        ) : complianceResult ? (
                            <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
                        ) : (
                            <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
                        )}
                        <span className="text-muted-foreground">
                            {complianceChecking ? 'Checking...' : 
                             complianceResult?.isCompliant ? `Compliant` : 
                             complianceResult ? 'Blocked' : 'No API key'}
                        </span>
                    </div>
                )}
            </div>

            {/* Status Message */}
            {statusMessage && (
                <div className={`rounded-xl p-4 text-sm ${
                    step === 'error' ? 'status-error' : 
                    step === 'complete' ? 'status-success' : 
                    'bg-secondary/50'
                }`}>
                    <div className="flex items-center gap-3">
                        {isProcessing && <Loader2 className="w-5 h-5 animate-spin text-primary" />}
                        {step === 'complete' && <CheckCircle className="w-5 h-5 text-green-500" />}
                        {step === 'error' && <AlertCircle className="w-5 h-5 text-red-500" />}
                        <span className="flex-1 font-medium">{statusMessage}</span>
                        {(step === 'complete' || step === 'error') && (
                            <button 
                                onClick={handleReset} 
                                className="text-xs px-2 py-1 rounded-md bg-white/10 hover:bg-white/20 transition-colors"
                            >
                                Reset
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Swap Button */}
            <button
                onClick={handlePrivateSwap}
                disabled={!canSwap}
                className={`w-full py-4 rounded-xl font-semibold text-base transition-all duration-300 ${
                    canSwap
                        ? 'bg-primary text-primary-foreground hover:bg-primary/90 btn-glow'
                        : 'bg-secondary text-muted-foreground cursor-not-allowed'
                }`}
            >
                {!connected ? (
                    <span className="flex items-center justify-center gap-2">
                        Connect Wallet
                    </span>
                ) : isProcessing ? (
                    <span className="flex items-center justify-center gap-2">
                        <Loader2 className="w-5 h-5 animate-spin" />
                        {step === 'authenticating' && 'Checking compliance...'}
                        {step === 'swapping' && 'Executing Private Swap...'}
                    </span>
                ) : (
                    <span className="flex items-center justify-center gap-2">
                        <Lock className="w-5 h-5" />
                        Execute Private Swap
                    </span>
                )}
            </button>

            {/* Transaction Link */}
            {txSignature && (
                <a
                    href={`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 text-sm text-primary hover:text-primary/80 transition-colors py-2"
                >
                    <ExternalLink className="w-4 h-4" />
                    <span>View on Solana Explorer</span>
                </a>
            )}
        </div>
    );
}
