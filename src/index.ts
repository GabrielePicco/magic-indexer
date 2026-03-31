import postgres from 'postgres';

const DELEGATION_PROGRAM = 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh';

interface Env {
	DB_URL: string;
	RPC_URL: string;
	RPCX_URL: string;
	AUTH_HEADER: string;
	DEBUG_LOGS?: string;
}

const SCHEMA_RETRY_DELAY_MS = 50;

function isDefined<T>(value: T | null | undefined): value is T {
	return value !== undefined && value !== null;
}

function normalizeAccountKey(accountKey: any): string | undefined {
	if (typeof accountKey === 'string') return accountKey;
	if (typeof accountKey?.pubkey === 'string') return accountKey.pubkey;
	return undefined;
}

function normalizeAccountKeys(accountKeys: any): string[] {
	if (!Array.isArray(accountKeys)) return [];

	return accountKeys.filter(Boolean).map((accountKey: any) => normalizeAccountKey(accountKey)).filter(isDefined);
}

function getInstructionProgramId(inst: any, accountKeys: string[]): string | undefined {
	if (typeof inst?.programId === 'string') return inst.programId;
	if (typeof inst?.programIdIndex === 'number') return accountKeys[inst.programIdIndex];
	return undefined;
}

function getInstructionAccounts(inst: any, accountKeys: string[]): string[] {
	if (!Array.isArray(inst?.accounts)) return [];

	if (inst.accounts.every((account: any) => typeof account === 'number')) {
		return inst.accounts.map((idx: number) => accountKeys[idx]).filter(isDefined);
	}

	return inst.accounts.map((account: any) => normalizeAccountKey(account)).filter(isDefined);
}

function getInstructionName(inst: any): string {
	return inst?.name || inst?.parsed?.type || inst?.programName || inst?.program || 'raw';
}

function getInstructionData(inst: any, accounts: string[]): any {
	if (inst?.parsedData) return inst.parsedData;
	if (inst?.parsed?.info) return inst.parsed.info;
	if (inst?.parsed) return inst.parsed;
	if (typeof inst?.data === 'string' && accounts.length > 0) {
		return {
			rawData: inst.data,
			accounts
		};
	}

	return null;
}

function normalizeParsedAccount(pubkey: string, account: any) {
	const parsed = account?.data?.parsed;
	if (!parsed) return null;

	return {
		key: pubkey,
		data: parsed.info ?? parsed,
		name: parsed.type,
		space: account.space,
		lamports: account.lamports,
		owner: account.owner,
		parsed: true
	};
}

function hasProcessableTransaction(txResult: any): boolean {
	const message = txResult?.transaction?.message;
	return normalizeAccountKeys(message?.accountKeys).length > 0 && Array.isArray(message?.instructions) &&
		message.instructions.length > 0;
}

function getTransactionEvents(txResult: any): any[] {
	if (Array.isArray(txResult?.transaction?.events)) return txResult.transaction.events;
	if (Array.isArray(txResult?.events)) return txResult.events;
	return [];
}

function formatTokenAmount(amount: string, decimals: number): string {
	const negative = amount.startsWith('-');
	const digits = negative ? amount.slice(1) : amount;

	if (decimals === 0) return `${negative ? '-' : ''}${digits}`;

	const padded = digits.padStart(decimals + 1, '0');
	const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, '');
	const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');

	return `${negative ? '-' : ''}${fraction ? `${whole}.${fraction}` : whole}`;
}

function getTokenBalanceKey(balance: any): string | null {
	if (typeof balance?.accountIndex !== 'number') return null;
	if (typeof balance?.mint !== 'string') return null;
	return `${balance.accountIndex}:${balance.mint}`;
}

