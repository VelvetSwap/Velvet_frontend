import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';

export const PRIVATE_SWAP_PROGRAM_ID = new PublicKey('4b8jCufu7b4WKXdxFRQHWSks4QdskW62qF7tApSNXuZD');
export const INCO_TOKEN_PROGRAM_ID = new PublicKey('HmBw1FN2fXbgqyGpjB268vggBEEymNx98cuPpZQPYDZc');
export const INCO_LIGHTNING_PROGRAM_ID = new PublicKey('5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj');
export const PERMISSION_PROGRAM_ID = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
export const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
export const DEFAULT_VALIDATOR = new PublicKey('FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA');
export const DEVNET_USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

export const INPUT_TYPE = 0;
export const CONFIDENTIAL_DECIMALS = 9;
export const DEFAULT_POOL_FEE_BPS = 30;

export const POOL_SEED = Buffer.from('pool');
export const POOL_AUTH_SEED = Buffer.from('pool_authority');

// Light Protocol devnet accounts
export const LIGHT_STATE_MERKLE_TREE = new PublicKey('smt1NamzXdq4AMqS2fS2F1i5KTYPZRhoHgWx38d8WsT');
export const LIGHT_NULLIFIER_QUEUE = new PublicKey('nfq1NvQDJ2GEgnS8zt9prAe8rjjpAW1zFkrvZoBR148');
export const LIGHT_ADDRESS_MERKLE_TREE = new PublicKey('amt1Ayt45jfbdw5YSo7iz6WZxUmnZsQTYXy82hVwyC2');
export const LIGHT_ADDRESS_QUEUE = new PublicKey('aq1S9z4reTSQAdgWHGD2zDaS39sjGrAxbR31vxJ2F4F');

// Light Protocol RPC endpoint (for indexer queries)
export const LIGHT_RPC_ENDPOINT = 'https://devnet.helius-rpc.com';

// MagicBlock PER SPL API
export const PER_SPL_API_BASE = 'https://privacy.magicblock.app';
export const PER_SPL_PROGRAM_ID = new PublicKey('SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2');

// TEE Validator for Private Ephemeral Rollup
export const TEE_VALIDATOR = new PublicKey('FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA');
export const TEE_RPC_URL = 'https://tee.magicblock.app';

// Devnet token mints for testing
export const DEVNET_WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const DEVNET_TEST_USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
