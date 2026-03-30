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