function extractTokenBalanceChanges(txResult: any, accountKeys: string[]): any[] {
	const preTokenBalances = Array.isArray(txResult?.meta?.preTokenBalances) ? txResult.meta.preTokenBalances : [];
	const postTokenBalances = Array.isArray(txResult?.meta?.postTokenBalances) ? txResult.meta.postTokenBalances : [];

	if (preTokenBalances.length === 0 && postTokenBalances.length === 0) return [];

	const tokenBalances = new Map<string, { pre?: any; post?: any }>();

	for (const balance of preTokenBalances) {
		const key = getTokenBalanceKey(balance);
		if (!key) continue;
		tokenBalances.set(key, { ...(tokenBalances.get(key) || {}), pre: balance });
	}

	for (const balance of postTokenBalances) {
		const key = getTokenBalanceKey(balance);
		if (!key) continue;
		tokenBalances.set(key, { ...(tokenBalances.get(key) || {}), post: balance });
	}

	return Array.from(tokenBalances.values())
		.map(({ pre, post }) => {
			const tokenBalance = post || pre;
			if (!tokenBalance) return null;

			const accountIndex = tokenBalance.accountIndex;
			const decimals = post?.uiTokenAmount?.decimals ?? pre?.uiTokenAmount?.decimals ?? 0;
			const preAmount = pre?.uiTokenAmount?.amount ?? '0';
			const postAmount = post?.uiTokenAmount?.amount ?? '0';

			if (preAmount === postAmount) return null;

			const deltaAmount = (BigInt(postAmount) - BigInt(preAmount)).toString();

			return {
				account: typeof accountIndex === 'number' ? accountKeys[accountIndex] : undefined,
				accountIndex,
				deltaAmount,
				deltaUiAmountString: formatTokenAmount(deltaAmount, decimals),
				decimals,
				mint: tokenBalance.mint,
				owner: post?.owner ?? pre?.owner,
				postAmount,
				postUiAmountString: post?.uiTokenAmount?.uiAmountString ?? formatTokenAmount(postAmount, decimals),
				preAmount,
				preUiAmountString: pre?.uiTokenAmount?.uiAmountString ?? formatTokenAmount(preAmount, decimals),
				programId: post?.programId ?? pre?.programId
			};
		})
		.filter(isDefined)
		.sort((left, right) => left.accountIndex - right.accountIndex);
}

function isDebugEnabled(env: Env): boolean {
	return env.DEBUG_LOGS === '1' || env.DEBUG_LOGS === 'true';
}

function debugLog(env: Env, message: string, data?: Record<string, unknown>) {
	if (!isDebugEnabled(env)) return;
	if (data) {
		console.log(message, data);
		return;
	}
	console.log(message);
}

