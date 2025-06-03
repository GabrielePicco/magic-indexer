import postgres from 'postgres';

interface Env {
	DB_URL: string;
	RPC_URL: string;
	RPCX_URL: string;
	AUTH_HEADER: string;
}

function getDb(dbUrl: string) {
	return postgres(dbUrl);
}

async function ensureTableExists(db: postgres.Sql, tableName: string, schema: string, comment?: string) {
	await db.unsafe(`CREATE TABLE IF NOT EXISTS ${tableName} (${schema})`);
	if (comment) {
		const safeComment = comment.replace(/'/g, "''");
		await db.unsafe(`COMMENT ON TABLE ${tableName} IS '${safeComment}'`);
	}
}


async function upsertTransaction(db: postgres.Sql, programId: string, programName: string, tx: {
	feePayer: string;
	data: any;
	name: string;
	accounts: string[];
	signature: string;
}) {
	const tableName = `${`txs_program_${programId}`.toLowerCase()}`;
	await ensureTableExists(
		db,
		tableName,
		`signature TEXT PRIMARY KEY, feePayer TEXT, name TEXT, data JSONB, accounts TEXT[]`,
		`Table for storing transactions for program ${programName} (${programId})`
	);

	await db`
		INSERT INTO ${db(tableName)} (signature, feePayer, name, data, accounts)
		VALUES (${tx.signature}, ${tx.feePayer}, ${tx.name}, ${JSON.stringify(tx.data)}, ${tx.accounts})
		ON CONFLICT (signature) DO UPDATE SET
			name = EXCLUDED.name,
			data = EXCLUDED.data,
			accounts = EXCLUDED.accounts
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

	const data = JSON.stringify(acc.data);
	await db`
			INSERT INTO ${db(tableName)} (pubkey, data, type, space, lamports)
			VALUES (${acc.key}, ${data}, ${acc.name}, ${acc.space}, ${acc.lamports})
			ON CONFLICT (pubkey) DO UPDATE SET
				data = EXCLUDED.data,
				type = EXCLUDED.type,
				space = EXCLUDED.space,
				lamports = EXCLUDED.lamports
		`;
}

async function rpcFetch(rpcUrl: string, rpcxUrl: string,  method: string, params: any): Promise<any> {
	const body = {
		jsonrpc: "2.0",
		id: "0",
		method,
		params
	};

	const res = await fetch(rpcxUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Rpc": rpcUrl
		},
		body: JSON.stringify(body)
	});

	if (!res.ok) {
		throw new Error(`RPC error: ${await res.text()}`);
	}

	const json = await res.json();
	// @ts-ignore
	if (!json.result) throw new Error("RPC result missing");
	// @ts-ignore
	return json.result;
}

export default {
	async fetch(request, env: Env, _ctx): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		const authHeader = request.headers.get('Authorization');
		if (authHeader !== env.AUTH_HEADER) {
			return new Response("Unauthorized", { status: 401 });
		}

		const db = getDb(env.DB_URL);

		try {
			const body = await request.json();
			// @ts-ignore
			const signature = body?.[0]?.transaction?.signatures?.[0];
			// @ts-ignore
			const accountKeys = body?.[0]?.transaction?.message?.accountKeys;

			if (!signature || !accountKeys) {
				return new Response("Invalid input", { status: 400 });
			}

			const txResult = await rpcFetch(env.RPC_URL, env.RPCX_URL, "getParsedTransaction", [signature, { commitment: "confirmed" }]);
			const message = txResult?.transaction?.message;
			const feePayer = message?.accountKeys?.[0];

			let txPromises = Promise.all(
				(message?.instructions || []).map(async (inst: any) => {
					if (inst.programId && inst.parsedData) {
						const accounts = (inst.accounts || []).map((idx: number) => accountKeys[idx]);
						await upsertTransaction(db, inst.programId, inst.programName, {
							feePayer,
							name: inst.name,
							data: inst.parsedData,
							accounts,
							signature
						});
					}
				})
			);

			const parsedData = await rpcFetch(env.RPC_URL, env.RPCX_URL, "getParsedAccountsData", {
				pubkeys: accountKeys,
				commitment: "processed",
				onlyParsed: true
			});

			const parsedAccounts = (parsedData.value || []).filter((acc: any) => acc?.parsed === true);
			// @ts-ignore
			const accountsPromises = Promise.all(parsedAccounts.map(acc => upsertParsedAccount(db, acc)));

			await txPromises;
			await accountsPromises;

			return new Response("Account data stored", { status: 200 });
		} catch (err: any) {
			console.error("Error:", err);
			return new Response(`Error: ${err.message}`, { status: 500 });
		}
	}
} satisfies ExportedHandler<Env>;
