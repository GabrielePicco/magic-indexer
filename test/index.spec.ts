import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testables } from '../src/index';

describe('RPC fallbacks', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('falls back to direct getTransaction when proxy parsed transaction fetch fails', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify({
				error: { code: -32601, message: 'Method not found' }
			}), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({
				result: {
					transaction: {
						message: {
							accountKeys: [{ pubkey: 'payer' }],
							instructions: [{ programId: 'Program111', accounts: ['payer'], data: 'abcd' }]
						}
					},
					meta: { innerInstructions: [] }
				}
			}), { status: 200 }));

		const result = await __testables.fetchParsedTransaction(
			'https://rpc.example',
			'https://rpcx.example',
			'signature'
		);

		expect(result.transaction.message.instructions[0].programId).toBe('Program111');
		expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://rpcx.example', expect.objectContaining({
			method: 'POST',
			headers: expect.objectContaining({
				'Rpc': 'https://rpc.example'
			})
		}));
		expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://rpc.example', expect.objectContaining({
			method: 'POST'
		}));
	});

	it('falls back to getMultipleAccounts and normalizes parsed accounts', async () => {
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify({
				error: { code: -32000, message: 'proxy failed' }
			}), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({
				result: {
					value: [{
						lamports: 123,
						owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
						space: 165,
						data: {
							parsed: {
								type: 'account',
								info: {
									mint: 'Mint111',
									owner: 'Owner111'
								}
							}
						}
					}, {
						lamports: 1,
						owner: '11111111111111111111111111111111',
						space: 0,
						data: ['', 'base64']
					}]
				}
			}), { status: 200 }));

		const result = await __testables.fetchParsedAccounts(
			'https://rpc.example',
			'https://rpcx.example',
			['Parsed111', 'Raw111']
		);

		expect(result.value).toEqual([{
			key: 'Parsed111',
			data: {
				mint: 'Mint111',
				owner: 'Owner111'
			},
			name: 'account',
			space: 165,
			lamports: 123,
			owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
			parsed: true
		}, null]);
	});

	it('extracts token balance changes from transaction metadata', () => {
		const result = __testables.extractTokenBalanceChanges({
			meta: {
				preTokenBalances: [{
					accountIndex: 1,
					mint: 'Mint111',
					owner: 'Owner111',
					programId: 'Token111',
					uiTokenAmount: {
						amount: '1500',
						decimals: 2,
						uiAmountString: '15'
					}
				}],
				postTokenBalances: [{
					accountIndex: 1,
					mint: 'Mint111',
					owner: 'Owner111',
					programId: 'Token111',
					uiTokenAmount: {
						amount: '1200',
						decimals: 2,
						uiAmountString: '12'
					}
				}]
			}
		}, ['payer', 'TokenAccount111']);

		expect(result).toEqual([{
			account: 'TokenAccount111',
			accountIndex: 1,
			deltaAmount: '-300',
			deltaUiAmountString: '-3',
			decimals: 2,
			mint: 'Mint111',
			owner: 'Owner111',
			postAmount: '1200',
			postUiAmountString: '12',
			preAmount: '1500',
			preUiAmountString: '15',
			programId: 'Token111'
		}]);
	});

	it('uses the incoming transaction payload when it already contains a processable message', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const requestTxResult = {
			transaction: {
				signatures: ['signature'],
				message: {
					accountKeys: [{ pubkey: 'payer' }],
					instructions: [{ programId: 'Program111', accounts: ['payer'], data: 'abcd' }]
				}
			},
			meta: {
				innerInstructions: []
			}
		};

		const result = await __testables.resolveTransactionResult(
			'https://rpc.example',
			'https://rpcx.example',
			'signature',
			requestTxResult
		);

		expect(result).toBe(requestTxResult);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('stores raw instruction data only when the instruction has accounts', () => {
		expect(__testables.getInstructionData({
			data: 'abcd'
		}, [])).toBeNull();

		expect(__testables.getInstructionData({
			data: 'abcd'
		}, ['payer'])).toEqual({
			rawData: 'abcd',
			accounts: ['payer']
		});
	});
});

describe('delivery dedupe and account fetch caching', () => {
	it('marks signatures as processed and reports duplicates', () => {
		const signature = `sig-${Date.now()}`;

		expect(__testables.wasRecentlyProcessed(signature)).toBe(false);
		__testables.markProcessed(signature);
		expect(__testables.wasRecentlyProcessed(signature)).toBe(true);
	});

	it('filters out recently fetched accounts', () => {
		const fresh = `fresh-${Date.now()}`;
		const stale = `stale-${Date.now()}`;

		__testables.markAccountsFetched([fresh]);

		expect(__testables.filterRecentlyFetchedAccounts([fresh, stale])).toEqual([stale]);
	});
});