function isCreateTableRace(error: any): boolean {
	return error?.code === '42P07' || (error?.code === '23505' && error?.constraint_name === 'pg_type_typname_nsp_index');
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function getDb(dbUrl: string) {
	return postgres(dbUrl);
}

async function ensureTableExists(db: postgres.Sql, tableName: string, schema: string, comment?: string) {
	const safeComment = comment?.replace(/'/g, '\'\'');

	for (let attempt = 0; ; attempt++) {
		try {
			await db.unsafe(`CREATE TABLE IF NOT EXISTS ${tableName}
										 (
											 ${schema}
										 )`);
			if (safeComment) {
				await db.unsafe(`COMMENT ON TABLE ${tableName} IS '${safeComment}'`);
			}
			return;
		} catch (error: any) {
			if (!isCreateTableRace(error) || attempt >= 2) {
				throw error;
			}
			await sleep(SCHEMA_RETRY_DELAY_MS * (attempt + 1));
		}
	}
}

async function columnExists(db: postgres.Sql, tableName: string, columnName: string): Promise<boolean> {
	const result = await db`
		SELECT 1
		FROM information_schema.columns
		WHERE table_name = ${tableName}
			AND column_name = ${columnName}
	`;
	return result.length > 0;
}

async function addColumnIfMissing(db: postgres.Sql, tableName: string, columnName: string, columnType: string) {
	if (!(await columnExists(db, tableName, columnName))) {
		try {
			await db.unsafe(`ALTER TABLE ${tableName}
				ADD COLUMN ${columnName} ${columnType}`);
		} catch (error: any) {
			if (error?.code !== '42701') {
				throw error;
			}
		}
	}
}


async function upsertTransaction(db: postgres.Sql, programId: string, programName: string, tx: {
	feePayer: string;
	data: any;
	name: string;
	events: string[];
	tokenBalanceChanges: any[];
	accounts: string[];
	signature: string;
}) {
	const tableName = `${`txs_program_${programId}`.toLowerCase()}`;

	await ensureTableExists(
		db,
		tableName,
		`signature TEXT PRIMARY KEY,
		   feePayer TEXT,
		   name TEXT,
		   data JSONB,
		   accounts TEXT[],
		   tokenBalanceChanges JSONB,
		   timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
		`${programName}: transactions for program (${programId})`
	);

	await addColumnIfMissing(db, tableName, 'events', 'JSONB');
	await addColumnIfMissing(db, tableName, 'tokenBalanceChanges', 'JSONB');

	await db`
		INSERT INTO ${db(tableName)} (signature, feePayer, name, data, accounts, events, tokenBalanceChanges)
		VALUES (${tx.signature}, ${tx.feePayer}, ${tx.name}, ${tx.data}, ${tx.accounts},
						${tx.events}, ${tx.tokenBalanceChanges}) ON CONFLICT (signature) DO
		UPDATE SET
			name = EXCLUDED.name,
			data = EXCLUDED.data,
			accounts = EXCLUDED.accounts,
			events = EXCLUDED.events,
			tokenBalanceChanges = EXCLUDED.tokenBalanceChanges
	`;
}

async function upsertParsedAccount(db: postgres.Sql, acc: any) {
	const programId = acc?.owner?.toLowerCase()?.replace(/[^a-z0-9_]/g, '_');
	if (!programId) return;

	const tableName = `${`program_${programId}`.toLowerCase()}`;
	await ensureTableExists(db, tableName, `
		pubkey TEXT PRIMARY KEY,
		data JSONB,
		type TEXT,
		space BIGINT,
		lamports BIGINT
	`, 'Stores parsed account data indexed by pubkey for a specific Solana program.');

	await db`
		INSERT INTO ${db(tableName)} (pubkey, data, type, space, lamports)
		VALUES (${acc.key}, ${acc.data}, ${acc.name}, ${acc.space}, ${acc.lamports}) ON CONFLICT (pubkey) DO
		UPDATE SET
			data = EXCLUDED.data,
			type = EXCLUDED.type,
			space = EXCLUDED.space,
			lamports = EXCLUDED.lamports
	`;
}

async function rpcFetch(rpcUrl: string, rpcxUrl: string, method: string, params: any): Promise<any> {
	return rpcRequest(rpcxUrl, {
		'Rpc': rpcUrl
	}, method, params);
}

async function rpcFetchDirect(rpcUrl: string, method: string, params: any): Promise<any> {
	return rpcRequest(rpcUrl, {}, method, params);
}

async function rpcRequest(url: string, headers: Record<string, string>, method: string, params: any): Promise<any> {
	const body = {
		jsonrpc: '2.0',
		id: '0',
		method,
		params
	};

	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...headers
		},
		body: JSON.stringify(body)
	});

	const text = await res.text();
	if (!res.ok) {
		throw new Error(`RPC ${method} failed: ${text}`);
	}

	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(`RPC ${method} returned non-JSON: ${text}`);
	}

	if (json?.error) {
		throw new Error(`RPC ${method} error (${json.error.code}): ${json.error.message}`);
	}

	if (!('result' in json)) throw new Error(`RPC ${method} result missing`);
	return json.result;
}

async function fetchParsedTransaction(rpcUrl: string, rpcxUrl: string, signature: string): Promise<any> {
	try {
		return await rpcFetch(rpcUrl, rpcxUrl, 'getParsedTransaction', [signature, { commitment: 'confirmed' }]);
	} catch (_error) {
		return rpcFetchDirect(rpcUrl, 'getTransaction', [signature, {
			commitment: 'confirmed',
			encoding: 'jsonParsed',
			maxSupportedTransactionVersion: 0
		}]);
	}
}

async function resolveTransactionResult(rpcUrl: string, rpcxUrl: string, signature: string, txResult: any): Promise<any> {
	if (hasProcessableTransaction(txResult)) return txResult;
	return fetchParsedTransaction(rpcUrl, rpcxUrl, signature);
}

async function fetchParsedAccounts(rpcUrl: string, rpcxUrl: string, accountKeys: string[]): Promise<any> {
	if (accountKeys.length === 0) return { value: [] };

	try {
		return await rpcFetch(rpcUrl, rpcxUrl, 'getParsedAccountsData', {
			pubkeys: accountKeys,
			commitment: 'processed',
			onlyParsed: true
		});
	} catch (_error) {
		const result = await rpcFetchDirect(rpcUrl, 'getMultipleAccounts', [accountKeys, {
			commitment: 'processed',
			encoding: 'jsonParsed'
		}]);

		return {
			value: (result?.value || []).map((account: any, index: number) => normalizeParsedAccount(accountKeys[index], account))
		};
	}
}

export const __testables = {
	extractTokenBalanceChanges,
	fetchParsedAccounts,
	fetchParsedTransaction,
	getInstructionData,
	resolveTransactionResult
};

export default {
	async fetch(request, env: Env, _ctx): Promise<Response> {
		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		const authHeader = request.headers.get('Authorization');
		if (authHeader !== env.AUTH_HEADER) {
			return new Response('Unauthorized', { status: 401 });
		}

		const db = getDb(env.DB_URL);

		try {
			const body: any = await request.json();
			const requestTxResult = body?.[0];
			const signature = requestTxResult?.transaction?.signatures?.[0];
			const accountKeys = normalizeAccountKeys(requestTxResult?.transaction?.message?.accountKeys);
			debugLog(env, 'Processing transaction request', {
				signature,
				accountKeyCount: accountKeys.length
			});

			if (!signature || accountKeys.length === 0) {
				return new Response('Invalid input', { status: 400 });
			}

			const txResult = await resolveTransactionResult(env.RPC_URL, env.RPCX_URL, signature, requestTxResult);
			const message = txResult?.transaction?.message;
			const resolvedAccountKeys = normalizeAccountKeys(message?.accountKeys);
			const txAccountKeys = resolvedAccountKeys.length > 0 ? resolvedAccountKeys : accountKeys;
			const feePayer = normalizeAccountKey(message?.accountKeys?.[0]) ?? txAccountKeys[0];
			const events = getTransactionEvents(txResult);
			const tokenBalanceChanges = extractTokenBalanceChanges(txResult, txAccountKeys);
			debugLog(env, 'Transaction resolved', {
				signature,
				instructionCount: message?.instructions?.length || 0,
				resolvedAccountKeyCount: txAccountKeys.length,
				tokenBalanceChangeCount: tokenBalanceChanges.length,
				usedRequestPayload: txResult === requestTxResult
			});

			// Detect if the transaction contains delegations
			const delegationMatches: {
				parentProgramId: string;
			}[] = [];
			const isDelegation = txResult.meta?.innerInstructions?.some((innerInstruction: any) => {
				try {
					return innerInstruction.instructions?.some((ix: any) => {
						const mappedProgramId = getInstructionProgramId(ix, txAccountKeys);
						const parentIndex = innerInstruction.index;
						const parentProgramId = getInstructionProgramId(
							txResult.transaction.message.instructions[parentIndex],
							txAccountKeys
						);

						const match =
							mappedProgramId === DELEGATION_PROGRAM &&
							typeof ix.data === 'string' &&
							ix.data.startsWith('11111111');

						if (match) {
							delegationMatches.push({
								parentProgramId: parentProgramId ?? 'unknown'
							});
						}

						return match;
					});
				} catch {
					return false;
				}
			});
			if (isDelegation) {
				const extractedProgramId = delegationMatches[0].parentProgramId;
				debugLog(env, 'Delegation transaction detected', {
					signature,
					parentProgramId: extractedProgramId
				});
				await upsertTransaction(db, DELEGATION_PROGRAM, 'Delegation Program', {
					feePayer,
					name: 'delegate',
					data: { program: extractedProgramId },
					accounts: txAccountKeys,
					events,
					tokenBalanceChanges,
					signature
				});
			}

			// Parse
			let txPromises = Promise.all(
				(message?.instructions || []).map(async (inst: any) => {
					const programId = getInstructionProgramId(inst, txAccountKeys);
					const accounts = getInstructionAccounts(inst, txAccountKeys);
					const data = getInstructionData(inst, accounts);

					if (programId && data) {
						await upsertTransaction(db, programId, inst.programName || inst.program || programId, {
							feePayer,
							name: getInstructionName(inst),
							data,
							events,
							tokenBalanceChanges,
							accounts,
							signature
						});
					}
				})
			);

			let accountsPromises = Promise.resolve();
			try {
				const parsedData = await fetchParsedAccounts(env.RPC_URL, env.RPCX_URL, txAccountKeys);
				const parsedAccounts = (parsedData.value || []).filter((acc: any) => acc?.parsed === true);
				debugLog(env, 'Parsed accounts fetched', {
					signature,
					parsedAccountCount: parsedAccounts.length
				});
				// @ts-ignore
				accountsPromises = Promise.all(parsedAccounts.map(acc => upsertParsedAccount(db, acc)));
			} catch (error) {
				console.warn('Account parsing skipped:', error);
			}

			await txPromises;
			await accountsPromises;
			debugLog(env, 'Transaction stored', { signature });

			return new Response('Account data stored', { status: 200 });
		} catch (err: any) {
			console.error('Error:', err);
			return new Response(`Error: ${err.message}`, { status: 500 });
		}
	}
} satisfies ExportedHandler<Env>;
